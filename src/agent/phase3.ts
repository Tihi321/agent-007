/**
 * Phase 3 wiring (S17.7, S18.4, S19): everything the settings split, the proposal flow and the personas add to the agent host,
 * built in one place so `startAgent` stays readable and tests can swap the seams.
 *
 *   - the append-only settings audit writer (`writer: "agent"`), `prefs.json` (untrusted, re-read on change)
 *   - the proposal engine (durable `SettingsProposals` doc) and the five DEFERRED tools in the `a7-settings` extension
 *   - the `style` prompt section (always on; the defaults reproduce Phase 1/2), placed after the preamble
 *   - out-of-band edit detection at start (I29b), the hourly settings ACL check (freezes proposals on a violation, I29c)
 *   - `/status` lines: `running rev X, file rev Y`
 *
 * No Phase 3 file edits `ALWAYS_LOADED`: the five tools are `deferred: true` and live in their own extension, so the host
 * registry still offers exactly the 10 always-loaded tools (I27, I27a).
 */
import { homedir } from "node:os";
import type { Logger, PeerProvenance } from "../contracts.js";
import type { Config } from "../config/schema.js";
import type { IcaclsRunner } from "../config/secrets.js";
import type { TemplateSource } from "../jobs/tools.js";
import type { Redactor } from "../logging/redact.js";
import { BACKGROUND_CONTEXT, section } from "../pi/adapter.js";
import type { TelegramBridge } from "../telegram/bot.js";
import { TelegramSettingsUi } from "../telegram/settingsUi.js";
import type { BeforeToolHandler, Extension, Harness, Registry } from "../pi/adapter.js";
import { checkSettingsAcl } from "../settings/acl.js";
import { DEFAULT_ROWS, getAt, parseSettingPath } from "../settings/allowlist.js";
import type { AllowRow } from "../settings/allowlist.js";
import { createSettingsAudit } from "../settings/audit.js";
import type { SettingsAuditWriter } from "../settings/audit.js";
import { PersonaApplier } from "../personas/apply.js";
import type { PresetModel } from "../personas/apply.js";
import { createPersonaGuard } from "../personas/guard.js";
import { createMemoryPromptView, createMemoryTargetResolver } from "../personas/memory.js";
import { createPersonaKind } from "../personas/propose.js";
import { PersonaResolver } from "../personas/resolver.js";
import { createPersonaSections } from "../personas/sections.js";
import { PersonaStore } from "../personas/store.js";
import { TelegramPersonaUi } from "../telegram/personaUi.js";
import { toConversationId } from "../telegram/conversations.js";
import { A7_EXTENSION_NAME } from "./extension.js";
import type { MemoryTarget } from "../tools/memory.js";
import { ceilingFor } from "../settings/ceiling.js";
import type { Ceiling, SecurityLike } from "../settings/ceiling.js";
import type { PersonaRuntime, ProposalTransport } from "../settings/contracts.js";
import { recordRevisions } from "../settings/drift.js";
import type { LoadedSettings } from "../settings/load.js";
import { PrefsStore } from "../settings/prefs.js";
import { DEFAULT_LIMITS, ProposalEngine, harnessProposalStore } from "../settings/proposals.js";
import type { ProposalLimits, ProposalStore } from "../settings/proposals.js";
import { DEFAULT_BUDGETS, DEFAULT_PROPOSALS } from "../settings/split.js";
import { fileRevision } from "../settings/store.js";
import { renderStyle } from "../settings/style.js";
import { createSettingsExtension, redactedSecurityView } from "../settings/tools.js";
import { validateSecurityDoc } from "../settings/schema.js";
import { readTextIfExists } from "../settings/store.js";

