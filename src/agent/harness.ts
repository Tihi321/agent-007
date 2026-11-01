/**
 * The startup sequence (S6.2, plan 4.1) as a function, so `src/main.ts` and the integration tests run the same code.
 *
 *   1. read and parse config (needed for `paths.runDir`), then take the single-instance lock
 *   2. load secrets (ACL check) and validate the config against them
 *   3. logger, audit, kill switch, runner health monitor; provider for `model.runner` (through the adapter)
 *   4. the Telegram bridge object (approval transport, notifier, chat lookup), Phase 2 (job runner client, job UI, MCP hub,
 *      Flow guard; `createPhase2`), the `a7` extension (one combined `beforeTool`: Flow guard, then the shell gate), the registry
 *   5. `Harness.open(...)`
 *   6. `harness.resume()`, then the job runner client starts connecting (a resumed Job task waits for it)
 *   7. `bridge.attach(harness)` then `bridge.start()`: delivers pending replies, then starts the long poll
 *   8. start the health monitor
 *
 * Phase 4: when `security.json` has a `bots` block (`parseBots(...).implicit` is false) steps 4 to 7 are `startMultiBot` (`multibot.ts`):
 * a `BotManager` with one Harness and one bridge per bot, the bus, the gate, the proxy brain and the room mirror. A one-bot install
 * (no `bots` block) runs the code below, unchanged.
 *
 * Shutdown (`handle.stop()`): stop the health monitor and the bot, `harness.close(ctx)`, close the job runner client and the MCP
 * clients, release the lock.
 * A `session_failed` report (a Storage error, spec section 12) calls `onFatal`; the entry point exits non-zero and the
 * scheduled task restarts the process (reopen, do not retry).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { AuditLog, Logger, LogLevel } from "../contracts.js";
import { createKillSwitch } from "../approval/killSwitch.js";
import type { KillSwitchHandle } from "../approval/killSwitch.js";
import { loadConfig, selectRunner } from "../config/load.js";
import type { RunnerSelection } from "../config/load.js";
import { defaultsFromEnv, parseConfig } from "../config/schema.js";
import type { Config, DefaultsEnv } from "../config/schema.js";
import { loadSecrets, secretValues } from "../config/secrets.js";
import type { Secrets } from "../config/secrets.js";
import { createAuditLog } from "../logging/audit.js";
import { createLogger } from "../logging/logger.js";
import { createRedactor, errorFields } from "../logging/redact.js";
import type { Redactor } from "../logging/redact.js";
import { BACKGROUND_CONTEXT, Harness, createModels, createRegistry, createRunnerProvider, openNodeSqliteStorage } from "../pi/adapter.js";
import type { HarnessSettings, Registry, ReportInfo } from "../pi/adapter.js";
import { budgetProblem, compactionSettings } from "../prompt/budget.js";
import { createHealthMonitor } from "../runtime/health.js";
import type { HealthMonitor } from "../runtime/health.js";
import { acquireLock } from "../runtime/lock.js";
import type { Lock } from "../runtime/lock.js";
import type { ShellRunner } from "../shell/runner.js";
import { createTelegramBridge } from "../telegram/bot.js";
import type { TelegramBridge, TelegramBridgeOptions } from "../telegram/bot.js";
import type { PsRunner } from "../tools/systemFacts.js";
import { A7_EXTENSION_NAME, createA7Extension } from "./extension.js";
import type { A7Extension } from "./extension.js";
import { createPhase2 } from "./phase2.js";
import type { Phase2Handle, Phase2Options } from "./phase2.js";
import { createPhase3 } from "./phase3.js";
import { derivedPresets, startMultiBot } from "./multibot.js";
import type { MultiBotHandle, MultiBotSeams } from "./multibot.js";
import { parseBots } from "../bots/schema.js";
import type { Phase3Handle, Phase3Options } from "./phase3.js";
import { assertSettingsAcl } from "../settings/acl.js";
import { composeRawConfig } from "../settings/load.js";
import type { LoadedSettings } from "../settings/load.js";
import { homedir } from "node:os";

export interface StartOptions {
  configPath: string;
  secretsPath: string;
  /** Run the `icacls` checks on the secrets file and the Strata config copy. Default true; false only for dev runs and tests. */
  checkAcl?: boolean;
  /** false = a dry run: build everything, but never attach or start the Telegram bridge (no network). Default true. */
  telegram?: boolean;
  /** Test seams: a Bot whose HTTP layer is fake, and its `getMe` result. */
  bot?: Bot;
  botInfo?: UserFromGetMe;
  bridge?: Partial<TelegramBridgeOptions>;
  env?: DefaultsEnv;
  logLevel?: LogLevel;
  healthIntervalMs?: number;
  /** Called on a fatal condition (`session_failed`). The entry point exits non-zero. */
  onFatal?: (error: unknown, info?: ReportInfo) => void;
  /** Test seams for the tools and the gate. */
  shellRunner?: ShellRunner;
  psRunner?: PsRunner;
  gatePollMs?: number;
  fetchImpl?: typeof fetch;
  /** Phase 2 seams (a fake job runner client, a template source, MCP hub overrides). */
  phase2?: Phase2Options;
  /** Phase 3 seams (the proposal card transport, the persona runtime, the ACL runner). */
  phase3?: Phase3Options;
  /** `/applysettings`: the host exits gracefully with this code (4). The entry point wires it to its shutdown. */
  onRestart?: (code: number) => void;
  /** Phase 4 test seams (a fake grammY Bot per bot, a fake proxy fetch, a fake room API). Used only by a multi-bot install. */
  multi?: MultiBotSeams;
}

