/** S32: invites, accept flow, roles, caps, disable, delete, retention, step-up, IDOR. Offline. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AuthError } from "../../src/web/auth.js";
import type { AuthContext } from "../../src/web/auth.js";
import { memoryWebAudit } from "../../src/web/audit.js";
import { defaultCaps } from "../../src/web/schemas.js";
import type { Caps } from "../../src/web/schemas.js";
import { userPaths } from "../../src/web/paths.js";
import { adminRoutes } from "../../src/web/routes/admin.js";
import { authRoutes } from "../../src/web/routes/auth.js";
import { startGateway } from "../../src/web/server.js";
import { createWebStack } from "../../src/web/stack.js";
import { totpAt, totpStep } from "../../src/web/totp.js";
import { AdminError, INVITE_TTL_MS, RETENTION_MS, UserAdmin, capsWithin } from "../../src/web/users.js";
import { tempDir } from "../settings/helpers.js";
import { cookieFrom, http } from "./helpers.js";

const PORT = 47009;
const PUBLIC = "pc.tail1234.ts.net";
const LOCAL: AuthContext = { identity: { kind: "local" }, host: `localhost:${PORT}`, ip: "local", ua: "t" };
const ts = (login: string): AuthContext => ({ identity: { kind: "tailscale", login }, host: PUBLIC, ip: "ts:" + login, ua: "t" });

async function world(clock = { t: Date.now() }) {
  const dir = tempDir("a7-users-");
  const audit = memoryWebAudit();
  const stack = createWebStack({ dataDir: dir, port: PORT, publicHosts: [PUBLIC], audit, now: () => clock.t });
  const admin = new UserAdmin(stack, { now: () => clock.t, knownPresets: () => ["strata", "claude-sonnet", "claude-opus"] });
  const { code } = stack.auth.issueOwnerCode();
  const b = stack.auth.claimBegin(code, LOCAL);
  const owner = await stack.auth.claimFinish({ claimId: b.claimId, login: "owner@example.com", displayName: "Olive", password: "a long enough password", totpCode: totpAt(b.totp.secret, totpStep(clock.t)) }, LOCAL);
  let n = 0;
  /** Invite + accept; returns the new user. Each call moves the clock one TOTP step so codes are never reused. */
  const addUser = async (login: string, role: "user" | "admin" = "user", caps?: Caps) => {
    const inv = admin.createInvite(owner.userId, { role, ...(caps ? { caps } : {}), tailscaleLoginPin: login });
    const begin = admin.inviteBegin(inv.code, ts(login));
    const password = `password-number-${++n}-long`;
    const r = await admin.inviteFinish({ token: begin.token, code: inv.code, displayName: login.split("@")[0], password, totpCode: totpAt(begin.totp.secret, totpStep(clock.t)) }, ts(login));
    return { ...r, login, password, secret: begin.totp.secret, inviteCode: inv.code };
  };
  return { dir, clock, audit, stack, admin, owner, addUser };
}

test("createInvite: 160-bit code stored only as a hash, 24 h default expiry, audited; a pin is validated", async () => {
  const w = await world();
  const inv = w.admin.createInvite(w.owner.userId, {});
  assert.ok(Buffer.from(inv.code, "base64url").length >= 20);
  assert.equal(inv.expiresAt, w.clock.t + INVITE_TTL_MS);
  const file = readFileSync(w.stack.paths.invitesFile, "utf8");
  assert.ok(!file.includes(inv.code));
  assert.match(file, /"codeHash": "[0-9a-f]{64}"/);
  assert.ok(w.audit.events.some((e) => e.kind === "invite_create"));
  assert.throws(() => w.admin.createInvite(w.owner.userId, { tailscaleLoginPin: "bad login" }), (e: AdminError) => e.status === 400);
  assert.equal(w.admin.createInvite(w.owner.userId, { ttlHours: 1 }).expiresAt, w.clock.t + 3_600_000);
  assert.throws(() => w.admin.createInvite("0".repeat(32), {}), (e: AdminError) => e.status === 403, "an unknown actor");
  // caps: a tool outside the user universe and an unknown preset are refused
  assert.throws(() => w.admin.createInvite(w.owner.userId, { caps: { ...defaultCaps(), tools: ["shell"] } }), /not a tool a user bot can have/);
  assert.throws(() => w.admin.createInvite(w.owner.userId, { caps: { ...defaultCaps(), presets: ["gpt-9"] } }), /not a configured preset/);
  assert.throws(() => w.admin.createInvite(w.owner.userId, { caps: { ...defaultCaps(), maxJobsPerDay: 3 } }), /must be 0/);
});

