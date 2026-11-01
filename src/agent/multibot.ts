/**
 * Phase 4 wiring (S26.1 to S26.3): the multi-bot host. `startAgent` calls `startMultiBot` instead of building one bridge and one
 * Harness when `security.json` has a `bots` block (`parseBots(...).implicit` is false). A one-bot install never gets here: its path in
 * `harness.ts` is the Phase 1 to 3 code, unchanged.
 *
 * Host-wide (ONE each): the bot bus and router, its audit and chain store, the local gate and its priority hints, the proxy brain
 * (one limiter set, one status), the settings audit writer, `prefs.json`, the allowlist with a row per bot, the job runner client, the
 * room mirror and the kill switch. Per bot: the bridge, the Harness and its SQLite file (`createHarnessBotFactory`), the extensions
 * (`a7` with the bus guard, tool search, MCP hub, jobs, settings, `a7-bots`), the model switcher, the fallback engine and the
 * `/model` and `/status` additions.
 *
 * Order of the model hooks of a bot: `proxy limiter -> local gate -> the provider`. Each gates only its own providers (`acp-*` and
 * `lmstudio`/`strata`), so they compose without knowing each other.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { AuditLog, Logger, PeerProvenance } from "../contracts.js";
import { BotManager, botLogger } from "../bots/manager.js";
import type { BotRuntimeContext, BotStatus } from "../bots/manager.js";
import { checkMainMigrated } from "../bots/migrate.js";
import { botPathScope, sharedPaths } from "../bots/paths.js";
import { botRows } from "../bots/rows.js";
import { createHarnessBotFactory, providerIdOf, tokenResolver } from "../bots/runtime.js";
import type { BotRuntimeHandle } from "../bots/runtime.js";
import { allowedToolSet, narrowExtension } from "../bots/registry.js";
import type { PresetConfig, ResolvedBot, ResolvedBots } from "../bots/schema.js";
import { createSharedSection } from "../bots/shared.js";
import { BusAudit } from "../botbus/audit.js";
import { createBotBus } from "../botbus/bus.js";
import type { InProcessBotBus } from "../botbus/bus.js";
import { FileChainStore } from "../botbus/chains.js";
import type { UserNotice } from "../botbus/contracts.js";
import { createBotBusExtension } from "../botbus/tools.js";
import { startBotRoomMirror } from "../botroom/mirror.js";
import type { BotRoomMirror, RoomApi } from "../botroom/mirror.js";
import type { KillSwitchHandle } from "../approval/killSwitch.js";
import type { Config } from "../config/schema.js";
import type { RunnerSelection } from "../config/load.js";
import type { Secrets } from "../config/secrets.js";
import { LocalGate, PriorityHints, createGateDecorator, gateStatusLines, localTopology, waitNoticeText } from "../gate/index.js";
import { P0, P2 } from "../gate/queue.js";
import { IpcClient } from "../ipc/client.js";
import { IpcKey } from "../ipc/hmac.js";
import type { JobRunnerClient } from "../jobs/contracts.js";
import type { Redactor } from "../logging/redact.js";
import { FallbackEngine } from "../models/fallback.js";
import { ModelSwitcher } from "../models/switch.js";
import { checkProxy } from "../proxy/discover.js";
import { toFallbackFailure } from "../proxy/errors.js";
import type { AuthMethod } from "../proxy/health.js";
import { DEFAULT_PROXY_PORT, ProxyStatus, fetchHealth, proxyEndpoint } from "../proxy/health.js";
import type { FetchLike } from "../proxy/health.js";
import { createProxyBrain } from "../proxy/provider.js";
import type { CallInfo, FailureEvent, ProxyBrain } from "../proxy/provider.js";
import { BACKGROUND_CONTEXT, section } from "../pi/adapter.js";
import type { Extension, Registry } from "../pi/adapter.js";
import type { HealthMonitor } from "../runtime/health.js";
import type { Lock } from "../runtime/lock.js";
import { DEFAULT_ROWS, withRows } from "../settings/allowlist.js";
import { createSettingsAudit } from "../settings/audit.js";
import type { LoadedSettings } from "../settings/load.js";
import { PrefsStore } from "../settings/prefs.js";
import type { BridgeExtension, TelegramBridgeOptions } from "../telegram/bot.js";
import { TelegramModelUi } from "../telegram/modelUi.js";
import { toConversationId } from "../telegram/conversations.js";
import { botReadPolicy, botWritePolicy } from "../tools/pathPolicy.js";
import { busAuditSource } from "./busAdapter.js";
import { createBusGuard } from "./busGuard.js";
import { A7_EXTENSION_NAME, createA7Extension } from "./extension.js";
import type { A7Extension } from "./extension.js";
import { createPhase2 } from "./phase2.js";
import type { Phase2Handle, Phase2Options } from "./phase2.js";
import { createPhase3 } from "./phase3.js";
import type { Phase3Handle, Phase3Options } from "./phase3.js";
import { createPeerRuntime, ToolUseLog } from "./peerRuntime.js";
import { PeerProvenanceTracker } from "./provenance.js";
import { createRefReader } from "./refReader.js";

/** Test seams for the multi-bot start. Nothing here is used in production. */
export interface MultiBotSeams {
  /** A fake grammY `Bot` (and its `getMe`) per bot, and bridge options such as the edit interval. */
  bridgeFor?: (ctx: BotRuntimeContext) => { bot?: Bot; botInfo?: UserFromGetMe; options?: Partial<TelegramBridgeOptions> };
  /** The fetch used by the proxy start-up check and `/status` (a fake proxy). */
  proxyFetch?: FetchLike;
  /** The grammY `Api` the room mirror posts with (a fake). */
  botRoomApi?: RoomApi;
  /** Timeout for the proxy start-up check, in ms. */
  proxyCheckTimeoutMs?: number;
}

