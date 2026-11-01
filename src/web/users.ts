/**
 * User management (S32): invites, the accept flow, roles, caps, disable and revoke, delete with typed confirmation, retention.
 *
 * Authority (UI-37): the owner can do everything except remove themselves; an `admin` can invite and disable ordinary users and set caps
 * no higher than their own, but cannot create admins, touch the owner or another admin, or change host settings (there are none here).
 * Every method takes the ACTING user's id from the session and checks authority over the TARGET: a target id from the client is never
 * trusted (I47). Sensitive methods are guarded by step-up on the route (I56). Everything is audited with ids, never with bodies.
 */
import { existsSync, rmSync } from "node:fs";
import { AuthError, newRecoveryCodes } from "./auth.js";
import type { AuthContext, LoggedIn } from "./auth.js";
import { MIN_PASSWORD_LENGTH, hashPassword, hashSecret, randomToken, safeEqual } from "./crypto.js";
import { USER_TOOL_UNIVERSE } from "./capabilities.js";
import { isUserId, newInviteId, newUserId } from "./ids.js";
import { userPaths } from "./paths.js";
import { LOGIN_PATTERN, defaultCaps, parseCaps, recordFor } from "./schemas.js";
import type { Caps, Invite, Role, WebUser } from "./schemas.js";
import type { Identity } from "./server.js";
import type { WebStack } from "./stack.js";
import { newTotpSecret, otpauthUri, verifyTotp } from "./totp.js";
import { WebAuthnError, creationOptions, finishRegistration } from "./webauthn.js";
import type { CreationOptions } from "./webauthn.js";

export const INVITE_TTL_MS = 24 * 3_600_000;
export const RETENTION_MS = 30 * 24 * 3_600_000;
const INVALID_INVITE = "That invitation is not valid. Ask for a new one.";

export class AdminError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminError";
    this.status = status;
  }
}

interface Actor {
  id: string;
  user: WebUser;
}

/** True when every cap of `child` is within `parent` (an admin cannot hand out more than they have). */
export function capsWithin(child: Caps, parent: Caps): boolean {
  return (
    child.presets.every((p) => parent.presets.includes(p)) &&
    child.tools.every((t) => parent.tools.includes(t)) &&
    child.maxBots <= parent.maxBots &&
    child.maxChatsPerDay <= parent.maxChatsPerDay &&
    child.maxTokensPerDay <= parent.maxTokensPerDay &&
    child.storageMB <= parent.storageMB
  );
}

interface PendingInvite {
  inviteId: string;
  userId: string;
  login: string;
  totpSecret: string;
  expiresAt: number;
  ceremony: { rpId: string; origin: string } | undefined;
}

export class UserAdmin {
  readonly #s: WebStack;
  readonly #now: () => number;
  readonly #pending = new Map<string, PendingInvite>();
  readonly #knownPresets: (() => readonly string[]) | undefined;
  readonly #onUserRevoked: ((userId: string) => void) | undefined;
  readonly #dropPaid: ((userId: string) => void) | undefined;

  /** `onUserRevoked`: called when a user is disabled or deleted, after the sessions end, so the gateway stops their running turns (L3). */
  constructor(stack: WebStack, opts: { now?: () => number; knownPresets?: () => readonly string[]; onUserRevoked?: (userId: string) => void; dropPaid?: (userId: string) => void } = {}) {
    this.#dropPaid = opts.dropPaid;
    this.#s = stack;
    this.#now = opts.now ?? Date.now;
    this.#knownPresets = opts.knownPresets;
    this.#onUserRevoked = opts.onUserRevoked;
  }

