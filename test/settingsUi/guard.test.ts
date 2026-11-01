import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LoginStore } from "../../src/jobrunner/settingsUi/auth.js";
import { startSettingsUi, SettingsUiBindError } from "../../src/jobrunner/settingsUi/server.js";
import { memLogger, request, signIn, startRig } from "./helpers.js";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function treeHash(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else parts.push(`${p}:${sha(readFileSync(p, "utf8"))}`);
    }
  };
  walk(dir);
  return sha(parts.join("\n"));
}

test("no session: every API route answers 401", async () => {
  const rig = await startRig();
  try {
    assert.ok(rig.routeKeys.length >= 12);
    for (const key of rig.routeKeys) {
      const [method, path] = key.split(" ") as [string, string];
      const r = await request(rig, method, path, { body: method === "POST" ? {} : undefined, headers: method === "POST" ? { "X-CSRF-Token": "x" } : {} });
      assert.equal(r.status, 401, key);
      assert.equal(r.json()["error"], "no_session");
    }
    assert.equal((await request(rig, "POST", "/api/logout", { body: {} })).status, 401);
  } finally {
    await rig.cleanup();
  }
});

test("a foreign Host (evil.example, a rebinding-style 127.0.0.1.evil.example, a wrong port) gets 421 and no body", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    for (const host of ["evil.example", "127.0.0.1.evil.example", `127.0.0.1.evil.example:${rig.port}`, "127.0.0.1:1", "localhost", "[::1]:" + rig.port, ""]) {
      for (const path of ["/", "/api/schema", "/app.js"]) {
        const r = await request(rig, "GET", path, { headers: { Host: host || undefined, Cookie: s.cookie } });
        assert.ok(r.status === 421 || r.status === 400, `${host} ${path}: ${r.status}`);
        assert.equal(r.text, "", `${host} ${path} has no body`);
      }
    }
    assert.equal((await request(rig, "GET", "/", { headers: { Host: `localhost:${rig.port}` } })).status, 200, "localhost:<port> is allowed");
    assert.ok(rig.logger.lines.some((l) => l.event === "settingsui.refused"));
  } finally {
    await rig.cleanup();
  }
});

test("POST: Origin null, a foreign Origin and a missing Origin are refused; Sec-Fetch-Site cross-site too", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    for (const origin of ["null", "http://evil.example", `http://127.0.0.1:${rig.port + 1}`, `https://127.0.0.1:${rig.port}`, undefined]) {
      const r = await request(rig, "POST", "/api/logout", { body: {}, headers: { Origin: origin, Cookie: s.cookie, "X-CSRF-Token": s.csrf } });
      assert.equal(r.status, 403, String(origin));
    }
    for (const site of ["cross-site", "same-site", "none"]) {
      const r = await request(rig, "POST", "/api/personas/delete", { body: {}, headers: { "Sec-Fetch-Site": site, Cookie: s.cookie, "X-CSRF-Token": s.csrf } });
      assert.equal(r.status, 403, site);
    }
    // same-origin and localhost origins pass the guard (this one then fails validation, which is fine)
    const ok = await request(rig, "POST", "/api/personas/delete", { body: {}, headers: { "Sec-Fetch-Site": "same-origin", Origin: `http://localhost:${rig.port}`, Host: `localhost:${rig.port}`, Cookie: s.cookie, "X-CSRF-Token": s.csrf } });
    assert.equal(ok.status, 400);
  } finally {
    await rig.cleanup();
  }
});

test("a form-encoded POST is refused; a missing or wrong CSRF token is refused", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const form = await request(rig, "POST", "/api/security/save", { body: "section=shell&value=x", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: s.cookie, "X-CSRF-Token": s.csrf } });
    assert.equal(form.status, 415);
    const text = await request(rig, "POST", "/api/security/save", { body: "{}", headers: { "Content-Type": "text/plain", Cookie: s.cookie, "X-CSRF-Token": s.csrf } });
    assert.equal(text.status, 415);
    const noCsrf = await request(rig, "POST", "/api/security/save", { body: {}, headers: { Cookie: s.cookie } });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json()["error"], "csrf");
    const wrong = await request(rig, "POST", "/api/security/save", { body: {}, headers: { Cookie: s.cookie, "X-CSRF-Token": s.csrf + "x" } });
    assert.equal(wrong.status, 403);
    const other = await signIn(rig);
    const crossSession = await request(rig, "POST", "/api/security/save", { body: {}, headers: { Cookie: s.cookie, "X-CSRF-Token": other.csrf } });
    assert.equal(crossSession.status, 403, "another session's token does not work");
  } finally {
    await rig.cleanup();
  }
});

