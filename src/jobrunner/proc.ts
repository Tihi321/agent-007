/**
 * Process helpers for the job runner (S11.4, S11.5): a tree kill (Windows has no clean SIGINT for a child), a liveness
 * check, and a bounded `exec` with fixed argv (never a shell string). Nothing here builds a command from model text.
 */
import { execFile, spawn } from "node:child_process";

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kills a process and everything it started: `taskkill /PID <pid> /T /F` on Windows, SIGKILL elsewhere. Resolves true when it ran. */
export function killProcessTree(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return Promise.resolve(false);
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }
  return new Promise((resolve) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 }, (err) => resolve(!err));
  });
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Output kept per stream (the tail). Default 64 KiB. */
  maxBytes?: number;
}

export type Exec = (exe: string, args: readonly string[], opts: ExecOptions) => Promise<ExecResult>;

/** `spawn` with `shell: false`, no stdin, a timeout that kills the tree, and bounded output. */
export const nodeExec: Exec = (exe, args, opts) =>
  new Promise((resolve) => {
    const max = opts.maxBytes ?? 64 * 1024;
    let out = "";
    let err = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, timedOut });
    };
    let child;
    try {
      child = spawn(exe, [...args], { cwd: opts.cwd, env: opts.env ?? process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      resolve({ code: null, stdout: "", stderr: err, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void killProcessTree(child.pid);
    }, opts.timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      out = (out + c.toString("utf8")).slice(-max);
    });
    child.stderr?.on("data", (c: Buffer) => {
      err = (err + c.toString("utf8")).slice(-max);
    });
    child.on("error", (e) => {
      err = (err + e.message).slice(-max);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
