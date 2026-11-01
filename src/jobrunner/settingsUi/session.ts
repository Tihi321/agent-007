/**
 * Sessions of the settings UI (S18.1, I25b): in memory only (lost on a job runner restart), idle timeout 30 min, absolute
 * timeout 8 h, at most 3 at a time (the oldest is dropped). The cookie holds an unguessable random id; the CSRF token is a
 * second random value returned in the JSON body of the login and never in a cookie. Audit lines carry `sha256(id)`, never the id.
 *
 * `revokedAt` (from `settings-link --revoke`) ends every session that was created before it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "a7sid";

export interface Session {
  id: string;
  csrf: string;
  createdAt: number;
  lastSeen: number;
  /** A short hash for audit lines. */
  hash: string;
}

export interface SessionOptions {
  idleMs: number;
  maxAgeMs: number;
  maxSessions?: number;
  now?: () => number;
  /** Sessions created before this instant are invalid (read from the login store at each request). */
  revokedAt?: () => number;
}

export function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

export class SessionStore {
  readonly #o: SessionOptions;
  readonly #now: () => number;
  readonly #byId = new Map<string, Session>();

  constructor(o: SessionOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  create(): Session {
    const now = this.#now();
    this.#sweep(now);
    const max = this.#o.maxSessions ?? 3;
    while (this.#byId.size >= max) {
      const oldest = [...this.#byId.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) break;
      this.#byId.delete(oldest.id);
    }
    const id = randomBytes(32).toString("base64url");
    const s: Session = { id, csrf: randomBytes(32).toString("base64url"), createdAt: now, lastSeen: now, hash: hashId(id) };
    this.#byId.set(id, s);
    return s;
  }

  /** The live session for a cookie header, or undefined. Touches `lastSeen`. */
  fromCookie(header: string | undefined): Session | undefined {
    const id = parseCookie(header, COOKIE_NAME);
    if (!id) return undefined;
    const s = this.#byId.get(id);
    if (!s) return undefined;
    const now = this.#now();
    const revoked = this.#o.revokedAt?.() ?? 0;
    if (s.createdAt <= revoked || now - s.lastSeen > this.#o.idleMs || now - s.createdAt > this.#o.maxAgeMs) {
      this.#byId.delete(id);
      return undefined;
    }
    s.lastSeen = now;
    return s;
  }

  destroy(id: string): void {
    this.#byId.delete(id);
  }

  clear(): void {
    this.#byId.clear();
  }

  get size(): number {
    return this.#byId.size;
  }

  #sweep(now: number): void {
    for (const [id, s] of this.#byId) if (now - s.lastSeen > this.#o.idleMs || now - s.createdAt > this.#o.maxAgeMs) this.#byId.delete(id);
  }
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Constant-time string comparison (different lengths are unequal without leaking where). */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

export function sessionCookie(id: string, maxAgeSec: number): string {
  return `${COOKIE_NAME}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
