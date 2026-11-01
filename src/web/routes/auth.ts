/**
 * HTTP routes for sign-in, claim, session and account (S31). Thin: parse the body, call `AuthService`, set or clear the cookie, map
 * `AuthError` to a status. The session user always comes from the cookie (I47); nothing here reads a userId from the client.
 */
import { AuthError } from "../auth.js";
import type { AuthContext } from "../auth.js";
import { clearCookie, one, sessionCookie } from "../http.js";
import type { RouteCtx, RouteDef, RouteResult } from "../server.js";
import type { WebStack } from "../stack.js";

export const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function authContext(c: RouteCtx): AuthContext {
  return { identity: c.identity, host: (one(c.req.headers["host"]) ?? "").toLowerCase(), ip: c.ip, ua: c.ua };
}

/** Runs a handler and turns an `AuthError` into the response the page expects. */
export async function guarded(fn: () => Promise<RouteResult> | RouteResult): Promise<RouteResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AuthError) {
      const status = e.code === "locked" ? 429 : e.code === "invalid" ? 401 : e.code === "forbidden" ? 403 : e.code === "step_up_required" ? 401 : 400;
      return { status, body: { error: e.code, message: e.message, ...(e.retryAfterSec !== undefined ? { retryAfterSec: e.retryAfterSec } : {}) }, ...(e.retryAfterSec !== undefined ? { headers: { "Retry-After": String(e.retryAfterSec) } } : {}) };
    }
    throw e;
  }
}

