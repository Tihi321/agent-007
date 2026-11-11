/**
 * Profile lock (REQ-0014 T3): one Chromium profile can be open once. An exclusive-create file holds the pid of the owner;
 * a lock of a dead pid is stale and is replaced. Used by the driver (a job) and by `browser-login` (the user).
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isProcessAlive } from "../../proc.js";

export class ProfileBusyError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(`the browser profile is in use by process ${pid} (a browser job or browser-login); wait for it or cancel it`);
    this.name = "ProfileBusyError";
    this.pid = pid;
  }
}

export interface ProfileLock {
  release(): void;
}

function readPid(file: string): number | undefined {
  try {
    const raw = readFileSync(file, "utf8").trim();
    const n = Number(raw.startsWith("{") ? (JSON.parse(raw) as { pid?: unknown }).pid : raw);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Throws `ProfileBusyError` when a live process holds the lock. `isAlive` is a test seam. */
export function acquireProfileLock(lockFile: string, pid: number = process.pid, isAlive: (pid: number) => boolean = isProcessAlive): ProfileLock {
  mkdirSync(dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lockFile, JSON.stringify({ pid }), { flag: "wx" });
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          if (readPid(lockFile) === pid) {
            try {
              unlinkSync(lockFile);
            } catch {
              /* already gone */
            }
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = readPid(lockFile);
    if (holder !== undefined && isAlive(holder)) throw new ProfileBusyError(holder);
    try {
      unlinkSync(lockFile); // stale (dead pid) or unreadable: replace it
    } catch {
      /* raced with another process; retry */
    }
  }
  throw new Error("could not take the browser profile lock");
}
