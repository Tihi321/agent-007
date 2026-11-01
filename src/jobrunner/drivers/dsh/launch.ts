/**
 * Locating, launching and killing `dsh` (S13.1). Read-only lookup; the real binary is only run by the live probe and live jobs.
 *
 * Windows: `dsh.cmd` cannot be spawned directly (Node refuses `.cmd` without a shell since the 2024 fixes), so it is run as
 * `cmd.exe /d /s /c ""<path>" args"`. The path is validated (no quote, percent, caret, ampersand, pipe, angle bracket,
 * bang or control character) and the args are constants, so nothing a template or the model says reaches that command line.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { DshLaunch } from "./types.js";

const UNSAFE_PATH_CHARS = /["%^&|<>!\r\n\0`]/;
export const ACP_ARGS: readonly string[] = ["--profile", "acp"];

/** Variables the child may inherit. The job runner's own environment (other secrets) is not passed on. */
const ENV_ALLOW = [
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "HOME", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
  "LANG", "LC_ALL", "TERM", "NO_COLOR",
];

export const DEEPSEEK_KEY_ENV = "DEEPSEEK_API_KEY";

/** The child's environment: an allowlist of the parent's, then `extra`, then the key. The key goes nowhere else. */
export function buildChildEnv(base: NodeJS.ProcessEnv, apiKey: string | undefined, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const allow = new Set(ENV_ALLOW);
  for (const [k, v] of Object.entries(base)) if (v !== undefined && allow.has(k.toUpperCase())) out[k] = v;
  for (const [k, v] of Object.entries(extra)) if (k.toUpperCase() !== DEEPSEEK_KEY_ENV) out[k] = v;
  if (apiKey !== undefined && apiKey !== "") out[DEEPSEEK_KEY_ENV] = apiKey;
  return out;
}

export class DshNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DshNotFoundError";
  }
}

export interface ResolveOptions {
  /** `dsh.path` from `jobrunner.json`. Must be absolute and exist. */
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Test seam. Default: a regular file that can be read. */
  isFile?: (path: string) => boolean;
}

function defaultIsFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read-only: an explicit absolute path, else the first `dsh.cmd`, `dsh.exe`, `dsh.bat` (Windows) or `dsh` on PATH. */
export function resolveDshPath(opts: ResolveOptions = {}): string {
  const isFile = opts.isFile ?? defaultIsFile;
  if (opts.explicit !== undefined && opts.explicit !== "") {
    if (!isAbsolute(opts.explicit)) throw new DshNotFoundError(`dsh path must be absolute: ${opts.explicit}`);
    if (!isFile(opts.explicit)) throw new DshNotFoundError(`dsh not found at ${opts.explicit}`);
    return opts.explicit;
  }
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const names = platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh.bat"] : ["dsh"];
  const pathVar = env["PATH"] ?? env["Path"] ?? "";
  for (const dir of pathVar.split(platform === "win32" ? ";" : delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    for (const n of names) {
      const p = join(dir, n);
      if (isFile(p)) return p;
    }
  }
  throw new DshNotFoundError("dsh was not found on PATH (set dsh.path in jobrunner.json)");
}

/** Build the launch for a resolved path. `.cmd` and `.bat` go through `cmd.exe`. */
export function buildLaunch(dshPath: string, args: readonly string[], opts: { platform?: NodeJS.Platform; comspec?: string } = {}): DshLaunch {
  const platform = opts.platform ?? process.platform;
  if (!isAbsolute(dshPath)) throw new DshNotFoundError(`dsh path must be absolute: ${dshPath}`);
  const ext = extname(dshPath).toLowerCase();
  if (platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    if (UNSAFE_PATH_CHARS.test(dshPath)) throw new DshNotFoundError("dsh path contains a character that is not safe on a cmd.exe command line");
    for (const a of args) if (!/^[A-Za-z0-9._=-]+$/.test(a)) throw new DshNotFoundError(`unsafe dsh argument: ${a}`);
    const comspec = opts.comspec ?? process.env["ComSpec"] ?? "cmd.exe";
    return { file: comspec, args: ["/d", "/s", "/c", `""${dshPath}" ${args.join(" ")}"`], windowsVerbatimArguments: true };
  }
  return { file: dshPath, args: [...args] };
}

// ---- the child process ------------------------------------------------------------------------------------------

export interface DshChild {
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  /** The last bytes of stderr (never logged above `warn`, redacted by the caller). */
  stderrTail(): string;
  readonly exited: Promise<number | null>;
  hasExited(): boolean;
  /** Kill the process and its children (Windows `taskkill /T /F`), resolve when it is gone or after 5 s. */
  killTree(): Promise<void>;
}

const STDERR_KEEP = 2000;

export function spawnDsh(launch: DshLaunch, opts: { cwd: string; env: NodeJS.ProcessEnv }): DshChild {
  const child = spawn(launch.file, launch.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments === true,
    shell: false,
  });
  let tail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    tail = (tail + d).slice(-STDERR_KEEP);
  });
  let exited = false;
  const exitedP = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      exited = true;
      resolve(code);
    });
    child.once("error", () => {
      exited = true;
      resolve(null);
    });
  });
  // A write to a dead child's stdin must not crash the job runner.
  child.stdin.on("error", () => {});
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderrTail: () => tail,
    exited: exitedP,
    hasExited: () => exited,
    async killTree(): Promise<void> {
      if (exited) return;
      if (process.platform === "win32" && child.pid !== undefined) {
        await new Promise<void>((resolve) => {
          const k = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          k.once("exit", () => resolve());
          k.once("error", () => resolve());
        });
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await Promise.race([exitedP, new Promise<void>((r) => setTimeout(r, 5000).unref())]);
    },
  };
}

/** `dsh --version`: the first non-empty line, at most 200 characters. */
export async function readDshVersion(launch: DshLaunch, opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<string> {
  const child = spawnDsh(launch, opts);
  child.stdin.end();
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    if (out.length < 4000) out += d;
  });
  const timer = setTimeout(() => void child.killTree(), opts.timeoutMs ?? 15_000);
  timer.unref();
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
  const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
  if (line === undefined) throw new Error("dsh --version printed nothing");
  return line.slice(0, 200);
}
