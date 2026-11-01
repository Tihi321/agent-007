/**
 * S23: scripts/proxy/check-port.ps1 prints only the port. These tests run it against fixture files under .claude/temp; the real
 * %APPDATA%\api-acp-proxy\settings.json is never read (every run passes -SettingsPath, and the missing-file case points at a fixture path).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const IS_WINDOWS = process.platform === "win32";
const HAS_PS = IS_WINDOWS && spawnSync("powershell.exe", ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0;
const skip = HAS_PS ? false : "Windows PowerShell is not available";

const SCRIPT = resolve(process.cwd(), "scripts", "proxy", "check-port.ps1");
const TEMP = resolve(process.cwd(), ".claude", "temp");
mkdirSync(TEMP, { recursive: true });
const DIR = mkdtempSync(join(TEMP, "check-port-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

const SECRET = "sk-fake-secret-key-must-not-be-printed-123456";

function fixture(name: string, content: string): string {
  const p = join(DIR, name);
  writeFileSync(p, content, "utf8");
  return p;
}

function run(settingsPath: string, env: Record<string, string | undefined> = {}): { status: number | null; out: string; err: string } {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env };
  if (!("PROXY_PORT" in env)) delete e["PROXY_PORT"];
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", SCRIPT, "-SettingsPath", settingsPath], { encoding: "utf8", env: e });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test("prints only the port, never the key or the rest of the file", { skip }, () => {
  const p = fixture("good.json", JSON.stringify({ apiKey: SECRET, auth: { key: SECRET }, server: { port: 9123, host: "127.0.0.1" }, providers: { codex: { token: SECRET } } }));
  const r = run(p);
  assert.equal(r.status, 0);
  assert.equal(r.out, "9123");
  assert.ok(!(r.out + r.err).includes(SECRET));
  assert.equal(r.err, "");
});

test("a port given as a numeric string is accepted", { skip }, () => {
  assert.equal(run(fixture("str.json", JSON.stringify({ server: { port: "8787" } }))).out, "8787");
});

test("PROXY_PORT overrides the file and the file is not read at all", { skip }, () => {
  const missing = join(DIR, "does-not-exist.json");
  const r = run(missing, { PROXY_PORT: "7000" });
  assert.equal(r.status, 0);
  assert.equal(r.out, "7000");
  // a file that would be an error is not even looked at
  const r2 = run(fixture("broken.json", `{ not json ${SECRET}`), { PROXY_PORT: "7001" });
  assert.equal(r2.out, "7001");
  const bad = run(missing, { PROXY_PORT: "70000" });
  assert.equal(bad.status, 2);
  assert.match(bad.err, /PROXY_PORT/);
});

test("clear errors, no content echoed: file missing, key missing, bad value, not JSON", { skip }, () => {
  const missingFile = run(join(DIR, "nope.json"));
  assert.equal(missingFile.status, 2);
  assert.match(missingFile.err, /not found/);

  const noKey = run(fixture("nokey.json", JSON.stringify({ apiKey: SECRET, server: { host: "127.0.0.1" } })));
  assert.equal(noKey.status, 2);
  assert.match(noKey.err, /server\.port is missing/);
  assert.equal(noKey.out, "");

  const noServer = run(fixture("noserver.json", JSON.stringify({ apiKey: SECRET })));
  assert.equal(noServer.status, 2);
  assert.match(noServer.err, /server\.port is missing/);

  for (const [name, port] of [["zero", 0], ["big", 65536], ["neg", -5], ["float", 80.5], ["text", "abc"], ["bool", true], ["null", null], ["obj", { a: 1 }]] as const) {
    const r = run(fixture(`${name}.json`, JSON.stringify({ apiKey: SECRET, server: { port } })));
    assert.equal(r.status, 2, name);
    assert.equal(r.out, "", name);
    assert.match(r.err, /server\.port/, name);
    assert.ok(!r.err.includes(SECRET), name);
  }

  const broken = run(fixture("notjson.json", `{"apiKey":"${SECRET}", oops`));
  assert.equal(broken.status, 2);
  assert.match(broken.err, /could not be read as JSON/);
  assert.ok(!(broken.out + broken.err).includes(SECRET));
});
