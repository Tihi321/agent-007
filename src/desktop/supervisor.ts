/**
 * Child-process supervisor for the desktop launcher (no electron import). Spawns a node script with an IPC channel, logs its
 * output (5 MB cap, one `.1` rotation), restarts it by the exit-code policy in `nextAction`, and stops it with an IPC
 * `{type:"shutdown"}` followed by a tree kill after a timeout. Exit codes: 0 stopped, 1 crash, 2 bad config, 3 already
 * running elsewhere, 4 restart now.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { killProcessTree } from "../jobrunner/proc.js";

export type SupervisorState =
  | { state: "starting" }
  | { state: "running" }
  | { state: "stopped" }
  | { state: "error"; reason: string; lastStderrLine: string };

export interface ExitRecord {
  code: number | null;
  /** ms timestamp of the exit */
  at: number;
}

export type Action = "stopped" | "restart" | { error: string };

export const CRASH_WINDOW_MS = 10 * 60 * 1000;
export const BACKOFF_MS: readonly number[] = [2_000, 10_000, 30_000];
export const LOG_CAP_BYTES = 5 * 1024 * 1024;

/** Crash exits (anything but 0 and 4) of `history` inside the window that ends at the last entry. */
function crashesInWindow(history: readonly ExitRecord[]): number {
  const last = history[history.length - 1];
  if (!last) return 0;
  return history.filter((h) => h.code !== 0 && h.code !== 4 && last.at - h.at <= CRASH_WINDOW_MS).length;
}

/**
 * Policy for the exit just recorded as the LAST entry of `history` (ms timestamps, oldest first). `code` is that exit's code
 * (null = killed by a signal, treated as a crash). Pure.
 */
export function nextAction(code: number | null, history: readonly ExitRecord[]): Action {
  if (code === 0) return "stopped";
  if (code === 4) return "restart";
  if (code === 2) return { error: "bad configuration" };
  if (code === 3) return { error: "already running elsewhere" };
  return crashesInWindow(history) > BACKOFF_MS.length ? { error: "keeps crashing" } : "restart";
}

/** Delay before the restart that `nextAction` returned "restart" for: 0 for exit 4, else 2 s / 10 s / 30 s by crash count. */
export function restartDelayMs(code: number | null, history: readonly ExitRecord[]): number {
  if (code === 4) return 0;
  const n = crashesInWindow(history);
  return BACKOFF_MS[Math.min(Math.max(n, 1), BACKOFF_MS.length) - 1] ?? 0;
}

export interface SupervisorOptions {
  name: string;
  nodeExe: string;
  script: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logFile: string;
  onState: (s: SupervisorState) => void;
  /** Injectable clock and timers (tests). */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class Supervisor {
  private child: ChildProcess | null = null;
  private history: ExitRecord[] = [];
  private timer: unknown = null;
  private stopping = false;
  private lastStderrLine = "";
  private logSize = 0;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly o: SupervisorOptions) {
    this.now = o.now ?? Date.now;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
    try {
      this.logSize = statSync(o.logFile).size;
    } catch {
      this.logSize = 0;
    }
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    if (this.child || this.timer !== null) return;
    this.stopping = false;
    this.history = [];
    this.spawnChild();
  }

  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const child = this.child;
    if (!child) {
      this.o.onState({ state: "stopped" });
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      if (child.connected) child.send({ type: "shutdown" });
    } catch {
      /* channel already closed; the timeout path kills it */
    }
    let t: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      t = setTimeout(() => resolve(true), timeoutMs);
    });
    const killed = await Promise.race([exited.then(() => false), timedOut]);
    clearTimeout(t);
    if (killed && child.pid) {
      await killProcessTree(child.pid);
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5_000))]);
    }
    this.child = null;
    this.o.onState({ state: "stopped" });
  }

  private spawnChild(): void {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries({ ...process.env, ...this.o.env })) {
      if (!k.toUpperCase().startsWith("ELECTRON_") && v !== undefined) env[k] = v;
    }
    this.lastStderrLine = "";
    this.o.onState({ state: "starting" });
    let child: ChildProcess;
    try {
      child = spawn(this.o.nodeExe, [this.o.script, ...(this.o.args ?? [])], {
        cwd: this.o.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      this.o.onState({ state: "error", reason: "could not start", lastStderrLine: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.child = child;
    child.stdout?.on("data", (c: Buffer) => this.log(c));
    child.stderr?.on("data", (c: Buffer) => {
      this.log(c);
      const lines = c.toString("utf8").split(/\r?\n/).filter((l) => l.trim());
      const last = lines[lines.length - 1];
      if (last) this.lastStderrLine = last;
    });
    child.once("spawn", () => {
      if (this.child === child && !this.stopping) this.o.onState({ state: "running" });
    });
    child.once("error", (e) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.stopping) this.o.onState({ state: "error", reason: "could not start", lastStderrLine: e.message });
    });
    child.once("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return; // stop() reports the state
      this.history.push({ code, at: this.now() });
      const action = nextAction(code, this.history);
      if (action === "stopped") this.o.onState({ state: "stopped" });
      else if (action === "restart") {
        const delay = restartDelayMs(code, this.history);
        this.o.onState({ state: "starting" });
        this.timer = this.setTimer(() => {
          this.timer = null;
          if (!this.stopping) this.spawnChild();
        }, delay);
      } else this.o.onState({ state: "error", reason: action.error, lastStderrLine: this.lastStderrLine });
    });
  }

  private log(chunk: Buffer): void {
    try {
      mkdirSync(dirname(this.o.logFile), { recursive: true });
      if (this.logSize + chunk.length > LOG_CAP_BYTES) {
        try {
          renameSync(this.o.logFile, `${this.o.logFile}.1`);
        } catch {
          /* nothing to rotate */
        }
        this.logSize = 0;
      }
      appendFileSync(this.o.logFile, chunk);
      this.logSize += chunk.length;
    } catch {
      /* logging must never take the supervisor down */
    }
  }
}