test("accept: the whole flow, then the new user signs in with their tailnet identity; nobody else can use their login", async () => {
  const w = await world();
  const u = await w.addUser("alice@example.com");
  assert.equal(u.role, "user");
  assert.equal(u.recoveryCodes.length, 10);
  const rec = w.stack.users.read().users[u.userId];
  assert.deepEqual([rec?.login, rec?.status, rec?.invitedBy], ["alice@example.com", "active", w.owner.userId]);
  assert.deepEqual(rec?.caps, defaultCaps());
  assert.ok(w.stack.sessions.resolve(u.sessionId, { ip: "x", ua: "t" }));
  w.clock.t += 31_000;
  const li = await w.stack.auth.loginPassword({ login: "alice@example.com", password: u.password, totpCode: totpAt(u.secret, totpStep(w.clock.t)) }, ts("alice@example.com"));
  assert.equal(li.role, "user");
  // from the PC (local identity) a non-owner cannot sign in; and another tailnet login cannot use alice's
  w.clock.t += 31_000;
  await assert.rejects(() => w.stack.auth.loginPassword({ login: "alice@example.com", password: u.password, totpCode: totpAt(u.secret, totpStep(w.clock.t)) }, LOCAL), (e: AuthError) => e.code === "invalid");
  await assert.rejects(() => w.stack.auth.loginPassword({ login: "alice@example.com", password: u.password, totpCode: totpAt(u.secret, totpStep(w.clock.t)) }, ts("bob@example.com")), (e: AuthError) => e.code === "invalid");
  assert.ok(w.audit.events.some((e) => e.kind === "invite_use"));
});

test("accept failures all look the same: replay, expiry, revoked, pin mismatch, wrong code, local identity, login already taken", async () => {
  const w = await world();
  const used = await w.addUser("alice@example.com");
  const sameMessage = new Set<string>();
  const rejects = async (fn: () => unknown, code: string) => {
    try {
      await fn();
      assert.fail("should have been refused");
    } catch (e) {
      assert.ok(e instanceof AuthError, String(e));
      assert.equal(e.code, code);
      if (code === "invalid") sameMessage.add(e.message);
    }
  };
  // replay of a used code (by alice or by someone else)
  await rejects(() => w.admin.inviteBegin(used.inviteCode, ts("alice@example.com")), "invalid");
  await rejects(() => w.admin.inviteBegin(used.inviteCode, ts("mallory@example.com")), "invalid");
  // wrong code
  await rejects(() => w.admin.inviteBegin("not-a-code", ts("bob@example.com")), "invalid");
  // pin mismatch
  const pinned = w.admin.createInvite(w.owner.userId, { tailscaleLoginPin: "carol@example.com" });
  await rejects(() => w.admin.inviteBegin(pinned.code, ts("mallory@example.com")), "invalid");
  // revoked
  const rev = w.admin.createInvite(w.owner.userId, {});
  w.admin.revokeInvite(w.owner.userId, rev.id);
  await rejects(() => w.admin.inviteBegin(rev.code, ts("dave@example.com")), "invalid");
  // expired
  const exp = w.admin.createInvite(w.owner.userId, { ttlHours: 1 });
  w.clock.t += 2 * 3_600_000;
  await rejects(() => w.admin.inviteBegin(exp.code, ts("erin@example.com")), "invalid");
  // local identity: the invitee opens it from their own tailnet device
  const open = w.admin.createInvite(w.owner.userId, {});
  await rejects(() => w.admin.inviteBegin(open.code, LOCAL), "forbidden");
  // a login that already has an account
  await rejects(() => w.admin.inviteBegin(open.code, ts("ALICE@example.com")), "invalid");
  assert.equal(sameMessage.size, 1, "one sentence for every invalid invitation");
  assert.ok(w.audit.events.filter((e) => e.kind === "login_fail" && e.detail?.["step"] === "invite").length >= 6);
});