export interface Phase3Options {
  /** The card transport (Telegram in production, S18.4). Without one, a proposal that needs a card is refused. */
  transport?: ProposalTransport;
  /** A persona runtime instead of the real resolver (tests). Without it the S19 resolver, store, applier and guard are used. */
  runtime?: PersonaRuntime;
  store?: ProposalStore;
  agentUser?: string;
  icacls?: IcaclsRunner;
  aclIntervalMs?: number;
  reapIntervalMs?: number;
  templateRefreshMs?: number;
  now?: () => number;
  newId?: () => string;
  /**
   * Phase 4 (S26.1): ONE settings audit writer, ONE `prefs.json` store and one allowlist (the defaults plus a row per bot) for the whole
   * host, shared by every bot's engine, so the hash chain has one writer and a switch in one bot is seen by the others. Absent: this
   * handle makes its own (the one-bot install).
   */
  audit?: SettingsAuditWriter;
  prefs?: PrefsStore;
  rows?: readonly AllowRow[];
  /** Phase 4: only one bot writes the start-up audit lines (revisions, "running"). Default true. */
  recordStartup?: boolean;
  /**
   * Phase 4: the bot's brain is its OWN choice (`/model`, the route), so a persona whose model preset is just the global default (the
   * built-in `readonly` and every persona that has no preference of its own) keeps the bot's current model instead of switching it to
   * that default. A persona that names another preset still switches to it. Default false: the Phase 3 behaviour.
   */
  keepBotModel?: boolean;
  /** Phase 4 (S26.2): peer replies a conversation's turn received, quoted on a proposal card. */
  provenanceFor?: (conversationId: string) => readonly PeerProvenance[] | undefined;
}

export interface Phase3Deps {
  config: Config;
  settings: LoadedSettings;
  logger: Logger;
  redact: Redactor;
  chats: { chatForConversation(id: string): number | undefined };
  getHarness: () => Harness | undefined;
  templates: TemplateSource;
  /** Run the settings ACL checks (default true; dev runs and tests pass false). */
  checkAcl: boolean;
  /** The Telegram bridge: the card transport, `/settings`, `/proposals`, `/applysettings` and the `/status` lines are attached to it. */
  bridge?: TelegramBridge | undefined;
  /** The model every conversation starts with (the active runner); personas switch to their preset's model from here. */
  baseModel: { provider: string; modelId: string };
  /** Is the runner of a preset up? Used before a persona's model preset is switched to (UI-20c). Default: assume up. */
  runnerUp?: ((runner: string) => Promise<boolean>) | undefined;
  /** `/applysettings`: exit the agent gracefully with this code (4) so Task Scheduler restarts it. */
  requestRestart?: ((code: number) => void) | undefined;
  options?: Phase3Options | undefined;
}

type PromptSectionLike = ReturnType<typeof section>;

export interface Phase3Handle {
  readonly engine: ProposalEngine;
  readonly prefs: PrefsStore;
  readonly audit: SettingsAuditWriter;
  readonly runtime: PersonaRuntime;
  /** The real persona parts (absent when a test runtime was given). */
  readonly personas?: { store: PersonaStore; resolver: PersonaResolver; applier: PersonaApplier };
  /** For the `a7` extension: where `remember` writes, and what the memory section shows, per conversation. */
  readonly memoryTarget?: (conversationId: string) => MemoryTarget;
  readonly memoryFor?: (conversationId: string) => { sharedRead: boolean; scope?: string; scopeFile?: string };
  /** The `a7-settings` extension: the five deferred tools. */
  readonly extension: Extension;
  /** Sections placed right after `preamble` in the `a7` extension (S19 puts `persona` and `guardrails` before `style`). */
  readonly afterPreamble: PromptSectionLike[];
  /** Composed into the single combined `beforeTool` ahead of the Flow guard and the shell gate (the persona guard slot, S19). */
  readonly beforeTool: BeforeToolHandler[];
  ceiling(): Ceiling;
  frozen(): boolean;
  statusLines(): string[];
  attachRegistry(r: Registry): void;
  /** After the Harness is open: external-edit audit lines, proposal reaping, timers. */
  start(): Promise<void>;
  close(): Promise<void>;
}

/** The parts of the security settings the ceiling needs, from the snapshot or (legacy mode) from the Phase 1/2 config. */
export interface PresetInfo {
  id: string;
  label?: string;
  runner?: string;
  modelId?: string;
}

