/** S10.1: the HubClient against a local fake Streamable HTTP MCP server: loopback only, cancel, timeout, progress, reconnect. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { HubClient, HubUnavailableError, McpUrlRefusedError, assertLoopbackMcpUrl, describeMcpError, probeMcpServer } from "../../src/mcp/client.js";
import { McpTimeoutError } from "../../src/pi/adapter.js";
import { FakeMcpServer, closedPort } from "./fakeMcpServer.js";

test("only http(s) URLs on 127.0.0.1 or localhost without credentials are accepted", () => {
  for (const ok of ["http://127.0.0.1:7458/mcp", "http://localhost:7460/mcp", "https://127.0.0.1/mcp"]) {
    assert.doesNotThrow(() => assertLoopbackMcpUrl("s", ok), ok);
  }
  for (const bad of [
    "http://192.168.1.20:7458/mcp",
    "http://10.0.0.5/mcp",
    "http://0.0.0.0:7458/mcp",
    "http://example.com/mcp",
    "http://127.0.0.1.evil.com/mcp",
    "http://user:pw@127.0.0.1:7458/mcp",
    "ftp://127.0.0.1/mcp",
    "file:///C:/x",
    "not a url",
    "",
  ]) {
    assert.throws(() => assertLoopbackMcpUrl("s", bad), McpUrlRefusedError, bad);
  }
});

test("constructing a client for a non-loopback URL throws before any network use", () => {
  assert.throws(() => new HubClient({ id: "evil", url: "http://example.com:7458/mcp" }), /not on loopback/);
});

test("connect, list tools (all pages) and call a tool", async () => {
  const fake = await FakeMcpServer.start({
    pageSize: 2,
    tools: ["a", "b", "c", "d", "e"].map((name) => ({ name, handler: (args: Record<string, unknown>) => `${name}:${JSON.stringify(args)}` })),
  });
  const c = new HubClient({ id: "demo", url: fake.url });
  try {
    const tools = await c.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["a", "b", "c", "d", "e"]);
    const r = await c.callTool("c", { x: 1 });
    assert.deepEqual(r.content, [{ type: "text", text: 'c:{"x":1}' }]);
    assert.deepEqual(fake.calls.map((x) => x.name), ["c"]);
  } finally {
    await c.close();
    await fake.close();
  }
});

test("a bearer token from secrets is sent on every request (and none when not configured)", async () => {
  const fake = await FakeMcpServer.start({ tools: [{ name: "t" }], requireToken: "tok-123456" });
  const good = new HubClient({ id: "book-translator", url: fake.url, token: "tok-123456" });
  const bad = new HubClient({ id: "book-translator", url: fake.url });
  try {
    assert.equal((await good.listTools()).length, 1);
    assert.equal(fake.initAuth[0], "Bearer tok-123456");
    await assert.rejects(bad.listTools(), (e: unknown) => e instanceof HubUnavailableError && e.reason === "auth_required");
    assert.match(describeMcpError(new HubUnavailableError("book-translator", "auth_required"), "book-translator").message, /not answering/);
  } finally {
    await good.close();
    await bad.close();
    await fake.close();
  }
});

test("a closed port is HubUnavailableError(unreachable) with a message that points to hub_start and never auto-starts", async () => {
  const port = await closedPort();
  const c = new HubClient({ id: "vibetts", url: `http://127.0.0.1:${port}/mcp`, connectTimeoutMs: 2000 });
  await assert.rejects(c.listTools(), (e: unknown) => e instanceof HubUnavailableError && e.reason === "unreachable");
  const d = describeMcpError(new HubUnavailableError("vibetts", "unreachable"), "vibetts");
  assert.equal(d.kind, "unavailable");
  assert.match(d.message, /never starts a service itself/);
  assert.match(d.message, /hub_start/);
  await c.close();
});

test("the caller's signal cancels a call: it rejects at once and the server is told", async () => {
  const fake = await FakeMcpServer.start({ tools: [{ name: "slow", hang: true }] });
  const c = new HubClient({ id: "demo", url: fake.url });
  try {
    await c.listTools();
    const ac = new AbortController();
    const t0 = Date.now();
    const call = c.callTool("slow", {}, { signal: ac.signal, timeoutMs: 60_000 });
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(call, (e: unknown) => describeMcpError(e, "demo").kind === "abort");
    assert.ok(Date.now() - t0 < 5000, "did not wait for the 60 s timeout");
    for (let i = 0; i < 40 && fake.cancelled.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(fake.cancelled.length, 1, "notifications/cancelled reached the server");
  } finally {
    await c.close();
    await fake.close();
  }
});

test("a call that exceeds its timeout fails with a timeout error and a clear message", async () => {
  const fake = await FakeMcpServer.start({ tools: [{ name: "slow", hang: true }] });
  const c = new HubClient({ id: "demo", url: fake.url });
  try {
    await c.listTools();
    await assert.rejects(c.callTool("slow", {}, { timeoutMs: 150 }), (e: unknown) => {
      assert.ok(e instanceof McpTimeoutError);
      const d = describeMcpError(e, "demo");
      assert.equal(d.kind, "timeout");
      assert.match(d.message, /may still be running/);
      return true;
    });
  } finally {
    await c.close();
    await fake.close();
  }
});

test("progress notifications reach the callback", async () => {
  const fake = await FakeMcpServer.start({
    tools: [{ name: "render", progress: [{ progress: 1, total: 3, message: "step one" }, { progress: 2, total: 3 }, { progress: 3, total: 3 }], handler: () => "rendered" }],
  });
  const c = new HubClient({ id: "demo", url: fake.url });
  try {
    await c.listTools();
    const seen: number[] = [];
    const r = await c.callTool("render", {}, { onProgress: (p) => seen.push(p.progress) });
    assert.deepEqual(seen, [1, 2, 3]);
    assert.deepEqual(r.content, [{ type: "text", text: "rendered" }]);
    assert.equal(fake.calls[0]?.hadProgressToken, true);
  } finally {
    await c.close();
    await fake.close();
  }
});

test("after the server forgets the session the call is retried once on a fresh session", async () => {
  const fake = await FakeMcpServer.start({ tools: [{ name: "t", handler: () => "fine" }] });
  const c = new HubClient({ id: "demo", url: fake.url });
  try {
    await c.listTools();
    fake.dropSessions(); // a server restart: the old session id gets 404
    const r = await c.callTool("t", {});
    assert.deepEqual(r.content, [{ type: "text", text: "fine" }]);
    assert.equal(fake.calls.length, 1, "the call ran once");
    assert.equal(fake.methods.filter((m) => m === "initialize").length, 2, "a new session was opened");
  } finally {
    await c.close();
    await fake.close();
  }
});

test("probeMcpServer: up (initialize only), down (closed port), no_mcp (a port that is not MCP), auth_required", async () => {
  const fake = await FakeMcpServer.start({ tools: [{ name: "t" }] });
  const locked = await FakeMcpServer.start({ tools: [{ name: "t" }], requireToken: "secret-token" });
  try {
    const up = await probeMcpServer("demo", { url: fake.url });
    assert.equal(up.state, "up");
    assert.ok(!fake.methods.includes("tools/call") && !fake.methods.includes("tools/list"), "initialize only: no tool is listed or called");
    assert.equal((await probeMcpServer("gone", { url: `http://127.0.0.1:${await closedPort()}/mcp` })).state, "down");
    assert.equal((await probeMcpServer("locked", { url: locked.url })).state, "auth_required");
    assert.equal((await probeMcpServer("locked", { url: locked.url, token: "secret-token" })).state, "up");
    // a live HTTP port with no /mcp route
    const wrongPath = await probeMcpServer("odd", { url: fake.url.replace("/mcp", "/other"), initTimeoutMs: 1500 });
    assert.equal(wrongPath.state, "no_mcp");
  } finally {
    await fake.close();
    await locked.close();
  }
});
