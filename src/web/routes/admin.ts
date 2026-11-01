/**
 * Routes for invites, the accept flow and user management (S32). Admin routes need an owner or admin session; the sensitive ones also need
 * a fresh step-up (I56). Targets are authority-checked inside `UserAdmin`; a client-supplied id never widens what the session may touch.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AuthError } from "../auth.js";
import { clearCookie, sessionCookie } from "../http.js";
import type { RouteCtx, RouteDef, RouteResult } from "../server.js";
import type { WebStack } from "../stack.js";
import { AdminError } from "../users.js";
import type { UserAdmin } from "../users.js";
import { authContext, guarded, obj } from "./auth.js";

async function admin(fn: () => Promise<RouteResult> | RouteResult): Promise<RouteResult> {
  return guarded(async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AdminError) return { status: e.status, body: { error: "admin", message: e.message } };
      throw e;
    }
  });
}

/** The last `n` audit lines (newest last), parsed. Bodies are never in the audit, so there is nothing to hide here (I54). */
export function auditTail(dir: string, n = 200): unknown[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^web-\d{6}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const f of files.reverse()) {
    const lines = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
    for (const l of lines.reverse()) {
      try {
        out.unshift(JSON.parse(l));
      } catch {
        /* skip a damaged line */
      }
      if (out.length >= n) return out;
    }
  }
  return out;
}

export function adminRoutes(stack: WebStack, users: UserAdmin): Record<string, RouteDef> {
  const me = (c: RouteCtx): string => c.session?.userId ?? "";
  const sessionBody = (r: Awaited<ReturnType<UserAdmin["inviteFinish"]>>): RouteResult => ({
    status: 200,
    body: { ok: true, csrf: r.csrf, user: { displayName: r.displayName, role: r.role }, recoveryCodes: r.recoveryCodes },
    headers: { "Set-Cookie": sessionCookie(r.sessionId, r.maxAgeSec) },
  });
  return {
    "POST /api/invite/begin": { auth: "public", handler: (c) => guarded(() => ({ status: 200, body: users.inviteBegin(obj(c.body)["code"], authContext(c)) })) },
    "POST /api/invite/finish": {
      auth: "public",
      handler: (c) =>
        guarded(async () => {
          const b = obj(c.body);
          return sessionBody(await users.inviteFinish({ token: b["token"], code: b["code"], displayName: b["displayName"], password: b["password"], totpCode: b["totpCode"], ...(b["passkey"] !== undefined ? { passkey: obj(b["passkey"]) as never } : {}) }, authContext(c)));
        }),
    },
    "POST /api/admin/users": { auth: "admin", handler: (c) => admin(() => ({ status: 200, body: { users: users.listUsers(me(c)) } })) },
    "POST /api/admin/invites": { auth: "admin", handler: (c) => admin(() => ({ status: 200, body: { invites: users.listInvites(me(c)) } })) },
    "POST /api/admin/invites/create": {
      auth: "admin",
      stepUp: true,
      handler: (c) => admin(() => ({ status: 200, body: users.createInvite(me(c), obj(c.body)) })),
    },
    "POST /api/admin/invites/revoke": { auth: "admin", handler: (c) => admin(() => (users.revokeInvite(me(c), obj(c.body)["id"]), { status: 200, body: { ok: true } })) },
    "POST /api/admin/users/caps": { auth: "admin", stepUp: true, handler: (c) => admin(() => (users.setCaps(me(c), obj(c.body)["id"], obj(c.body)["caps"]), { status: 200, body: { ok: true } })) },
    "POST /api/admin/users/role": { auth: "owner", stepUp: true, handler: (c) => admin(() => (users.setRole(me(c), obj(c.body)["id"], obj(c.body)["role"]), { status: 200, body: { ok: true } })) },
    "POST /api/admin/users/disable": { auth: "admin", stepUp: true, handler: (c) => admin(() => (users.disableUser(me(c), obj(c.body)["id"]), { status: 200, body: { ok: true } })) },
    "POST /api/admin/users/enable": { auth: "admin", stepUp: true, handler: (c) => admin(() => (users.enableUser(me(c), obj(c.body)["id"]), { status: 200, body: { ok: true } })) },
    "POST /api/admin/users/delete": {
      auth: "owner",
      stepUp: true,
      handler: (c) => admin(() => (users.deleteUser(me(c), obj(c.body)["id"], obj(c.body)["confirm"]), { status: 200, body: { ok: true } })),
    },
    "POST /api/admin/audit": { auth: "owner", handler: async () => ({ status: 200, body: { events: auditTail(stack.paths.auditDir) } }) },
  };
}

export { AuthError, clearCookie };
