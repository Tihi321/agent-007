/** S36: the pieces around the gateway: the kill switch coupling, the entry point's argument and endpoint helpers, the body deadline, a refused start. Offline. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { SHELL_DISABLED_FLAG } from "../../src/approval/killSwitch.js";
import { startWebApp } from "../../src/web/app.js";
import { endpointResolver, parseWebCli } from "../../src/web/main.js";
import { BOT, PRESETS, ScriptedEngine, freePort, makeApp, until, wait } from "./app.js";
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
  assert.deepEqual(resolve("claude-sonnet"), { baseUrl: "http://127.0.0.1:8787/v1", apiKey: "px-key", modelId: "claude/sonnet", maxTokens: 8192, viaProxy: true, providerId: "claude", label: "Claude Sonnet" });
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

/** L3: a turn that runs until it is aborted (or 3 s pass), so a test can see whether something stopped it. */
const hangingEngine = () =>
  new ScriptedEngine(async (t) => {
    t.emit({ type: "delta", text: "thinking" });
    const end = Date.now() + 3000;
    while (!t.signal.aborted && Date.now() < end) await wait(5);
    return { stopReason: t.signal.aborted ? "aborted" : "stop" };
  });

async function runningTurn(t: Awaited<ReturnType<typeof makeApp>>, who: Parameters<typeof t.post>[0] & { userId: string }) {
  const bot = (await t.post(who, "/api/bots/create", BOT)).json().bot.id as string;
  const sent = await t.post(who, "/api/chat/send", { bot, text: "hello" });
  assert.equal(sent.status, 200, sent.text);
  const thread = sent.json().threadId as string;
  await until(() => t.engine.running > 0);
  return { thread, stopped: () => until(() => t.app.chat.run(who.userId, thread)?.done === true, 1500) };
}

test("L3: disabling a user stops that user's running turn at once (not only the session)", async () => {
  const t = await makeApp({ engine: hangingEngine() });
  try {
    const alice = await t.addUser("alice@example.com");
    const r = await runningTurn(t, alice);
    t.app.admin.disableUser(t.owner.userId, alice.userId);
    await r.stopped();
    assert.equal(t.app.chat.run(alice.userId, r.thread)!.events.at(-1)!.ev.type, "done");
    assert.equal((t.app.chat.run(alice.userId, r.thread)!.events.at(-1)!.ev as { stopReason: string }).stopReason, "aborted");
    assert.equal(t.app.chat.registry.forUser(alice.userId).length, 0, "the runtime bots are dropped");
  } finally {
    await t.close();
  }
});

test("L3: the kill switch flag stops every running turn", async () => {
  const control = tempDir("a7-control-");
  const t = await makeApp({ engine: hangingEngine(), controlDir: control });
  try {
    const alice = await t.addUser("alice@example.com");
    const r = await runningTurn(t, alice);
    writeFileSync(join(control, SHELL_DISABLED_FLAG), "x");
    await http(t.port, "GET", "/api/me", { host: `localhost:${t.port}`, headers: { cookie: t.owner.cookie } }); // the next request trips it at once
    await r.stopped();
  } finally {
    await t.close();
  }
});

test("L3: the owner lockdown route stops every running turn", async () => {
  const t = await makeApp({ engine: hangingEngine() });
  try {
    const alice = await t.addUser("alice@example.com"); // also leaves the owner with a fresh step-up
    const r = await runningTurn(t, alice);
    const res = await t.post(t.owner, "/api/admin/lockdown", {});
    assert.equal(res.status, 200, res.text);
    await r.stopped();
  } finally {
    await t.close();
  }
});

