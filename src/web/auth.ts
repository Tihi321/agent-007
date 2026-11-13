/**
 * App login for the web gateway (S31, section 6 layer 3, I53, I56): owner claim (loopback only, one-time code, 10 minutes), password +
 * TOTP, passkeys (WebAuthn), recovery codes, step-up, and the Tailscale-identity binding. The service holds no HTTP code: `api.ts` calls it.
 *
 * Every failure to sign in is the same `AuthError("invalid")` with the same sentence, so the page never says whether a user exists or
 * which factor was wrong. Failures count against a per-login and a per-client lockout (5 then 15 min, doubling, cap 24 h) and the owner
 * is told on Telegram through `onLockout`.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { WebAudit } from "./audit.js";
import { SecretBox, hashPassword, hashSecret, passwordProblem, randomToken, safeEqual, verifyPassword } from "./crypto.js";
import { newUserId } from "./ids.js";
import type { LockoutTracker } from "./ratelimit.js";
import { LOGIN_PATTERN } from "./schemas.js";
import type { Caps, CredentialsFile, Passkey, UsersFile, WebUser } from "./schemas.js";
import type { AuthedSession, Identity } from "./server.js";
import type { SessionManager } from "./sessions.js";
import { atomicWriteJson } from "./store.js";
import type { JsonStore } from "./store.js";
import { newTotpSecret, otpauthUri, verifyTotp, totpStep } from "./totp.js";
import { ChallengeStore, WebAuthnError, creationOptions, finishAuthentication, finishRegistration, requestOptions } from "./webauthn.js";
import type { CreationOptions, RequestOptions } from "./webauthn.js";

export type AuthErrorCode = "invalid" | "locked" | "forbidden" | "bad_request" | "step_up_required";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly retryAfterSec?: number;
  constructor(code: AuthErrorCode, message: string, retryAfterSec?: number) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    if (retryAfterSec !== undefined) this.retryAfterSec = retryAfterSec;
  }
}

export type LocalResetChannel = "cli" | "desktop";
export type ResetChannel = LocalResetChannel | "admin" | "account";

export const GENERIC_FAIL = "Sign-in failed.";
export const OWNER_CODE_TTL_MS = 10 * 60_000;
export const RECOVERY_CODE_COUNT = 10;

export function ownerCaps(): Caps {
  return { presets: [], tools: ["tool_search", "ask_user", "write_file", "read_file", "list_dir", "search_files"], maxBots: 8, maxChatsPerDay: 100_000, maxTokensPerDay: 100_000_000, maxJobsPerDay: 0, storageMB: 5000 };
}

export interface AuthContext {
  identity: Identity;
  /** The `Host` header, lower-case. */
  host: string;
  ip: string;
  ua: string;
}

export interface Ceremony {
  rpId: string;
  origin: string;
}

export interface AuthDeps {
  users: JsonStore<UsersFile>;
  credentials: JsonStore<CredentialsFile>;
  claimFile: string;
  box: SecretBox;
  sessions: SessionManager;
  lockout: LockoutTracker;
  audit: WebAudit;
  port: number;
  publicHosts: string[];
  now?: () => number;
}

export interface LoggedIn {
  sessionId: string;
  csrf: string;
  maxAgeSec: number;
  userId: string;
  role: WebUser["role"];
  displayName: string;
}

const normRecovery = (c: string): string => c.replace(/[\s-]/g, "").toUpperCase();

export function newRecoveryCodes(): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const t = randomToken(8).replace(/[^A-Za-z0-9]/g, "").toUpperCase().padEnd(10, "7").slice(0, 10);
    return `${t.slice(0, 5)}-${t.slice(5)}`;
  });
  return { plain, hashes: plain.map((c) => hashSecret("recovery", normRecovery(c))) };
}

interface PendingClaim {
  userId: string;
  totpSecret: string;
  reset: boolean;
  expiresAt: number;
  ceremony: Ceremony | undefined;
}

export class AuthService {
  readonly #d: AuthDeps;
  readonly #now: () => number;
  readonly challenges: ChallengeStore;
  readonly #claims = new Map<string, PendingClaim>();

