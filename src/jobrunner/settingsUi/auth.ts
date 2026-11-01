/**
 * One-time login codes (S18.1, I25b, UI-19). `settings-link` (run by the main user in their own terminal) creates a code and
 * prints `http://127.0.0.1:<port>/#code=<code>`; the code sits in the URL FRAGMENT, so it never reaches a Host header, a log or a
 * Referer. The page POSTs it once to `/api/login`. A code is single-use, expires in 5 minutes, and only its HASH is stored, in a
 * file in the job runner's main-user-only data folder. `settings-link --revoke` removes every code and ends every session.
 *
 * Failures: 5 per minute, then a 60 second lockout (login is refused outright while locked, whatever code is sent).
 *
 * The CLI and the server are separate processes that share the small login file; every operation re-reads it.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { safeEqual } from "./session.js";

export const CODE_TTL_MS = 5 * 60 * 1000;
export const MAX_FAILURES_PER_MINUTE = 5;
export const LOCKOUT_MS = 60 * 1000;

interface LoginFile {
  codes: { hash: string; expiresAt: number }[];
  /** Sessions created at or before this instant are invalid. */
  revokedAt: number;
}

function hashCode(code: string): string {
  return createHash("sha256").update(`a7-settings-login:${code}`).digest("hex");
}

export class LoginStore {
  readonly #file: string;
  readonly #now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.#file = file;
    this.#now = now;
  }

  #read(): LoginFile {
    try {
      const raw = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<LoginFile>;
      return { codes: Array.isArray(raw.codes) ? raw.codes.filter((c) => typeof c?.hash === "string" && typeof c?.expiresAt === "number") : [], revokedAt: typeof raw.revokedAt === "number" ? raw.revokedAt : 0 };
    } catch {
      return { codes: [], revokedAt: 0 };
    }
  }

  #write(f: LoginFile): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f), "utf8");
    renameSync(tmp, this.#file);
  }

  /** Creates a code (the caller prints it once). Older unused codes are dropped: one live code at a time. */
  issue(): { code: string; expiresAt: number } {
    const code = randomBytes(24).toString("base64url");
    const f = this.#read();
    const expiresAt = this.#now() + CODE_TTL_MS;
    this.#write({ ...f, codes: [{ hash: hashCode(code), expiresAt }] });
    return { code, expiresAt };
  }

  /** True once for a valid, unexpired code; the code is consumed either way it matches. */
  consume(code: string): boolean {
    const f = this.#read();
    const h = hashCode(code);
    const now = this.#now();
    const live = f.codes.filter((c) => c.expiresAt > now);
    const hit = live.find((c) => safeEqual(c.hash, h));
    if (live.length !== f.codes.length || hit) this.#write({ ...f, codes: live.filter((c) => c !== hit) });
    return hit !== undefined;
  }

  /** Ends every code and every session created so far. */
  revoke(): void {
    this.#write({ codes: [], revokedAt: this.#now() });
  }

  revokedAt(): number {
    return this.#read().revokedAt;
  }
}

export class LoginLimiter {
  readonly #now: () => number;
  #failures: number[] = [];
  #lockedUntil = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Milliseconds left on a lockout (0 = not locked). */
  lockedFor(): number {
    return Math.max(0, this.#lockedUntil - this.#now());
  }

  recordFailure(): void {
    const now = this.#now();
    this.#failures = this.#failures.filter((t) => now - t < 60_000);
    this.#failures.push(now);
    if (this.#failures.length >= MAX_FAILURES_PER_MINUTE) {
      this.#lockedUntil = now + LOCKOUT_MS;
      this.#failures = [];
    }
  }

  recordSuccess(): void {
    this.#failures = [];
  }
}

export function linkFor(host: string, port: number, code: string): string {
  return `http://${host}:${port}/#code=${code}`;
}