test("a GET that tries to change state changes nothing: file hashes are unchanged", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const before = treeHash(rig.dir);
    for (const path of [
      "/api/security/save?section=shell&value=%7B%7D&baseRevision=x",
      "/api/personas/delete?id=anything",
      "/api/templates/save?doc=%7B%7D",
      "/api/jobrunner/save?limits=%7B%7D",
      "/api/logout",
      "/api/audit?limit=5&delete=1",
      "/api/security?save=1",
    ]) {
      const r = await s.get(path);
      assert.ok([200, 404].includes(r.status), `${path}: ${r.status}`);
    }
    assert.deepEqual(readdirSync(rig.paths.auditDir), [], "no audit line was written by a GET");
    assert.equal(treeHash(rig.dir), before, "nothing under the temp tree changed");
    assert.equal((await s.get("/api/schema")).status, 200, "the session still works after /api/logout was tried as GET");
  } finally {
    await rig.cleanup();
  }
});

test("forged X-Forwarded-For, X-Forwarded-Host and Forwarded change nothing", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const plain = await s.get("/api/status");
    const forged = await s.get("/api/status", { "X-Forwarded-For": "10.1.2.3", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https", Forwarded: "for=10.1.2.3;host=evil.example;proto=https" });
    assert.equal(forged.status, plain.status);
    assert.equal(forged.text, plain.text);
    const noSession = await request(rig, "GET", "/api/status", { headers: { "X-Forwarded-For": "127.0.0.1", Forwarded: "for=127.0.0.1" } });
    assert.equal(noSession.status, 401, "a forged loopback does not grant a session");
    const hostForged = await request(rig, "GET", "/", { headers: { "X-Forwarded-Host": `127.0.0.1:${rig.port}`, Host: "evil.example" } });
    assert.equal(hostForged.status, 421, "X-Forwarded-Host cannot replace Host");
  } finally {
    await rig.cleanup();
  }
});

test("a body over 256 KB is refused, and so is a method other than GET, HEAD and POST", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const big = await s.post("/api/security/save", { pad: "x".repeat(300 * 1024) });
    assert.equal(big.status, 413);
    const noHeader = await request(rig, "POST", "/api/security/save", { body: "x".repeat(300 * 1024), headers: { "Content-Length": undefined, Cookie: s.cookie, "X-CSRF-Token": s.csrf } }).catch(() => ({ status: 413 }));
    assert.ok([413, 400].includes(noHeader.status));
    for (const m of ["PUT", "DELETE", "PATCH", "OPTIONS", "TRACE"]) assert.equal((await request(rig, m, "/api/schema", { headers: { Cookie: s.cookie } })).status, 405, m);
    assert.equal((await request(rig, "HEAD", "/api/schema", { headers: { Cookie: s.cookie } })).status, 405, "HEAD is for static files only");
    assert.equal((await request(rig, "HEAD", "/app.css")).status, 200);
    assert.equal((await request(rig, "HEAD", "/app.css")).text, "");
  } finally {
    await rig.cleanup();
  }
});

test("the listener is on 127.0.0.1 (not :: or 0.0.0.0), refuses a non-loopback bind and a port equal to the IPC port, and a second one on the same port fails cleanly", async () => {
  const rig = await startRig();
  try {
    const addr = rig.ui.server.address();
    assert.ok(addr && typeof addr === "object");
    assert.equal(addr.address, "127.0.0.1");
    assert.equal(addr.family, "IPv4");
    const base = { port: 0, ipcPort: 47007, sessionIdleMin: 30, sessionMaxHours: 8, routes: {}, loginStore: new LoginStore(join(rig.dir, "l2.json")), logger: memLogger() };
    await assert.rejects(startSettingsUi({ ...base, host: "0.0.0.0" }), SettingsUiBindError);
    await assert.rejects(startSettingsUi({ ...base, host: "::" }), /loopback only/);
    await assert.rejects(startSettingsUi({ ...base, host: "192.168.1.5" }), /loopback only/);
    await assert.rejects(startSettingsUi({ ...base, host: "127.0.0.1", port: 47007 }), /differ from the IPC port/);
    const assets = new Map();
    await assert.rejects(startSettingsUi({ ...base, host: "127.0.0.1", port: rig.port, assets }), (e: unknown) => e instanceof SettingsUiBindError && /already in use/.test(e.message));
  } finally {
    await rig.cleanup();
  }
});
