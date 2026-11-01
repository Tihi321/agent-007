/**
 * The job runner entry point (S11.1): `node dist/src/jobrunner/main.js [--config <jobrunner.json>]`, run by the scheduled
 * task `\agent-007\jobrunner` as the MAIN user at logon (I17, UI-13).
 *
 * Start order: single-instance lock (data folder) -> logger -> redactor -> audit, journal -> templates -> hub -> drivers ->
 * manager.recover() (running jobs become `interrupted`, queued jobs go back in line) -> the IPC server on 127.0.0.1.
 *
 * Config: `C:\ProgramData\agent-007\jobrunner\jobrunner.json` (limits, cwd allowlist, IPC port, engines; the agent user cannot
 * read it). Secrets: `<dataDir>\secrets.json` = `{ipcHmacKey, deepseekApiKey?}` (main user only). The data folder is
 * `%LOCALAPPDATA%\agent-007-jobrunner`: `run\jobrunner.lock`, `logs\`, `audit\`, `journal\`.
 *
 * Drivers: the `hub` driver is built in. S12 (claude) and S13 (dsh) are found by convention, or passed in by a caller:
 * `src/jobrunner/drivers/<engine>/index.js` exporting `createDriver(ctx: DriverFactoryContext): EngineDriver`. An engine
 * with no driver reports `enabled: false` and its templates are refused with `engine_disabled`.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Logger } from "../contracts.js";
import { IpcKey, IPC_KEY_TEXT_PATTERN } from "../ipc/hmac.js";
import type { IpcServer } from "../ipc/server.js";
import type { EngineDriver, JobEngine } from "../jobs/contracts.js";
import { createLogger } from "../logging/logger.js";
import { createRedactor, errorFields } from "../logging/redact.js";
import type { Redactor } from "../logging/redact.js";
import { EXIT_CODE_LOCK_HELD, LockHeldError, acquireLock } from "../runtime/lock.js";
import type { Lock } from "../runtime/lock.js";
import { createJobAuditLog } from "./audit.js";
import { HubRunner, createHubEngineDriver } from "./hub.js";
import type { HubDeps } from "./hub.js";
import { Journal } from "./journal.js";
import { DEFAULT_PROGRAM_DATA_JOBRUNNER, parseJobRunnerConfig } from "./limits.js";
import type { JobRunnerConfig } from "./limits.js";
import type { PermissionBroker } from "./drivers/claude/permissionBroker.js";
import { JobKeyRegistry, JobManager } from "./manager.js";
import { createSettingsAudit } from "../settings/audit.js";
import { LoginStore, linkFor } from "./settingsUi/auth.js";
import { denyPathSource } from "./settingsUi/denyPaths.js";
import { shippedForms } from "./settingsUi/forms/registry.js";
import type { FormRegistry } from "./settingsUi/forms/registry.js";
import { createRoutes } from "./settingsUi/routes.js";
import type { RoutesDeps } from "./settingsUi/routes.js";
import { startSettingsUi } from "./settingsUi/server.js";
import type { RunningSettingsUi } from "./settingsUi/server.js";
import type { JobManagerOptions } from "./manager.js";
import { startJobRunnerServer } from "./server.js";
import { loadTemplates } from "./templates.js";

export class JobRunnerSecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobRunnerSecretsError";
  }
}

export interface JobRunnerSecrets {
  ipcKey: IpcKey;
  /** For S13 only (DEEPSEEK_API_KEY goes into the child's env and nowhere else). Never log it. */
  deepseekApiKey?: string;
  /** Every secret value, for the redactor. */
  redactValues: string[];
}