/** `hooks.onLockdown`: called after an owner lockdown ends every session, so the gateway stops every running turn (L3). */
export function authRoutes(stack: WebStack, hooks: { onLockdown?: () => void } = {}): Record<string, RouteDef> {
  const { auth, sessions } = stack;
  const loggedIn = (r: Awaited<ReturnType<typeof auth.loginPassword>>, extra: Record<string, unknown> = {}): RouteResult => ({
    status: 200,
    body: { ok: true, csrf: r.csrf, user: { displayName: r.displayName, role: r.role }, ...extra },
    headers: { "Set-Cookie": sessionCookie(r.sessionId, r.maxAgeSec) },
  });

  return {
    // What the sign-in page needs to know. Nothing about any user.
    "GET /api/state": {
      auth: "public",
      handler: async (c) => ({ status: 200, body: { claimed: auth.ownerExists(), local: c.identity.kind === "local", passkeys: auth.ceremonyFor(one(c.req.headers["host"]) ?? "") !== undefined } }),
    },
    "POST /api/claim/begin": { auth: "public", handler: (c) => guarded(() => ({ status: 200, body: auth.claimBegin(obj(c.body)["code"], authContext(c)) })) },
    "POST /api/claim/finish": {
      auth: "public",
      handler: (c) =>
        guarded(async () => {
          const b = obj(c.body);
          const r = await auth.claimFinish({ claimId: b["claimId"], login: b["login"], displayName: b["displayName"], password: b["password"], totpCode: b["totpCode"], ...(b["passkey"] !== undefined ? { passkey: obj(b["passkey"]) as never } : {}) }, authContext(c));
          return loggedIn(r, { recoveryCodes: r.recoveryCodes });
        }),
    },
    "POST /api/login/password": {
      auth: "public",
      handler: (c) =>
        guarded(async () => {
          const b = obj(c.body);
          return loggedIn(await auth.loginPassword({ login: b["login"], password: b["password"], totpCode: b["totpCode"], recoveryCode: b["recoveryCode"] }, authContext(c)));
        }),
    },
    "POST /api/login/passkey/begin": { auth: "public", handler: (c) => guarded(() => ({ status: 200, body: auth.loginPasskeyBegin(obj(c.body)["login"], authContext(c)) })) },
    "POST /api/login/passkey/finish": {
      auth: "public",
      handler: (c) =>
        guarded(() => {
          const b = obj(c.body);
          return loggedIn(auth.loginPasskeyFinish({ login: b["login"], id: b["id"], clientDataJSON: b["clientDataJSON"], authenticatorData: b["authenticatorData"], signature: b["signature"] }, authContext(c)));
        }),
    },
    "POST /api/logout": {
      auth: "session",
      handler: async (c) => {
        if (c.session) {
          sessions.revoke(c.session.idHash);
          stack.audit.write({ kind: "logout", user: c.session.userId });
        }
        return { status: 200, body: { ok: true }, headers: { "Set-Cookie": clearCookie() } };
      },
    },
    /** A GET on purpose: after a reload the page has no CSRF token (the cookie is HttpOnly), so it asks here. Read-only; same-origin only; no CORS. */
    "GET /api/me": {
      auth: "session",
      handler: async (c) => {
        const s = c.session;
        if (!s) return { status: 401, body: { error: "no_session" } };
        const u = stack.users.read().users[s.userId];
        return { status: 200, body: { csrf: s.csrf, user: { displayName: u?.displayName ?? "", login: s.login, role: s.role }, stepUpFresh: Date.now() - s.stepUpAt < 5 * 60_000 } };
      },
    },
    "POST /api/stepup/options": {
      auth: "session",
      handler: (c) =>
        guarded(() => {
          const o = c.session ? auth.stepUpOptions(c.session, authContext(c)) : undefined;
          return { status: 200, body: { passkey: o ?? null } };
        }),
    },
    "POST /api/stepup": {
      auth: "session",
      handler: (c) =>
        guarded(() => {
          if (!c.session) return { status: 401, body: { error: "no_session" } };
          const b = obj(c.body);
          auth.stepUp(c.session, { totpCode: b["totpCode"], id: b["id"], clientDataJSON: b["clientDataJSON"], authenticatorData: b["authenticatorData"], signature: b["signature"] }, authContext(c));
          return { status: 200, body: { ok: true } };
        }),
    },
    "POST /api/account/passkey/begin": { auth: "session", stepUp: true, handler: (c) => guarded(() => ({ status: 200, body: c.session ? auth.passkeyRegisterBegin(c.session, authContext(c)) : {} })) },
    "POST /api/account/passkey/finish": {
      auth: "session",
      stepUp: true,
      handler: (c) =>
        guarded(() => {
          const b = obj(c.body);
          if (c.session) auth.passkeyRegisterFinish(c.session, { id: b["id"], clientDataJSON: b["clientDataJSON"], attestationObject: b["attestationObject"], label: b["label"] });
          return { status: 200, body: { ok: true } };
        }),
    },
    "POST /api/account/sessions": { auth: "session", handler: async (c) => ({ status: 200, body: { sessions: c.session ? sessions.list(c.session.userId, c.session.idHash) : [] } }) },
    "POST /api/account/sessions/revoke": {
      auth: "session",
      handler: async (c) => ({ status: 200, body: { ok: c.session ? sessions.revokeRef(c.session.userId, String(obj(c.body)["ref"] ?? "")) : false } }),
    },
    "POST /api/account/signout-everywhere": {
      auth: "session",
      handler: async (c) => {
        const n = c.session ? sessions.revokeUser(c.session.userId) : 0;
        if (c.session) stack.audit.write({ kind: "session_revoked", user: c.session.userId, detail: { count: n, reason: "signout_everywhere" } });
        return { status: 200, body: { ok: true, ended: n }, headers: { "Set-Cookie": clearCookie() } };
      },
    },
    "POST /api/account/recovery/regenerate": { auth: "session", stepUp: true, handler: async (c) => ({ status: 200, body: { recoveryCodes: c.session ? auth.regenerateRecovery(c.session.userId) : [] } }) },
    // Owner lockdown (also the web side of the Telegram /killswitch): every session ends, including this one.
    "POST /api/admin/lockdown": {
      auth: "owner",
      stepUp: true,
      handler: async (c) => {
        const n = sessions.revokeAll();
        hooks.onLockdown?.();
        stack.audit.write({ kind: "lockdown", ...(c.session ? { user: c.session.userId } : {}), detail: { sessions: n, via: "web" } });
        return { status: 200, body: { ok: true, ended: n }, headers: { "Set-Cookie": clearCookie() } };
      },
    },
  };
}