export interface MultiBotArgs {
  config: Config;
  secrets: Secrets;
  settings: LoadedSettings;
  resolved: ResolvedBots;
  logger: Logger;
  redact: Redactor;
  audit: AuditLog;
  killSwitch: KillSwitchHandle;
  health: HealthMonitor;
  runner: RunnerSelection;
  checkAcl: boolean;
  seams?: MultiBotSeams | undefined;
  phase2?: Phase2Options | undefined;
  phase3?: Phase3Options | undefined;
  shellRunner?: Parameters<typeof createA7Extension>[0]["shellRunner"];
  psRunner?: Parameters<typeof createA7Extension>[0]["psRunner"];
  gatePollMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  onRestart?: ((code: number) => void) | undefined;
  onFatal?: ((id: string, error: unknown) => void) | undefined;
  lock?: Lock | undefined;
  streamTimeoutMs?: number | undefined;
}

/** What the host keeps for one bot. */
export interface BotParts {
  readonly id: string;
  readonly spec: ResolvedBot;
  readonly p2: Phase2Handle;
  readonly p3: Phase3Handle;
  readonly a7: A7Extension;
  readonly switcher: ModelSwitcher;
  readonly fallback: FallbackEngine;
  readonly toolUse: ToolUseLog;
  /** Set in `afterOpen`. */
  rt?: BotRuntimeHandle;
}

export interface MultiBotHandle {
  readonly manager: BotManager;
  readonly bus: InProcessBotBus;
  readonly gate: LocalGate;
  readonly hints: PriorityHints;
  readonly proxy: ProxyBrain;
  readonly provenance: PeerProvenanceTracker;
  readonly mirror: BotRoomMirror | undefined;
  readonly resolved: ResolvedBots;
  /** Startup statuses of every bot. */
  readonly statuses: readonly BotStatus[];
  /** The per-bot parts (a bot that failed to start has none of `rt`). */
  part(id: string): BotParts | undefined;
  parts(): BotParts[];
  /** The `/status` lines the bot's own chat shows in addition to the base ones. */
  statusLines(id: string): Promise<string[]>;
  stop(): Promise<void>;
}

const peersFile = (): string => fileURLToPath(new URL("../../../prompts/peers.md", import.meta.url));

