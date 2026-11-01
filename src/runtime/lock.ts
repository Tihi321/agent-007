/**
 * Single-instance lock (S1.5). `openSync(lockPath, "wx")` writes `{pid, startedAt}`.
 * If the file exists and the PID is alive: `LockHeldError` (the entry point exits with code 3).
 * If the PID is dead: take over.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const EXIT_CODE_LOCK_HELD = 3;

export class LockHeldError extends Error {
  readonly pid: number;
  constructor(lockPath: string, pid: number) {
    super(`another agent-007 instance holds ${lockPath} (pid ${pid})`);
    this.name = "LockHeldError";
    this.pid = pid;
  }
}

export interface LockInfo {
  pid: number;
  startedAt: string;
}

export interface Lock {
  readonly path: string;
  release(): void;
}

export interface LockOptions {
  pid?: number;
  /** Test seam; default uses `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): LockInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
    if (typeof parsed.pid === "number") return { pid: parsed.pid, startedAt: String(parsed.startedAt ?? "") };
  } catch {
    /* unreadable or half-written: treated as stale by the caller */
  }
  return undefined;
}

export function acquireLock(lockPath: string, opts: LockOptions = {}): Lock {
  const pid = opts.pid ?? process.pid;
  const alive = opts.isAlive ?? isProcessAlive;
  const now = opts.now ?? (() => new Date());
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 5; attempt++) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = readLock(lockPath);
      if (holder && holder.pid !== pid && alive(holder.pid)) throw new LockHeldError(lockPath, holder.pid);
      // Dead holder (or our own stale file, or garbage): take over.
      try {
        unlinkSync(lockPath);
      } catch {
        /* someone else just took it over; the next attempt sees their pid */
      }
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ pid, startedAt: now().toISOString() } satisfies LockInfo));
    } finally {
      closeSync(fd);
    }
    let released = false;
    return {
      path: lockPath,
      release() {
        if (released) return;
        released = true;
        const holder = readLock(lockPath);
        if (holder?.pid === pid) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* already gone */
          }
        }
      },
    };
  }
  throw new Error(`could not acquire ${lockPath} after repeated attempts`);
}
