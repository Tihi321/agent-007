/** S34: the real chat engine over OpenAI-compatible endpoints, against fakes. The proxy rules of I39, the tool loop, and a whole chat through the gateway. Offline. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProxyStatus } from "../../src/proxy/health.js";
import { createOpenAiEngine } from "../../src/web/chat/openaiEngine.js";
import type { ModelEndpoint } from "../../src/web/chat/openaiEngine.js";
import type { EngineEvent, EngineTurn } from "../../src/web/chat/engine.js";
import { buildUserToolbox } from "../../src/web/runtime/tools.js";
import { toRuntimeBot } from "../../src/web/runtime/userBots.js";
import { newUserId } from "../../src/web/ids.js";
import { startFakeOpenAi } from "../helpers/fakeOpenAi.js";
import type { Behavior } from "../helpers/fakeOpenAi.js";
import { FAKE_KEY, freePort } from "../proxy/helpers.js";
import { BOT, ScriptedEngine, makeApp, until } from "./app.js";
import { tempDir } from "../settings/helpers.js";

const cfg = (preset: string, fallback?: string) => ({ name: "H", tagline: "", avatar: "robot", persona: "", preset, ...(fallback ? { fallback } : {}), tools: ["tool_search", "read_file"], memory: false, starters: [], createdAt: 1, updatedAt: 1 });

function turn(over: { fallback?: string; preset?: string; signal?: AbortSignal; callTool?: EngineTurn["callTool"] } = {}) {
  const dir = tempDir("a7-eng-");
  const bot = toRuntimeBot(dir, newUserId(), "hh", cfg(over.preset ?? "claude-sonnet", over.fallback ?? "strata"));
  const events: EngineEvent[] = [];
  const box = buildUserToolbox(bot, { storageMB: 1 });
  const ac = new AbortController();
  const t: EngineTurn = { bot, system: "SYS", history: [{ role: "user", text: "earlier" }, { role: "assistant", text: "reply" }], userText: "now", signal: over.signal ?? ac.signal, tools: box.tools, emit: (e) => events.push(e), callTool: over.callTool ?? (async (n, a) => box.call(n, a)) };
  return { t, events, text: () => events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join(""), notices: () => events.filter((e) => e.type === "notice").length, ac };
}

const say = (text: string): Behavior => () => ({ type: "text", text });

test("a plain answer streams as deltas, history and system prompt go in order, usage is read, and no sampling field is sent", async () => {
  const strata = await startFakeOpenAi({ behavior: say("Hello from Strata"), modelId: "m" });
  try {
    const eng = createOpenAiEngine({ endpoint: (id) => (id === "strata" ? { baseUrl: strata.baseUrl, modelId: "m", maxTokens: 512, viaProxy: false, label: "Strata" } : undefined) });
    const x = turn({ preset: "strata", fallback: "" });
    const r = await eng.runTurn(x.t);
    assert.equal(r.stopReason, "stop");
    assert.equal(x.text(), "Hello from Strata");
    assert.ok(r.usage.input > 0 && r.usage.output > 0);
    const body = strata.chatRequests()[0]!.body!;
    assert.deepEqual(body.messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
    assert.equal(body.messages[3]?.content, "now");
    assert.equal(body.stream, true);
    for (const k of ["temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty", "seed"]) assert.ok(!(k in body), k);
    assert.deepEqual((body.tools ?? []).map((t) => t.function?.name).sort(), ["read_file", "tool_search"]);
  } finally {
    await strata.close();
  }
});

test("tool loop: a tool call runs through callTool, its result goes back wrapped as untrusted data, the final text follows", async () => {
  let n = 0;
  const strata = await startFakeOpenAi({
    modelId: "m",
    behavior: (i) => {
      n++;
      if (n === 1) return { type: "tool_calls", calls: [{ name: "read_file", args: { path: "notes.txt" } }] };
      assert.equal(i.afterTool, true);
      assert.match(i.lastToolText, /<untrusted_content source="tool:read_file">[\s\S]*FILE BODY[\s\S]*<\/untrusted_content>/);
      return { type: "text", text: "done" };
    },
  });
  try {
    const eng = createOpenAiEngine({ endpoint: () => ({ baseUrl: strata.baseUrl, modelId: "m", maxTokens: 512, viaProxy: false, label: "Strata" }) });
    const called: string[] = [];
    const x = turn({ preset: "strata", fallback: "", callTool: async (name) => (called.push(name), { ok: true, text: "FILE BODY" }) });
    const r = await eng.runTurn(x.t);
    assert.deepEqual(called, ["read_file"]);
    assert.equal(x.text(), "done");
    assert.equal(r.stopReason, "stop");
    // a model that loops on tools is cut off after the round cap
    const loop = await startFakeOpenAi({ modelId: "m", behavior: () => ({ type: "tool_calls", calls: [{ name: "tool_search", args: {} }] }) });
    try {
      const e2 = createOpenAiEngine({ endpoint: () => ({ baseUrl: loop.baseUrl, modelId: "m", maxTokens: 512, viaProxy: false, label: "Strata" }), maxToolRounds: 3 });
      const y = turn({ preset: "strata", fallback: "", callTool: async () => ({ ok: true, text: "x" }) });
      await e2.runTurn(y.t);
      assert.equal(loop.chatRequests().length, 3);
    } finally {
      await loop.close();
    }
  } finally {
    await strata.close();
  }
});

test("I39 in the chat engine: proxy 503 provider_auth_required, a downed proxy and a busy provider each fall back to the local preset once, with one notice", async () => {
  const strata = await startFakeOpenAi({ behavior: say("local answer"), modelId: "m" });
  try {
    for (const proxy of [{ kind: "auth", reply: { type: "error" as const, status: 503, body: { error: { code: "provider_auth_required", message: "login", type: "x" } } } }, { kind: "busy", reply: { type: "error" as const, status: 503, body: { error: { code: "provider_busy", message: "busy", type: "x" } } } }, { kind: "queue", reply: { type: "error" as const, status: 429, body: { error: { code: "provider_queue_full", message: "q", type: "x" } } } }]) {
      const px = await startFakeOpenAi({ behavior: () => proxy.reply, modelId: "claude/sonnet", requireKey: FAKE_KEY });
      const status = new ProxyStatus();
      try {
        const eng = createOpenAiEngine({
          status,
          endpoint: (id) => (id === "claude-sonnet" ? { baseUrl: px.baseUrl, apiKey: FAKE_KEY, modelId: "claude/sonnet", maxTokens: 512, viaProxy: true, providerId: "claude", label: "Claude" } : { baseUrl: strata.baseUrl, modelId: "m", maxTokens: 512, viaProxy: false, label: "Strata" }),
        });
        const x = turn();
        const r = await eng.runTurn(x.t);
        assert.equal(r.stopReason, "stop", proxy.kind);
        assert.equal(x.text(), "local answer", proxy.kind);
        assert.equal(x.notices(), 1, `${proxy.kind}: told once`);
        assert.equal(px.chatRequests().length, 1, `${proxy.kind}: the proxy was tried once`);
        if (proxy.kind === "auth") assert.equal(status.needsLogin("acp-claude"), true, "/status says the provider needs a login");
      } finally {
        await px.close();
      }
    }
    // a downed proxy (nothing listens)
    const port = await freePort();
    const eng = createOpenAiEngine({ endpoint: (id) => (id === "claude-sonnet" ? { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: FAKE_KEY, modelId: "claude/sonnet", maxTokens: 512, viaProxy: true, providerId: "claude", label: "Claude" } : { baseUrl: strata.baseUrl, modelId: "m", maxTokens: 512, viaProxy: false, label: "Strata" }) });
    const x = turn();
    assert.equal((await eng.runTurn(x.t)).stopReason, "stop");
    assert.equal(x.text(), "local answer");
    assert.match((x.events.find((e) => e.type === "notice") as { text: string }).text, /not reachable/);
  } finally {
    await strata.close();
  }
});

test("a Claude preset whose proxy login is an API key is never called; a bad request is not a fallback; no fallback means a clear error; abort stops", async () => {
  const strata = await startFakeOpenAi({ behavior: say("local answer"), modelId: "m" });
  const px = await startFakeOpenAi({ behavior: say("claude answer"), modelId: "claude/sonnet", requireKey: FAKE_KEY });
  try {
    const status = new ProxyStatus();
    status.noteAuthMethod("claude", "api_key");
    const ep = (id: string): ModelEndpoint | undefined => (id === "claude-sonnet" ? { baseUrl: px.baseUrl, apiKey: FAKE_KEY, modelId: "claude/sonnet", maxTokens: 512, viaProxy: true, providerId: "claude", label: "Claude" } : id === "strata" ? { baseUrl: strata.baseUrl, modelId: "m", maxTokens: 512, viaProxy: false, label: "Strata" } : undefined);
    const eng = createOpenAiEngine({ endpoint: ep, status });
    const x = turn();
    assert.equal((await eng.runTurn(x.t)).stopReason, "stop");
    assert.equal(x.text(), "local answer");
    assert.equal(px.requests.length, 0, "no request reached the proxy");
    assert.match((x.events.find((e) => e.type === "notice") as { text: string }).text, /not usable/);
    // refused and no fallback: a fixed error sentence
    const solo = turn({ fallback: "" });
    const r = await eng.runTurn(solo.t);
    assert.equal(r.stopReason, "error");
    assert.match(r.error ?? "", /not available/);
    // 400 is a client bug: no fallback to the local model
    const bad = await startFakeOpenAi({ behavior: () => ({ type: "error", status: 400, body: { error: { code: "unsupported_parameter", message: "x", type: "y" } } }), modelId: "claude/sonnet" });
    try {
      const e2 = createOpenAiEngine({ endpoint: (id) => (id === "claude-sonnet" ? { baseUrl: bad.baseUrl, modelId: "claude/sonnet", maxTokens: 512, viaProxy: true, providerId: "claude", label: "Claude" } : ep(id)) });
      const y = turn();
      const rr = await e2.runTurn(y.t);
      assert.equal(rr.stopReason, "error");
      assert.equal(strata.chatRequests().length, 1, "only the earlier local call; no fallback for a 400");
    } finally {
      await bad.close();
    }
    // abort while streaming
    const slow = await startFakeOpenAi({ behavior: () => ({ type: "text", text: "x".repeat(2000), chunkSize: 1, chunkDelayMs: 5 }), modelId: "m" });
    try {
      const e3 = createOpenAiEngine({ endpoint: () => ({ baseUrl: slow.baseUrl, modelId: "m", maxTokens: 512, viaProxy: false, label: "S" }) });
      const z = turn({ preset: "strata", fallback: "" });
      const p = e3.runTurn(z.t);
      await until(() => z.text().length > 3);
      z.ac.abort();
      const out = await p;
      assert.equal(out.stopReason, "aborted");
      assert.ok(z.text().length < 2000);
    } finally {
      await slow.close();
    }
  } finally {
    await px.close();
    await strata.close();
  }
});

test("a whole chat through the gateway: a Claude bot with a Strata fallback; the proxy says 503 provider_auth_required; the answer arrives from Strata with one notice stored on the message", async () => {
  const strata = await startFakeOpenAi({ behavior: say("local answer"), modelId: "m" });
  const px = await startFakeOpenAi({ behavior: () => ({ type: "error", status: 503, body: { error: { code: "provider_auth_required", message: "x", type: "y" } } }), modelId: "claude/sonnet", requireKey: FAKE_KEY });
  const t = await makeApp({
    engine: new ScriptedEngine(),
    realEngine: createOpenAiEngine({
      status: new ProxyStatus(),
      endpoint: (id) => (id === "claude-sonnet" ? { baseUrl: px.baseUrl, apiKey: FAKE_KEY, modelId: "claude/sonnet", maxTokens: 512, viaProxy: true, providerId: "claude", label: "Claude" } : id === "strata" ? { baseUrl: strata.baseUrl, modelId: "m", maxTokens: 512, viaProxy: false, label: "Strata" } : undefined),
    }),
  });
  try {
    const bot = await t.post(t.owner, "/api/bots/create", { ...BOT, preset: "claude-sonnet", fallback: "strata", tools: ["tool_search"] });
    assert.equal(bot.status, 200, bot.text);
    for (let k = 1; k <= 2; k++) {
      const sent = (await t.post(t.owner, "/api/chat/send", { bot: bot.json().bot.id, text: `question ${k}`, ...(k === 2 ? { thread: undefined } : {}) })).json();
      await t.app.chat.settle(t.owner.userId, sent.threadId);
      const th = (await t.post(t.owner, "/api/chat/thread/get", { bot: bot.json().bot.id, thread: sent.threadId })).json().thread;
      assert.equal(th.messages[1].text, "local answer");
      assert.match(th.messages[1].notice, /needs a login/);
      assert.equal(th.messages[1].error, undefined);
    }
  } finally {
    await t.close();
    await px.close();
    await strata.close();
  }
});

test("L7: the API-key refusal is keyed by the preset's provider id, not by 'claude' in the model id; a 503 asks the host to re-read the proxy health", async () => {
  const strata = await startFakeOpenAi({ behavior: say("local answer"), modelId: "m" });
  const px = await startFakeOpenAi({ behavior: say("proxy answer"), modelId: "anthropic/sonnet-4" });
  try {
    const status = new ProxyStatus();
    status.noteAuthMethod("claude", "api_key");
    // a Claude preset whose model id does not say "claude" is still refused
    const claudeNoName = (id: string): ModelEndpoint | undefined => (id === "claude-sonnet" ? { baseUrl: px.baseUrl, modelId: "anthropic/sonnet-4", maxTokens: 512, viaProxy: true, providerId: "claude", label: "Claude" } : { baseUrl: strata.baseUrl, modelId: "m", maxTokens: 512, viaProxy: false, label: "Strata" });
    const x = turn();
    await createOpenAiEngine({ endpoint: claudeNoName, status }).runTurn(x.t);
    assert.equal(px.requests.length, 0, "refused: no request reached the proxy");
    assert.equal(x.text(), "local answer");
    // a codex preset whose model id happens to contain "claude" is NOT refused by the Claude login state
    const codexNamed = (id: string): ModelEndpoint | undefined => (id === "claude-sonnet" ? { baseUrl: px.baseUrl, modelId: "codex/claude-compatible", maxTokens: 512, viaProxy: true, providerId: "codex", label: "Codex" } : undefined);
    const y = turn();
    await createOpenAiEngine({ endpoint: codexNamed, status }).runTurn(y.t);
    assert.equal(y.text(), "proxy answer");
  } finally {
    await px.close();
  }
  // a 503 from the proxy triggers an immediate health refresh (not only the 60 s poll)
  const down = await startFakeOpenAi({ behavior: () => ({ type: "error", status: 503, body: { error: { code: "provider_auth_required", message: "login", type: "x" } } }), modelId: "claude/sonnet" });
  try {
    let refreshes = 0;
    const eng = createOpenAiEngine({ status: new ProxyStatus(), onProxyTrouble: () => refreshes++, endpoint: (id) => (id === "claude-sonnet" ? { baseUrl: down.baseUrl, modelId: "claude/sonnet", maxTokens: 512, viaProxy: true, providerId: "claude", label: "Claude" } : { baseUrl: strata.baseUrl, modelId: "m", maxTokens: 512, viaProxy: false, label: "Strata" }) });
    await eng.runTurn(turn().t);
    assert.equal(refreshes, 1);
  } finally {
    await down.close();
    await strata.close();
  }
  // the refresher: one check at a time, at most one per gap
  const { proxyRefresher } = await import("../../src/web/main.js");
  let checks = 0;
  const clock = { t: 0 };
  const r = proxyRefresher(async () => void checks++, { minGapMs: 5000, now: () => clock.t });
  await r.refresh();
  assert.equal(r.refresh(), undefined, "inside the gap");
  clock.t += 6000;
  await r.refresh();
  assert.equal(checks, 2);
});

test("M2: a paid preset's budget clamps max_tokens and ends the tool loop when used up; servedBy names the preset; allow() drops a link", async () => {
  const loop = await startFakeOpenAi({ modelId: "m", behavior: () => ({ type: "tool_calls", calls: [{ name: "tool_search", args: {} }] }) });
  const strata = await startFakeOpenAi({ behavior: say("local"), modelId: "m" });
  try {
    const eng = createOpenAiEngine({ endpoint: (id) => (id === "claude-sonnet" ? { baseUrl: loop.baseUrl, modelId: "m", maxTokens: 4096, viaProxy: true, providerId: "claude", paid: true, label: "Paid" } : { baseUrl: strata.baseUrl, modelId: "m", maxTokens: 512, viaProxy: false, label: "Strata" }) });
    const x = turn({ callTool: async () => ({ ok: true, text: "x" }) });
    x.t.budget = (id) => (id === "claude-sonnet" ? 30 : undefined);
    const r = await eng.runTurn(x.t);
    assert.equal(loop.chatRequests()[0]!.body!.max_tokens, 30, "the output is clamped to the cap's headroom");
    assert.ok(loop.chatRequests().length < 6, "the loop stopped at the cap, not at the round limit");
    assert.equal(r.servedBy, "claude-sonnet");
    assert.ok(x.events.some((e) => e.type === "notice" && /spending cap/.test(e.text)));
    // a link dropped since the turn started (allow false) is skipped: the local model answers
    const y = turn();
    y.t.allow = (id) => id !== "claude-sonnet";
    const before = loop.chatRequests().length;
    const r2 = await eng.runTurn(y.t);
    assert.equal(loop.chatRequests().length, before);
    assert.equal(r2.servedBy, "strata");
  } finally {
    await loop.close();
    await strata.close();
  }
});