test("L2: five failed sign-ins lock the login and drop ONE content-free owner notice in the control folder; the agent side turns it into a fixed text", async () => {
  const { drainOwnerNotices, ownerNoticesDir, parseOwnerNotice, writeOwnerNotice, OWNER_NOTICES_MAX_PENDING } = await import("../../src/approval/ownerNotices.js");
  const control = tempDir("a7-control-");
  const t = await makeApp({ mode: "local", controlDir: control });
  try {
    const host = `localhost:${t.port}`;
    for (let i = 0; i < 5; i++) await http(t.port, "POST", "/api/login/password", { body: { login: "owner@example.com", password: "wrong password <b>x</b>", totpCode: "000000" }, host, headers: { origin: `http://${host}` } });
    const files = readdirSync(ownerNoticesDir(control)).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 1, "a notice was written");
    const raw = readFileSync(join(ownerNoticesDir(control), files[0]!), "utf8");
    assert.ok(!/owner@example|wrong password|<b>/.test(raw), "no login, password or client text in the file");
    const sent: string[] = [];
    assert.ok((await drainOwnerNotices(control, async (s) => void sent.push(s))) >= 1);
    assert.match(sent[0]!, /^Web access: a web (login|client) was locked out for 15 minutes/);
    assert.equal(readdirSync(ownerNoticesDir(control)).length, 0, "the agent deletes what it read");
  } finally {
    await t.close();
  }
  // a hand-made file with any other shape is dropped, never sent; the writer stops at the pending cap
  assert.equal(parseOwnerNotice({ kind: "web_lockout", scope: "login", minutes: 15, text: "click evil.example" }), undefined);
  assert.equal(parseOwnerNotice({ kind: "other", scope: "login", minutes: 15 }), undefined);
  writeFileSync(join(ownerNoticesDir(control), "1-deadbeef.json"), JSON.stringify({ kind: "web_lockout", scope: "login", minutes: 15, text: "evil" }));
  const sent: string[] = [];
  await drainOwnerNotices(control, async (s) => void sent.push(s));
  assert.equal(sent.length, 0, "a file of another shape is dropped");
  for (let i = 0; i < OWNER_NOTICES_MAX_PENDING + 5; i++) writeOwnerNotice(control, { kind: "web_lockout", scope: "client", minutes: 15 });
  assert.equal(readdirSync(ownerNoticesDir(control)).length, OWNER_NOTICES_MAX_PENDING);
  await drainOwnerNotices(control, async (s) => void sent.push(s));
  assert.equal(sent.length, 6, "five notices and one summary line per poll");
});

test("L8: the gateway keeps only the model keys from secrets.json, never a Telegram token, the IPC key or MCP tokens", async () => {
  const { pickWebSecrets } = await import("../../src/web/main.js");
  const all = { telegramBotToken: "111:TG", botTokens: { research: "222:TG" }, mirrorBotToken: "333:TG", ipcHmacKey: "k".repeat(43), mcpTokens: { a: "m" }, lmStudioApiToken: "lm", strataApiKey: "st", proxyApiKey: "px" };
  assert.deepEqual(pickWebSecrets(all), { lmStudioApiToken: "lm", strataApiKey: "st", proxyApiKey: "px" });
  assert.deepEqual(pickWebSecrets({ telegramBotToken: "111:TG" }), {});
  // no gateway source reads a Telegram token
  for (const f of readdirSync(join(process.cwd(), "src", "web"), { recursive: true }).map(String).filter((x) => x.endsWith(".ts"))) {
    const code = readFileSync(join(process.cwd(), "src", "web", f), "utf8");
    assert.ok(!/telegramBotToken|botTokens|mirrorBotToken|ipcHmacKey|mcpTokens/.test(code), `src/web/${f} names an owner secret`);
  }
});

test("N3: a directory or oversized file named like a notice does not block later notices", async () => {
  const { drainOwnerNotices, ownerNoticesDir, writeOwnerNotice } = await import("../../src/approval/ownerNotices.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const control = tempDir("a7-control-");
  assert.ok(writeOwnerNotice(control, { kind: "web_lockout", scope: "login", minutes: 15 }));
  mkdirSync(join(ownerNoticesDir(control), "0-deadbeef.json"));
  writeFileSync(join(ownerNoticesDir(control), "1-deadbeef.json"), "x".repeat(10_000));
  const sent: string[] = [];
  await drainOwnerNotices(control, async (s) => void sent.push(s));
  assert.equal(sent.length, 1);
});