function peersSection(): ReturnType<typeof section> {
  return section("peers", async () => (await readFile(peersFile(), "utf8")).replace(/^﻿/, "").replace(/\r\n/g, "\n").trim());
}

/** The preset a model call used, found by its provider id and model id. */
function presetOfCall(presets: readonly PresetConfig[], providerId: string, modelId: string): PresetConfig | undefined {
  return presets.find((p) => providerIdOf(p) === providerId && p.modelId === modelId);
}

/** A `ProxyStatus` that also tells the host when a provider answered, so the retry counters and the outage flags end. */
class HostProxyStatus extends ProxyStatus {
  onSuccess: ((providerId: string) => void) | undefined;
  override noteSuccess(providerId: string): void {
    super.noteSuccess(providerId);
    this.onSuccess?.(providerId);
  }
}

export async function startMultiBot(a: MultiBotArgs): Promise<MultiBotHandle> {
  const { config, secrets, settings, resolved, logger: log, redact } = a;
  const seams = a.seams ?? {};
  const botsById = new Map(resolved.bots.map((b) => [b.id, b] as const));
  const parts = new Map<string, BotParts>();
  const allowedUserIds = config.telegram.allowedUserIds;

  const dataDir = config.paths.dataDir;
  mkdirSync(join(dataDir, "bus"), { recursive: true });
  const chainStore = new FileChainStore(join(dataDir, "bus", "chains.json"));
  const bus: InProcessBotBus = createBotBus({
    bots: resolved.bots,
    limits: resolved.botBus,
    audit: new BusAudit({ dir: join(dataDir, "bus-audit"), redact }),
    chains: chainStore,
    refs: createRefReader({ config, bots: resolved.bots, presets: resolved.presets }),
    flowServerId: config.flow.serverId,
    notify: (notice) => void tellUserOfNotice(notice),
  });
  const provenance = new PeerProvenanceTracker(bus);

  /** Tells the user (the private chat of the allowed user) through one bot's own API. A failure is logged, never thrown. */
  async function tellUser(botId: string, text: string, conversationId?: string): Promise<void> {
    const p = parts.get(botId);
    const bridge = p?.rt?.bridge;
    if (!bridge) return;
    try {
      if (conversationId !== undefined && bridge.chatLookup.chatForConversation(conversationId) !== undefined) {
        await bridge.notifier.notify(conversationId, text);
        return;
      }
      for (const id of allowedUserIds) await bridge.bot.api.sendMessage(id, redact(text), { link_preview_options: { is_disabled: true } });
    } catch (e) {
      log.warn("bots.notice_failed", { bot: botId, error: e instanceof Error ? e.name : "error" });
    }
  }
  async function tellUserOfNotice(n: UserNotice): Promise<void> {
    await tellUser(n.bot, n.text, n.conversationId);
  }

  // ---- gate and hints ------------------------------------------------------------------------------------------------
  const hints = new PriorityHints();
  const gate = new LocalGate({
    settings: resolved.gate,
    logger: log,
    // a bot's notifier exists only after the bot is built, so the lookup is late, at call time
    onWait: async (n) => {
      const p = parts.get(n.bot);
      if (!p?.rt || n.conversationId === undefined) return;
      await p.rt.bridge.notifier.notify(n.conversationId, waitNoticeText(n.ahead));
    },
  });

  // ---- the proxy brain -----------------------------------------------------------------------------------------------
  const acpPresets = resolved.presets.filter((p) => p.kind === "acp");
  let unavailable: ReadonlySet<string> | undefined;
  let startAuth: Record<string, AuthMethod> = {};
  if (acpPresets.length > 0) {
    const first = acpPresets.find((p) => p.baseUrl !== undefined);
    try {
      const report = await checkProxy({
        ...(first?.baseUrl !== undefined ? { baseUrl: first.baseUrl } : { port: DEFAULT_PROXY_PORT }),
        apiKey: secrets.proxyApiKey,
        presets: acpPresets,
        ...(seams.proxyFetch ? { fetch: seams.proxyFetch } : {}),
        ...(seams.proxyCheckTimeoutMs !== undefined ? { timeoutMs: seams.proxyCheckTimeoutMs } : {}),
      });
      // Only a proxy that answered and listed its models can say a preset is missing; a proxy that is down is handled per call.
      if (report.health.ok && report.models.ok) unavailable = new Set(report.presets.filter((p) => !p.available).map((p) => p.presetId));
      startAuth = report.authMethods;
      log.info("proxy.checked", { ok: report.ok, health: report.health.ok, models: report.models.ok, unavailable: unavailable ? [...unavailable] : [] });
    } catch (e) {
      log.warn("proxy.check_failed", { error: e instanceof Error ? e.name : "error" });
    }
  }

  const attempts = new Map<string, number>();
  const proxyStatus = new HostProxyStatus();
  const proxy = createProxyBrain({
    presets: resolved.presets,
    secrets: { proxyApiKey: secrets.proxyApiKey },
    proxyMaxConcurrent: resolved.gate.proxyMaxConcurrent,
    maxQueue: resolved.gate.maxQueueDepth,
    agingMs: resolved.gate.agingSec * 1000,
    status: proxyStatus,
    redact,
    ...(unavailable ? { unavailablePresetIds: unavailable } : {}),
    // P0 for the user's own turn, P1 or P2 for peer turns, P2 for background turns, P3 for summaries: the same hints the gate reads
    priorityFor: (info: CallInfo) => (info.kind === "complete" ? 3 : hints.resolve(info.botId).priority),
    onFailure: (ev) => void onProxyFailure(ev),
  });
  for (const [prov, m] of Object.entries(startAuth)) proxyStatus.noteAuthMethod(prov, m);
  proxyStatus.onSuccess = (providerId) => {
    for (const k of [...attempts.keys()]) if (k.includes(`|${providerId}|`)) attempts.delete(k);
    for (const p of parts.values()) for (const preset of resolved.presets) if (providerIdOf(preset) === providerId) p.fallback.succeeded(preset.id);
  };

  /**
   * A proxy failure goes to the bot's fallback engine (I39). Proxy retries for `busy`, `queue_full` and `timeout` happen earlier, inside
   * `limitProxyModels` (src/proxy/provider.ts, piece 12), so a failure reported here has already used them; the Harness's own retry policy
   * still applies to the local runners (deviation 98). The engine counts the failures of an outage so that once the retries are spent
   * the route rule applies: a fallback preset (with `autoFallback`), or ONE notice to the user.
   */
  async function onProxyFailure(ev: FailureEvent): Promise<void> {
    const p = parts.get(ev.botId);
    if (!p) return;
    const failure = toFallbackFailure(ev.failure);
    if (!failure) return;
    const preset = presetOfCall(resolved.presets, ev.providerId, ev.modelId);
    if (!preset) return;
    const key = `${ev.botId}|${ev.providerId}|${preset.id}`;
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n);
    const handled = p.fallback.handle(failure, preset.id, n - 1);
    const d = handled.decision;
    if (d.action === "fallback") {
      p.switcher.setFallback(d.preset, ev.failure.kind);
      bus.recordNote({ event: "fallback", bot: ev.botId, detail: `${preset.id} to ${d.preset.id} (${ev.failure.kind})` });
    }
    if (handled.notice) await tellUser(ev.botId, handled.notice);
  }

  // ---- shared settings objects -----------------------------------------------------------------------------------------
  const settingsAudit = createSettingsAudit({ dir: settings.paths.auditDir, writer: "agent", redact });
  const prefs = new PrefsStore(settings.paths.prefsFile, { onWarning: (w) => log.warn("settings.prefs_invalid", { warning: w }) });
  const rows = withRows(DEFAULT_ROWS, botRows(resolved));

  // ---- the job runner client (one connection for the host) ---------------------------------------------------------------
  let sharedClient: JobRunnerClient | undefined = a.phase2?.client;
  if (!sharedClient && secrets.ipcHmacKey !== undefined) sharedClient = new IpcClient({ port: config.jobs.ipcPort, key: IpcKey.fromBase64Url(secrets.ipcHmacKey), logger: log });

  // ---- runner liveness for a switch and a persona preset --------------------------------------------------------------
  const runnerUp = async (name: string): Promise<boolean> => {
    if (name === a.runner.runner) return a.health.status().up;
    const block = config.model.runners[name as "lmstudio" | "strata"];
    const key = name === "lmstudio" ? secrets.lmStudioApiToken : secrets.strataApiKey;
    if (!block || (name === "lmstudio" && !key)) return false;
    try {
      const res = await (a.fetchImpl ?? fetch)(`${block.baseUrl.replace(/\/$/, "")}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  };
  const presetUp = async (p: PresetConfig): Promise<boolean> => {
    if (p.kind === "local") return p.runner ? runnerUp(p.runner) : true;
    // a preset the proxy did not list at start-up is refused as a switch target (the start-up check, S23.1)
    return !(unavailable?.has(p.id) ?? false) && !proxyStatus.needsLogin(providerIdOf(p)) && !proxyStatus.refused(providerIdOf(p));
  };

  let mirror: BotRoomMirror | undefined;

  // ---- one bot's host parts ------------------------------------------------------------------------------------------------
  let startupClaimed = false;
  const activeTurns = new Map<string, number>();
  const turnEnds = new Map<string, (() => void)[]>();

  const factory = createHarnessBotFactory({
    config,
    presets: resolved.presets,
    secrets,
    allowedUserIds,
    redact,
    killFlagPath: a.killSwitch.flagPath,
    ...(a.streamTimeoutMs !== undefined ? { streamTimeoutMs: a.streamTimeoutMs } : {}),
    extraProviders: (spec) => proxy.extraProviders(spec),
    decorateModels: (models, spec) => createGateDecorator({ gate, hints })(proxy.decorateModels(models, spec), spec),
    ...(seams.bridgeFor ? { bridgeFor: (ctx: BotRuntimeContext) => seams.bridgeFor?.(ctx) ?? {} } : {}),
    onFatal: (id, error) => a.onFatal?.(id, error),
    extensionsFor: async (ctx): Promise<Extension[]> => {
      const spec = ctx.spec;
      const botConfig = ctx.config;
      const bridge = ctx.bridge;
      const l = ctx.logger;
      const self = spec.id;
      const writesStartup = !startupClaimed;
      startupClaimed = true;
      let me: BotParts | undefined;
      const rt = (): BotRuntimeHandle | undefined => me?.rt;
      const scope = botPathScope(config.paths.dataDir, config.paths.programDataDir, spec);

      const switcher = new ModelSwitcher({
        bot: spec,
        presets: resolved.presets,
        terms: () => resolved.termsAccepted,
        prefs,
        audit: settingsAudit,
        propose: (input, c) => (me as BotParts).p3.engine.propose("setting", input, c),
        models: () => rt()?.models,
        up: presetUp,
        guardExtension: A7_EXTENSION_NAME,
        logger: l,
      });
      // a model switch goes to the bus audit as a note (I45)
      const switchByUser = switcher.switchByUser.bind(switcher);
      switcher.switchByUser = async (req) => {
        const out = await switchByUser(req);
        bus.recordNote({ event: "model_switch", bot: self, detail: `${out.status} ${out.preset?.id ?? "-"}` });
        return out;
      };
      const fallback = new FallbackEngine({ bot: spec, presets: resolved.presets, terms: () => resolved.termsAccepted, audit: settingsAudit, revision: () => prefs.get().revision });
      const toolUse = new ToolUseLog();

      const prov = (conversationId: string): readonly PeerProvenance[] | undefined => provenance.forConversation(self, conversationId);
      const p2 = await createPhase2({
        config: botConfig,
        secrets,
        logger: l,
        redact,
        bridge,
        getHarness: () => rt()?.harness,
        options: { ...(a.phase2 ?? {}), ...(sharedClient ? { client: sharedClient } : {}), jobUi: { ...(a.phase2?.jobUi ?? {}), provenanceFor: prov } },
      });
      const p3 = await createPhase3({
        config: botConfig,
        settings,
        logger: l,
        redact,
        chats: bridge.chatLookup,
        getHarness: () => rt()?.harness,
        templates: p2.templates,
        checkAcl: a.checkAcl,
        bridge,
        // a getter object: a persona change reapplies the CURRENT model, never the primary
        baseModel: switcher.liveModelRef(),
        runnerUp,
        requestRestart: a.onRestart,
        options: { ...(a.phase3 ?? {}), audit: settingsAudit, prefs, rows, recordStartup: writesStartup, keepBotModel: true, provenanceFor: prov },
      });

      // in a peer turn of a cloud-capable bot the read tools may name only the cloud-safe roots
      const cloudSafeConfig: Config = { ...botConfig, folders: { allow: spec.cloudSafeRoots.map((r) => ({ ...r })), deny: [...botConfig.folders.deny] } };
      const busGuard = createBusGuard({
        bus,
        self,
        ...(spec.cloudCapable ? { cloudSafePolicy: botReadPolicy(cloudSafeConfig, scope) } : {}),
        onToolUsed: (conv, tool) => toolUse.note(conv, tool),
      });
      const shared = createSharedSection(spec, sharedPaths(config.paths.programDataDir));
      const primary = resolved.presets.find((p) => p.id === spec.route.primary);
      const a7 = createA7Extension({
        config: botConfig,
        logger: l,
        redact,
        audit: a.audit,
        killSwitch: ctx.killSwitch,
        telegram: bridge,
        health: a.health,
        modelId: primary?.modelId ?? a.runner.provider.modelId,
        readPolicy: botReadPolicy(botConfig, scope),
        writePolicy: botWritePolicy(botConfig, scope),
        extraBeforeTool: [busGuard.beforeTool, ...p3.beforeTool, ...p2.beforeTool],
        extraAfterTool: [busGuard.afterTool],
        afterPreamble: [...(bus.hasEdges(self) ? [peersSection()] : []), ...p3.afterPreamble, ...(shared ? [shared] : [])],
        ...(p3.memoryTarget ? { memoryTarget: p3.memoryTarget } : {}),
        ...(p3.memoryFor ? { memoryFor: p3.memoryFor } : {}),
        provenanceFor: prov,
        ...(a.shellRunner ? { shellRunner: a.shellRunner } : {}),
        ...(a.psRunner ? { psRunner: a.psRunner } : {}),
        ...(a.gatePollMs !== undefined ? { gatePollMs: a.gatePollMs } : {}),
      });
      me = { id: self, spec, p2, p3, a7, switcher, fallback, toolUse };
      parts.set(self, me);
      return [a7.extension, ...p2.installs, p3.extension, createBotBusExtension({ bus, self })];
    },
    afterOpen: async (handle) => {
      const p = parts.get(handle.id) as BotParts;
      p.rt = handle;
      const spec = p.spec;
      const allow = allowedToolSet(spec);
      // the MCP hub adds tools later (`hub_start`): through the bot's allowlist, never around it
      const narrowed = new Proxy(handle.registry, {
        get(t, prop) {
          if (prop === "install") return (e: Extension) => t.install(narrowExtension(e, allow));
          const v = Reflect.get(t, prop, t) as unknown;
          return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
        },
      }) as Registry;
      p.p2.attachRegistry(narrowed);
      p.p3.attachRegistry(handle.registry);
      p.p2.start();
      await p.p3.start();

      // `/model` and the admission hook that makes the chat's conversation follow the bot's active preset (after the persona extension)
      const ui = new TelegramModelUi({
        api: handle.bridge.bot.api,
        allowedUserIds,
        logger: botLogger(log, handle.id),
        switcher: p.switcher,
        bot: spec,
        presets: resolved.presets,
        ensureConversation: (chatId) => handle.bridge.ensureConversation(chatId),
        conversation: async (id) => handle.harness.conversation(toConversationId(id), BACKGROUND_CONTEXT),
        fallback: p.fallback,
      });
      handle.bridge.extend(ui.extension());
      handle.bridge.extend(hostExtension(p));
      bus.register(handle.id, createPeerRuntime({ botId: handle.id, harness: () => handle.harness, registry: () => handle.registry, switcher: p.switcher, modelRef: () => p.switcher.modelRef(), guardExtension: A7_EXTENSION_NAME, toolUse: p.toolUse, chains: chainStore, hints, gate, logger: botLogger(log, handle.id) }));
    },
  });

  /** Chain, hint and `/status` hooks of one bot's bridge. */
  function hostExtension(p: BotParts): BridgeExtension {
    const self = p.id;
    return {
      beforeSubmit: async ({ conversationId, injected }) => {
        // A user message starts a new chain (the only way a chain gets user authority). A message that arrives while the previous turn
        // of the conversation still runs keeps that chain, so a later message cannot clear the taint of work in progress.
        if (!injected && (activeTurns.get(`${self}|${conversationId}`) ?? 0) === 0) bus.beginUserTurn(self, conversationId);
        const end = hints.begin(self, { priority: injected ? P2 : P0, conversationId });
        const key = `${self}|${conversationId}`;
        activeTurns.set(key, (activeTurns.get(key) ?? 0) + 1);
        const done = (): void => {
          end();
          const n = (activeTurns.get(key) ?? 1) - 1;
          if (n <= 0) activeTurns.delete(key);
          else activeTurns.set(key, n);
        };
        const list = turnEnds.get(key) ?? [];
        list.push(done);
        turnEnds.set(key, list);
      },
      afterSubmit: ({ conversationId, submission, error }) => {
        const key = `${self}|${conversationId}`;
        const list = turnEnds.get(key);
        const done = list?.shift();
        if (list && list.length === 0) turnEnds.delete(key);
        if (!done) return;
        if (error !== undefined || !submission) return done();
        void submission.wait(BACKGROUND_CONTEXT).then(done, done);
      },
      statusLines: () => statusLines(self),
    };
  }

  const manager = new BotManager({
    bots: resolved.bots,
    tokenFor: tokenResolver(secrets),
    factory,
    killSwitch: a.killSwitch,
    logger: log,
    redact,
    ...(a.lock ? { lock: a.lock } : {}),
    preflight: (bot) => (bot.id === "main" && bot.layout === "bots" ? checkMainMigrated(dataDir) : undefined),
  });

  // ---- /status (S26.3) ---------------------------------------------------------------------------------------------------
  async function statusLines(id: string): Promise<string[]> {
    const p = parts.get(id);
    const spec = botsById.get(id);
    const lines: string[] = [];
    lines.push(`Bots: ${manager.status().map((s) => `${s.id} ${s.state}${s.reason ? ` (${s.reason})` : ""}`).join(", ")}`);
    if (spec) {
      const label = (pid: string): string => resolved.presets.find((x) => x.id === pid)?.label ?? pid;
      const active = p?.switcher.effective();
      lines.push(`Route: primary ${label(spec.route.primary)}, active ${active?.label ?? label(spec.route.primary)}, allowed ${spec.route.allowed.map(label).join(", ")}${spec.route.fallback.length > 0 ? `, fallback ${spec.route.fallback.map(label).join(", ")}` : ""}`);
    }
    for (const l of gateStatusLines(gate.status())) lines.push(`Local gate ${l}`);
    const topo = localTopology(resolved.bots, resolved.presets, resolved.gate.localBotsOnStrata);
    const byRunner = Object.entries(topo.byRunner).map(([r, ids]) => `${r} ${ids.length}`);
    if (byRunner.length > 0) lines.push(`Local bots by runner: ${byRunner.join(", ")} (Strata limit ${topo.limit}${topo.withinLimit ? "" : ", OVER"})`);
    if (acpPresets.length > 0) lines.push(...(await proxyLines()));
    if (bus.hasEdges(id)) {
      const edges = bus.edgeStatus().filter((e) => e.from === id || e.to === id);
      const today = edges.filter((e) => e.from === id).reduce((n, e) => n + e.today, 0);
      lines.push(`Bot links: ${bus.peersOf(id).map((x) => x.id).join(", ") || "none"}; asks today ${today}`);
      for (const e of edges.filter((x) => x.pausedUntil !== undefined)) lines.push(`Link ${e.from} to ${e.to} is PAUSED (too many asks)`);
    }
    lines.push(`Bot room: ${mirror ? "on" : "off"}${mirror ? ` (${mirror.stats().posts} posts, ${mirror.stats().droppedLines} dropped)` : ""}`);
    return lines;
  }

  async function proxyLines(): Promise<string[]> {
    const out: string[] = [];
    const first = acpPresets.find((p) => p.baseUrl !== undefined);
    try {
      const ep = proxyEndpoint(first?.baseUrl !== undefined ? { baseUrl: first.baseUrl } : { port: DEFAULT_PROXY_PORT });
      const h = await fetchHealth(ep, { ...(seams.proxyFetch ? { fetch: seams.proxyFetch } : {}), timeoutMs: 2000 });
      if (h.ok) {
        const ps = h.health.providers.map((x) => `${x.id} active ${x.active ?? "?"}, queued ${x.queued ?? "?"}`);
        out.push(`Proxy: up${ps.length > 0 ? ` (${ps.join("; ")})` : ""}`);
        for (const x of h.health.providers) {
          proxy.status.noteAuthMethod(x.id, x.authMethod);
          if (x.authMethod !== undefined) out.push(`${x.id} login: ${x.authMethod}`);
          else if (x.id === "claude") out.push("claude login: not reported (older proxy)");
        }
      } else out.push("Proxy: not reachable (the proxy is not running, or the main account is logged off)");
    } catch {
      out.push("Proxy: not checked");
    }
    if (unavailable && unavailable.size > 0) out.push(`Not listed by the proxy at start-up: ${[...unavailable].join(", ")}`);
    for (const [prov, s] of Object.entries(proxy.limiters.stats())) out.push(`Proxy limiter ${prov}: ${s.active} of ${s.limit} running, ${s.queued} queued`);
    for (const s of proxy.status.snapshot()) {
      if (s.needsLogin) out.push(`${s.providerId} needs a login on the main account`);
      if (s.refused) out.push(`${s.providerId}: needs attention, refused (the proxy login is an API key, not the subscription)`);
      if (s.needsKeyFix) out.push(`${s.providerId}: the proxy key in secrets.json was rejected`);
    }
    return out;
  }

  // ---- start ---------------------------------------------------------------------------------------------------------------
  const statuses = await manager.start();
  mirror = startBotRoomMirror({
    botRoom: resolved.botRoom,
    mirrorToken: secrets.mirrorBotToken,
    source: busAuditSource(bus),
    logger: log,
    redact,
    ...(seams.botRoomApi ? { api: seams.botRoomApi } : {}),
  });

  let stopped = false;
  return {
    manager,
    bus,
    gate,
    hints,
    proxy,
    provenance,
    mirror,
    resolved,
    statuses,
    part: (id) => parts.get(id),
    parts: () => [...parts.values()],
    statusLines,
    async stop() {
      if (stopped) return;
      stopped = true;
      mirror?.stop();
      provenance.stop();
      await manager.stop();
      for (const p of parts.values()) {
        await p.p2.close().catch(() => undefined);
        await p.p3.close().catch(() => undefined);
      }
      await sharedClient?.close().catch(() => undefined);
    },
  };
}

/** The presets of a Phase 1 to 3 install that has none in `security.json`: one per configured local runner. */
export function derivedPresets(config: Config): PresetConfig[] {
  return (["lmstudio", "strata"] as const).flatMap((r) => {
    const b = config.model.runners[r];
    return b
      ? [{ id: r, kind: "local" as const, runner: r, label: r === "lmstudio" ? "LM Studio" : "Strata", modelId: b.modelId, contextWindow: b.contextWindow, maxTokens: b.maxTokens, privacy: "local" as const, autoFallback: true }]
      : [];
  });
}
