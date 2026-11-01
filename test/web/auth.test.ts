/** S31: TOTP vectors, WebAuthn with a software authenticator, owner claim, login matrix, sessions, CLI. Offline. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { AuthError, GENERIC_FAIL } from "../../src/web/auth.js";
import type { AuthContext } from "../../src/web/auth.js";
import { runWebCli } from "../../src/web/cli.js";
import { memoryWebAudit } from "../../src/web/audit.js";
import { sha256Hex } from "../../src/web/crypto.js";
import { authRoutes } from "../../src/web/routes/auth.js";
import { startGateway } from "../../src/web/server.js";
import { ABSOLUTE_MS, IDLE_MS } from "../../src/web/sessions.js";
import { createWebStack } from "../../src/web/stack.js";
import { base32Encode, totpAt, totpStep, verifyTotp } from "../../src/web/totp.js";
import { ChallengeStore, WebAuthnError, cborDecode, creationOptions, finishAuthentication, finishRegistration, requestOptions } from "../../src/web/webauthn.js";
import { tempDir } from "../settings/helpers.js";
import { cookieFrom, http } from "./helpers.js";
import { SoftAuthenticator, cborEncode } from "./softAuthenticator.js";

const PORT = 47009;
const PUBLIC = "pc.tail1234.ts.net";
const LOCAL: AuthContext = { identity: { kind: "local" }, host: `localhost:${PORT}`, ip: "local", ua: "test" };
const tsCtx = (login: string, ip = "ts:" + login): AuthContext => ({ identity: { kind: "tailscale", login }, host: PUBLIC, ip, ua: "test" });

function mkStack(clock = { t: 1_800_000_000_000 }) {
  const dir = tempDir("a7-auth-");
  const audit = memoryWebAudit();
  const alerts: string[] = [];
  const stack = createWebStack({ dataDir: dir, port: PORT, publicHosts: [PUBLIC], audit, now: () => clock.t, onLockout: (k) => alerts.push(k) });
  return { dir, clock, audit, alerts, stack };
}

async function claimOwner(s: ReturnType<typeof mkStack>, login = "owner@example.com", password = "a long enough password") {
  const { code } = s.stack.auth.issueOwnerCode();
  const begin = s.stack.auth.claimBegin(code, LOCAL);
  const r = await s.stack.auth.claimFinish({ claimId: begin.claimId, login, displayName: "Olive", password, totpCode: totpAt(begin.totp.secret, totpStep(s.clock.t)) }, LOCAL);
  return { ...r, secret: begin.totp.secret, login, password };
}

test("TOTP: RFC 6238 vectors, base32 round trip, a window of one step, and a code is single use", () => {
  const key = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(totpAt(key, 1, 8), "94287082");
  assert.equal(totpAt(key, 37037036, 8), "07081804");
  assert.equal(totpAt(key, 37037037, 8), "14050471");
  assert.equal(totpAt(key, 41152263, 8), "89005924");
  const now = 59_000 + 30_000 * 5;
  const cur = totpAt(key, totpStep(now));
  assert.equal(verifyTotp(key, cur, now, 0), totpStep(now));
  assert.equal(verifyTotp(key, totpAt(key, totpStep(now) - 1), now, 0), totpStep(now) - 1, "one step back is allowed");
  assert.equal(verifyTotp(key, totpAt(key, totpStep(now) + 2), now, 0), undefined, "two steps ahead is not");
  assert.equal(verifyTotp(key, cur, now, totpStep(now)), undefined, "replay of the same step");
  assert.equal(verifyTotp(key, "12345", now, 0), undefined);
  assert.equal(verifyTotp(key, "abcdef", now, 0), undefined);
});

test("CBOR decode handles the shapes WebAuthn uses and refuses junk", () => {
  const m = new Map<number | string, number | Buffer | string>([[1, 2], [-7, Buffer.from("ab")], ["fmt", "none"]]);
  const r = cborDecode(cborEncode(m as never)).value as Map<unknown, unknown>;
  assert.equal(r.get(1), 2);
  assert.equal(r.get(-7)?.toString(), "ab");
  assert.equal(r.get("fmt"), "none");
  assert.throws(() => cborDecode(Buffer.alloc(0)));
  assert.throws(() => cborDecode(Buffer.from([0x5f])), /indefinite/);
  assert.throws(() => cborDecode(Buffer.from([0x42, 1])), /truncated/);
});

test("WebAuthn registration and authentication with a software authenticator, and every way to get it wrong", () => {
  const rp = { rpId: PUBLIC, origin: `https://${PUBLIC}` };
  const store = new ChallengeStore();
  const dev = new SoftAuthenticator();
  const userId = "a".repeat(32);
  const reg = (t = {}, challengeFor?: () => string) => {
    const opts = creationOptions(store, { ...rp, userId, login: "a@x.com", displayName: "A", existing: [] });
    return finishRegistration(store, dev.create({ challenge: challengeFor ? challengeFor() : opts.challenge, ...rp }, t));
  };
  const pk = reg();
  assert.equal(pk.id, dev.id);
  assert.equal(pk.userId, userId);
  assert.equal(pk.signCount, 0);
  let stored = { id: pk.id, publicKey: pk.publicKey, signCount: 0 };
  const authn = (t = {}, key = stored, o: { rpId: string; origin: string } = rp) => {
    const opts = requestOptions(store, { ...o, credentialIds: [pk.id] });
    return finishAuthentication(store, dev.get({ challenge: opts.challenge, ...rp }, t), (id) => (id === key.id ? key : undefined));
  };
  const ok = authn();
  assert.equal(ok.credentialId, pk.id);
  assert.equal(ok.signCount, 1);
  stored = { ...stored, signCount: ok.signCount };
  // registration failures
  const bad = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error) => e instanceof WebAuthnError && re.test(e.message));
  bad(() => reg({ flags: 0x41 }), /user verification/);
  bad(() => reg({ flags: 0x44 }), /user presence/);
  bad(() => reg({ flags: 0x05 }), /no credential data/);
  bad(() => reg({ rpId: "evil.example" }), /rpId hash/);
  bad(() => reg({ origin: "https://evil.example" }), /origin/);
  bad(() => reg({ fmt: "packed" }), /attestation none/);
  bad(() => reg({ alg: -257 }), /ES256/);
  bad(() => reg({ type: "webauthn.get" }), /ceremony type/);
  bad(() => reg({ crossOrigin: true }), /cross-origin/);
  bad(() => reg({}, () => "AAAA"), /challenge/);
  // a challenge is single use
  const opts = creationOptions(store, { ...rp, userId, login: "a@x.com", displayName: "A", existing: [] });
  const resp = dev.create({ challenge: opts.challenge, ...rp });
  finishRegistration(store, resp);
  bad(() => finishRegistration(store, resp), /challenge/);
  // authentication failures
  bad(() => authn({ badSignature: true }), /signature/);
  bad(() => authn({ counter: 1 }), /counter/);
  bad(() => authn({}, { ...stored, signCount: 50 }), /counter/);
  bad(() => authn({ flags: 0x01 }), /user verification/);
  bad(() => authn({ rpId: "evil.example" }), /rpId hash/);
  bad(() => authn({ origin: "https://evil.example" }), /origin/);
  const other = new SoftAuthenticator();
  const o2 = requestOptions(store, { ...rp, credentialIds: [] });
  bad(() => finishAuthentication(store, other.get({ challenge: o2.challenge, ...rp }), () => undefined), /unknown credential/);
  const o3 = requestOptions(store, { ...rp, credentialIds: [] });
  const forged = other.get({ challenge: o3.challenge, ...rp });
  bad(() => finishAuthentication(store, { ...forged, id: dev.id }, (id) => (id === stored.id ? stored : undefined)), /signature/);
  // a challenge from the wrong ceremony kind
  const create2 = creationOptions(store, { ...rp, userId, login: "a@x.com", displayName: "A", existing: [] });
  bad(() => finishAuthentication(store, dev.get({ challenge: create2.challenge, ...rp }), () => stored), /challenge/);
  // expiry
  let t = 0;
  const st2 = new ChallengeStore(() => t);
  const o4 = requestOptions(st2, { ...rp, credentialIds: [] });
  t += 6 * 60_000;
  bad(() => finishAuthentication(st2, dev.get({ challenge: o4.challenge, ...rp }), () => stored), /expired/);
});

test("claim: loopback only, code single use and 10 minutes, second claim refused, recovery codes stored hashed", async () => {
  const s = mkStack();
  const { code } = s.stack.auth.issueOwnerCode();
  const file = JSON.parse(readFileSync(s.stack.paths.claimFile, "utf8"));
  assert.ok(!JSON.stringify(file).includes(code), "only the hash is stored");
  // a tailnet identity cannot claim, even with the right code
  assert.throws(() => s.stack.auth.claimBegin(code, tsCtx("owner@example.com")), (e: AuthError) => e.code === "forbidden");
  // a wrong code
  assert.throws(() => s.stack.auth.claimBegin("nope", LOCAL), (e: AuthError) => e.code === "invalid");
  // expiry
  s.clock.t += 10 * 60_000 + 1;
  assert.throws(() => s.stack.auth.claimBegin(code, LOCAL), (e: AuthError) => e.code === "invalid");
  s.clock.t -= 10 * 60_000 + 1;
  const begin = s.stack.auth.claimBegin(code, LOCAL);
  assert.match(begin.totp.uri, /^otpauth:\/\/totp\/agent-007:owner\?secret=[A-Z2-7]+/);
  assert.ok(begin.passkey, "localhost allows passkeys");
  assert.equal(s.stack.auth.claimBegin(code, { ...LOCAL, host: `127.0.0.1:${PORT}` }).passkey, undefined, "an IP cannot be an RP ID");
  // bad inputs
  await assert.rejects(() => s.stack.auth.claimFinish({ claimId: begin.claimId, login: "owner@example.com", displayName: "O", password: "short", totpCode: "000000" }, LOCAL), (e: AuthError) => e.code === "bad_request");
  await assert.rejects(() => s.stack.auth.claimFinish({ claimId: begin.claimId, login: "owner@example.com", displayName: "O", password: "a long enough password", totpCode: "000000" }, LOCAL), (e: AuthError) => e.code === "invalid");
  const r = await s.stack.auth.claimFinish({ claimId: begin.claimId, login: "owner@example.com", displayName: "O", password: "a long enough password", totpCode: totpAt(begin.totp.secret, totpStep(s.clock.t)) }, LOCAL);
  assert.equal(r.role, "owner");
  assert.equal(r.recoveryCodes.length, 10);
  const creds = JSON.parse(readFileSync(s.stack.paths.credentialsFile, "utf8"));
  const text = JSON.stringify(creds);
  for (const c of r.recoveryCodes) assert.ok(!text.includes(c), "recovery codes are hashed");
  assert.ok(!text.includes(begin.totp.secret), "the TOTP secret is sealed");
  assert.ok(!text.includes("a long enough password"));
  assert.equal(existsSync(s.stack.paths.claimFile), false, "the code is consumed");
  // second claim: refused
  assert.throws(() => s.stack.auth.issueOwnerCode(), (e: AuthError) => e.code === "forbidden");
  assert.throws(() => s.stack.auth.claimBegin(code, LOCAL), (e: AuthError) => e.code === "invalid");
  assert.equal(s.stack.auth.ownerExists(), true);
  assert.ok(s.audit.events.some((e) => e.kind === "claim" && e.detail?.["step"] === "claimed"));
});

test("claim with a passkey, and --reset re-enrols the owner, replaces the credentials and ends every session", async () => {
  const s = mkStack();
  const { code } = s.stack.auth.issueOwnerCode();
  const begin = s.stack.auth.claimBegin(code, LOCAL);
  const dev = new SoftAuthenticator();
  const att = dev.create({ challenge: begin.passkey!.challenge, rpId: "localhost", origin: `http://localhost:${PORT}` });
  const r = await s.stack.auth.claimFinish({ claimId: begin.claimId, login: "owner@example.com", displayName: "O", passkey: att }, LOCAL);
  assert.equal(s.stack.credentials.read().users[r.userId]?.passkeys.length, 1);
  assert.equal(s.stack.credentials.read().users[r.userId]?.password, undefined);
  // sign in with the passkey at localhost
  const lo = s.stack.auth.loginPasskeyBegin("owner@example.com", LOCAL);
  const li = s.stack.auth.loginPasskeyFinish({ login: "owner@example.com", ...dev.get({ challenge: lo.challenge, rpId: "localhost", origin: `http://localhost:${PORT}` }) }, LOCAL);
  assert.equal(li.userId, r.userId);
  assert.equal(s.stack.sessions.count(), 2);
  // reset: needs an owner, and the next claim keeps the userId but replaces the credentials
  assert.throws(() => mkStack().stack.auth.issueOwnerCode({ reset: true }), (e: AuthError) => e.code === "bad_request");
  const rs = s.stack.auth.issueOwnerCode({ reset: true });
  const b2 = s.stack.auth.claimBegin(rs.code, LOCAL);
  const r2 = await s.stack.auth.claimFinish({ claimId: b2.claimId, login: "owner@example.com", displayName: "O", password: "another long password", totpCode: totpAt(b2.totp.secret, totpStep(s.clock.t)) }, LOCAL);
  assert.equal(r2.userId, r.userId, "same owner id");
  assert.equal(s.stack.credentials.read().users[r.userId]?.passkeys.length, 0, "old passkeys gone");
  assert.equal(s.stack.sessions.count(), 1, "only the new session remains");
  assert.ok(s.audit.events.some((e) => e.kind === "claim" && e.detail?.["reset"] === true && e.detail?.["step"] === "claimed"));
});

test("password login: the same generic failure for every wrong input, TOTP replay refused, lockout after 5 with the owner told", async () => {
  const s = mkStack();
  const o = await claimOwner(s);
  s.clock.t += 31_000; // next TOTP step (the claim used one)
  const attempt = (over: Record<string, unknown> = {}, ctx = LOCAL) =>
    s.stack.auth.loginPassword({ login: o.login, password: o.password, totpCode: totpAt(o.secret, totpStep(s.clock.t)), ...over }, ctx);
  const good = await attempt();
  assert.equal(good.role, "owner");
  assert.ok(good.sessionId.length >= 40);
  const fails: string[] = [];
  const failing = async (over: Record<string, unknown>, ctx = LOCAL) => {
    try {
      await attempt(over, ctx);
      assert.fail("should have failed");
    } catch (e) {
      assert.ok(e instanceof AuthError);
      fails.push(e.message);
    }
  };
  s.clock.t += 31_000;
  await failing({ password: "the wrong password!!" });
  await failing({ login: "nobody@example.com" });
  await failing({ totpCode: "000000" });
  assert.deepEqual([...new Set(fails)], [GENERIC_FAIL], "no hint which factor or whether the user exists");
  // replay: a code that already signed in cannot be used again
  s.clock.t += 31_000;
  const code = totpAt(o.secret, totpStep(s.clock.t));
  await attempt({ totpCode: code, login: o.login });
  await assert.rejects(() => attempt({ totpCode: code }), (e: AuthError) => e.message === GENERIC_FAIL);
  // the identity binding: a tailnet identity with another login cannot use the owner's login
  s.clock.t += 31_000;
  await assert.rejects(() => attempt({}, tsCtx("mallory@example.com", "ip-m")), (e: AuthError) => e.message === GENERIC_FAIL);
  s.clock.t += 31_000;
  assert.equal((await attempt({}, tsCtx("owner@example.com", "ip-o"))).role, "owner", "the matching tailnet login works");
  // lockout: 5 failures in a row for a login
  const l = mkStack();
  const ow = await claimOwner(l);
  for (let i = 0; i < 5; i++) await assert.rejects(() => l.stack.auth.loginPassword({ login: ow.login, password: "x".repeat(14), totpCode: "000000" }, { ...LOCAL, ip: "client-" + i }));
  await assert.rejects(() => l.stack.auth.loginPassword({ login: ow.login, password: ow.password, totpCode: totpAt(ow.secret, totpStep(l.clock.t + 60_000)) }, LOCAL), (e: AuthError) => e.code === "locked" && (e.retryAfterSec ?? 0) > 800);
  assert.ok(l.alerts.some((k) => k.startsWith("login:")), "the owner is told");
  assert.ok(l.audit.events.some((e) => e.kind === "lockout"));
  l.clock.t += 16 * 60_000;
  assert.equal((await l.stack.auth.loginPassword({ login: ow.login, password: ow.password, totpCode: totpAt(ow.secret, totpStep(l.clock.t)) }, LOCAL)).role, "owner", "free again after 15 minutes");
});

test("recovery codes work once in place of TOTP; a disabled user and a local identity for a non-owner are refused", async () => {
  const s = mkStack();
  const o = await claimOwner(s);
  const code = o.recoveryCodes[0] as string;
  const r = await s.stack.auth.loginPassword({ login: o.login, password: o.password, recoveryCode: code.toLowerCase() }, LOCAL);
  assert.equal(r.role, "owner");
  await assert.rejects(() => s.stack.auth.loginPassword({ login: o.login, password: o.password, recoveryCode: code }, LOCAL), (e: AuthError) => e.message === GENERIC_FAIL);
  assert.equal(s.stack.credentials.read().users[o.userId]?.recovery.length, 9);
  // regenerate invalidates the old ones
  const fresh = s.stack.auth.regenerateRecovery(o.userId);
  assert.equal(fresh.length, 10);
  await assert.rejects(() => s.stack.auth.loginPassword({ login: o.login, password: o.password, recoveryCode: (o.recoveryCodes[1] as string) }, LOCAL));
  // disabled
  s.clock.t += 31_000;
  s.stack.users.update((d) => {
    (d.users[o.userId] as { status: string }).status = "disabled";
  });
  await assert.rejects(() => s.stack.auth.loginPassword({ login: o.login, password: o.password, totpCode: totpAt(o.secret, totpStep(s.clock.t)) }, LOCAL), (e: AuthError) => e.message === GENERIC_FAIL);
});

test("sessions: idle 8 h and absolute 7 d, revoked on disable, sign out everywhere, step-up freshness, ids stored only as hashes", async () => {
  const s = mkStack();
  const o = await claimOwner(s);
  const file = readFileSync(s.stack.paths.sessionsFile, "utf8");
  assert.ok(!file.includes(o.sessionId), "the session id is not stored");
  assert.ok(file.includes(sha256Hex(`a7-web:session:${o.sessionId}`)));
  const ctx = { ip: "local", ua: "t" };
  const live = s.stack.sessions.resolve(o.sessionId, ctx);
  assert.equal(live?.userId, o.userId);
  assert.equal(live?.csrf, o.csrf);
  assert.equal(s.stack.sessions.resolve("x".repeat(43), ctx), undefined);
  // idle
  s.clock.t += IDLE_MS - 1000;
  assert.ok(s.stack.sessions.resolve(o.sessionId, ctx), "just inside the idle window; this touches lastSeen");
  s.clock.t += IDLE_MS - 1000;
  assert.ok(s.stack.sessions.resolve(o.sessionId, ctx), "the touch moved the idle window");
  // absolute
  s.clock.t += ABSOLUTE_MS;
  assert.equal(s.stack.sessions.resolve(o.sessionId, ctx), undefined);
  assert.equal(s.stack.sessions.count(), 0, "an expired session is removed");
  // revoke on disable and sign out everywhere
  s.clock.t += 31_000;
  const a = await s.stack.auth.loginPassword({ login: o.login, password: o.password, totpCode: totpAt(o.secret, totpStep(s.clock.t)) }, LOCAL);
  s.clock.t += 31_000;
  const b = await s.stack.auth.loginPassword({ login: o.login, password: o.password, totpCode: totpAt(o.secret, totpStep(s.clock.t)) }, LOCAL);
  assert.notEqual(a.sessionId, b.sessionId, "a new id on every login");
  assert.ok(s.stack.sessions.resolve(a.sessionId, ctx) && s.stack.sessions.resolve(b.sessionId, ctx));
  assert.equal(s.stack.sessions.revokeUser(o.userId, sha256Hex(`a7-web:session:${b.sessionId}`)), 1);
  assert.equal(s.stack.sessions.resolve(a.sessionId, ctx), undefined);
  s.stack.users.update((d) => {
    (d.users[o.userId] as { status: string }).status = "disabled";
  });
  assert.equal(s.stack.sessions.resolve(b.sessionId, ctx), undefined, "disabling a user kills the session at once");
  // step-up
  s.stack.users.update((d) => {
    (d.users[o.userId] as { status: string }).status = "active";
  });
  s.clock.t += 31_000;
  const c = await s.stack.auth.loginPassword({ login: o.login, password: o.password, totpCode: totpAt(o.secret, totpStep(s.clock.t)) }, LOCAL);
  const sess = s.stack.sessions.resolve(c.sessionId, ctx)!;
  s.clock.t += 6 * 60_000;
  assert.throws(() => s.stack.auth.stepUp(s.stack.sessions.resolve(c.sessionId, ctx)!, { totpCode: "000000" }, LOCAL), (e: AuthError) => e.code === "invalid");
  s.stack.auth.stepUp(s.stack.sessions.resolve(c.sessionId, ctx)!, { totpCode: totpAt(o.secret, totpStep(s.clock.t)) }, LOCAL);
  assert.equal(s.stack.sessions.resolve(c.sessionId, ctx)!.stepUpAt, s.clock.t);
  assert.ok(sess.stepUpAt < s.clock.t);
});

test("HTTP: claim and login over the gateway set a __Host- cookie with Secure, HttpOnly, SameSite=Strict, Path=/; the claim works from loopback only", async () => {
  const s = mkStack({ t: Date.now() });
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    publicHosts: [PUBLIC],
    audit: s.audit,
    sessions: s.stack.sessions,
    identify: async (req) => (req.headers["x-test-identity"] ? { ok: true, identity: { kind: "tailscale", login: String(req.headers["x-test-identity"]) } } : { ok: true, identity: { kind: "local" } }),
    routes: authRoutes(s.stack),
  });
  try {
    const port = gw.port;
    const { code } = s.stack.auth.issueOwnerCode();
    const host = `localhost:${port}`;
    const hdr = { origin: `http://${host}` };
    // from a tailnet identity: refused
    assert.equal((await http(port, "POST", "/api/claim/begin", { body: { code }, headers: { ...hdr, "x-test-identity": "x@y.com" }, host })).status, 403);
    // note: the auth service computes ceremonies from the real port, so use the gateway port for claim over HTTP
    const begin = await http(port, "POST", "/api/claim/begin", { body: { code }, headers: hdr, host });
    assert.equal(begin.status, 200);
    const b = begin.json();
    const fin = await http(port, "POST", "/api/claim/finish", { body: { claimId: b.claimId, login: "owner@example.com", displayName: "O", password: "a long enough password", totpCode: totpAt(b.totp.secret, totpStep(Date.now())) }, headers: hdr, host });
    assert.equal(fin.status, 200, fin.text);
    const sc = String(fin.headers["set-cookie"]);
    assert.match(sc, /^__Host-a7web=[A-Za-z0-9_-]{40,}; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/);
    assert.ok(!sc.includes("Domain="), "__Host- cookies have no Domain");
    const cookie = cookieFrom(fin);
    const csrf = fin.json().csrf as string;
    assert.equal(fin.json().recoveryCodes.length, 10);
    // /api/me needs the cookie and CSRF
    assert.equal((await http(port, "GET", "/api/me", { host })).status, 401);
    const me = await http(port, "GET", "/api/me", { headers: { cookie }, host });
    assert.equal(me.status, 200, "a reloaded page can get its CSRF token with the cookie alone");
    assert.equal(me.json().user.role, "owner");
    assert.equal(me.json().csrf, csrf);
    assert.equal((await http(port, "POST", "/api/logout", { body: {}, headers: { ...hdr, cookie }, host })).status, 403, "but a state change still needs the CSRF header");
    assert.equal((await http(port, "GET", "/api/state", { host })).json().claimed, true);
    // logout clears the cookie and the session is gone
    const out = await http(port, "POST", "/api/logout", { body: {}, headers: { ...hdr, cookie, "x-csrf-token": csrf }, host });
    assert.match(String(out.headers["set-cookie"]), /Max-Age=0/);
    assert.equal((await http(port, "GET", "/api/me", { headers: { cookie }, host })).status, 401);
    // a wrong password over HTTP is the generic 401, then the lockout is a 429 with Retry-After
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await http(port, "POST", "/api/login/password", { body: { login: "owner@example.com", password: "x".repeat(14), totpCode: "000000" }, headers: hdr, host })).status;
    assert.equal(last, 429);
  } finally {
    await gw.close();
  }
});

test("CLI: owner-code prints a code once, refuses a second owner without --reset; lockdown ends every session", async () => {
  const s = mkStack({ t: Date.now() });
  const lines: string[] = [];
  assert.equal(runWebCli(["owner-code", "--data-dir", s.dir], { out: (l) => lines.push(l) }), 0);
  assert.match(lines[1] ?? "", /^[A-Za-z0-9_-]{20,}$/);
  assert.match(lines.join("\n"), /localhost:47009\/claim/);
  const begin = s.stack.auth.claimBegin(lines[1], LOCAL);
  await s.stack.auth.claimFinish({ claimId: begin.claimId, login: "owner@example.com", displayName: "O", password: "a long enough password", totpCode: totpAt(begin.totp.secret, totpStep(s.clock.t)) }, LOCAL);
  const l2: string[] = [];
  assert.equal(runWebCli(["owner-code", "--data-dir", s.dir], { out: (l) => l2.push(l) }), 1);
  assert.match(l2.join(), /already exists/);
  assert.equal(runWebCli(["owner-code", "--data-dir", s.dir, "--reset"], { out: () => undefined }), 0);
  const l3: string[] = [];
  assert.equal(runWebCli(["lockdown", "--data-dir", s.dir], { out: (l) => l3.push(l) }), 0);
  assert.match(l3.join(), /ended 1 web session/);
  assert.equal(runWebCli(["owner-code"], { out: () => undefined }), 2);
  assert.equal(runWebCli(["owner-code", "--data-dir", s.dir, "--bogus"], { out: () => undefined }), 2);
});
