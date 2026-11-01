/**
 * The real bot runtime factory (S20.2): one bot = its own directory, SQLite file, Pi `Harness`, `Models` registry, registry of
 * extensions narrowed to its allowlist (S20.4), and one grammY `Bot` on its own token. `BotManager` calls it once per bot.
 *
 * What it does NOT do (Slice 26 wires it): the host extensions themselves (`extensionsFor` is a callback: the `a7` extension with
 * the guard, tool search, jobs, settings, built per bot from `configForBot`), the bus and router, the proxy provider (`extraProviders`),
 * the gate and the mirror. Several `Harness.open` instances in one process are not shown upstream (U50); the tests here run two
 * real Harnesses on two real SQLite files over a fake OpenAI-compatible server and fake Telegram APIs.
 */
import { mkdirSync } from "node:fs";
import type { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { KillSwitch, Logger } from "../contracts.js";
import { botTokenFor } from "../config/secrets.js";
import type { Secrets } from "../config/secrets.js";
import type { Config } from "../config/schema.js";
import type { Redactor } from "../logging/redact.js";
import { errorFields } from "../logging/redact.js";
import { BACKGROUND_CONTEXT, Harness, createBotModels, openNodeSqliteStorage } from "../pi/adapter.js";
import type { Extension, HarnessSettings, Models, OpenAICompatModelInput, OpenAICompatProviderInput, Registry, ReportInfo } from "../pi/adapter.js";
import { compactionOverride } from "../prompt/budget.js";
import { createTelegramBridge } from "../telegram/bot.js";
import type { TelegramBridge, TelegramBridgeOptions } from "../telegram/bot.js";
import { configForBot } from "./config.js";
import type { BotFactory, BotLifecycle, BotRuntimeContext } from "./manager.js";
import { botDirs, botPaths } from "./paths.js";
import type { BotPaths } from "./paths.js";
import { buildBotRegistry } from "./registry.js";
import type { PresetConfig, ResolvedBot } from "./schema.js";

/** The provider id a preset is registered under in a bot's `Models`: the runner name, or `acp-<provider>` for the proxy. */
export function providerIdOf(p: PresetConfig): string {
  return p.kind === "local" ? (p.runner ?? "local") : `acp-${p.providerId ?? "proxy"}`;
}

export interface ModelKeys {
  lmStudioApiToken?: string | undefined;
  strataApiKey?: string | undefined;
  proxyApiKey?: string | undefined;
}

/** The route's presets of one bot, in order, without duplicates. */
export function routePresets(spec: Pick<ResolvedBot, "route">, presets: readonly PresetConfig[]): PresetConfig[] {
  const ids = [spec.route.primary, ...spec.route.allowed, ...spec.route.fallback];
  const out: PresetConfig[] = [];
  for (const id of ids) {
    const p = presets.find((x) => x.id === id);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The provider inputs for a bot's route: local presets by runner (the runner block gives the URL and compat flags, the preset gives
 * the model, window and output limit), and `acp` presets by proxy provider with the proxy key (when present). One registry per bot.
 */
export function providersForBot(spec: Pick<ResolvedBot, "route">, presets: readonly PresetConfig[], config: Config, keys: ModelKeys): OpenAICompatProviderInput[] {
  interface Draft {
    id: string;
    baseUrl: string;
    apiKey?: string;
    models: OpenAICompatModelInput[];
  }
  const byProvider = new Map<string, Draft>();
  for (const p of routePresets(spec, presets)) {
    const id = providerIdOf(p);
    const block = p.kind === "local" && (p.runner === "lmstudio" || p.runner === "strata") ? config.model.runners[p.runner] : undefined;
    let draft = byProvider.get(id);
    if (!draft) {
      if (p.kind === "local") {
        if (!block) continue; // a runner with no block cannot serve; the route skips it
        const key = p.runner === "lmstudio" ? keys.lmStudioApiToken : keys.strataApiKey;
        draft = { id, baseUrl: block.baseUrl, ...(key ? { apiKey: key } : {}), models: [] };
      } else {
        if (!p.baseUrl) continue;
        draft = { id, baseUrl: p.baseUrl, ...(keys.proxyApiKey ? { apiKey: keys.proxyApiKey } : {}), models: [] };
      }
      byProvider.set(id, draft);
    }
    if (!draft.models.some((m) => m.modelId === p.modelId)) {
      draft.models.push({ modelId: p.modelId, name: p.label, contextWindow: p.contextWindow, maxTokens: p.maxTokens, ...(block?.compat ? { compat: block.compat } : {}) });
    }
  }
  return [...byProvider.values()].filter((d) => d.models.length > 0);
}

export interface BotExtensionContext {
  spec: ResolvedBot;
  /** `configForBot(host, spec)`: the bot's folders, read roots and shell switch. */
  config: Config;
  paths: BotPaths;
  bridge: TelegramBridge;
  killSwitch: KillSwitch;
  logger: Logger;
}

export interface BotRuntimeHandle extends BotLifecycle {
  readonly id: string;
  readonly harness: Harness;
  readonly bridge: TelegramBridge;
  readonly registry: Registry;
  readonly models: Models;
  readonly paths: BotPaths;
  readonly storagePath: string;
}

export interface HarnessBotDeps {
  /** The host `Config` (every bot's config is derived from it). */
  config: Config;
  presets: readonly PresetConfig[];
  secrets: Pick<Secrets, "lmStudioApiToken" | "strataApiKey" | "proxyApiKey">;
  allowedUserIds: readonly number[];
  redact?: Redactor;
  /** The kill-switch flag file named in `/killshell` replies. */
  killFlagPath: string;
  /** The extensions of one bot, built AFTER its bridge exists (the approval transport lives in it). Narrowed by the allowlist here. */
  extensionsFor(ctx: BotExtensionContext): Extension[] | Promise<Extension[]>;
  /** Extra providers (S23: the proxy through the generic factory); merged with the route's own. */
  extraProviders?: (spec: ResolvedBot) => OpenAICompatProviderInput[];
  /** Wraps the bot's `Models` (S25: the local-inference gate and S23's limiter sit in front of the provider call). Default: unchanged. */
  decorateModels?: (models: Models, spec: ResolvedBot) => Models;
  /** Test seams: a fake-API Bot, its `getMe`, and any bridge options (edit interval, retry policy). */
  bridgeFor?: (ctx: BotRuntimeContext) => { bot?: Bot; botInfo?: UserFromGetMe; options?: Partial<TelegramBridgeOptions> };
  /** Called after `harness.resume()` and before the bridge starts (S26: job client, bus registration). */
  afterOpen?: (rt: BotRuntimeHandle) => Promise<void> | void;
  /** Called for `session_failed` (a storage error): the host exits and the task restarts it. */
  onFatal?: (id: string, error: unknown, info?: ReportInfo) => void;
  /** Stream timeout and retry come from the host config. */
  streamTimeoutMs?: number;
}

/** The factory `BotManager` uses: builds one bot's directory, Harness, registry and bridge. Nothing starts until `start()`. */
export function createHarnessBotFactory(deps: HarnessBotDeps): BotFactory {
  return async (ctx) => {
    const spec = ctx.spec;
    const paths = botPaths(deps.config.paths.dataDir, spec.id, spec.layout);
    for (const d of botDirs(paths)) mkdirSync(d, { recursive: true });
    const botConfig = configForBot(deps.config, spec, deps.presets);
    const log = ctx.logger;
    const redact = deps.redact ?? ((s: string) => s);

    const providers = [...providersForBot(spec, deps.presets, deps.config, { ...deps.secrets }), ...(deps.extraProviders?.(spec) ?? [])];
    if (providers.length === 0) throw new Error(`bot ${spec.id}: the route has no preset that can be served (no runner block or proxy URL)`);
    const models = deps.decorateModels ? deps.decorateModels(createBotModels(providers), spec) : createBotModels(providers);
    const primary = deps.presets.find((p) => p.id === spec.route.primary);
    const modelRef = { provider: primary ? providerIdOf(primary) : (providers[0] as OpenAICompatProviderInput).id, modelId: primary?.modelId ?? ((providers[0] as OpenAICompatProviderInput).models[0] as { modelId: string }).modelId };

    const seam = deps.bridgeFor?.(ctx);
    const bridge = createTelegramBridge({
      ...(seam?.bot ? { bot: seam.bot } : { token: ctx.token }),
      ...(seam?.botInfo ? { botInfo: seam.botInfo } : {}),
      allowedUserIds: deps.allowedUserIds,
      logger: log,
      redact,
      runner: { name: botConfig.model.runner, modelId: modelRef.modelId },
      modelRef,
      killSwitch: ctx.killSwitch,
      killFlagPath: deps.killFlagPath,
      shellEnabled: botConfig.shell.enabled,
      onPollingFailed: ctx.reportFailure,
      ...(seam?.options ?? {}),
    });

    const extensions = await deps.extensionsFor({ spec, config: botConfig, paths, bridge, killSwitch: ctx.killSwitch, logger: log });
    const registry = buildBotRegistry(extensions, spec);

    const settings: HarnessSettings = {
      stream: { timeoutMs: deps.streamTimeoutMs ?? deps.config.model.streamTimeoutMs },
      retry: { ...deps.config.model.retry },
      toolExecution: "sequential",
      compaction: {
        modelOverrides: Object.fromEntries(
          routePresets(spec, deps.presets)
            .filter((p) => p.maxTokens < p.contextWindow)
            .map((p) => [`${providerIdOf(p)}/${p.modelId}`, compactionOverride(p.contextWindow)]),
        ),
      },
    };
    const storage = await openNodeSqliteStorage(paths.storageFile);
    let harness: Harness;
    try {
      harness = await Harness.open(
        storage,
        {
          models,
          registry,
          settings: () => settings,
          onReport: (error, info) => {
            if (info.type === "session_failed") {
              log.error("bot.fatal", { reportType: info.type, ...errorFields(error, redact) });
              deps.onFatal?.(spec.id, error, info);
              return;
            }
            log.error("harness.report", { reportType: info.type, ...errorFields(error, redact) });
          },
        },
        BACKGROUND_CONTEXT,
      );
    } catch (e) {
      await bridge.stop().catch(() => undefined);
      throw e;
    }

    let stopped = false;
    const handle: BotRuntimeHandle = {
      id: spec.id,
      harness,
      bridge,
      registry,
      models,
      paths,
      storagePath: paths.storageFile,
      async start() {
        harness.resume(); // this bot's own turns, tasks and approvals that a crash left open
        await deps.afterOpen?.(handle);
        await bridge.attach(harness);
        await bridge.start();
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          await bridge.stop();
        } catch (e) {
          log.warn("bot.bridge_stop_failed", errorFields(e, redact));
        }
        try {
          await harness.close(BACKGROUND_CONTEXT);
        } catch (e) {
          log.warn("bot.harness_close_failed", errorFields(e, redact));
        }
      },
    };
    return handle;
  };
}

/** `BotManager.tokenFor` over the secrets: the token a bot's `telegramTokenRef` names. */
export function tokenResolver(secrets: Pick<Secrets, "telegramBotToken" | "botTokens">): (ref: string) => string | undefined {
  return (ref) => botTokenFor(secrets, ref);
}
