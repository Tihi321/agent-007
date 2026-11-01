/** S29: the gateway skeleton. Headers, CSRF, origin, rate limit, lockout, fail-closed startup (I48, I55). Offline. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { memoryWebAudit } from "../../src/web/audit.js";
import { csrfFor, SECURITY_HEADERS } from "../../src/web/http.js";
import { LOCKOUT_BASE_MS, LOCKOUT_MAX_MS, LockoutTracker, TokenBuckets } from "../../src/web/ratelimit.js";
import { GatewayStartError, checkStartup, startGateway } from "../../src/web/server.js";
import type { AuthedSession, GatewayOptions, RouteDef } from "../../src/web/server.js";
import { inspectServeStatus } from "../../src/web/tailscale.js";
import { WebStoreError } from "../../src/web/store.js";
import { tempDir } from "../settings/helpers.js";
import { http } from "./helpers.js";

const SID = "session-one";
const sess = (over: Partial<AuthedSession> = {}): AuthedSession => ({ userId: "u1", role: "user", login: "a@x.com", idHash: "h", csrf: csrfFor(SID), stepUpAt: Date.now(), ...over });

async function rig(over: Partial<GatewayOptions> = {}, routes: Record<string, RouteDef> = {}, session: AuthedSession | undefined = sess()) {
  const audit = memoryWebAudit();
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    publicHosts: ["pc.tail1234.ts.net"],
    audit,
    sessions: { resolve: (cookie) => (cookie === SID ? session : undefined) },
    identify: async () => ({ ok: true, identity: { kind: "local" } }),
    assets: new Map([["/", { body: "<!doctype html><title>x</title>", type: "text/html; charset=utf-8" }]]),
    routes: {
      "GET /api/ping": { auth: "public", handler: async () => ({ status: 200, body: { ok: true } }) },
      "POST /api/echo": { auth: "session", handler: async (c) => ({ status: 200, body: { got: c.body, user: c.session?.userId } }) },
      "POST /api/owner": { auth: "owner", handler: async () => ({ status: 200, body: { ok: true } }) },
      "POST /api/sensitive": { auth: "session", stepUp: true, handler: async () => ({ status: 200, body: { ok: true } }) },
      "POST /api/public": { auth: "public", handler: async () => ({ status: 200, body: { ok: true } }) },
      ...routes,
    },
    ...over,
  });
  return { gw, audit, port: gw.port, auth: { cookie: `__Host-a7web=${SID}`, "x-csrf-token": csrfFor(SID) } };
}

test("every response carries the security headers: 200, static, 401, 403, 404, 421", async () => {
  const r = await rig();
  try {
    const replies = [
      await http(r.port, "GET", "/api/ping"),
      await http(r.port, "GET", "/"),
      await http(r.port, "GET", "/missing.js"),
      await http(r.port, "POST", "/api/echo", { body: {} }),
      await http(r.port, "GET", "/api/ping", { host: "evil.example" }),
      await http(r.port, "POST", "/api/public", { body: {}, headers: { origin: "https://evil.example" } }),
    ];
    assert.deepEqual(replies.map((x) => x.status), [200, 200, 404, 401, 421, 403]);
    for (const x of replies) {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(x.headers[k.toLowerCase()], v, `${k} on ${x.status}`);
    }
    const csp = String(replies[0]?.headers["content-security-policy"]);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp));
    assert.equal(replies[0]?.headers["access-control-allow-origin"], undefined, "no CORS");
  } finally {
    await r.gw.close();
  }
});

test("Host: loopback names and the public ts.net name are accepted, anything else is 421", async () => {
  const r = await rig();
  try {
    assert.equal((await http(r.port, "GET", "/api/ping", { host: `localhost:${r.port}` })).status, 200);
    assert.equal((await http(r.port, "GET", "/api/ping", { host: "pc.tail1234.ts.net" })).status, 200);
    assert.equal((await http(r.port, "GET", "/api/ping", { host: "pc.tail1234.ts.net:443" })).status, 200);
    assert.equal((await http(r.port, "GET", "/api/ping", { host: "attacker.com" })).status, 421);
    assert.equal((await http(r.port, "GET", "/api/ping", { host: `127.0.0.1:${r.port + 1}` })).status, 421);
  } finally {
    await r.gw.close();
  }
});

test("CSRF and origin: a session POST needs the header and a same-origin Origin; content type and size are checked", async () => {
  const r = await rig();
  try {
    const go = (o: Parameters<typeof http>[3]) => http(r.port, "POST", "/api/echo", o);
    assert.equal((await go({ body: { a: 1 }, headers: { cookie: r.auth.cookie } })).status, 403, "no CSRF header");
    assert.equal((await go({ body: { a: 1 }, headers: { cookie: r.auth.cookie, "x-csrf-token": "wrong" } })).status, 403);
    const good = await go({ body: { a: 1 }, headers: r.auth });
    assert.equal(good.status, 200);
    assert.deepEqual(good.json(), { got: { a: 1 }, user: "u1" });
    assert.equal((await go({ body: {}, headers: { ...r.auth, origin: "https://evil.example" } })).status, 403, "foreign origin");
    assert.equal((await go({ body: {}, headers: { ...r.auth, origin: "null" } })).status, 403, "Origin: null");
    assert.equal((await go({ body: {}, headers: { ...r.auth, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await go({ body: {}, headers: { ...r.auth, "content-type": "text/plain" } })).status, 415);
    assert.equal((await go({ raw: "{nope", headers: r.auth })).status, 400);
    const noOrigin = await new Promise<number>((resolve) => {
      void http(r.port, "POST", "/api/public", { raw: "{}", headers: { origin: "" } }).then((x) => resolve(x.status));
    });
    assert.equal(noOrigin, 403, "an empty Origin is refused");
    const big = await go({ raw: JSON.stringify({ x: "a".repeat(300 * 1024) }), headers: r.auth });
    assert.equal(big.status, 413);
    assert.equal((await http(r.port, "GET", "/api/echo")).status, 404, "a POST route is not reachable by GET");
  } finally {
    await r.gw.close();
  }
});

test("roles and step-up: an owner route refuses a user (and audits it); a step-up route refuses a stale confirmation", async () => {
  const r = await rig();
  try {
    assert.equal((await http(r.port, "POST", "/api/owner", { body: {}, headers: r.auth })).status, 403);
    assert.ok(r.audit.events.some((e) => e.kind === "tool_denied"));
    assert.equal((await http(r.port, "POST", "/api/sensitive", { body: {}, headers: r.auth })).status, 200);
  } finally {
    await r.gw.close();
  }
  const stale = await rig({}, {}, sess({ stepUpAt: Date.now() - 6 * 60_000 }));
  try {
    const x = await http(stale.port, "POST", "/api/sensitive", { body: {}, headers: stale.auth });
    assert.equal(x.status, 401);
    assert.equal(x.json().error, "step_up_required");
  } finally {
    await stale.gw.close();
  }
  const owner = await rig({}, {}, sess({ role: "owner" }));
  try {
    assert.equal((await http(owner.port, "POST", "/api/owner", { body: {}, headers: owner.auth })).status, 200);
  } finally {
    await owner.gw.close();
  }
});

test("identity: a rejected or unknown identity gets the same generic 403 page, for pages and API alike", async () => {
  const r = await rig({
    identify: async (req) => (req.headers["x-who"] === "bad" ? { ok: false, reason: "forged" } : { ok: true, identity: { kind: "tailscale", login: req.headers["x-who"] === "stranger" ? "stranger@x.com" : "a@x.com" } }),
    admit: (id) => id.kind === "tailscale" && id.login === "a@x.com",
  });
  try {
    const forged = await http(r.port, "GET", "/", { headers: { "x-who": "bad" } });
    const stranger = await http(r.port, "GET", "/", { headers: { "x-who": "stranger" } });
    const api = await http(r.port, "GET", "/api/ping", { headers: { "x-who": "stranger" } });
    assert.deepEqual([forged.status, stranger.status, api.status], [403, 403, 403]);
    assert.equal(forged.text, stranger.text, "no hint whether the user exists");
    assert.equal(stranger.text, api.text);
    assert.equal((await http(r.port, "GET", "/api/ping", { headers: { "x-who": "ok" } })).status, 200);
    assert.equal(r.audit.events.filter((e) => e.kind === "identity_rejected").length, 3);
  } finally {
    await r.gw.close();
  }
});

test("rate limit: a client that exceeds its bucket gets 429 with Retry-After; others are unaffected", async () => {
  const r = await rig({ rate: { capacity: 3, perSec: 0.001 } });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await http(r.port, "GET", "/api/ping")).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.equal((await http(r.port, "GET", "/api/ping")).headers["retry-after"], "5");
  } finally {
    await r.gw.close();
  }
  let t = 0;
  const b = new TokenBuckets({ capacity: 2, refillPerSec: 1, now: () => t });
  assert.deepEqual([b.take("k"), b.take("k"), b.take("k")], [true, true, false]);
  t += 1500;
  assert.equal(b.take("k"), true);
  assert.equal(b.take("other"), true);
});

test("SSE slots: at most N open streams per user", async () => {
  let opened: (() => void)[] = [];
  const r = await rig({ maxStreamsPerUser: 2 }, {
    "POST /api/slot": {
      auth: "session",
      handler: async (c) => {
        const rel = c.openStream();
        if (rel) opened.push(rel);
        return { status: rel ? 200 : 429, body: {} };
      },
    },
  });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await http(r.port, "POST", "/api/slot", { body: {}, headers: r.auth })).status);
    assert.deepEqual(codes, [200, 200, 429]);
    opened[0]?.();
    opened[0]?.();
    assert.equal((await http(r.port, "POST", "/api/slot", { body: {}, headers: r.auth })).status, 200, "one slot freed, released twice counts once");
    opened = [];
  } finally {
    await r.gw.close();
  }
});

test("lockout: 5 failures lock for 15 min, each further lockout doubles up to 24 h, a success clears the count, and the owner is told", () => {
  let t = 1_000_000;
  const told: [string, number][] = [];
  const l = new LockoutTracker({ now: () => t, onLockout: (k, ms) => told.push([k, ms]) });
  for (let i = 0; i < 4; i++) assert.equal(l.fail("a"), 0);
  assert.equal(l.lockedFor("a"), 0);
  assert.equal(l.fail("a"), LOCKOUT_BASE_MS);
  assert.equal(l.lockedFor("a"), LOCKOUT_BASE_MS);
  assert.equal(l.lockedFor("b"), 0, "per key");
  t += LOCKOUT_BASE_MS + 1;
  assert.equal(l.lockedFor("a"), 0);
  for (let i = 0; i < 4; i++) l.fail("a");
  assert.equal(l.fail("a"), LOCKOUT_BASE_MS * 2);
  for (let n = 2; n < 12; n++) {
    t += LOCKOUT_MAX_MS * 2;
    for (let i = 0; i < 5; i++) l.fail("a");
  }
  assert.equal(l.lockedFor("a"), LOCKOUT_MAX_MS, "capped at 24 h");
  assert.ok(told.length >= 3 && told[0]?.[1] === LOCKOUT_BASE_MS);
  const m = new LockoutTracker({ now: () => t });
  for (let i = 0; i < 3; i++) m.fail("x");
  m.ok("x");
  for (let i = 0; i < 4; i++) m.fail("x");
  assert.equal(m.lockedFor("x"), 0, "the success reset the count");
});

test("lockout state survives a restart; a corrupt lockout file stops the start", () => {
  const dir = tempDir("a7-lock-");
  const file = join(dir, "lockout.json");
  const a = new LockoutTracker({ file });
  for (let i = 0; i < 5; i++) a.fail("owner");
  assert.ok(new LockoutTracker({ file }).lockedFor("owner") > 0);
  writeFileSync(file, "{broken");
  assert.throws(() => new LockoutTracker({ file }));
});

const FUNNEL_ON = JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { "pc.t.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:47009" } } } }, AllowFunnel: { "pc.t.ts.net:443": true } });
const GOOD = JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { "pc.t.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:47009" } } } } });
const to = (p: string) => JSON.stringify({ Web: { "pc.t.ts.net:443": { Handlers: { "/": { Proxy: p } } } } });

test("serve status matrix (I48): only a background proxy of 47009 passes; Funnel, 47008, 47007, files, TCP forwards and junk are refused", () => {
  assert.equal(inspectServeStatus(GOOD).ok, true);
  assert.deepEqual(inspectServeStatus(GOOD).hosts, ["pc.t.ts.net:443"]);
  assert.equal(inspectServeStatus("{}").ok, true, "nothing served yet");
  assert.equal(inspectServeStatus(FUNNEL_ON).ok, false);
  assert.match(inspectServeStatus(FUNNEL_ON).problems.join(), /Funnel/);
  assert.equal(inspectServeStatus(JSON.stringify({ AllowFunnel: { "pc.t.ts.net:443": false } })).ok, true, "a Funnel entry that is off is fine");
  for (const bad of ["http://127.0.0.1:47008", "http://127.0.0.1:47007", "http://127.0.0.1:8080", "http://192.168.1.5:47009", "https://127.0.0.1:47009", "http://evil.com:47009", "http://u:p@127.0.0.1:47009"]) {
    assert.equal(inspectServeStatus(to(bad)).ok, false, bad);
  }
  assert.equal(inspectServeStatus(to("http://127.0.0.1:47009/app")).ok, true);
  assert.equal(inspectServeStatus(to("http://localhost:47009")).ok, true);
  assert.equal(inspectServeStatus(JSON.stringify({ Web: { h: { Handlers: { "/": { Path: "C:\\" } } } } })).ok, false, "a file handler");
  assert.equal(inspectServeStatus(JSON.stringify({ TCP: { "22": { TCPForward: "127.0.0.1:22" } } })).ok, false);
  assert.equal(inspectServeStatus(JSON.stringify({ Foreground: { s1: {} } })).ok, false);
  for (const junk of [undefined, "", "not json", "[]", "null", '"x"']) assert.equal(inspectServeStatus(junk).ok, false, String(junk));
  assert.ok(!inspectServeStatus(to("http://127.0.0.1:47008")).problems.join().includes("47008"), "problems are fixed sentences");
});

test("fail-closed startup (I48, I55): non-loopback host, the settings/IPC ports, a Funnel entry, a corrupt store, a missing CLI and a skewed clock all refuse", async () => {
  const audit = memoryWebAudit();
  const base = { host: "127.0.0.1", port: 47009, audit };
  const ok = { mode: "tailnet" as const, loadStores: () => undefined, serveStatus: () => GOOD, clockSkewMs: () => 1000 };
  assert.deepEqual((await checkStartup(base, ok)).serveHosts, ["pc.t.ts.net:443"]);
  const refuses = async (o: Parameters<typeof checkStartup>[0], c: Parameters<typeof checkStartup>[1], re: RegExp) => {
    await assert.rejects(() => checkStartup(o, c), (e: Error) => e instanceof GatewayStartError && re.test(e.message));
  };
  await refuses({ ...base, host: "0.0.0.0" }, ok, /127\.0\.0\.1 only/);
  await refuses({ ...base, host: "192.168.1.5" }, ok, /127\.0\.0\.1 only/);
  await refuses({ ...base, port: 47008 }, ok, /port/);
  await refuses({ ...base, port: 47007 }, ok, /port/);
  await refuses(base, { ...ok, serveStatus: () => FUNNEL_ON }, /Funnel/);
  await refuses(base, { ...ok, serveStatus: () => to("http://127.0.0.1:47008") }, /other than the gateway/);
  await refuses(base, { ...ok, serveStatus: () => undefined }, /could not be read/);
  await refuses(base, { ...ok, serveStatus: () => { throw new Error("spawn tailscale ENOENT"); } }, /could not be read/);
  await refuses(base, { ...ok, serveStatus: undefined }, /serve status check/);
  await refuses(base, { ...ok, loadStores: () => { throw new WebStoreError("users.json: the file is not valid JSON"); } }, /corrupt/);
  await refuses(base, { ...ok, loadStores: () => { throw new Error("ENOENT"); } }, /missing or unreadable/);
  await refuses(base, { ...ok, clockSkewMs: () => 10 * 60_000 }, /clock is off/);
  await refuses(base, { ...ok, clockSkewMs: () => undefined }, /clock could not be checked/);
  assert.ok(audit.events.filter((e) => e.kind === "startup_refused").length >= 12, "every refusal is audited");
  // local mode needs no tailscale at all
  await checkStartup(base, { mode: "local", loadStores: () => undefined });
  await assert.rejects(() => startGateway({ host: "0.0.0.0", port: 0, publicHosts: [], routes: {}, audit, sessions: { resolve: () => undefined }, identify: async () => ({ ok: true, identity: { kind: "local" } }) }), GatewayStartError);
});

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test("I57: no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval or new Function in src/web or ui/web", () => {
  const files = [...walk(join(process.cwd(), "src", "web")), ...(statSync(join(process.cwd(), "ui", "web"), { throwIfNoEntry: false })?.isDirectory() ? walk(join(process.cwd(), "ui", "web")) : [])].filter((f) => /\.(ts|js|html)$/.test(f));
  assert.ok(files.length > 5);
  for (const f of files) {
    const code = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(code), f);
  }
});