/** Parses the job runner's secrets file text. Error messages never echo content. */
export function parseJobRunnerSecrets(text: string): JobRunnerSecrets {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new JobRunnerSecretsError("the job runner's secrets file is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new JobRunnerSecretsError("the job runner's secrets file must be a JSON object");
  const o = raw as Record<string, unknown>;
  const ipc = o["ipcHmacKey"];
  if (typeof ipc !== "string" || !IPC_KEY_TEXT_PATTERN.test(ipc)) throw new JobRunnerSecretsError("secrets: ipcHmacKey is missing or is not a base64url key of at least 32 bytes");
  const out: JobRunnerSecrets = { ipcKey: IpcKey.fromBase64Url(ipc), redactValues: [ipc] };
  const ds = o["deepseekApiKey"];
  if (ds !== undefined && ds !== "") {
    if (typeof ds !== "string") throw new JobRunnerSecretsError("secrets: deepseekApiKey must be a string");
    out.deepseekApiKey = ds;
    out.redactValues.push(ds);
  }
  return out;
}

export function loadJobRunnerSecrets(path: string): JobRunnerSecrets {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new JobRunnerSecretsError(`the job runner's secrets file cannot be read: ${path}`);
  }
  return parseJobRunnerSecrets(text);
}

export function loadJobRunnerConfig(path: string): JobRunnerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`jobrunner.json cannot be read or is not valid JSON: ${path} (${(e as NodeJS.ErrnoException).code ?? "parse error"})`);
  }
  return parseJobRunnerConfig(raw);
}

export interface DriverFactoryContext {
  engine: JobEngine;
  config: JobRunnerConfig;
  dataDir: string;
  logger: Logger;
  redact: Redactor;
  secrets: { deepseekApiKey?: string };
  /** A driver that keeps its own per-job permission tokens (Claude) hands its broker here so the IPC server accepts them (S15). */
  registerPermissionBroker?: (broker: Pick<PermissionBroker, "keys" | "handle" | "isActive">) => void;
  /** The deny paths read at each job start (S18.3): the job runner's own list plus `security.json` `folders.deny`. */
  denyPaths?: () => readonly string[];
}

export interface StartJobRunnerOptions {
  config: JobRunnerConfig;
  secrets: JobRunnerSecrets;
  /**
   * Drivers to use: an object, or a function that gets the same context a convention-loaded driver gets (so a test can build a
   * Claude driver around a fake `claude`). When absent, `claude` and `dsh` are looked up by the convention above. The `hub`
   * driver is added.
   */
  drivers?:
    | Partial<Record<JobEngine, EngineDriver>>
    | ((ctx: Omit<DriverFactoryContext, "engine">) => Partial<Record<JobEngine, EngineDriver>> | Promise<Partial<Record<JobEngine, EngineDriver>>>);
  logger?: Logger;
  hubDeps?: HubDeps;
  /** The path jobrunner.json was read from (the UI's "jobs" form writes the limits back to it). */
  configFile?: string;
  /** The settings UI (S18): test seams and extra forms. Only used when config.settingsUi.enabled. */
  settingsUi?: { assetsDir?: string; forms?: FormRegistry; folderGrant?: RoutesDeps["folderGrant"]; fsProbe?: RoutesDeps["fsProbe"]; port?: number; routeOverrides?: Partial<RoutesDeps> };
  /** Test seams for the manager (cwd check, tree kill, clock). */
  managerOverrides?: Partial<Pick<JobManagerOptions, "checkCwd" | "killTree" | "isAlive" | "now" | "retentionDays" | "runnerVersion">>;
}

export interface RunningJobRunner {
  port: number;
  /** The settings UI listener, when settingsUi.enabled. */
  settingsUi?: RunningSettingsUi;
  manager: JobManager;
  server: IpcServer;
  logger: Logger;
  lockPath: string;
  stop(): Promise<void>;
}

async function loadConventionDrivers(ctx: Omit<DriverFactoryContext, "engine">): Promise<Partial<Record<JobEngine, EngineDriver>>> {
  const out: Partial<Record<JobEngine, EngineDriver>> = {};
  for (const engine of ["claude", "dsh"] as const) {
    if (!ctx.config.engines[engine].enabled) continue;
    try {
      const url = new URL(`./drivers/${engine}/index.js`, import.meta.url).href;
      const mod = (await import(url)) as { createDriver?: (c: DriverFactoryContext) => EngineDriver | Promise<EngineDriver> };
      if (typeof mod.createDriver !== "function") {
        ctx.logger.warn("jobrunner.driver_invalid", { engine });
        continue;
      }
      out[engine] = await mod.createDriver({ ...ctx, engine });
      ctx.logger.info("jobrunner.driver_loaded", { engine });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ERR_MODULE_NOT_FOUND") ctx.logger.info("jobrunner.driver_absent", { engine });
      else ctx.logger.error("jobrunner.driver_failed", { engine, ...errorFields(e, ctx.redact) });
    }
  }
  return out;
}

