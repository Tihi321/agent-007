import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CODE_TTL_MS, LOCKOUT_MS, linkFor } from "../../src/jobrunner/settingsUi/auth.js";
import { request, sessionOf, signIn, startRig } from "./helpers.js";

const login = (rig: Parameters<typeof request>[0], code: string) => request(rig, "POST", "/api/login", { body: { code } });

test("a wrong, reused or expired code is refused; the right one works exactly once", async () => {
  const rig = await startRig();
  try {
    assert.equal((await login(rig, "nope")).status, 401);
    assert.equal((await login(rig, "")).status, 401);
    const { code } = rig.loginStore.issue();
    const ok = await login(rig, code);
    assert.equal(ok.status, 200);
    assert.equal((await login(rig, code)).status, 401, "single use");
    const old = rig.loginStore.issue().code;
    rig.clock.t += CODE_TTL_MS + 1;
    assert.equal((await login(rig, old)).status, 401, "expired after 5 minutes");
    const fresh = rig.loginStore.issue().code;
    rig.clock.t += CODE_TTL_MS - 1000;
    assert.equal((await login(rig, fresh)).status, 200, "still valid just before it expires");
  } finally {
    await rig.cleanup();
  }
});

test("only a hash of the code is stored (never the code), and a new code replaces the unused one", async () => {
  const rig = await startRig();
  try {
    const a = rig.loginStore.issue().code;
    const stored = readFileSync(join(rig.dir, "data", "settings-login.json"), "utf8");
    assert.ok(!stored.includes(a), "the code is not in the file");
    const b = rig.loginStore.issue().code;
    assert.equal((await login(rig, a)).status, 401, "the older code no longer works");
    assert.equal((await login(rig, b)).status, 200);
    assert.match(linkFor("127.0.0.1", 47008, "abc"), /^http:\/\/127\.0\.0\.1:47008\/#code=abc$/, "the code is in the fragment");
  } finally {
    await rig.cleanup();
  }
});

test("5 failures in a minute lock login out for 60 s, even for the right code; then it works again", async () => {
  const rig = await startRig();
  try {
    const { code } = rig.loginStore.issue();
    for (let i = 0; i < 5; i++) assert.equal((await login(rig, `wrong${i}`)).status, 401);
    const locked = await login(rig, code);
    assert.equal(locked.status, 429);
    assert.equal(locked.json()["error"], "locked");
    assert.ok(Number(locked.headers["retry-after"]) >= 1);
    rig.clock.t += LOCKOUT_MS - 1000;
    assert.equal((await login(rig, code)).status, 429, "still locked");
    rig.clock.t += 2000;
    const { code: c2 } = rig.loginStore.issue();
    assert.equal((await login(rig, c2)).status, 200, "the lockout ended");
  } finally {
    await rig.cleanup();
  }
});

test("the session cookie is HttpOnly, SameSite=Strict, Path=/; the CSRF token is in the JSON body, not a cookie", async () => {
  const rig = await startRig();
  try {
    const { code } = rig.loginStore.issue();
    const r = await login(rig, code);
    const cookies = r.headers["set-cookie"] ?? [];
    assert.equal(cookies.length, 1);
    assert.match(cookies[0] as string, /^a7sid=[A-Za-z0-9_-]{40,}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/);
    assert.ok(!/Secure/.test(cookies[0] as string), "plain http on loopback");
    const body = r.json();
    assert.equal(typeof body["csrf"], "string");
    assert.ok(!(cookies[0] as string).includes(String(body["csrf"])));
  } finally {
    await rig.cleanup();
  }
});

test("the idle timeout (30 min) and the absolute timeout (8 h) end a session", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    assert.equal((await s.get("/api/status")).status, 200);
    rig.clock.t += 29 * 60_000;
    assert.equal((await s.get("/api/status")).status, 200, "activity keeps it alive");
    rig.clock.t += 31 * 60_000;
    assert.equal((await s.get("/api/status")).status, 401, "idle for 31 minutes");
    const s2 = await signIn(rig);
    for (let i = 0; i < 19; i++) {
      rig.clock.t += 25 * 60_000; // active every 25 minutes, so never idle for 30
      assert.equal((await s2.get("/api/status")).status, 200, `step ${i + 1}`);
    }
    rig.clock.t += 25 * 60_000;
    assert.equal((await s2.get("/api/status")).status, 401, "past 8 hours in total, however active");
  } finally {
    await rig.cleanup();
  }
});

test("at most 3 sessions: a fourth sign-in ends the oldest", async () => {
  const rig = await startRig();
  try {
    const a = await signIn(rig);
    rig.clock.t += 1000;
    const b = await signIn(rig);
    rig.clock.t += 1000;
    const c = await signIn(rig);
    rig.clock.t += 1000;
    const d = await signIn(rig);
    assert.equal((await a.get("/api/status")).status, 401, "the oldest was dropped");
    for (const s of [b, c, d]) assert.equal((await s.get("/api/status")).status, 200);
    assert.equal(rig.ui.sessions.size, 3);
  } finally {
    await rig.cleanup();
  }
});

test("logout ends the session; settings-link --revoke ends every session and code", async () => {
  const rig = await startRig();
  try {
    const a = await signIn(rig);
    const out = await a.post("/api/logout");
    assert.equal(out.status, 200);
    assert.match(String(out.headers["set-cookie"]?.[0]), /Max-Age=0/);
    assert.equal((await a.get("/api/status")).status, 401);
    const b = await signIn(rig);
    const c = await signIn(rig);
    const pending = rig.loginStore.issue().code;
    rig.clock.t += 5;
    rig.loginStore.revoke();
    assert.equal((await b.get("/api/status")).status, 401);
    assert.equal((await c.get("/api/status")).status, 401);
    assert.equal((await login(rig, pending)).status, 401, "an unused code is gone too");
    rig.clock.t += 5;
    const after = await signIn(rig);
    assert.equal((await after.get("/api/status")).status, 200, "a new sign-in after the revoke works");
    void sessionOf;
  } finally {
    await rig.cleanup();
  }
});
