/**
 * Server-side sessions (S31, section 6 layer 4). The cookie holds a random 256-bit id; the store holds only its hash (I53). Idle timeout
 * 8 h, absolute 7 d. A session is rotated (a new id, the old one gone) on login and on a privilege change; disabling a user or
 * "sign out everywhere" kills every session of the user at once; the owner lockdown kills them all.
 */
import { randomToken, sha256Hex } from "./crypto.js";
import { csrfFor } from "./http.js";
import type { AuthedSession, SessionResolver } from "./server.js";
import type { JsonStore } from "./store.js";
import type { SessionRecord, SessionsFile, UsersFile } from "./schemas.js";

export const IDLE_MS = 8 * 3_600_000;
export const ABSOLUTE_MS = 7 * 24 * 3_600_000;
export const MAX_SESSIONS_PER_USER = 10;
const TOUCH_EVERY_MS = 60_000;

export const hashSessionId = (id: string): string => sha256Hex(`a7-web:session:${id}`);

export interface SessionManagerOptions {
  sessions: JsonStore<SessionsFile>;
  users: JsonStore<UsersFile>;
  now?: () => number;
  idleMs?: number;
  absoluteMs?: number;
}

export interface SessionInfo {
  /** First 12 characters of the stored hash: enough to name a device in the list and revoke it, useless as a credential. */
  ref: string;
  createdAt: number;
  lastSeen: number;
  ip: string;
  current: boolean;
}

export class SessionManager implements SessionResolver {
  readonly #o: SessionManagerOptions;
  readonly #now: () => number;
  readonly #idle: number;
  readonly #abs: number;

  constructor(o: SessionManagerOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#idle = o.idleMs ?? IDLE_MS;
    this.#abs = o.absoluteMs ?? ABSOLUTE_MS;
  }

  /** A new session. Returns the cookie value (shown once) and its CSRF token. */
  create(userId: string, ctx: { ip: string; ua: string }, opts: { stepUp?: boolean } = {}): { id: string; csrf: string; maxAgeSec: number } {
    const id = randomToken(32);
    const now = this.#now();
    this.#o.sessions.update((d) => {
      d.sessions = d.sessions.filter((s) => s.expiresAt > now && now - s.lastSeen <= this.#idle);
      const mine = d.sessions.filter((s) => s.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
      while (mine.length >= MAX_SESSIONS_PER_USER) {
        const drop = mine.shift();
        d.sessions = d.sessions.filter((s) => s !== drop);
      }
      d.sessions.push({ idHash: hashSessionId(id), userId, createdAt: now, lastSeen: now, expiresAt: now + this.#abs, ip: ctx.ip.slice(0, 64), uaHash: sha256Hex(ctx.ua).slice(0, 32), stepUpAt: opts.stepUp === false ? 0 : now });
    });
    return { id, csrf: csrfFor(id), maxAgeSec: Math.floor(this.#abs / 1000) };
  }

  resolve(cookie: string, _ctx: { ip: string; ua: string }): AuthedSession | undefined {
    if (cookie.length < 30 || cookie.length > 100) return undefined;
    const idHash = hashSessionId(cookie);
    let rec: SessionRecord | undefined;
    let users: UsersFile;
    try {
      rec = this.#o.sessions.read().sessions.find((s) => s.idHash === idHash);
      users = this.#o.users.read();
    } catch {
      return undefined; // an unreadable store never opens a session (I55)
    }
    if (!rec) return undefined;
    const now = this.#now();
    if (now > rec.expiresAt || now - rec.lastSeen > this.#idle) {
      this.revoke(idHash);
      return undefined;
    }
    const user = users.users[rec.userId];
    if (!user || user.status !== "active") {
      this.revoke(idHash);
      return undefined;
    }
    if (now - rec.lastSeen > TOUCH_EVERY_MS) {
      this.#o.sessions.update((d) => {
        const r = d.sessions.find((s) => s.idHash === idHash);
        if (r) r.lastSeen = now;
      });
    }
    return { userId: rec.userId, role: user.role, login: user.login, idHash, csrf: csrfFor(cookie), stepUpAt: rec.stepUpAt };
  }

  /** A fresh passkey or TOTP confirmation (I56). */
  markStepUp(idHash: string): void {
    const now = this.#now();
    this.#o.sessions.update((d) => {
      const r = d.sessions.find((s) => s.idHash === idHash);
      if (r) r.stepUpAt = now;
    });
  }

  revoke(idHash: string): void {
    this.#o.sessions.update((d) => {
      d.sessions = d.sessions.filter((s) => s.idHash !== idHash);
    });
  }

  /** Every session of a user, optionally keeping one (sign out everywhere, disable, privilege change). Returns how many were removed. */
  revokeUser(userId: string, keepIdHash?: string): number {
    return this.#o.sessions.update((d) => {
      const before = d.sessions.length;
      d.sessions = d.sessions.filter((s) => s.userId !== userId || s.idHash === keepIdHash);
      return before - d.sessions.length;
    });
  }

  /** Lockdown: no session survives. */
  revokeAll(): number {
    return this.#o.sessions.update((d) => {
      const n = d.sessions.length;
      d.sessions = [];
      return n;
    });
  }

  /** Revoke one session by its list reference, only if it belongs to `userId` (I47). */
  revokeRef(userId: string, ref: string): boolean {
    return this.#o.sessions.update((d) => {
      const hit = d.sessions.find((s) => s.userId === userId && s.idHash.startsWith(ref) && ref.length >= 12);
      if (!hit) return false;
      d.sessions = d.sessions.filter((s) => s !== hit);
      return true;
    });
  }

  list(userId: string, currentIdHash?: string): SessionInfo[] {
    return this.#o.sessions
      .read()
      .sessions.filter((s) => s.userId === userId)
      .map((s) => ({ ref: s.idHash.slice(0, 12), createdAt: s.createdAt, lastSeen: s.lastSeen, ip: s.ip, current: s.idHash === currentIdHash }));
  }

  count(): number {
    return this.#o.sessions.read().sessions.length;
  }
}