export function securityLikeOf(config: Config, security: Readonly<Record<string, unknown>> | undefined): Omit<SecurityLike, "presets"> & { presets: PresetInfo[] } {
  const presets =
    Array.isArray(security?.["presets"]) && (security?.["presets"] as unknown[]).length > 0
      ? (security?.["presets"] as { id: string; label?: string; runner?: string; modelId?: string }[])
      : (["lmstudio", "strata"] as const).flatMap((r) => {
          const b = config.model.runners[r];
          return b ? [{ id: r, label: r === "lmstudio" ? "LM Studio" : "Strata", runner: r, modelId: b.modelId }] : [];
        });
  const model = (security?.["model"] ?? {}) as { defaultPreset?: string };
  const budgets = (security?.["budgets"] ?? DEFAULT_BUDGETS) as { maxJobsPerDay?: number };
  return {
    shell: { enabled: config.shell.enabled },
    mcp: { servers: config.mcp.servers.map((s) => ({ id: s.id, allowTools: s.allowTools, macros: s.macros })) },
    presets,
    model: { runner: config.model.runner, defaultPreset: model.defaultPreset ?? config.model.runner },
    budgets,
  };
}

export function proposalLimitsOf(security: Readonly<Record<string, unknown>> | undefined): ProposalLimits {
  const p = (security?.["proposals"] ?? {}) as Partial<ProposalLimits>;
  return { ...DEFAULT_LIMITS, ...DEFAULT_PROPOSALS, ...p };
}

