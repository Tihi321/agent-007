/**
 * Entry point (S6.2): `node dist/src/main.js [--config <path>] [--secrets <path>] [--no-telegram] [--skip-acl-check]`.
 *
 * Defaults: `%ProgramData%\agent-007\config\config.json` and `%ProgramData%\agent-007\secrets\secrets.json`
 * (`AGENT007_CONFIG` / `AGENT007_SECRETS` override the paths; the secret VALUES are never read from the environment).
 *
 * Exit codes: 0 clean shutdown, 1 fatal runtime error (the scheduled task restarts the process), 2 invalid
 * configuration or secrets, 3 another instance holds the lock.
 *
 * Shutdown: SIGINT, SIGTERM, SIGBREAK or SIGHUP (a console close) stop the bot, close the Harness and release the lock.
 * Windows has no real signals for a child process: `Stop-ScheduledTask` ends it hard and the durable resume covers
 * that. When a parent started this process with an IPC channel, a `{ "type": "shutdown" }` message does the same
 * graceful stop (used by the tests; the scheduled task has no IPC channel).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startAgent } from "./agent/harness.js";
import type { AgentHandle, StartOptions } from "./agent/harness.js";
import { missingConfigMessage } from "./config/load.js";
import { ConfigError } from "./config/schema.js";
import { SecretsError } from "./config/secrets.js";
import { SettingsAclError } from "./settings/acl.js";
import type { Redactor } from "./logging/redact.js";
import { EXIT_CODE_LOCK_HELD, LockHeldError } from "./runtime/lock.js";

export const EXIT_OK = 0;
export const EXIT_FATAL = 1;
export const EXIT_BAD_CONFIG = 2;
export { EXIT_CODE_LOCK_HELD };

export interface CliOptions {
  configPath: string;
  secretsPath: string;
  telegram: boolean;
  checkAcl: boolean;
}

export function parseCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const programData = env["ProgramData"] ?? env["PROGRAMDATA"] ?? "C:\\ProgramData";
  let configPath = env["AGENT007_CONFIG"] ?? `${programData}\\agent-007\\config\\config.json`;
  let secretsPath = env["AGENT007_SECRETS"] ?? `${programData}\\agent-007\\secrets\\secrets.json`;
  let telegram = true;
  let checkAcl = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (name: string): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value`);
      return next;
    };
    if (a === "--config") configPath = value("--config");
    else if (a === "--secrets") secretsPath = value("--secrets");
    else if (a === "--no-telegram") telegram = false;
    else if (a === "--skip-acl-check") checkAcl = false;
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  return { configPath, secretsPath, telegram, checkAcl };
}

/** What `runMain` needs from the process; a test passes a fake. */
export interface ProcessLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface MainIO {
  proc?: ProcessLike;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Test seam: extra start options (fake bot, fake runner, ...). */
  start?: Partial<StartOptions>;
  /** Called with the running agent, after startup. */
  onStarted?: (agent: AgentHandle) => void;
}

/** Redacts text written straight to stderr by the last-resort handlers (set once the secrets are known). */
let stderrRedact: Redactor = (t) => t;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const;

/** Runs the agent until it is told to stop. Resolves with the process exit code. */
export async function runMain(cli: CliOptions, io: MainIO = {}): Promise<number> {
  const out = io.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = io.err ?? ((l: string) => void process.stderr.write(`${l}\n`));
  const proc: ProcessLike = io.proc ?? process;

  const missing = missingConfigMessage(cli.configPath);
  if (missing) {
    err(`agent-007: ${missing}`);
    return EXIT_FATAL;
  }

  let agent: AgentHandle | undefined;
  let resolveDone: (code: number) => void = () => undefined;
  const done = new Promise<number>((r) => {
    resolveDone = r;
  });
  let shuttingDown = false;
  const shutdown = (code: number, why: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    out(`agent-007 stopping (${why})`);
    const finish = (): void => resolveDone(code);
    if (agent) void agent.stop().then(finish, finish);
    else finish();
  };

  const listeners: [string, () => void][] = [];
  for (const sig of SIGNALS) {
    const l = (): void => shutdown(EXIT_OK, sig);
    listeners.push([sig, l]);
    proc.on(sig, l);
  }
  const onMessage = (msg: unknown): void => {
    if (typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "shutdown") shutdown(EXIT_OK, "ipc shutdown");
  };
  listeners.push(["message", onMessage as () => void]);
  proc.on("message", onMessage);

  try {
    agent = await startAgent({
      configPath: cli.configPath,
      secretsPath: cli.secretsPath,
      checkAcl: cli.checkAcl,
      telegram: cli.telegram,
      onFatal: () => shutdown(EXIT_FATAL, "fatal error"),
      onRestart: (code) => shutdown(code, "restart requested (/applysettings)"),
      ...(io.start ?? {}),
    });
  } catch (e) {
    for (const [ev, l] of listeners) proc.off?.(ev, l);
    if (e instanceof LockHeldError) {
      err(`agent-007: ${e.message}`);
      return EXIT_CODE_LOCK_HELD;
    }
    if (e instanceof ConfigError || e instanceof SecretsError || e instanceof SettingsAclError) {
      err(`agent-007: ${e.message}`);
      return EXIT_BAD_CONFIG;
    }
    err(`agent-007: startup failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return EXIT_FATAL;
  }

  stderrRedact = agent.redact;
  // Phase 4: a multi-bot install says which bots run (a one-bot install prints the line it always did)
  const bots = agent.multi ? `, bots ${agent.multi.manager.running().join("+") || "none"}` : "";
  out(`agent-007 started (pid ${process.pid}, runner ${agent.runner.runner}, model ${agent.runner.provider.modelId}${bots}${cli.telegram ? "" : ", telegram off"})`);
  io.onStarted?.(agent);
  if (shuttingDown) await agent.stop(); // a stop arrived while starting
  const code = await done;
  for (const [ev, l] of listeners) proc.off?.(ev, l);
  out("agent-007 stopped");
  return code;
}

function isEntry(): boolean {
  const a = process.argv[1];
  return a !== undefined && resolve(a) === fileURLToPath(import.meta.url);
}

if (isEntry()) {
  let cli: CliOptions;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`agent-007: ${(e as Error).message}\n`);
    process.exit(EXIT_BAD_CONFIG);
  }
  process.on("uncaughtException", (e) => {
    process.stderr.write(`${stderrRedact(`agent-007: uncaught exception: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)}\n`);
    process.exit(EXIT_FATAL);
  });
  process.on("unhandledRejection", (e) => {
    process.stderr.write(`${stderrRedact(`agent-007: unhandled rejection: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)}\n`);
    process.exit(EXIT_FATAL);
  });
  runMain(cli).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`${stderrRedact(`agent-007: ${String(e)}`)}\n`);
      process.exit(EXIT_FATAL);
    },
  );
}