export interface AgentHandle {
  readonly config: Config;
  readonly warnings: readonly string[];
  readonly runner: RunnerSelection;
  readonly logger: Logger;
  readonly audit: AuditLog;
  readonly redact: Redactor;
  readonly killSwitch: KillSwitchHandle;
  readonly health: HealthMonitor;
  readonly bridge: TelegramBridge;
  readonly harness: Harness;
  readonly registry: Registry;
  readonly a7: A7Extension;
  /** The Phase 2 parts: job runner client, job UI, MCP hub, jobs extension. */
  readonly phase2: Phase2Handle;
  /** The Phase 3 parts: settings audit, proposal engine, the five deferred tools, personas. */
  readonly phase3: Phase3Handle;
  /** Legacy or migrated mode, the settings folders, the `security.json` snapshot and revision (`/status`). */
  readonly settings: LoadedSettings;
  readonly lock: Lock;
  readonly storagePath: string;
  /**
   * Phase 4: set for a multi-bot install. `bridge`, `harness`, `registry`, `a7`, `phase2` and `phase3` above then are the `main` bot's, and reading
   * one while `main` is not running throws; every bot's own parts are in `multi`.
   */
  readonly multi?: MultiBotHandle;
  /** Idempotent. */
  stop(): Promise<void>;
}

function mkdirs(...dirs: string[]): void {
  for (const d of dirs) mkdirSync(d, { recursive: true });
}

/** The settings every conversation runs with (stream timeout, retry, sequential tools, 75% compaction threshold). */
export function harnessSettings(config: Config, provider: RunnerSelection["provider"]): HarnessSettings {
  return {
    stream: { timeoutMs: config.model.streamTimeoutMs },
    retry: { ...config.model.retry },
    toolExecution: "sequential",
    compaction: compactionSettings(provider),
  };
}