export async function startJobRunner(opts: StartJobRunnerOptions): Promise<RunningJobRunner> {
  const { config, secrets } = opts;
  const dataDir = config.paths.dataDir;
  mkdirSync(dataDir, { recursive: true });
  // 1. single instance: a second one throws LockHeldError before it opens anything else
  const lockPath = join(dataDir, "run", "jobrunner.lock");
  const lock: Lock = acquireLock(lockPath);
  try {
    const redact = createRedactor(secrets.redactValues);
    const logger = opts.logger ?? createLogger({ dir: join(dataDir, "logs"), redact });
    const audit = createJobAuditLog({ dir: join(dataDir, "audit"), redact });
    const journal = new Journal({ dir: join(dataDir, "journal"), redact });
    const hub = new HubRunner(config.hub, { logger, ...(opts.hubDeps ?? {}) });
    const loadRegistry = () => loadTemplates(config.paths.templatesDir, { flowServerId: config.flow.serverId, hubServices: hub.services() });
    let registry = loadRegistry();
    for (const e of registry.errors) logger.warn("jobrunner.template_rejected", { file: e.file, errors: e.errors });
    logger.info("jobrunner.templates_loaded", { count: registry.size, rejected: registry.errors.length });

    // S18.3: the deny paths are the job runner's own list plus security.json folders.deny, read at each job start.
    const securityFile = join(config.paths.settingsDir, "security.json");
    const denyPaths = denyPathSource({ ownDeny: config.denyPaths, securityFile });
    const brokers: Pick<PermissionBroker, "keys" | "handle" | "isActive">[] = [];
    const driverCtx: Omit<DriverFactoryContext, "engine"> = {
      config,
      dataDir,
      logger,
      redact,
      secrets: secrets.deepseekApiKey !== undefined ? { deepseekApiKey: secrets.deepseekApiKey } : {},
      registerPermissionBroker: (b) => void brokers.push(b),
      denyPaths,
    };
    const drivers: Partial<Record<JobEngine, EngineDriver>> = {
      ...(typeof opts.drivers === "function" ? await opts.drivers(driverCtx) : (opts.drivers ?? (await loadConventionDrivers(driverCtx)))),
    };
    if (drivers.hub === undefined) drivers.hub = createHubEngineDriver(hub);

    const jobKeys = new JobKeyRegistry();
    let boundPort = config.ipcPort;
    const manager = new JobManager({
      config,
      templates: () => registry,
      denyPaths,
      journal,
      audit,
      hub,
      drivers,
      logger,
      redact,
      jobKeys,
      channelPort: () => boundPort,
      ...(opts.managerOverrides ?? {}),
    });
    manager.recover();

    const { server, port } = await startJobRunnerServer({ port: config.ipcPort, key: secrets.ipcKey, manager, jobKeys, permissionBrokers: brokers, logger });
    boundPort = port;
    logger.info("jobrunner.started", { port, pid: process.pid, keyFingerprint: secrets.ipcKey.fingerprint });

    // S18.1: the settings UI, a separate loopback listener (off unless settingsUi.enabled).
    let ui: RunningSettingsUi | undefined;
    if (config.settingsUi.enabled) {
      try {
        const settingsAudit = createSettingsAudit({ dir: join(config.paths.settingsDir, "audit"), writer: "jobrunner", redact });
        const routes = createRoutes({
          paths: {
            securityFile,
            settingsDir: config.paths.settingsDir,
            personasDir: join(config.paths.settingsDir, "personas"),
            auditDir: join(config.paths.settingsDir, "audit"),
            templatesDir: config.paths.templatesDir,
            jobrunnerFile: opts.configFile,
          },
          audit: settingsAudit,
          forms: opts.settingsUi?.forms ?? shippedForms(),
          flowServerId: config.flow.serverId,
          hubServices: () => hub.services(),
          agentUser: config.settingsUi.agentUser,
          reloadTemplates: () => {
            registry = loadRegistry();
            logger.info("jobrunner.templates_reloaded", { count: registry.size, rejected: registry.errors.length });
          },
          ...(opts.settingsUi?.folderGrant ? { folderGrant: opts.settingsUi.folderGrant } : {}),
          ...(opts.settingsUi?.fsProbe ? { fsProbe: opts.settingsUi.fsProbe } : {}),
          ...(opts.settingsUi?.routeOverrides ?? {}),
        });
        ui = await startSettingsUi({
          host: config.settingsUi.host,
          port: opts.settingsUi?.port ?? config.settingsUi.port,
          ipcPort: config.ipcPort,
          sessionIdleMin: config.settingsUi.sessionIdleMin,
          sessionMaxHours: config.settingsUi.sessionMaxHours,
          routes,
          loginStore: new LoginStore(join(dataDir, "settings-login.json")),
          logger,
          ...(opts.settingsUi?.assetsDir ? { assetsDir: opts.settingsUi.assetsDir } : {}),
        });
      } catch (e) {
        // The UI is optional: a failure to start it (port taken, assets missing) never stops the job runner.
        logger.error("jobrunner.settings_ui_failed", errorFields(e, redact));
      }
    }
    let stopped = false;
    return {
      port,
      ...(ui ? { settingsUi: ui } : {}),
      manager,
      server,
      logger,
      lockPath,
      async stop() {
        if (stopped) return;
        stopped = true;
        await ui?.close().catch(() => undefined);
        await server.close();
        await manager.shutdown();
        lock.release();
        logger.info("jobrunner.stopped");
      },
    };
  } catch (e) {
    lock.release();
    throw e;
  }
}