export async function createPhase3(deps: Phase3Deps): Promise<Phase3Handle> {
  const { config, settings, logger: log } = deps;
  const o = deps.options ?? {};
  const now = o.now ?? Date.now;

  const audit = o.audit ?? createSettingsAudit({ dir: settings.paths.auditDir, writer: "agent", redact: deps.redact });
  const prefs = o.prefs ?? new PrefsStore(settings.paths.prefsFile, { onWarning: (w) => log.warn("settings.prefs_invalid", { warning: w }) });

  let frozen = false;
  const sec = settings.security;
  const secLike = securityLikeOf(config, sec);
  let templateIds: string[] = [];
  const ceiling = (): Ceiling => ceilingFor(secLike, { templates: templateIds });
  const refreshTemplates = async (): Promise<void> => {
    try {
      templateIds = (await deps.templates.list()).map((t) => t.id);
    } catch {
      /* keep the last known list */
    }
  };

  // Personas (S19): the real resolver unless a test gave a runtime.
  const personaStore = new PersonaStore({ userDir: settings.paths.userPersonasDir, modelDir: settings.paths.modelPersonasDir });
  const resolver = new PersonaResolver({ store: personaStore, ceiling, chats: deps.chats, prefs, getHarness: deps.getHarness, logger: log, now });
  const runtime: PersonaRuntime = o.runtime ?? resolver;
  let registryRef: Registry | undefined;
  let applier: PersonaApplier | undefined;
  if (!o.runtime) {
    applier = new PersonaApplier({
      resolver,
      registry: () => registryRef,
      getConversation: async (id) => deps.getHarness()?.conversation(toConversationId(id), BACKGROUND_CONTEXT),
      baseModel: deps.baseModel,
      presetModel: (presetId): PresetModel | undefined => {
        if (o.keepBotModel === true && presetId === secLike.model?.defaultPreset) return undefined;
        const p = secLike.presets.find((x) => x.id === presetId);
        if (!p || !p.runner || !p.modelId) return undefined;
        const runner = p.runner;
        return { ref: { provider: runner, modelId: p.modelId }, up: () => (deps.runnerUp ? deps.runnerUp(runner) : Promise.resolve(true)) };
      },
      guardExtension: A7_EXTENSION_NAME,
      logger: log,
    });
  }
  let tgUi: TelegramSettingsUi | undefined;
  let transport: ProposalTransport | undefined = o.transport;
  if (!transport && deps.bridge) {
    const bridgeRef = deps.bridge;
    tgUi = new TelegramSettingsUi({
      api: bridgeRef.bot.api,
      allowedUserIds: config.telegram.allowedUserIds,
      logger: log,
      ...(o.provenanceFor
        ? {
            provenanceForChat: (chatId: number) => {
              const conv = bridgeRef.conversationOf(chatId);
              return conv === undefined ? undefined : o.provenanceFor?.(conv);
            },
          }
        : {}),
    });
    transport = tgUi;
  }
  const engine = new ProposalEngine({
    store: o.store ?? harnessProposalStore(deps.getHarness),
    audit,
    prefs,
    prefsFile: settings.paths.prefsFile,
    rows: o.rows ?? DEFAULT_ROWS,
    allowedUserIds: config.telegram.allowedUserIds,
    limits: () => proposalLimitsOf(sec),
    ...(transport ? { transport } : {}),
    now,
    ...(o.newId ? { newId: o.newId } : {}),
    logger: log,
    currentPersona: (cid) => runtime.current(cid),
    frozen: () => frozen,
    personaIds: () => runtime.list().filter((p) => p.valid).map((p) => p.id),
  });
  engine.registerSwitchKind(runtime);
  if (!o.runtime) engine.registerKind(createPersonaKind({ store: personaStore, ceiling, audit }));

  const securityView = (): Record<string, unknown> => redactedSecurityView(config, { presets: secLike.presets, budgets: secLike.budgets, proposals: proposalLimitsOf(sec) });
  const extension = createSettingsExtension({ engine, prefs, runtime, securityView, chats: deps.chats, audit, logger: log });
  const style = section("style", () => renderStyle(prefs.get().prefs));

  const statusLines = (): string[] => {
    if (settings.mode === "legacy") return ["Settings: legacy mode (run migrate-settings to split security.json and prefs.json)"];
    let file = "unreadable";
    try {
      file = fileRevision(settings.paths.securityFile).slice(0, 8);
    } catch {
      /* shown as unreadable */
    }
    const running = settings.securityRevision.slice(0, 8);
    const lines = [`Settings: running rev ${running}, file rev ${file}${file !== running ? " (restart required: /applysettings)" : ""}`];
    if (frozen) lines.push("Settings changes are FROZEN: the settings folder permissions are wrong (see the log).");
    return lines;
  };
  const validateSecurity = (): { ok: boolean; problems: string[] } | null => {
    if (settings.mode !== "migrated") return null;
    try {
      const text = readTextIfExists(settings.paths.securityFile);
      if (text === undefined) return { ok: false, problems: ["security.json is missing"] };
      const v = validateSecurityDoc(JSON.parse(text));
      return { ok: v.ok, problems: v.issues };
    } catch (e) {
      return { ok: false, problems: [`security.json cannot be read (${(e as Error).message.slice(0, 80)})`] };
    }
  };
  if (deps.bridge) {
    // /status lines for every transport; the Telegram UI adds its commands and callbacks.
    deps.bridge.extend({ statusLines: () => statusLines() });
    if (tgUi) {
      tgUi.bind({
        engine,
        valueOf: (path) => {
          const v = getAt(prefs.get().prefs, parseSettingPath(path));
          return v === undefined ? "(not set)" : String(v);
        },
        personaIds: () => runtime.list().filter((p) => p.valid).map((p) => p.id),
        statusLine: () => statusLines()[0] ?? "",
        validateSecurity,
        requestRestart: (code) => (deps.requestRestart ?? (() => undefined))(code),
        conversationOf: (chatId) => deps.bridge?.conversationOf(chatId),
        injectMessage: (conversationId, text, requestId) => (deps.bridge as NonNullable<typeof deps.bridge>).injectInput(conversationId, text, requestId),
      });
      deps.bridge.extend(tgUi.extension());
    }
    if (applier) {
      const ui = new TelegramPersonaUi({
        api: deps.bridge.bot.api,
        allowedUserIds: config.telegram.allowedUserIds,
        logger: log,
        resolver,
        applier,
        audit,
        store: personaStore,
        ceiling,
        ensureConversation: (chatId) => (deps.bridge as NonNullable<typeof deps.bridge>).ensureConversation(chatId),
      });
      deps.bridge.extend(ui.extension());
    }
  }

  const timers: NodeJS.Timeout[] = [];
  const unref = (t: NodeJS.Timeout): NodeJS.Timeout => {
    t.unref?.();
    return t;
  };
  const agentUser = o.agentUser ?? (process.env["USERNAME"] ?? homedir().split(/[\\/]/).pop() ?? "agent007");
  const aclOk = (): boolean => {
    if (!deps.checkAcl || settings.mode !== "migrated") return true;
    const problems = checkSettingsAcl({ paths: settings.paths, agentUser, ...(o.icacls ? { icacls: o.icacls } : {}) });
    if (problems.length > 0) {
      if (!frozen) log.error("settings.acl_violation", { problems });
      frozen = true;
      return false;
    }
    if (frozen) log.info("settings.acl_ok_again");
    frozen = false;
    return true;
  };

  return {
    engine,
    prefs,
    audit,
    runtime,
    extension,
    ...(applier ? { personas: { store: personaStore, resolver, applier } } : {}),
    ...(applier ? { memoryTarget: createMemoryTargetResolver(resolver, config.paths.memoryFile), memoryFor: createMemoryPromptView(resolver, config.paths.memoryFile) } : {}),
    afterPreamble: applier ? [...createPersonaSections(resolver), style] : [style],
    beforeTool: applier ? [createPersonaGuard({ resolver, logger: log })] : [],
    ceiling,
    frozen: () => frozen,
    statusLines,
    attachRegistry(r) {
      registryRef = r;
    },
    async start() {
      for (const n of settings.notes) log.warn("settings.note", { note: n });
      if (settings.mode === "migrated" && o.recordStartup !== false) {
        try {
          recordRevisions(audit, settings.paths.auditDir, [
            { file: "security.json", kind: "security", revision: settings.securityRevision },
            { file: "prefs.json", kind: "setting", revision: prefs.get().revision },
          ]);
        } catch (e) {
          log.warn("settings.drift_audit_failed", { error: String((e as Error).message) });
        }
        // The settings UI (another process, another user) cannot read the agent's memory: this line is how it learns which revision runs.
        try {
          audit.append({
            source: "system",
            kind: "security",
            target: { file: "security.json", path: "(running)" },
            diff: [],
            decision: "loaded",
            baseRevision: settings.securityRevision,
            afterRevision: settings.securityRevision,
          });
        } catch (e) {
          log.warn("settings.running_audit_failed", { error: String((e as Error).message) });
        }
      }
      await resolver.load().catch((e) => log.warn("personas.load_failed", { error: String((e as Error).message) }));
      if ((settings.mode === "migrated" || personaStore.files().length > 0) && o.recordStartup !== false) {
        try {
          recordRevisions(
            audit,
            settings.paths.auditDir,
            personaStore.files().filter((f) => f.revision !== "").map((f) => ({ file: f.source === "user" ? `personas/${f.id}.json` : `prefs/personas/${f.id}.json`, kind: "persona" as const, revision: f.revision })),
          );
        } catch (e) {
          log.warn("settings.drift_audit_failed", { error: String((e as Error).message) });
        }
      }
      await refreshTemplates();
      await engine.reap().catch((e) => log.warn("settings.reap_failed", { error: String((e as Error).message) }));
      timers.push(unref(setInterval(() => void engine.reap().catch(() => undefined), o.reapIntervalMs ?? 30_000)));
      timers.push(unref(setInterval(() => void refreshTemplates(), o.templateRefreshMs ?? 300_000)));
      if (deps.checkAcl && settings.mode === "migrated") timers.push(unref(setInterval(() => void aclOk(), o.aclIntervalMs ?? 3_600_000)));
    },
    async close() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
  };
}