  #revoked(userId: string): void {
    try {
      this.#onUserRevoked?.(userId);
    } catch {
      /* stopping a turn never blocks the disable */
    }
  }

  #actor(userId: string): Actor {
    const user = recordFor(this.#s.users.read().users, userId);
    if (!user || user.status !== "active" || (user.role !== "owner" && user.role !== "admin")) throw new AdminError(403, "Not allowed.");
    return { id: userId, user };
  }

  /** The caps must be valid, inside the tool universe and (when a preset list is known) name real presets. */
  #checkCaps(caps: unknown): Caps {
    let c: Caps;
    try {
      c = parseCaps(caps);
    } catch (e) {
      throw new AdminError(400, e instanceof Error ? e.message : "bad caps");
    }
    const badTool = c.tools.find((t) => !USER_TOOL_UNIVERSE.includes(t));
    if (badTool) throw new AdminError(400, `caps.tools: "${badTool.slice(0, 40)}" is not a tool a user bot can have`);
    const known = this.#knownPresets?.();
    const badPreset = known ? c.presets.find((p) => !known.includes(p)) : undefined;
    if (badPreset) throw new AdminError(400, `caps.presets: "${badPreset.slice(0, 40)}" is not a configured preset`);
    return c;
  }

  /** A target id from the client: only a real user id passes; "__proto__", "constructor" and the like are "no such user" (L1). */
  #targetId(targetId: unknown): string {
    if (!isUserId(targetId)) throw new AdminError(404, "No such user.");
    return targetId;
  }

  /** May `actor` act on `target`? Owner: anyone but the owner record itself for destructive actions (checked by the caller). Admin: ordinary users only. */
  #authority(actor: Actor, targetId: string, target: WebUser | undefined): WebUser {
    if (!target) throw new AdminError(404, "No such user.");
    if (actor.user.role === "owner") return target;
    if (actor.id === targetId || target.role !== "user") throw new AdminError(403, "Not allowed.");
    return target;
  }

  // ---- invites ------------------------------------------------------------------------------------------------------

  createInvite(actorId: string, req: { role?: unknown; caps?: unknown; tailscaleLoginPin?: unknown; ttlHours?: unknown }): { id: string; code: string; expiresAt: number } {
    const actor = this.#actor(actorId);
    const role = req.role === "admin" ? "admin" : "user";
    if (role === "admin" && actor.user.role !== "owner") throw new AdminError(403, "Only the owner can invite an admin.");
    const caps = req.caps === undefined ? defaultCaps() : this.#checkCaps(req.caps);
    if (actor.user.role === "admin" && !capsWithin(caps, actor.user.caps)) throw new AdminError(403, "You cannot give more than you have.");
    let pin: string | undefined;
    if (req.tailscaleLoginPin !== undefined && req.tailscaleLoginPin !== "") {
      pin = typeof req.tailscaleLoginPin === "string" ? req.tailscaleLoginPin.trim() : "";
      if (!LOGIN_PATTERN.test(pin)) throw new AdminError(400, "The Tailscale login is not valid.");
    }
    const ttl = typeof req.ttlHours === "number" && req.ttlHours >= 1 && req.ttlHours <= 24 * 7 ? req.ttlHours * 3_600_000 : INVITE_TTL_MS;
    const code = randomToken(20); // 160 bits, shown once
    const now = this.#now();
    const inv: Invite = { id: newInviteId(), codeHash: hashSecret("invite", code), role, caps, expiresAt: now + ttl, createdAt: now, createdBy: actorId, ...(pin ? { tailscaleLoginPin: pin } : {}) };
    this.#s.invites.update((d) => {
      d.invites = d.invites.filter((i) => i.expiresAt > now - 7 * 24 * 3_600_000 || i.usedBy === undefined).slice(-500);
      d.invites.push(inv);
    });
    this.#s.audit.write({ kind: "invite_create", user: actorId, detail: { invite: inv.id, role, pinned: pin !== undefined, hours: Math.round(ttl / 3_600_000) } });
    return { id: inv.id, code, expiresAt: inv.expiresAt };
  }

  listInvites(actorId: string): { id: string; role: string; expiresAt: number; state: "pending" | "used" | "expired" | "revoked"; pin?: string; createdBy: string }[] {
    this.#actor(actorId);
    const now = this.#now();
    return this.#s.invites.read().invites.map((i) => ({
      id: i.id,
      role: i.role,
      expiresAt: i.expiresAt,
      state: i.revoked ? "revoked" : i.usedBy ? "used" : i.expiresAt <= now ? "expired" : "pending",
      ...(i.tailscaleLoginPin ? { pin: i.tailscaleLoginPin } : {}),
      createdBy: i.createdBy,
    }));
  }

  revokeInvite(actorId: string, inviteId: unknown): void {
    const actor = this.#actor(actorId);
    this.#s.invites.update((d) => {
      const inv = d.invites.find((i) => i.id === inviteId);
      if (!inv) throw new AdminError(404, "No such invitation.");
      if (actor.user.role !== "owner" && inv.createdBy !== actorId) throw new AdminError(403, "Not allowed.");
      inv.revoked = true;
    });
    this.#s.audit.write({ kind: "invite_revoke", user: actorId, detail: { invite: String(inviteId).slice(0, 20) } });
  }

  /**
   * Does a verified Tailscale login map to an active user or a usable invite PINNED to that login? (the gateway's `admit`, generic 403
   * otherwise). An open invite (no pin) admits nobody by itself: the invitee first presents the code (`presentInvite`), which pins it (L6).
   */
  admit = (identity: Identity): boolean => {
    if (identity.kind !== "tailscale") return true;
    const l = identity.login.toLowerCase();
    try {
      if (Object.values(this.#s.users.read().users).some((u) => u.status === "active" && u.login.toLowerCase() === l)) return true;
      const now = this.#now();
      return this.#s.invites.read().invites.some((i) => !i.usedBy && !i.revoked && i.expiresAt > now && i.tailscaleLoginPin !== undefined && i.tailscaleLoginPin.toLowerCase() === l);
    } catch {
      return false; // a corrupt store admits nobody (I55)
    }
  };

  /**
   * L6: a tailnet login that is not admitted presents an invite code (`GET /invite?code=`). A valid code of an open invite pins the invite
   * to this login (first presentation wins, plan section 6) so `admit` lets the invitee in; a code pinned to this login is fine too.
   * Anything else is a failure counted against the login, and the caller answers with the generic 403.
   */
  presentInvite = (identity: Identity, code: string): boolean => {
    if (identity.kind !== "tailscale") return false;
    const l = identity.login.toLowerCase();
    const key = `invite:ts:${l}`;
    try {
      if (this.#s.lockout.lockedFor(key) > 0) return false;
      const inv = this.#findInvite(code);
      const taken = Object.values(this.#s.users.read().users).some((u) => u.login.toLowerCase() === l);
      if (!inv || taken || (inv.tailscaleLoginPin !== undefined && inv.tailscaleLoginPin.toLowerCase() !== l) || !LOGIN_PATTERN.test(identity.login)) {
        this.#s.lockout.fail(key);
        this.#s.audit.write({ kind: "login_fail", detail: { step: "invite_present" } });
        return false;
      }
      if (inv.tailscaleLoginPin === undefined) {
        this.#s.invites.update((d) => {
          const i = d.invites.find((x) => x.id === inv.id);
          if (!i || i.tailscaleLoginPin !== undefined) throw new AdminError(409, "taken");
          i.tailscaleLoginPin = identity.login;
        });
        this.#s.audit.write({ kind: "invite_bound", detail: { invite: inv.id } });
      }
      return true;
    } catch {
      return false; // a corrupt store or a lost race: nobody is admitted (I55)
    }
  };

  // ---- accept ---------------------------------------------------------------------------------------------------------

  #findInvite(code: unknown): Invite | undefined {
    if (typeof code !== "string" || code.length > 100) return undefined;
    const h = hashSecret("invite", code);
    const now = this.#now();
    return this.#s.invites.read().invites.find((i) => safeEqual(i.codeHash, h) && !i.usedBy && !i.revoked && i.expiresAt > now);
  }

  #checkInviteFor(code: unknown, ctx: AuthContext): Invite {
    if (ctx.identity.kind !== "tailscale") throw new AuthError("forbidden", "Open the invitation from your own device on the tailnet.");
    const key = `invite:${ctx.ip}`;
    const ms = this.#s.lockout.lockedFor(key);
    if (ms > 0) throw new AuthError("locked", "Too many attempts. Try again later.", Math.ceil(ms / 1000));
    const inv = this.#findInvite(code);
    const login = ctx.identity.login.toLowerCase();
    const taken = Object.values(this.#s.users.read().users).some((u) => u.login.toLowerCase() === login);
    if (!inv || taken || (inv.tailscaleLoginPin !== undefined && inv.tailscaleLoginPin.toLowerCase() !== login)) {
      this.#s.lockout.fail(key);
      this.#s.audit.write({ kind: "login_fail", detail: { step: "invite" } });
      throw new AuthError("invalid", INVALID_INVITE);
    }
    return inv;
  }

  inviteBegin(code: unknown, ctx: AuthContext): { token: string; totp: { secret: string; uri: string }; passkey?: CreationOptions } {
    const inv = this.#checkInviteFor(code, ctx);
    const identity = ctx.identity as Extract<Identity, { kind: "tailscale" }>;
    const userId = newUserId();
    const token = randomToken(24);
    const ceremony = this.#s.auth.ceremonyFor(ctx.host);
    const secret = newTotpSecret();
    this.#pending.set(token, { inviteId: inv.id, userId, login: identity.login, totpSecret: secret, expiresAt: this.#now() + 30 * 60_000, ceremony });
    const out: { token: string; totp: { secret: string; uri: string }; passkey?: CreationOptions } = { token, totp: { secret, uri: otpauthUri(secret, identity.login) } };
    if (ceremony) out.passkey = creationOptions(this.#s.auth.challenges, { ...ceremony, userId, login: identity.login, displayName: identity.login, existing: [], key: `invite:${ctx.ip}` });
    return out;
  }

  async inviteFinish(
    req: { token?: unknown; code?: unknown; displayName?: unknown; password?: unknown; totpCode?: unknown; passkey?: { id?: unknown; clientDataJSON?: unknown; attestationObject?: unknown } },
    ctx: AuthContext,
  ): Promise<LoggedIn & { recoveryCodes: string[] }> {
    const p = typeof req.token === "string" ? this.#pending.get(req.token) : undefined;
    if (!p || p.expiresAt < this.#now()) throw new AuthError("invalid", INVALID_INVITE);
    const inv = this.#checkInviteFor(req.code, ctx);
    if (inv.id !== p.inviteId || (ctx.identity.kind === "tailscale" && ctx.identity.login.toLowerCase() !== p.login.toLowerCase())) throw new AuthError("invalid", INVALID_INVITE);
    const displayName = typeof req.displayName === "string" ? req.displayName.trim() : "";
    if (displayName.length < 1 || displayName.length > 60) throw new AuthError("bad_request", "Give a display name.");
    let passkey: { id: string; publicKey: string; signCount: number } | undefined;
    let totpStep0 = 0;
    if (req.passkey) {
      if (!p.ceremony) throw new AuthError("bad_request", "Passkeys need the ts.net name.");
      try {
        const pk = finishRegistration(this.#s.auth.challenges, req.passkey);
        if (pk.userId !== p.userId) throw new AuthError("invalid", INVALID_INVITE);
        passkey = pk;
      } catch (e) {
        if (e instanceof WebAuthnError) throw new AuthError("invalid", "The passkey could not be verified.");
        throw e;
      }
    } else {
      const password = typeof req.password === "string" ? req.password : "";
      if (password.length < MIN_PASSWORD_LENGTH || password.length > 200) throw new AuthError("bad_request", `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
      const st = verifyTotp(p.totpSecret, typeof req.totpCode === "string" ? req.totpCode : "", this.#now(), 0);
      if (st === undefined) throw new AuthError("invalid", "The authenticator code is wrong. Check the clock on your phone.");
      totpStep0 = st;
    }
    // single use: mark the invite used BEFORE any await, so a second finish with the same code loses the race
    const now = this.#now();
    this.#s.invites.update((d) => {
      const i = d.invites.find((x) => x.id === inv.id);
      if (!i || i.usedBy || i.revoked || i.expiresAt <= now) throw new AuthError("invalid", INVALID_INVITE);
      i.usedBy = p.userId;
      i.usedAt = now;
    });
    this.#pending.delete(req.token as string);
    try {
      const passwordHash = passkey ? undefined : await hashPassword(String(req.password));
      const recovery = newRecoveryCodes();
      this.#s.users.update((d) => {
        d.users[p.userId] = { login: p.login, displayName, role: inv.role, status: "active", caps: inv.caps, createdAt: now, invitedBy: inv.createdBy };
      });
      this.#s.credentials.update((d) => {
        d.users[p.userId] = {
          passkeys: passkey ? [{ id: passkey.id, publicKey: passkey.publicKey, signCount: passkey.signCount, createdAt: now, label: "first passkey" }] : [],
          ...(passwordHash ? { password: { hash: passwordHash, totpSealed: this.#s.box.seal(p.totpSecret, p.userId), lastTotpStep: totpStep0 } } : {}),
          recovery: recovery.hashes,
        };
      });
      this.#s.audit.write({ kind: "invite_use", user: p.userId, detail: { invite: inv.id, method: passkey ? "passkey" : "password" } });
      const s = this.#s.sessions.create(p.userId, ctx);
      return { sessionId: s.id, csrf: s.csrf, maxAgeSec: s.maxAgeSec, userId: p.userId, role: inv.role, displayName, recoveryCodes: recovery.plain };
    } catch (e) {
      // the account could not be completed: release the invite so the owner does not have to issue a new one
      this.#s.invites.update((d) => {
        const i = d.invites.find((x) => x.id === inv.id);
        if (i) {
          delete i.usedBy;
          delete i.usedAt;
        }
      });
      throw e;
    }
  }

  // ---- users ---------------------------------------------------------------------------------------------------------

  /** The owner row reports `presets: "all"` (I61): the owner's models are every configured preset, not a stored list. */
  listUsers(actorId: string): { id: string; login: string; displayName: string; role: Role; status: string; caps: Omit<Caps, "presets"> & { presets: string[] | "all" }; createdAt: number; disabledAt?: number }[] {
    this.#actor(actorId);
    return Object.entries(this.#s.users.read().users).map(([id, u]) => ({ id, login: u.login, displayName: u.displayName, role: u.role, status: u.status, caps: u.role === "owner" ? { ...u.caps, presets: "all" as const } : u.caps, createdAt: u.createdAt, ...(u.disabledAt !== undefined ? { disabledAt: u.disabledAt } : {}) }));
  }

  setCaps(actorId: string, targetId: unknown, capsIn: unknown): void {
    const actor = this.#actor(actorId);
    const caps = this.#checkCaps(capsIn);
    const id = this.#targetId(targetId);
    this.#authority(actor, id, recordFor(this.#s.users.read().users, id));
    if (actor.user.role === "admin" && !capsWithin(caps, actor.user.caps)) throw new AdminError(403, "You cannot give more than you have.");
    this.#s.users.update((d) => {
      const t = recordFor(d.users, id);
      if (!t) throw new AdminError(404, "No such user.");
      t.caps = caps;
    });
    this.#s.sessions.revokeUser(id); // privilege change: sessions are rotated
    this.#s.audit.write({ kind: "user_change", user: actorId, detail: { target: id, change: "caps" } });
  }

  setRole(actorId: string, targetId: unknown, role: unknown): void {
    const actor = this.#actor(actorId);
    if (actor.user.role !== "owner") throw new AdminError(403, "Only the owner can change roles.");
    if (role !== "admin" && role !== "user") throw new AdminError(400, "The role must be admin or user.");
    const id = this.#targetId(targetId);
    const t = recordFor(this.#s.users.read().users, id);
    if (!t) throw new AdminError(404, "No such user.");
    if (t.role === "owner") throw new AdminError(403, "The owner role cannot be changed.");
    this.#s.users.update((d) => {
      const u = recordFor(d.users, id);
      if (!u) throw new AdminError(404, "No such user.");
      u.role = role;
    });
    this.#s.sessions.revokeUser(id);
    this.#s.audit.write({ kind: "user_change", user: actorId, detail: { target: id, change: "role", role } });
  }

  /** Disables the account and ends its sessions in the same call; the data stays (archive) until the retention sweep. */
  disableUser(actorId: string, targetId: unknown): void {
    const actor = this.#actor(actorId);
    const id = this.#targetId(targetId);
    const t = this.#authority(actor, id, recordFor(this.#s.users.read().users, id));
    if (t.role === "owner") throw new AdminError(403, "The owner cannot be disabled.");
    this.#s.users.update((d) => {
      const u = recordFor(d.users, id);
      if (!u) throw new AdminError(404, "No such user.");
      u.status = "disabled";
      u.disabledAt = this.#now();
    });
    const n = this.#s.sessions.revokeUser(id);
    this.#revoked(id);
    this.#s.audit.write({ kind: "user_change", user: actorId, detail: { target: id, change: "disabled", sessions: n } });
  }

  enableUser(actorId: string, targetId: unknown): void {
    const actor = this.#actor(actorId);
    const id = this.#targetId(targetId);
    this.#authority(actor, id, recordFor(this.#s.users.read().users, id));
    this.#s.users.update((d) => {
      const u = recordFor(d.users, id);
      if (!u) throw new AdminError(404, "No such user.");
      u.status = "active";
      delete u.disabledAt;
    });
    this.#s.audit.write({ kind: "user_change", user: actorId, detail: { target: id, change: "enabled" } });
  }

  /** Owner only. The user must type the login to confirm. Removes the user's tree, credentials and sessions (I52). */
  deleteUser(actorId: string, targetId: unknown, confirmLogin: unknown): void {
    const actor = this.#actor(actorId);
    if (actor.user.role !== "owner") throw new AdminError(403, "Only the owner can delete a user.");
    const id = this.#targetId(targetId);
    const t = recordFor(this.#s.users.read().users, id);
    if (!t) throw new AdminError(404, "No such user.");
    if (t.role === "owner") throw new AdminError(403, "The owner cannot be deleted.");
    if (typeof confirmLogin !== "string" || confirmLogin.trim().toLowerCase() !== t.login.toLowerCase()) throw new AdminError(400, "Type the user's login to confirm.");
    this.#purge(id);
    this.#s.audit.write({ kind: "user_delete", user: actorId, detail: { target: id, via: "owner" } });
  }

  #purge(id: string): void {
    this.#s.sessions.revokeUser(id);
    this.#revoked(id);
    this.#dropPaid?.(id); // N5: a deleted user keeps no paid grant
    const root = userPaths(this.#s.paths.usersDir.replace(/[\\/]users$/, ""), id).root;
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    this.#s.credentials.update((d) => {
      delete d.users[id];
    });
    this.#s.users.update((d) => {
      delete d.users[id];
    });
  }

  /** UI-44: a user disabled for more than 30 days is deleted with their data. Returns the ids removed. */
  sweepDisabled(): string[] {
    const now = this.#now();
    const gone = Object.entries(this.#s.users.read().users)
      .filter(([, u]) => u.status === "disabled" && u.role !== "owner" && u.disabledAt !== undefined && now - u.disabledAt > RETENTION_MS)
      .map(([id]) => id);
    for (const id of gone) {
      this.#purge(id);
      this.#s.audit.write({ kind: "user_delete", detail: { target: id, via: "retention" } });
    }
    return gone;
  }
}