  constructor(d: AuthDeps) {
    this.#d = d;
    this.#now = d.now ?? Date.now;
    this.challenges = new ChallengeStore(this.#now);
  }

  /** rpId and origin for passkeys on this request's host. An IP address cannot be an RP ID, so only `localhost` and the ts.net names work. */
  ceremonyFor(host: string): Ceremony | undefined {
    const h = host.toLowerCase();
    if (h === `localhost:${this.#d.port}`) return { rpId: "localhost", origin: `http://localhost:${this.#d.port}` };
    for (const p of this.#d.publicHosts) {
      const ph = p.toLowerCase();
      if (h === ph || h === `${ph}:443`) return { rpId: ph, origin: `https://${ph}` };
    }
    return undefined;
  }

  ownerExists(): boolean {
    return Object.values(this.#d.users.read().users).some((u) => u.role === "owner");
  }

  // ---- owner claim ----------------------------------------------------------------------------------------------------

  /**
   * `web-owner-code`: prints a one-time code (10 minutes). Without `reset` it refuses once an owner exists. `reset` is the recovery path
   * (physical access to the PC): the claim then REPLACES the owner's credentials and ends every session. Audited.
   */
  issueOwnerCode(opts: { reset?: boolean } = {}): { code: string; expiresAt: number } {
    const exists = this.ownerExists();
    if (exists && !opts.reset) throw new AuthError("forbidden", "an owner already exists; use --reset to re-enrol");
    if (!exists && opts.reset) throw new AuthError("bad_request", "there is no owner to reset");
    const code = randomToken(20);
    const expiresAt = this.#now() + OWNER_CODE_TTL_MS;
    mkdirSync(dirname(this.#d.claimFile), { recursive: true });
    atomicWriteJson(this.#d.claimFile, { codeHash: hashSecret("owner-code", code), expiresAt, reset: opts.reset === true });
    this.#d.audit.write({ kind: "claim", detail: { step: "code_issued", reset: opts.reset === true } });
    return { code, expiresAt };
  }

  #readClaim(): { codeHash: string; expiresAt: number; reset: boolean } | undefined {
    if (!existsSync(this.#d.claimFile)) return undefined;
    try {
      const c = JSON.parse(readFileSync(this.#d.claimFile, "utf8")) as { codeHash?: unknown; expiresAt?: unknown; reset?: unknown };
      if (typeof c.codeHash === "string" && typeof c.expiresAt === "number") return { codeHash: c.codeHash, expiresAt: c.expiresAt, reset: c.reset === true };
    } catch {
      /* an unreadable claim file is no claim */
    }
    return undefined;
  }

  /** True while an unexpired owner-reset code is pending (no detail beyond that). */
  resetPending(): boolean {
    const c = this.#readClaim();
    return c !== undefined && c.reset && c.expiresAt >= this.#now();
  }

  #checkClaimCode(code: unknown): { reset: boolean } {
    const c = this.#readClaim();
    if (!c || typeof code !== "string" || code.length > 200 || c.expiresAt < this.#now() || !safeEqual(c.codeHash, hashSecret("owner-code", code))) {
      throw new AuthError("invalid", "That code is wrong, already used or expired. Run web-owner-code again.");
    }
    return { reset: c.reset };
  }

  /** Step 1 of the claim: loopback only; checks the code (does not consume it) and returns the TOTP secret and passkey options. */
  claimBegin(code: unknown, ctx: AuthContext): { claimId: string; totp: { secret: string; uri: string }; passkey?: CreationOptions } {
    if (ctx.identity.kind !== "local") throw new AuthError("forbidden", "The owner account is claimed on the PC itself.");
    const lockKey = "claim";
    const locked = this.#d.lockout.lockedFor(lockKey);
    if (locked > 0) throw new AuthError("locked", "Too many attempts. Try again later.", Math.ceil(locked / 1000));
    let reset: boolean;
    try {
      ({ reset } = this.#checkClaimCode(code));
    } catch (e) {
      this.#d.lockout.fail(lockKey);
      this.#d.audit.write({ kind: "login_fail", detail: { step: "claim_code" } });
      throw e;
    }
    const existingOwner = Object.entries(this.#d.users.read().users).find(([, u]) => u.role === "owner");
    const userId = reset && existingOwner ? existingOwner[0] : newUserId();
    if (this.ownerExists() && !reset) throw new AuthError("forbidden", "An owner already exists.");
    const claimId = randomToken(24);
    const ceremony = this.ceremonyFor(ctx.host);
    const secret = newTotpSecret();
    this.#claims.set(claimId, { userId, totpSecret: secret, reset, expiresAt: this.#now() + OWNER_CODE_TTL_MS, ceremony });
    const out: { claimId: string; totp: { secret: string; uri: string }; passkey?: CreationOptions } = { claimId, totp: { secret, uri: otpauthUri(secret, "owner") } };
    if (ceremony) out.passkey = creationOptions(this.challenges, { ...ceremony, userId, login: "owner", displayName: "Owner", existing: [], key: "claim" });
    return out;
  }

  /** Step 2: creates (or, with reset, re-enrols) the owner. The code is consumed. Returns the recovery codes ONCE and a session. */
  async claimFinish(
    req: { claimId?: unknown; login?: unknown; displayName?: unknown; password?: unknown; totpCode?: unknown; passkey?: { id?: unknown; clientDataJSON?: unknown; attestationObject?: unknown } },
    ctx: AuthContext,
  ): Promise<LoggedIn & { recoveryCodes: string[] }> {
    if (ctx.identity.kind !== "local") throw new AuthError("forbidden", "The owner account is claimed on the PC itself.");
    const pending = typeof req.claimId === "string" ? this.#claims.get(req.claimId) : undefined;
    if (!pending || pending.expiresAt < this.#now()) throw new AuthError("invalid", "The claim expired. Start again.");
    if (!this.#readClaim()) throw new AuthError("invalid", "That code is already used. Run web-owner-code again.");
    if (this.ownerExists() && !pending.reset) throw new AuthError("forbidden", "An owner already exists.");
    const login = typeof req.login === "string" ? req.login.trim() : "";
    const displayName = typeof req.displayName === "string" ? req.displayName.trim() : "";
    if (!LOGIN_PATTERN.test(login) || displayName.length < 1 || displayName.length > 60) throw new AuthError("bad_request", "Give your Tailscale login (an email address) and a display name.");

    const creds: { passkeys: Passkey[]; password?: { hash: string; totpSealed: string; lastTotpStep: number } } = { passkeys: [] };
    if (req.passkey) {
      if (!pending.ceremony) throw new AuthError("bad_request", "Passkeys need http://localhost or the ts.net name, not an IP address.");
      try {
        const pk = finishRegistration(this.challenges, req.passkey);
        if (pk.userId !== pending.userId) throw new AuthError("invalid", GENERIC_FAIL);
        creds.passkeys.push({ id: pk.id, publicKey: pk.publicKey, signCount: pk.signCount, createdAt: this.#now(), label: "first passkey" });
      } catch (e) {
        if (e instanceof WebAuthnError) throw new AuthError("invalid", "The passkey could not be verified.");
        throw e;
      }
    } else {
      const problem = passwordProblem(req.password);
      if (problem) throw new AuthError("bad_request", problem);
      const password = req.password as string;
      const step = verifyTotp(pending.totpSecret, typeof req.totpCode === "string" ? req.totpCode : "", this.#now(), 0);
      if (step === undefined) throw new AuthError("invalid", "The authenticator code is wrong. Check the clock on your phone.");
      creds.password = { hash: await hashPassword(password), totpSealed: this.#d.box.seal(pending.totpSecret, pending.userId), lastTotpStep: step };
    }
    const rec = newRecoveryCodes();
    const userId = pending.userId;
    const t = this.#now();
    this.#d.users.update((d) => {
      const prev = d.users[userId];
      d.users[userId] = { login, displayName, role: "owner", status: "active", caps: prev?.caps ?? ownerCaps(), createdAt: prev?.createdAt ?? t, invitedBy: "self" };
    });
    this.#d.credentials.update((d) => {
      d.users[userId] = { passkeys: creds.passkeys, ...(creds.password ? { password: creds.password } : {}), recovery: rec.hashes };
    });
    this.#d.sessions.revokeUser(userId);
    try {
      unlinkSync(this.#d.claimFile);
    } catch {
      /* already gone */
    }
    this.#claims.delete(req.claimId as string);
    this.#d.audit.write({ kind: "claim", user: userId, detail: { step: "claimed", reset: pending.reset, method: req.passkey ? "passkey" : "password" } });
    const s = this.#d.sessions.create(userId, ctx);
    return { sessionId: s.id, csrf: s.csrf, maxAgeSec: s.maxAgeSec, userId, role: "owner", displayName, recoveryCodes: rec.plain };
  }

  // ---- sign in ----------------------------------------------------------------------------------------------------------

  #lockKeys(login: string, ctx: AuthContext): string[] {
    return [`login:${login.toLowerCase()}`, `client:${ctx.ip}`];
  }

  #assertNotLocked(keys: string[]): void {
    for (const k of keys) {
      const ms = this.#d.lockout.lockedFor(k);
      if (ms > 0) throw new AuthError("locked", "Too many failed attempts. Try again later.", Math.ceil(ms / 1000));
    }
  }

  #failed(login: string, ctx: AuthContext, step: string): never {
    for (const k of this.#lockKeys(login, ctx)) {
      const started = this.#d.lockout.fail(k);
      if (started > 0) this.#d.audit.write({ kind: "lockout", detail: { key: k.startsWith("login:") ? "login" : "client", minutes: Math.round(started / 60_000) } });
    }
    this.#d.audit.write({ kind: "login_fail", detail: { step } });
    throw new AuthError("invalid", GENERIC_FAIL);
  }

  /** Finds the active user for a login and checks the identity binding (tailscale login equals the record; local only for the owner). */
  #findUser(login: string, ctx: AuthContext): { id: string; user: WebUser } | undefined {
    const l = login.toLowerCase();
    const hit = Object.entries(this.#d.users.read().users).find(([, u]) => u.login.toLowerCase() === l);
    if (!hit) return undefined;
    const [id, user] = hit;
    if (user.status !== "active") return undefined;
    if (ctx.identity.kind === "tailscale" && ctx.identity.login.toLowerCase() !== l) return undefined;
    if (ctx.identity.kind === "local" && user.role !== "owner") return undefined;
    return { id, user };
  }

  #success(id: string, user: WebUser, ctx: AuthContext, method: string, keys: string[]): LoggedIn {
    for (const k of keys) this.#d.lockout.ok(k);
    // rotate: the old sessions of this browser are not reused; a fresh id is issued
    const s = this.#d.sessions.create(id, ctx);
    this.#d.audit.write({ kind: "login_ok", user: id, detail: { method } });
    return { sessionId: s.id, csrf: s.csrf, maxAgeSec: s.maxAgeSec, userId: id, role: user.role, displayName: user.displayName };
  }

  /** Password + (TOTP or a recovery code). */
  async loginPassword(req: { login?: unknown; password?: unknown; totpCode?: unknown; recoveryCode?: unknown }, ctx: AuthContext): Promise<LoggedIn> {
    const login = typeof req.login === "string" ? req.login.trim().slice(0, 120) : "";
    const keys = this.#lockKeys(login || "?", ctx);
    this.#assertNotLocked(keys);
    const found = login ? this.#findUser(login, ctx) : undefined;
    const cred = found ? this.#d.credentials.read().users[found.id]?.password : undefined;
    const password = typeof req.password === "string" && req.password.length <= 200 ? req.password : "";
    // always spend the same scrypt work, whether or not the user exists
    const okPw = await verifyPassword(password, cred?.hash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    if (!found || !cred || !okPw) return this.#failed(login, ctx, "password");
    if (typeof req.recoveryCode === "string" && req.recoveryCode !== "") {
      const h = hashSecret("recovery", normRecovery(req.recoveryCode));
      let used = false;
      this.#d.credentials.update((d) => {
        const c = d.users[found.id];
        if (c && c.recovery.includes(h)) {
          c.recovery = c.recovery.filter((x) => x !== h);
          used = true;
        }
      });
      if (!used) return this.#failed(login, ctx, "recovery");
      this.#d.audit.write({ kind: "step_up", user: found.id, detail: { factor: "recovery" } });
      return this.#success(found.id, found.user, ctx, "password+recovery", keys);
    }
    let secret: string;
    try {
      secret = this.#d.box.open(cred.totpSealed, found.id);
    } catch {
      return this.#failed(login, ctx, "totp");
    }
    const step = verifyTotp(secret, typeof req.totpCode === "string" ? req.totpCode : "", this.#now(), cred.lastTotpStep);
    if (step === undefined) return this.#failed(login, ctx, "totp");
    this.#d.credentials.update((d) => {
      const p = d.users[found.id]?.password;
      if (p) p.lastTotpStep = step;
    });
    return this.#success(found.id, found.user, ctx, "password+totp", keys);
  }

  /** Passkey sign-in, step 1. The answer has the same shape whether or not the login exists. */
  loginPasskeyBegin(login: unknown, ctx: AuthContext): RequestOptions {
    const cer = this.ceremonyFor(ctx.host);
    if (!cer) throw new AuthError("bad_request", "Passkeys need http://localhost or the ts.net name, not an IP address.");
    const l = typeof login === "string" ? login.trim() : "";
    const found = l ? this.#findUser(l, ctx) : undefined;
    const ids = found ? (this.#d.credentials.read().users[found.id]?.passkeys ?? []).map((p) => p.id) : [];
    return requestOptions(this.challenges, { ...cer, credentialIds: ids, key: `client:${ctx.ip}` });
  }

  loginPasskeyFinish(req: { login?: unknown; id?: unknown; clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown }, ctx: AuthContext): LoggedIn {
    const login = typeof req.login === "string" ? req.login.trim().slice(0, 120) : "";
    const keys = this.#lockKeys(login || "?", ctx);
    this.#assertNotLocked(keys);
    const found = login ? this.#findUser(login, ctx) : undefined;
    if (!found) return this.#failed(login, ctx, "passkey");
    const creds = this.#d.credentials.read().users[found.id];
    try {
      const r = finishAuthentication(this.challenges, req, (cid) => creds?.passkeys.find((p) => p.id === cid));
      this.#d.credentials.update((d) => {
        const p = d.users[found.id]?.passkeys.find((x) => x.id === r.credentialId);
        if (p) p.signCount = r.signCount;
      });
    } catch (e) {
      if (e instanceof WebAuthnError) return this.#failed(login, ctx, "passkey");
      throw e;
    }
    return this.#success(found.id, found.user, ctx, "passkey", keys);
  }

  // ---- step-up (I56) and account changes ---------------------------------------------------------------------------------

  /** Re-confirms the session user with a TOTP code or a passkey assertion; marks the session fresh for 5 minutes. */
  stepUp(session: AuthedSession, req: { totpCode?: unknown; id?: unknown; clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown }, ctx: AuthContext): void {
    const keys = [`login:${session.login.toLowerCase()}`, `client:${ctx.ip}`];
    this.#assertNotLocked(keys);
    const creds = this.#d.credentials.read().users[session.userId];
    let ok = false;
    if (typeof req.totpCode === "string" && creds?.password) {
      try {
        const step = verifyTotp(this.#d.box.open(creds.password.totpSealed, session.userId), req.totpCode, this.#now(), creds.password.lastTotpStep);
        if (step !== undefined) {
          this.#d.credentials.update((d) => {
            const p = d.users[session.userId]?.password;
            if (p) p.lastTotpStep = step;
          });
          ok = true;
        }
      } catch {
        ok = false;
      }
    } else if (typeof req.signature === "string") {
      try {
        const r = finishAuthentication(this.challenges, req, (cid) => creds?.passkeys.find((p) => p.id === cid));
        this.#d.credentials.update((d) => {
          const p = d.users[session.userId]?.passkeys.find((x) => x.id === r.credentialId);
          if (p) p.signCount = r.signCount;
        });
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      for (const k of keys) this.#d.lockout.fail(k);
      this.#d.audit.write({ kind: "login_fail", user: session.userId, detail: { step: "step_up" } });
      throw new AuthError("invalid", "That confirmation did not work.");
    }
    this.#d.sessions.markStepUp(session.idHash);
    this.#d.audit.write({ kind: "step_up", user: session.userId, detail: { factor: typeof req.totpCode === "string" ? "totp" : "passkey" } });
  }

  /** Step-up request options for a session user (passkey). */
  stepUpOptions(session: AuthedSession, ctx: AuthContext): RequestOptions | undefined {
    const cer = this.ceremonyFor(ctx.host);
    if (!cer) return undefined;
    const ids = (this.#d.credentials.read().users[session.userId]?.passkeys ?? []).map((p) => p.id);
    return requestOptions(this.challenges, { ...cer, userId: session.userId, credentialIds: ids });
  }

  passkeyRegisterBegin(session: AuthedSession, ctx: AuthContext): CreationOptions {
    const cer = this.ceremonyFor(ctx.host);
    if (!cer) throw new AuthError("bad_request", "Passkeys need http://localhost or the ts.net name, not an IP address.");
    const user = this.#d.users.read().users[session.userId];
    if (!user) throw new AuthError("forbidden", "No such user.");
    const existing = (this.#d.credentials.read().users[session.userId]?.passkeys ?? []).map((p) => p.id);
    return creationOptions(this.challenges, { ...cer, userId: session.userId, login: user.login, displayName: user.displayName, existing });
  }

  passkeyRegisterFinish(session: AuthedSession, req: { id?: unknown; clientDataJSON?: unknown; attestationObject?: unknown; label?: unknown }): void {
    try {
      const pk = finishRegistration(this.challenges, req);
      if (pk.userId !== session.userId) throw new AuthError("forbidden", "That ceremony belongs to another user.");
      const label = typeof req.label === "string" ? req.label.slice(0, 60) : "passkey";
      this.#d.credentials.update((d) => {
        const c = (d.users[session.userId] ??= { passkeys: [], recovery: [] });
        if (c.passkeys.some((p) => p.id === pk.id)) throw new AuthError("bad_request", "That passkey is already registered.");
        c.passkeys.push({ id: pk.id, publicKey: pk.publicKey, signCount: pk.signCount, createdAt: this.#now(), label });
      });
      this.#d.audit.write({ kind: "user_change", user: session.userId, detail: { change: "passkey_added" } });
    } catch (e) {
      if (e instanceof WebAuthnError) throw new AuthError("invalid", "The passkey could not be verified.");
      throw e;
    }
  }

  /** New recovery codes (the old ones stop working). Needs a fresh step-up, checked by the route. */
  regenerateRecovery(userId: string): string[] {
    const rec = newRecoveryCodes();
    this.#d.credentials.update((d) => {
      const c = d.users[userId];
      if (c) c.recovery = rec.hashes;
    });
    this.#d.audit.write({ kind: "user_change", user: userId, detail: { change: "recovery_regenerated" } });
    return rec.plain;
  }

  /** Enrol password + TOTP for an invited user (S32 accept flow). Returns the TOTP secret/URI to show once and a finisher. */
  async enrolPassword(userId: string, password: string, totpSecret: string, totpCode: string): Promise<void> {
    const problem = passwordProblem(password);
    if (problem) throw new AuthError("bad_request", problem);
    const step = verifyTotp(totpSecret, totpCode, this.#now(), 0);
    if (step === undefined) throw new AuthError("invalid", "The authenticator code is wrong. Check the clock on your phone.");
    const hash = await hashPassword(password);
    const sealed = this.#d.box.seal(totpSecret, userId);
    this.#d.credentials.update((d) => {
      const c = (d.users[userId] ??= { passkeys: [], recovery: [] });
      c.password = { hash, totpSealed: sealed, lastTotpStep: step };
    });
  }

  // ---- password and authenticator reset -----------------------------------------------------------------------------------

  /** The user id for a login (case-insensitive), any status. undefined when none. */
  userIdForLogin(login: unknown): string | undefined {
    if (typeof login !== "string") return undefined;
    const l = login.trim().toLowerCase();
    if (!l) return undefined;
    return Object.entries(this.#d.users.read().users).find(([, u]) => u.login.toLowerCase() === l)?.[0];
  }

  /** Forgets the lockout of the target's login and tailnet client keys (and the local client for the owner). */
  #clearLockout(userId: string): void {
    const u = this.#d.users.read().users[userId];
    if (!u) return;
    const l = u.login.toLowerCase();
    const keys = [`login:${l}`, `client:ts:${l}`];
    if (u.role === "owner") keys.push("client:local");
    for (const k of keys) this.#d.lockout.clear(k);
  }

  #resetAudit(targetId: string, change: "password_reset" | "totp_reset", channel: ResetChannel, ended: number, actorId?: string): void {
    this.#d.audit.write({ kind: "user_change", ...(actorId !== undefined ? { user: actorId } : {}), detail: { target: targetId, change, channel, sessions: ended } });
  }

  /**
   * THE password reset used by all four entry points. No authority checks here: each caller has done its own.
   * Changes only the password hash; the authenticator, passkeys and recovery codes stay. Ends every session of the target.
   */
  async resetPassword(req: { targetId: string; newPassword: unknown; channel: ResetChannel; actorId?: string }): Promise<{ ended: number }> {
    const problem = passwordProblem(req.newPassword);
    if (problem) throw new AuthError("bad_request", problem);
    if (!this.#d.users.read().users[req.targetId]) throw new AuthError("bad_request", "No such user.");
    const noPassword = "This account signs in with a passkey only; it has no password to reset.";
    if (!this.#d.credentials.read().users[req.targetId]?.password) throw new AuthError("bad_request", noPassword);
    const hash = await hashPassword(req.newPassword as string);
    this.#d.credentials.update((d) => {
      const p = d.users[req.targetId]?.password;
      if (!p) throw new AuthError("bad_request", noPassword);
      p.hash = hash;
    });
    const ended = this.#d.sessions.revokeUser(req.targetId);
    this.#clearLockout(req.targetId);
    this.#resetAudit(req.targetId, "password_reset", req.channel, ended, req.actorId);
    return { ended };
  }

  /** Account page: the session user changes their own password with the current password and an authenticator code. */
  async changeOwnPassword(session: AuthedSession, req: { currentPassword?: unknown; totpCode?: unknown; newPassword?: unknown }, ctx: AuthContext): Promise<{ ended: number }> {
    const problem = passwordProblem(req.newPassword);
    if (problem) throw new AuthError("bad_request", problem);
    const cred = this.#d.credentials.read().users[session.userId]?.password;
    if (!cred) throw new AuthError("bad_request", "This account signs in with a passkey only; it has no password.");
    const keys = this.#lockKeys(session.login, ctx);
    this.#assertNotLocked(keys);
    const current = typeof req.currentPassword === "string" && req.currentPassword.length <= 200 ? req.currentPassword : "";
    const okPw = await verifyPassword(current, cred.hash);
    let step: number | undefined;
    try {
      step = verifyTotp(this.#d.box.open(cred.totpSealed, session.userId), typeof req.totpCode === "string" ? req.totpCode : "", this.#now(), cred.lastTotpStep);
    } catch {
      step = undefined;
    }
    if (!okPw || step === undefined) {
      for (const k of keys) {
        const started = this.#d.lockout.fail(k);
        if (started > 0) this.#d.audit.write({ kind: "lockout", detail: { key: k.startsWith("login:") ? "login" : "client", minutes: Math.round(started / 60_000) } });
      }
      this.#d.audit.write({ kind: "login_fail", user: session.userId, detail: { step: "password_change" } });
      throw new AuthError("invalid", "The current password or the authenticator code is wrong.");
    }
    const used = step;
    this.#d.credentials.update((d) => {
      const p = d.users[session.userId]?.password;
      if (p) p.lastTotpStep = used;
    });
    return this.resetPassword({ targetId: session.userId, newPassword: req.newPassword, channel: "account", actorId: session.userId });
  }