// ---- the process entry point ------------------------------------------------------------------------------------

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * settings-link (S18.1, I25b): run by the MAIN user in their own terminal. Prints a one-time sign-in link for the settings UI
 * (http://127.0.0.1:<port>/#code=<code>; the code is single-use, expires in 5 minutes and is stored only as a hash in the job
 * runner's own data folder). --revoke ends every code and every session.
 */
export function runSettingsLink(argv: readonly string[], out: (line: string) => void = (l) => void process.stdout.write(l + "\n")): number {
  const configPath = resolve(argValue(argv, "--config") ?? join(DEFAULT_PROGRAM_DATA_JOBRUNNER, "jobrunner.json"));
  let config: JobRunnerConfig;
  try {
    config = loadJobRunnerConfig(configPath);
  } catch (e) {
    out("settings-link: " + (e instanceof Error ? e.message : String(e)));
    return 1;
  }
  const store = new LoginStore(join(config.paths.dataDir, "settings-login.json"));
  if (argv.includes("--revoke")) {
    store.revoke();
    out("Every sign-in code and every settings UI session was ended.");
    return 0;
  }
  if (!config.settingsUi.enabled) out("Note: settingsUi.enabled is false in jobrunner.json, so the settings UI is not running. Set it to true and restart the job runner.");
  const { code, expiresAt } = store.issue();
  out(linkFor("127.0.0.1", config.settingsUi.port, code));
  out("Open it in your own browser within 5 minutes (until " + new Date(expiresAt).toLocaleTimeString() + "). It works once. Do not share it.");
  return 0;
}

export async function runMain(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "settings-link") return runSettingsLink(argv.slice(1));
  const configPath = resolve(argValue(argv, "--config") ?? join(DEFAULT_PROGRAM_DATA_JOBRUNNER, "jobrunner.json"));
  let runner: RunningJobRunner;
  try {
    const config = loadJobRunnerConfig(configPath);
    const secrets = loadJobRunnerSecrets(join(config.paths.dataDir, "secrets.json"));
    runner = await startJobRunner({ config, secrets, configFile: configPath });
  } catch (e) {
    if (e instanceof LockHeldError) {
      process.stderr.write(`${e.message}\n`);
      return EXIT_CODE_LOCK_HELD;
    }
    process.stderr.write(`job runner failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  await new Promise<void>((done) => {
    const stop = (): void => {
      void runner.stop().finally(done);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("SIGBREAK", stop);
  });
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href && dirname(fileURLToPath(import.meta.url)) !== "") {
  void runMain().then((code) => process.exit(code));
}
