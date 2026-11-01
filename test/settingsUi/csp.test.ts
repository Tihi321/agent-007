import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SECURITY_HEADERS } from "../../src/jobrunner/settingsUi/guard.js";
import { ROOT, request, signIn, startRig } from "./helpers.js";

const UI = join(ROOT, "ui", "settings");

const EXPECTED: Record<string, string> = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

test("every response carries the CSP and the other headers: static, API, 401, 403, 404, 421 and 405", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const replies = [
      await request(rig, "GET", "/"),
      await request(rig, "GET", "/app.js"),
      await request(rig, "GET", "/nope"),
      await request(rig, "GET", "/api/schema"),
      await s.get("/api/schema"),
      await s.get("/api/nothing"),
      await request(rig, "POST", "/api/login", { body: { code: "x" } }),
      await request(rig, "POST", "/api/security/save", { body: {}, headers: { Origin: "http://evil.example" } }),
      await request(rig, "GET", "/", { headers: { Host: "evil.example" } }),
      await request(rig, "PUT", "/", {}),
    ];
    const statuses = replies.map((r) => r.status);
    assert.deepEqual(statuses, [200, 200, 404, 401, 200, 404, 401, 403, 421, 405]);
    for (const r of replies) for (const [k, v] of Object.entries(EXPECTED)) assert.equal(r.headers[k], v, `${r.status} ${k}`);
    assert.deepEqual(Object.fromEntries(Object.entries(SECURITY_HEADERS).map(([k, v]) => [k.toLowerCase(), v])), EXPECTED);
  } finally {
    await rig.cleanup();
  }
});

test("ui/settings contains no innerHTML, eval, new Function, document.write, inline script, inline style or event-handler attribute", () => {
  const files = readdirSync(UI);
  assert.ok(files.includes("index.html") && files.includes("app.js") && files.includes("app.css"));
  for (const f of files) {
    const text = readFileSync(join(UI, f), "utf8");
    for (const [name, re] of [
      ["innerHTML", /innerHTML/],
      ["outerHTML", /outerHTML/],
      ["insertAdjacentHTML", /insertAdjacentHTML/],
      ["eval", /\beval\s*\(/],
      ["new Function", /new\s+Function\b/],
      ["document.write", /document\.write/],
      ["setAttribute style", /setAttribute\(\s*["']style["']/],
      ["setTimeout with a string", /setTimeout\(\s*["'`]/],
    ] as const) assert.ok(!re.test(text), `${f} must not contain ${name}`);
    if (f.endsWith(".html")) {
      assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(text), "no inline <script>");
      assert.ok(!/\sstyle\s*=/i.test(text), "no style= attribute");
      assert.ok(!/<style[\s>]/i.test(text), "no <style> block");
      assert.ok(!/\son[a-z]+\s*=/i.test(text), "no inline event handler");
      assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(text), "no external resource");
    }
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\.[a-z]{2,}/i.test(text.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "")), `${f} loads nothing from the internet`);
  }
});

test("every ui/settings script is valid ES module syntax (node --check)", () => {
  for (const f of readdirSync(UI).filter((n) => n.endsWith(".js"))) {
    const r = spawnSync(process.execPath, ["--check", join(UI, f)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test("the page sets all text with textContent: forms.js builds elements from a fixed attribute list", () => {
  const forms = readFileSync(join(UI, "forms.js"), "utf8");
  assert.match(forms, /ALLOWED_ATTRS/);
  assert.match(forms, /createTextNode/);
  assert.ok(!/\.style\.[a-zA-Z]+\s*=/.test(readFileSync(join(UI, "app.js"), "utf8")));
});