  /** Local only. Returns a NEW authenticator secret and its URI. Writes nothing: the old secret stays valid until `finishTotpReset`. */
  beginTotpReset(targetId: string): { secret: string; uri: string } {
    const user = this.#d.users.read().users[targetId];
    if (!user) throw new AuthError("bad_request", "No such user.");
    if (!this.#d.credentials.read().users[targetId]?.password) throw new AuthError("bad_request", "This account signs in with a passkey only; it has no authenticator to reset.");
    const secret = newTotpSecret();
    return { secret, uri: otpauthUri(secret, user.login) };
  }

  /** Local only. Replaces the authenticator secret once a code from the new one is proven. Everything else stays. */
  finishTotpReset(req: { targetId: string; secret: string; code: string; channel: LocalResetChannel }): { ended: number } {
    const noTotp = "This account signs in with a passkey only; it has no authenticator to reset.";
    if (!this.#d.users.read().users[req.targetId]) throw new AuthError("bad_request", "No such user.");
    if (!this.#d.credentials.read().users[req.targetId]?.password) throw new AuthError("bad_request", noTotp);
    if (typeof req.secret !== "string" || !/^[A-Z2-7]{32}$/.test(req.secret)) throw new AuthError("bad_request", "That key is not valid.");
    const step = verifyTotp(req.secret, typeof req.code === "string" ? req.code : "", this.#now(), 0);
    if (step === undefined) throw new AuthError("invalid", "The authenticator code is wrong. Check the clock on your phone.");
    const sealed = this.#d.box.seal(req.secret, req.targetId);
    this.#d.credentials.update((d) => {
      const p = d.users[req.targetId]?.password;
      if (!p) throw new AuthError("bad_request", noTotp);
      p.totpSealed = sealed;
      p.lastTotpStep = step;
    });
    const ended = this.#d.sessions.revokeUser(req.targetId);
    this.#clearLockout(req.targetId);
    this.#resetAudit(req.targetId, "totp_reset", req.channel, ended);
    return { ended };
  }

  currentStep(): number {
    return totpStep(this.#now());
  }
}