export async function startAgent(opts: StartOptions): Promise<AgentHandle> {
  // 1. config (parsed first: the lock path is `paths.runDir`), then the lock. Phase 3: `config.json` v2 plus `security.json`.
  const env = opts.env ?? defaultsFromEnv();
  const early = parseConfig(composeRawConfig(readFileSync(opts.configPath, "utf8"), { env }).raw, env);
  mkdirs(early.paths.runDir);
  const lock = acquireLock(join(early.paths.runDir, "agent.lock"));

  let health: HealthMonitor | undefined;
  let bridge: TelegramBridge | undefined;
  let harness: Harness | undefined;
  let phase2: Phase2Handle | undefined;
  let phase3: Phase3Handle | undefined;
  let bridgeStarted = false;
  let stopped = false;
  let logger: Logger | undefined;
  let multi: MultiBotHandle | undefined;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    health?.stop();
    try {
      if (bridge && bridgeStarted) await bridge.stop();
    } catch (e) {
      logger?.warn("shutdown.bridge_stop_failed", { error: String(e) });
    }
    try {
      if (harness) await harness.close(BACKGROUND_CONTEXT);
    } catch (e) {
      logger?.warn("shutdown.harness_close_failed", { error: String(e) });
    }
    try {
      await phase2?.close();
    } catch (e) {
      logger?.warn("shutdown.phase2_close_failed", { error: String(e) });
    }
    try {
      await phase3?.close();
    } catch (e) {
      logger?.warn("shutdown.phase3_close_failed", { error: String(e) });
    }
    try {
      await multi?.stop();
    } catch (e) {
      logger?.warn("shutdown.multibot_stop_failed", { error: String(e) });
    }
    lock.release();
  };

  try {
    // 2. secrets and validation
    const strataFile = early.model.runners.strata?.configFile;
    const loadedSecrets = loadSecrets({
      secretsPath: opts.secretsPath,
      runner: early.model.runner,
      ...(strataFile ? { strataConfigFile: strataFile } : {}),
      checkAcl: opts.checkAcl ?? true,
    });
    const secrets: Secrets = loadedSecrets.secrets;
    const { config, warnings: configWarnings, settings: loadedSettings } = loadConfig({ configPath: opts.configPath, secrets, env });
    // Phase 3 (S17.2): a migrated install refuses to start when the settings folders are writable by the agent user.
    if (loadedSettings.mode === "migrated" && (opts.checkAcl ?? true)) {
      assertSettingsAcl({ paths: loadedSettings.paths, agentUser: opts.phase3?.agentUser ?? process.env["USERNAME"] ?? homedir().split(/[\/]/).pop() ?? "agent007", ...(opts.phase3?.icacls ? { icacls: opts.phase3.icacls } : {}) });
    }
    const runner = selectRunner(config, secrets);
    const warnings = [...new Set([...loadedSecrets.warnings, ...configWarnings, ...runner.warnings])];

    // 3. logging, audit, kill switch, health
    mkdirs(config.paths.stateDir, config.paths.workspaceDir, config.paths.logsDir, config.paths.auditDir, config.paths.controlDir, dirname(config.paths.memoryFile));
    const redact = createRedactor(secretValues(secrets));
    const log = createLogger({ dir: config.paths.logsDir, redact, ...(opts.logLevel ? { level: opts.logLevel } : {}) });
    logger = log;
    const audit = createAuditLog({ dir: config.paths.auditDir, redact });
    log.info("agent.starting", { runner: runner.runner, modelId: runner.provider.modelId, authMode: runner.authMode, pid: process.pid });
    for (const w of warnings) log.warn("config.warning", { warning: w });
    const budget = budgetProblem(runner.provider);
    if (budget) log.warn("config.budget", { problem: budget });

    const killSwitch = createKillSwitch({ controlDir: config.paths.controlDir, shellEnabled: () => config.shell.enabled, logger: log, audit });
    health = createHealthMonitor({
      runner: runner.runner,
      baseUrl: runner.provider.baseUrl,
      modelId: runner.provider.modelId,
      apiKey: runner.provider.apiKey,
      logger: log,
      ...(opts.healthIntervalMs !== undefined ? { intervalMs: opts.healthIntervalMs } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });

    // Phase 4: a `bots` block means several bots in this process
    const botsDoc = parseBots(loadedSettings.security, {
      folderAllow: config.folders.allow,
      derivedPresets: derivedPresets(config),
      defaultPreset: ((loadedSettings.security?.["model"] ?? {}) as { defaultPreset?: string }).defaultPreset ?? config.model.runner,
    });
    if (!botsDoc.implicit) {
      const nothingToStart = opts.telegram === false;
      if (nothingToStart) log.warn("agent.dry_run", { note: "Telegram is not started (dry run): no bot of the multi-bot install was started" });
      else {
        multi = await startMultiBot({
          config,
          secrets,
          settings: loadedSettings,
          resolved: botsDoc,
          logger: log,
          redact,
          audit,
          killSwitch,
          health,
          runner,
          checkAcl: opts.checkAcl ?? true,
          seams: opts.multi,
          phase2: opts.phase2,
          phase3: opts.phase3,
          shellRunner: opts.shellRunner,
          psRunner: opts.psRunner,
          gatePollMs: opts.gatePollMs,
          fetchImpl: opts.fetchImpl,
          onRestart: opts.onRestart,
          onFatal: (id, error) => {
            log.error("agent.fatal", { bot: id, ...errorFields(error, redact) });
            try {
              opts.onFatal?.(error);
            } catch {
              /* the entry point decides how to exit */
            }
          },
          lock,
        });
      }
      const mb = multi;
      health.start();
      log.info("agent.started", { extension: A7_EXTENSION_NAME, bots: botsDoc.bots.map((b) => b.id), running: mb?.manager.running() ?? [] });
      const main = (): NonNullable<ReturnType<NonNullable<typeof mb>["part"]>> & { rt: NonNullable<NonNullable<ReturnType<NonNullable<typeof mb>["part"]>>["rt"]> } => {
        const p = mb?.part("main");
        if (!p?.rt) throw new Error("the main bot is not running");
        return p as never;
      };
      return {
        config,
        warnings,
        runner,
        logger: log,
        audit,
        redact,
        killSwitch,
        health,
        get bridge() {
          return main().rt.bridge;
        },
        get harness() {
          return main().rt.harness;
        },
        get registry() {
          return main().rt.registry;
        },
        get a7() {
          return main().a7;
        },
        get phase2() {
          return main().p2;
        },
        get phase3() {
          return main().p3;
        },
        settings: loadedSettings,
        lock,
        get storagePath() {
          return main().rt.storagePath;
        },
        ...(mb ? { multi: mb } : {}),
        stop,
      };
    }

    // 4. provider, bridge object, extension, registry
    const models = createModels();
    models.setProvider(createRunnerProvider(runner.provider));
    // A persona's model preset may be on the OTHER runner (UI-20c): its provider is registered too, when its block and credentials exist.
    for (const name of ["lmstudio", "strata"] as const) {
      const block = config.model.runners[name];
      const key = name === "lmstudio" ? secrets.lmStudioApiToken : secrets.strataApiKey;
      if (name === runner.runner || !block || (name === "lmstudio" && !key)) continue;
      models.setProvider(createRunnerProvider({ id: name, baseUrl: block.baseUrl, modelId: block.modelId, contextWindow: block.contextWindow, maxTokens: block.maxTokens, ...(key ? { apiKey: key } : {}), ...(block.compat ? { compat: block.compat } : {}) }));
    }
    const br = createTelegramBridge({
      ...(opts.bot ? { bot: opts.bot } : { token: secrets.telegramBotToken }),
      ...(opts.botInfo ? { botInfo: opts.botInfo } : {}),
      allowedUserIds: config.telegram.allowedUserIds,
      logger: log,
      redact,
      runner: { name: runner.runner, modelId: runner.provider.modelId },
      modelRef: { provider: runner.runner, modelId: runner.provider.modelId },
      health,
      killSwitch,
      killFlagPath: killSwitch.flagPath,
      shellEnabled: config.shell.enabled,
      ...(opts.bridge ?? {}),
    });
    bridge = br;
    const p2 = await createPhase2({ config, secrets, logger: log, redact, bridge: br, getHarness: () => harness, options: opts.phase2 });
    phase2 = p2;
    const p3 = await createPhase3({
      config,
      settings: loadedSettings,
      logger: log,
      redact,
      chats: br.chatLookup,
      getHarness: () => harness,
      templates: p2.templates,
      checkAcl: opts.checkAcl ?? true,
      bridge: br,
      baseModel: { provider: runner.runner, modelId: runner.provider.modelId },
      runnerUp: async (name) => {
        if (name === runner.runner) return health?.status().up ?? true;
        const block = config.model.runners[name as "lmstudio" | "strata"];
        const key = name === "lmstudio" ? secrets.lmStudioApiToken : secrets.strataApiKey;
        if (!block || (name === "lmstudio" && !key)) return false;
        try {
          const res = await (opts.fetchImpl ?? fetch)(`${block.baseUrl.replace(/\/$/, "")}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(3000) });
          return res.ok;
        } catch {
          return false;
        }
      },
      requestRestart: opts.onRestart,
      options: opts.phase3,
    });
    phase3 = p3;
    const a7 = createA7Extension({
      config,
      logger: log,
      redact,
      audit,
      killSwitch,
      telegram: br,
      health,
      modelId: runner.provider.modelId,
      extraBeforeTool: [...p3.beforeTool, ...p2.beforeTool],
      afterPreamble: p3.afterPreamble,
      ...(p3.memoryTarget ? { memoryTarget: p3.memoryTarget } : {}),
      ...(p3.memoryFor ? { memoryFor: p3.memoryFor } : {}),
      ...(opts.shellRunner ? { shellRunner: opts.shellRunner } : {}),
      ...(opts.psRunner ? { psRunner: opts.psRunner } : {}),
      ...(opts.gatePollMs !== undefined ? { gatePollMs: opts.gatePollMs } : {}),
    });
    const registry = createRegistry();
    registry.install(a7.extension);
    for (const e of p2.installs) registry.install(e);
    registry.install(p3.extension);
    p2.attachRegistry(registry);
    p3.attachRegistry(registry);

    // 5. open the Harness
    const storagePath = join(config.paths.stateDir, "agent.sqlite");
    const settings = harnessSettings(config, runner.provider);
    const storage = await openNodeSqliteStorage(storagePath);
    const fatal = (error: unknown, info?: ReportInfo): void => {
      log.error("agent.fatal", { reportType: info?.type, ...errorFields(error, redact) });
      try {
        opts.onFatal?.(error, info);
      } catch {
        /* the entry point decides how to exit */
      }
    };
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: () => settings,
        onReport: (error, info) => {
          if (info.type === "session_failed") return fatal(error, info);
          log.error("harness.report", { reportType: info.type, extension: (info as { extension?: string }).extension, ...errorFields(error, redact) });
        },
      },
      BACKGROUND_CONTEXT,
    );

    // 6. resume turns, tasks and approvals that a crash or restart left open
    harness.resume();
    p2.start();
    await p3.start();

    // 7. Telegram: load the chat map, deliver pending replies, start the long poll
    if (opts.telegram !== false) {
      await br.attach(harness);
      await br.start();
      bridgeStarted = true;
    } else {
      log.warn("agent.dry_run", { note: "Telegram is not started (dry run)" });
    }

    // 8. runner health monitor
    health.start();
    log.info("agent.started", { extension: A7_EXTENSION_NAME, storagePath });

    return {
      config,
      warnings,
      runner,
      logger: log,
      audit,
      redact,
      killSwitch,
      health,
      bridge: br,
      harness,
      registry,
      a7,
      phase2: p2,
      phase3: p3,
      settings: loadedSettings,
      lock,
      storagePath,
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}