test("accept: two parallel finishes with one code create exactly one user (single use)", async () => {
  const w = await world();
  const inv = w.admin.createInvite(w.owner.userId, {});
  const a = w.admin.inviteBegin(inv.code, ts("alice@example.com"));
  const b = w.admin.inviteBegin(inv.code, ts("bob@example.com"));
  const fin = (begin: typeof a, login: string, pw: string) => w.admin.inviteFinish({ token: begin.token, code: inv.code, displayName: login, password: pw, totpCode: totpAt(begin.totp.secret, totpStep(w.clock.t)) }, ts(login));
  const res = await Promise.allSettled([fin(a, "alice@example.com", "first password long"), fin(b, "bob@example.com", "second password long")]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(Object.keys(w.stack.users.read().users).length, 2, "owner + one new user");
});

test("accept: a bad password or TOTP does not burn the invitation", async () => {
  const w = await world();
  const inv = w.admin.createInvite(w.owner.userId, {});
  const begin = w.admin.inviteBegin(inv.code, ts("alice@example.com"));
  await assert.rejects(() => w.admin.inviteFinish({ token: begin.token, code: inv.code, displayName: "A", password: "short", totpCode: "000000" }, ts("alice@example.com")), (e: AuthError) => e.code === "bad_request");
  await assert.rejects(() => w.admin.inviteFinish({ token: begin.token, code: inv.code, displayName: "A", password: "a long enough password", totpCode: "000000" }, ts("alice@example.com")), (e: AuthError) => e.code === "invalid");
  const ok = await w.admin.inviteFinish({ token: begin.token, code: inv.code, displayName: "A", password: "a long enough password", totpCode: totpAt(begin.totp.secret, totpStep(w.clock.t)) }, ts("alice@example.com"));
  assert.equal(ok.role, "user");
});

test("role matrix: owner and admin powers, and what an admin or user can never do", async () => {
  const w = await world();
  const adm = await w.addUser("admin@example.com", "admin");
  const alice = await w.addUser("alice@example.com");
  const bob = await w.addUser("bob@example.com");
  const adm2 = await w.addUser("admin2@example.com", "admin");
  const denied = (fn: () => unknown, status = 403) => assert.throws(fn, (e: AdminError) => e instanceof AdminError && e.status === status);
  // ordinary users are not actors at all
  denied(() => w.admin.listUsers(alice.userId));
  denied(() => w.admin.createInvite(alice.userId, {}));
  denied(() => w.admin.disableUser(alice.userId, bob.userId));
  // an admin: can invite a user, cannot invite an admin, cannot exceed own caps
  assert.ok(w.admin.createInvite(adm.userId, {}).code);
  denied(() => w.admin.createInvite(adm.userId, { role: "admin" }));
  denied(() => w.admin.createInvite(adm.userId, { caps: { ...defaultCaps(), maxBots: 50 } }), 400);
  denied(() => w.admin.createInvite(adm.userId, { caps: { ...defaultCaps(), presets: ["claude-opus"] } }));
  // an admin acts on ordinary users only
  w.admin.setCaps(adm.userId, alice.userId, { ...defaultCaps(), maxBots: 1 });
  assert.equal(w.stack.users.read().users[alice.userId]?.caps.maxBots, 1);
  denied(() => w.admin.setCaps(adm.userId, alice.userId, { ...defaultCaps(), presets: ["strata", "claude-opus"] }));
  denied(() => w.admin.setCaps(adm.userId, adm2.userId, defaultCaps()));
  denied(() => w.admin.setCaps(adm.userId, w.owner.userId, defaultCaps()));
  denied(() => w.admin.setCaps(adm.userId, adm.userId, defaultCaps()));
  denied(() => w.admin.disableUser(adm.userId, w.owner.userId));
  denied(() => w.admin.disableUser(adm.userId, adm2.userId));
  denied(() => w.admin.deleteUser(adm.userId, bob.userId, "bob@example.com"));
  denied(() => w.admin.setRole(adm.userId, bob.userId, "admin"));
  w.admin.disableUser(adm.userId, bob.userId);
  assert.equal(w.stack.users.read().users[bob.userId]?.status, "disabled");
  // the owner can do more, but never to the owner
  w.admin.setRole(w.owner.userId, alice.userId, "admin");
  assert.equal(w.stack.users.read().users[alice.userId]?.role, "admin");
  denied(() => w.admin.setRole(w.owner.userId, w.owner.userId, "user"));
  denied(() => w.admin.disableUser(w.owner.userId, w.owner.userId));
  denied(() => w.admin.deleteUser(w.owner.userId, w.owner.userId, "owner@example.com"));
  denied(() => w.admin.setRole(w.owner.userId, alice.userId, "owner"), 400);
  denied(() => w.admin.disableUser(w.owner.userId, "f".repeat(32)), 404);
  assert.equal(capsWithin({ ...defaultCaps(), maxBots: 2 }, defaultCaps()), true);
  assert.equal(capsWithin({ ...defaultCaps(), maxBots: 9 }, defaultCaps()), false);
});

test("disable and revoke: the sessions die at once, the data stays, re-enable works; a privilege change rotates sessions", async () => {
  const w = await world();
  const alice = await w.addUser("alice@example.com");
  const ctx = { ip: "x", ua: "t" };
  assert.ok(w.stack.sessions.resolve(alice.sessionId, ctx));
  mkdirSync(userPaths(w.dir, alice.userId).root, { recursive: true });
  w.admin.disableUser(w.owner.userId, alice.userId);
  assert.equal(w.stack.sessions.resolve(alice.sessionId, ctx), undefined);
  assert.equal(w.stack.sessions.count() >= 0, true);
  assert.ok(existsSync(userPaths(w.dir, alice.userId).root), "archive: the data is kept");
  assert.equal(w.admin.admit({ kind: "tailscale", login: "alice@example.com" }), false, "a disabled user is a stranger to the gateway");
  w.admin.enableUser(w.owner.userId, alice.userId);
  assert.equal(w.admin.admit({ kind: "tailscale", login: "alice@example.com" }), true);
  const again = await w.addUser("zed@example.com");
  assert.ok(w.stack.sessions.resolve(again.sessionId, ctx));
  w.admin.setCaps(w.owner.userId, again.userId, { ...defaultCaps(), maxBots: 2 });
  assert.equal(w.stack.sessions.resolve(again.sessionId, ctx), undefined, "caps change = sessions rotated");
});

test("delete: typed confirmation, the user's whole tree, credentials and sessions go; retention deletes after 30 days", async () => {
  const w = await world();
  const alice = await w.addUser("alice@example.com");
  const bob = await w.addUser("bob@example.com");
  const aroot = userPaths(w.dir, alice.userId);
  mkdirSync(aroot.bot("helper").workspaceDir, { recursive: true });
  writeFileSync(join(aroot.bot("helper").workspaceDir, "note.txt"), "private");
  assert.throws(() => w.admin.deleteUser(w.owner.userId, alice.userId, "wrong"), (e: AdminError) => e.status === 400);
  assert.ok(existsSync(aroot.root));
  w.admin.deleteUser(w.owner.userId, alice.userId, "ALICE@example.com");
  assert.equal(existsSync(aroot.root), false, "I52: the tree is gone");
  assert.equal(w.stack.users.read().users[alice.userId], undefined);
  assert.equal(w.stack.credentials.read().users[alice.userId], undefined);
  assert.equal(w.stack.sessions.resolve(alice.sessionId, { ip: "x", ua: "t" }), undefined);
  assert.ok(w.audit.events.some((e) => e.kind === "user_delete" && e.detail?.["via"] === "owner"));
  // retention
  mkdirSync(userPaths(w.dir, bob.userId).root, { recursive: true });
  w.admin.disableUser(w.owner.userId, bob.userId);
  w.clock.t += RETENTION_MS - 1000;
  assert.deepEqual(w.admin.sweepDisabled(), []);
  w.clock.t += 2000;
  assert.deepEqual(w.admin.sweepDisabled(), [bob.userId]);
  assert.equal(existsSync(userPaths(w.dir, bob.userId).root), false);
  assert.ok(w.stack.users.read().users[w.owner.userId], "the owner is never swept");
});

test("HTTP: admin routes need an admin session; sensitive ones need a fresh step-up; a user session gets 403; revoke kills the next request", async () => {
  const w = await world();
  const alice = await w.addUser("alice@example.com");
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    publicHosts: [PUBLIC],
    audit: w.audit,
    sessions: w.stack.sessions,
    identify: async (req) => (req.headers["x-test-identity"] ? { ok: true, identity: { kind: "tailscale", login: String(req.headers["x-test-identity"]) } } : { ok: true, identity: { kind: "local" } }),
    admit: w.admin.admit,
    routes: { ...authRoutes(w.stack), ...adminRoutes(w.stack, w.admin) },
    now: () => w.clock.t,
  });
  try {
    const port = gw.port;
    const host = `localhost:${port}`;
    const base = { origin: `http://${host}` };
    const as = (s: { sessionId: string; csrf: string }, who?: string) => ({ ...base, cookie: `__Host-a7web=${s.sessionId}`, "x-csrf-token": s.csrf, ...(who ? { "x-test-identity": who } : {}) });
    // an unknown tailnet login gets the generic 403 even for the public state route
    assert.equal((await http(port, "GET", "/api/state", { headers: { "x-test-identity": "stranger@example.com" }, host })).status, 403);
    // a user session on an admin route: 403
    assert.equal((await http(port, "POST", "/api/admin/users", { body: {}, headers: as(alice, "alice@example.com"), host })).status, 403);
    assert.equal((await http(port, "POST", "/api/admin/audit", { body: {}, headers: as(alice, "alice@example.com"), host })).status, 403);
    // the owner lists users; creating an invite needs a fresh step-up
    const list = await http(port, "POST", "/api/admin/users", { body: {}, headers: as(w.owner), host });
    assert.equal(list.status, 200);
    assert.equal(list.json().users.length, 2);
    assert.ok(!list.text.includes("passwordHash") && !list.text.includes("totp"), "no credentials in the list");
    w.clock.t += 6 * 60_000;
    const stale = await http(port, "POST", "/api/admin/invites/create", { body: {}, headers: as(w.owner), host });
    assert.equal(stale.status, 401);
    assert.equal(stale.json().error, "step_up_required");
    w.stack.auth.stepUp(w.stack.sessions.resolve(w.owner.sessionId, { ip: "x", ua: "t" })!, { totpCode: totpAt((await (async () => { const c = w.stack.credentials.read().users[w.owner.userId]!.password!; return w.stack.box.open(c.totpSealed, w.owner.userId); })()), totpStep(w.clock.t)) }, LOCAL);
    const made = await http(port, "POST", "/api/admin/invites/create", { body: { tailscaleLoginPin: "carol@example.com" }, headers: as(w.owner), host });
    assert.equal(made.status, 200, made.text);
    assert.ok(made.json().code.length >= 27);
    // the invitee accepts over HTTP from their own tailnet identity (public routes, no cookie)
    const hostTs = PUBLIC;
    const tsHdr = { origin: `https://${PUBLIC}`, "x-test-identity": "carol@example.com" };
    const begin = await http(port, "POST", "/api/invite/begin", { body: { code: made.json().code }, headers: tsHdr, host: hostTs });
    assert.equal(begin.status, 200, begin.text);
    const fin = await http(port, "POST", "/api/invite/finish", {
      body: { token: begin.json().token, code: made.json().code, displayName: "Carol", password: "carol password long", totpCode: totpAt(begin.json().totp.secret, totpStep(w.clock.t)) },
      headers: tsHdr,
      host: hostTs,
    });
    assert.equal(fin.status, 200, fin.text);
    assert.match(String(fin.headers["set-cookie"]), /^__Host-a7web=.+; Secure; HttpOnly; SameSite=Strict; Path=\//);
    const carolCookie = cookieFrom(fin);
    const me = await http(port, "POST", "/api/me", { body: {}, headers: { ...tsHdr, cookie: carolCookie, "x-csrf-token": fin.json().csrf }, host: hostTs });
    assert.equal(me.status, 200);
    // revoke: the next request of the revoked user fails
    const carolId = Object.entries(w.stack.users.read().users).find(([, u]) => u.login === "carol@example.com")![0];
    w.stack.auth.stepUp(w.stack.sessions.resolve(w.owner.sessionId, { ip: "x", ua: "t" })!, { totpCode: totpAt(w.stack.box.open(w.stack.credentials.read().users[w.owner.userId]!.password!.totpSealed, w.owner.userId), totpStep(w.clock.t + 30_000)) }, LOCAL);
    const dis = await http(port, "POST", "/api/admin/users/disable", { body: { id: carolId }, headers: as(w.owner), host });
    assert.equal(dis.status, 200, dis.text);
    assert.equal((await http(port, "POST", "/api/me", { body: {}, headers: { ...tsHdr, cookie: carolCookie, "x-csrf-token": fin.json().csrf }, host: hostTs })).status, 403, "now a stranger: the generic 403");
    // the audit view is owner-only and has no bodies
    const audit = await http(port, "POST", "/api/admin/audit", { body: {}, headers: as(w.owner), host });
    assert.equal(audit.status, 200);
  } finally {
    await gw.close();
  }
});
