/** S36: the pieces around the gateway: the kill switch coupling, the entry point's argument and endpoint helpers, the body deadline, a refused start. Offline. */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { SHELL_DISABLED_FLAG } from "../../src/approval/killSwitch.js";
import { startWebApp } from "../../src/web/app.js";
import { endpointResolver, parseWebCli } from "../../src/web/main.js";
import { PRESETS, ScriptedEngine, freePort, makeApp, until, wait } from "./app.js";
import { http } from "./helpers.js";
import { tempDir } from "../settings/helpers.js";

test("kill switch: when the flag file appears every web session ends and the API answers 503; the state page and the static files stay; deleting the flag re-enables sign-in", async () => {
  const control = tempDir("a7-control-");
  const t = await makeApp({ mode: "local", controlDir: control });
  try {
    const host = `localhost:${t.port}`;
    const me = () => http(t.port, "GET", "/api/me", { host, headers: { cookie: t.owner.cookie } });
    assert.equal((await me()).status, 200);
    writeFileSync(join(control, SHELL_DISABLED_FLAG), "x");
    const locked = await me();
    assert.equal(locked.status, 503);
    assert.equal(locked.json().error, "lockdown");
    assert.equal((await http(t.port, "GET", "/api/state", { host })).status, 200, "the sign-in page can still say what is going on");
    assert.equal((await http(t.port, "POST", "/api/login/password", { body: { login: "x@y.com", password: "x".repeat(14), totpCode: "000000" }, host, headers: { origin: `http://${host}` } })).status, 503, "no sign-in while it is on");
    assert.equal(t.app.stack.sessions.count(), 0, "every session is gone");
    assert.ok(t.audit.events.some((e) => e.kind === "lockdown" && e.detail?.["via"] === "killswitch"));
    rmSync(join(control, SHELL_DISABLED_FLAG));
    assert.equal((await me()).status, 401, "re-enabled, but the old session does not come back");
  } finally {
    await t.close();
  }
});

test("a POST body that drips in slowly is cut off with 408; the connection is not held open", async () => {
  const t = await makeApp({ mode: "local", bodyTimeoutMs: 250 });
  try {
    const status = await new Promise<string>((resolve) => {
      const s = connect(t.port, "127.0.0.1", () => {
        s.write(`POST /api/login/password HTTP/1.1\r\nHost: localhost:${t.port}\r\nOrigin: http://localhost:${t.port}\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{"login":`);
      });
      let got = "";
      s.on("data", (d) => (got += d.toString()));
      s.on("close", () => resolve(got.split("\r\n")[0] ?? ""));
      setTimeout(() => s.destroy(), 3000);
    });
    assert.match(status, /408|400/, status);
  } finally {
    await t.close();
  }
});

test("the entry point: arguments are parsed strictly, tailnet mode needs the ts.net name, endpoints come from the runner blocks and the proxy preset", () => {
  const env = { ProgramData: "C:\\PD" };
  const d = parseWebCli([], env);
  assert.deepEqual([d.mode, d.port, d.checkAcl, d.configPath], ["local", 47009, true, "C:\\PD\\agent-007\\config\\config.json"]);
  assert.equal(parseWebCli(["--mode", "tailnet", "--public-host", "PC.tail1234.ts.net", "--port", "47010"], env).publicHost, "pc.tail1234.ts.net");
  for (const bad of [["--mode", "tailnet"], ["--mode", "public"], ["--port", "0"], ["--port", "70000"], ["--bogus"], ["--config"], ["--mode", "tailnet", "--public-host", "evil.example.com"]]) assert.throws(() => parseWebCli(bad, env), Error, bad.join(" "));
  const resolve = endpointResolver(
    { model: { runners: { lmstudio: { baseUrl: "http://127.0.0.1:1234/v1" }, strata: { baseUrl: "http://127.0.0.1:8080/v1" } } } } as never,
    { lmStudioApiToken: "lm-key", strataApiKey: "st-key", proxyApiKey: "px-key" },
    PRESETS,
  );
  assert.deepEqual(resolve("strata"), { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "st-key", modelId: "strata", maxTokens: 4096, viaProxy: false, label: "strata" });
  assert.deepEqual(resolve("claude-sonnet"), { baseUrl: "http://127.0.0.1:8787/v1", apiKey: "px-key", modelId: "claude/sonnet", maxTokens: 8192, viaProxy: true, label: "Claude Sonnet" });
  assert.equal(resolve("nope"), undefined);
});

test("a start with a Funnel entry, a foreign serve target or a corrupt store is refused before anything listens", async () => {
  const mk = async (over: Record<string, unknown>, prep?: (dir: string) => void) => {
    const dir = tempDir("a7-refuse-");
    prep?.(dir);
    const port = await freePort();
    return startWebApp({ dataDir: dir, port, mode: "tailnet", publicHosts: ["pc.tail1234.ts.net"], presets: () => PRESETS, terms: () => ({ claude: true, antigravity: false }), engine: new ScriptedEngine(), clockSkewMs: () => 0, serveStatus: () => "{}", ...over });
  };
  await assert.rejects(() => mk({ serveStatus: () => JSON.stringify({ AllowFunnel: { "pc.tail1234.ts.net:443": true } }) }), /Funnel/);
  await assert.rejects(() => mk({ serveStatus: () => JSON.stringify({ Web: { h: { Handlers: { "/": { Proxy: "http://127.0.0.1:47008" } } } } }) }), /other than the gateway/);
  await assert.rejects(() => mk({ serveStatus: () => undefined }), /could not be read/);
  await assert.rejects(() => mk({ clockSkewMs: () => 3_600_000 }), /clock is off/);
  await assert.rejects(
    () =>
      mk({}, (dir) => {
        mkdirSync(join(dir, "web"), { recursive: true });
        writeFileSync(join(dir, "web", "users.json"), "{ not json");
      }),
    /corrupt/,
  );
  void until;
  void wait;
});
