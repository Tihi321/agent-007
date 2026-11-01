/**
 * Abuse limits of the web gateway (S29, section 6 layer 6): token buckets per key, and an exponential lockout (5 failures, then 15 min,
 * doubling on each further lockout up to 24 h). The lockout state can be persisted so a restart does not clear it. The `onLockout`
 * callback is how the owner is told on Telegram.
 */
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteJson } from "./store.js";

export class TokenBuckets {
  readonly #cap: number;
  readonly #perSec: number;
  readonly #now: () => number;
  readonly #b = new Map<string, { tokens: number; at: number }>();

  constructor(o: { capacity: number; refillPerSec: number; now?: () => number }) {
    this.#cap = o.capacity;
    this.#perSec = o.refillPerSec;
    this.#now = o.now ?? Date.now;
  }

  /** True if the call may go on (a token was taken). */
  take(key: string): boolean {
    const now = this.#now();
    const s = this.#b.get(key) ?? { tokens: this.#cap, at: now };
    s.tokens = Math.min(this.#cap, s.tokens + ((now - s.at) / 1000) * this.#perSec);
    s.at = now;
    const ok = s.tokens >= 1;
    if (ok) s.tokens -= 1;
    this.#b.set(key, s);
    if (this.#b.size > 10_000) for (const [k, v] of this.#b) if (now - v.at > 600_000) this.#b.delete(k);
    return ok;
  }
}

export const LOCKOUT_FAILS = 5;
export const LOCKOUT_BASE_MS = 15 * 60_000;
export const LOCKOUT_MAX_MS = 24 * 3_600_000;

interface LockState {
  fails: number;
  level: number;
  lockedUntil: number;
}

export class LockoutTracker {
  readonly #now: () => number;
  readonly #m = new Map<string, LockState>();
  readonly #file: string | undefined;
  readonly #onLockout: ((key: string, ms: number) => void) | undefined;

  constructor(o: { now?: () => number; file?: string; onLockout?: (key: string, ms: number) => void } = {}) {
    this.#now = o.now ?? Date.now;
    this.#file = o.file;
    this.#onLockout = o.onLockout;
    if (this.#file && existsSync(this.#file)) {
      // a corrupt lockout file throws: the gateway does not start (fail closed, I55)
      const raw = JSON.parse(readFileSync(this.#file, "utf8")) as Record<string, LockState>;
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v?.fails === "number" && typeof v?.level === "number" && typeof v?.lockedUntil === "number") this.#m.set(k, v);
      }
    }
  }

  /** Milliseconds left on a lockout for `key` (0 = free). */
  lockedFor(key: string): number {
    return Math.max(0, (this.#m.get(key)?.lockedUntil ?? 0) - this.#now());
  }

  /** Records one failure. Returns the lockout in ms when this failure started one. */
  fail(key: string): number {
    const s = this.#m.get(key) ?? { fails: 0, level: 0, lockedUntil: 0 };
    if (s.lockedUntil > this.#now()) return 0;
    s.fails += 1;
    let started = 0;
    if (s.fails >= LOCKOUT_FAILS) {
      started = Math.min(LOCKOUT_MAX_MS, LOCKOUT_BASE_MS * 2 ** s.level);
      s.level += 1;
      s.fails = 0;
      s.lockedUntil = this.#now() + started;
    }
    this.#m.set(key, s);
    this.#save();
    if (started > 0) {
      try {
        this.#onLockout?.(key, started);
      } catch {
        /* a failing notifier never changes the lockout */
      }
    }
    return started;
  }

  /** A success clears the failure count (the lockout level decays only after a day of quiet). */
  ok(key: string): void {
    const s = this.#m.get(key);
    if (!s) return;
    s.fails = 0;
    if (s.lockedUntil + LOCKOUT_MAX_MS < this.#now()) this.#m.delete(key);
    this.#save();
  }

  #save(): void {
    if (this.#file) atomicWriteJson(this.#file, Object.fromEntries(this.#m));
  }
}
