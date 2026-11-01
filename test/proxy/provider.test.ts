import assert from "node:assert/strict";
import { test } from "node:test";
import { createBotModels } from "../../src/pi/adapter.js";
import type { AssistantMessage, Models } from "../../src/pi/adapter.js";
import { createRedactor } from "../../src/logging/redact.js";
import { createProxyBrain, limitProxyModels, proxyProvidersForBot } from "../../src/proxy/provider.js";
import type { FailureEvent } from "../../src/proxy/provider.js";
import { ProxyLimiters } from "../../src/proxy/limiter.js";
import { startFakeOpenAi } from "../helpers/fakeOpenAi.js";
import type { Behavior, FakeServer } from "../helpers/fakeOpenAi.js";
import { FAKE_KEY, acpPreset, specFor, violations } from "./helpers.js";

type AnyFn = (...a: unknown[]) => unknown;
const USER = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });
const ADD_TOOL = { name: "add_numbers", description: "add", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } };

async function rig(behavior?: Behavior, requireKey: string | undefined = FAKE_KEY): Promise<{ fake: FakeServer; models: Models; modelRef: unknown; brain: ReturnType<typeof createProxyBrain>; failures: FailureEvent[] }> {
  const fake = await startFakeOpenAi({ ...(behavior ? { behavior } : {}), ...(requireKey ? { requireKey } : {}) });
  const preset = acpPreset({ baseUrl: fake.baseUrl });
  const failures: FailureEvent[] = [];
  const brain = createProxyBrain({ presets: [preset], secrets: { proxyApiKey: FAKE_KEY }, retry: false, onFailure: (e) => failures.push(e), redact: createRedactor([FAKE_KEY]) });
  const spec = specFor("codex") as never;
  const base = createBotModels(brain.extraProviders(spec));
  const models = brain.decorateModels(base, spec);
  const modelRef = await (models as unknown as { getModel: AnyFn }).getModel("acp-codex", "codex/gpt-x");
  assert.ok(modelRef, "the preset became a Model in provider acp-codex");
  return { fake, models, modelRef, brain, failures };
}

async function collect(stream: AsyncIterable<{ type: string }> & { result(): Promise<AssistantMessage> }): Promise<{ types: string[]; result: AssistantMessage }> {
  const types: string[] = [];
  for await (const ev of stream) types.push(ev.type);
  return { types, result: await stream.result() };
}

const call = (r: { models: Models; modelRef: unknown }, ctx: unknown, opts?: unknown) => (r.models as unknown as { streamSimple: AnyFn }).streamSimple(r.modelRef, ctx, opts) as never as Parameters<typeof collect>[0];

test("proxyProvidersForBot: one provider per vendor, one Model per preset, no sampling fields, loopback only", () => {
  const a = acpPreset({ baseUrl: "http://127.0.0.1:8787/v1" });
  const b = acpPreset({ id: "codex2", modelId: "codex/other", baseUrl: "http://127.0.0.1:8787/v1" });
  const c = acpPreset({ id: "claude", providerId: "claude", modelId: "claude/sonnet", baseUrl: "http://127.0.0.1:8787/v1" });
  const spec = { id: "main", route: { primary: "codex", allowed: ["codex2"], fallback: ["claude"], onAuthRequired: "ask" as const } };
  const providers = proxyProvidersForBot(spec, [a, b, c], { proxyApiKey: FAKE_KEY });
  assert.deepEqual(providers.map((p) => p.id).sort(), ["acp-claude", "acp-codex"]);
  assert.equal(providers.find((p) => p.id === "acp-codex")?.models.length, 2);
  assert.deepEqual(providers.find((p) => p.id === "acp-codex")?.models[0], { modelId: "codex/gpt-x", name: "Codex", contextWindow: 100000, maxTokens: 4096 });
  // unavailable presets are left out
  const less = proxyProvidersForBot(spec, [a, b, c], { proxyApiKey: FAKE_KEY, unavailablePresetIds: new Set(["claude"]) });
  assert.deepEqual(less.map((p) => p.id), ["acp-codex"]);
  // a non-loopback URL is refused
  assert.throws(() => proxyProvidersForBot(spec, [{ ...a, baseUrl: "http://10.1.2.3:8787/v1" }], {}), /loopback/);
  // local presets are not proxy providers
  assert.deepEqual(proxyProvidersForBot(spec, [{ ...a, kind: "local" } as never], {}), []);
});

test("a plain text call: streaming events, usage parsed, bearer key sent, only POST /v1/chat/completions, no sampling field", async () => {
  const r = await rig();
  try {
    const { types, result } = await collect(call(r, { messages: [USER("Reply with exactly: PONG")] }));
    assert.ok(types.includes("text_delta"), types.join(","));
    assert.equal(types[types.length - 1], "done");
    assert.equal(result.stopReason, "stop");
    assert.match(JSON.stringify(result.content), /PONG/);
    assert.equal(result.usage.input, 10);
    assert.ok(result.usage.output >= 1);
    assert.equal(result.usage.totalTokens, result.usage.input + result.usage.output);
    const reqs = r.fake.chatRequests();
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0]?.method, "POST");
    assert.equal(reqs[0]?.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(reqs[0]?.body?.model, "codex/gpt-x");
    assert.equal(reqs[0]?.body?.stream, true);
    assert.deepEqual(violations(r.fake.requests), []);
    assert.equal(r.brain.limiters.stats()["acp-codex"]?.active, 0, "the slot is released");
  } finally {
    await r.fake.close();
  }
});

test("a tool-call round trip: one call per response, then the answer", async () => {
  const r = await rig();
  try {
    const ctx1 = { messages: [USER("please add 1234 and 4321")], tools: [ADD_TOOL] };
    const first = await collect(call(r, ctx1));
    assert.equal(first.result.stopReason, "toolUse");
    const calls = first.result.content.filter((c) => c.type === "toolCall");
    assert.equal(calls.length, 1, "one tool call per response");
    const tc = calls[0] as unknown as { id: string; name: string; arguments: { a: number; b: number } };
    assert.equal(tc.name, "add_numbers");
    assert.deepEqual(tc.arguments, { a: 1234, b: 4321 });
    const ctx2 = {
      ...ctx1,
      messages: [...ctx1.messages, first.result, { role: "toolResult" as const, toolCallId: tc.id, toolName: tc.name, content: [{ type: "text" as const, text: "5555" }], isError: false, timestamp: Date.now() }],
    };
    const second = await collect(call(r, ctx2));
    assert.equal(second.result.stopReason, "stop");
    assert.match(JSON.stringify(second.result.content), /5555/);
    const reqs = r.fake.chatRequests();
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0]?.body?.tools?.[0]?.function?.name, "add_numbers");
    assert.equal(reqs[1]?.body?.messages.some((m) => m.role === "tool"), true);
    assert.deepEqual(violations(r.fake.requests), []);
  } finally {
    await r.fake.close();
  }
});

test("a complete (non-streamed API of the Models) call also works and uses the same single endpoint", async () => {
  const r = await rig();
  try {
    const m = (await (r.models as unknown as { completeSimple: AnyFn }).completeSimple(r.modelRef, { messages: [USER("Reply with exactly: PONG")] })) as AssistantMessage;
    assert.equal(m.stopReason, "stop");
    assert.match(JSON.stringify(m.content), /PONG/);
    assert.deepEqual(violations(r.fake.requests), []);
    assert.equal(r.brain.limiters.stats()["acp-codex"]?.active, 0);
  } finally {
    await r.fake.close();
  }
});

test("the fake proxy checker itself catches a stray URL and a sampling field", () => {
  assert.deepEqual(violations([{ method: "POST", url: "/v1/chat/completions" }, { method: "GET", url: "/healthz" }, { method: "GET", url: "/v1/models" }]), []);
  assert.equal(violations([{ method: "GET", url: "/v1/mcp" }]).length, 1);
  assert.equal(violations([{ method: "POST", url: "/v1/images/generations" }]).length, 1);
  assert.equal(violations([{ method: "GET", url: "/v1/chat/completions" }]).length, 1);
  assert.equal(violations([{ method: "GET", url: "/healthz?x=1" }]).length, 1);
  for (const f of ["temperature", "top_p", "frequency_penalty", "presence_penalty", "seed"]) {
    assert.equal(violations([{ method: "POST", url: "/v1/chat/completions", body: { messages: [], [f]: 0 } }]).length, 1, f);
  }
});

const errorCases: { name: string; status: number; body: unknown; marked: string | null; kind: string }[] = [
  { name: "503 auth", status: 503, body: { error: { message: "log in", type: "t", code: "provider_auth_required" } }, marked: "auth_required", kind: "auth_required" },
  { name: "404", status: 404, body: { error: { message: "no such model", type: "t", code: "model_not_found" } }, marked: "model_not_found", kind: "model_not_found" },
  { name: "400", status: 400, body: { error: { message: "no temperature please", type: "t", code: "unsupported_parameter" } }, marked: "bad_request", kind: "bad_request" },
  { name: "401", status: 401, body: { error: { message: "Invalid API key", type: "t", code: "invalid_api_key" } }, marked: "bad_key", kind: "bad_key" },
  { name: "503 busy", status: 503, body: { error: { message: "busy", type: "t", code: "provider_busy" } }, marked: null, kind: "busy" },
  { name: "429", status: 429, body: { error: { message: "full", type: "t", code: "provider_queue_full" } }, marked: null, kind: "queue_full" },
  { name: "504", status: 504, body: { error: { message: "slow", type: "t", code: "request_timeout" } }, marked: null, kind: "timeout" },
];

for (const c of errorCases) {
  test(`end to end: proxy ${c.name} is classified, reported once, and the slot is released`, async () => {
    const r = await rig(() => ({ type: "error", status: c.status, body: c.body }), undefined);
    try {
      const { result } = await collect(call(r, { messages: [USER("hi")] }, { maxRetries: 0 }));
      assert.equal(result.stopReason, "error");
      assert.equal(r.failures.length, 1);
      assert.equal(r.failures[0]?.failure.kind, c.kind);
      assert.equal(r.failures[0]?.providerId, "acp-codex");
      assert.match(result.errorMessage ?? "", new RegExp(`\\[a7-proxy:${c.kind}\\]`), "every proxy failure is marked so the Harness never retries on top of the wrapper (deviation 98)");
      assert.ok(!(result.errorMessage ?? "").includes(FAKE_KEY));
      assert.equal(r.brain.limiters.stats()["acp-codex"]?.active, 0);
      assert.equal(r.brain.status.needsLogin("acp-codex"), c.kind === "auth_required");
    } finally {
      await r.fake.close();
    }
  });
}

test("a refused connection is classified as down and marked", async () => {
  const r = await rig();
  await r.fake.close(); // nothing listens any more
  const { result } = await collect(call(r, { messages: [USER("hi")] }, { maxRetries: 0 }));
  assert.equal(result.stopReason, "error");
  assert.equal(r.failures[0]?.failure.kind, "down");
  assert.match(result.errorMessage ?? "", /\[a7-proxy:down\]/);
  assert.equal(r.brain.status.needsLogin("acp-codex"), true);
});

test("a wrong key sent to the fake proxy comes back as bad_key and the key text is not in the message", async () => {
  const fake = await startFakeOpenAi({ requireKey: "the-real-key-abcdef123456" });
  const wrong = "sk-wrong-key-zzzzzzzz";
  try {
    const preset = acpPreset({ baseUrl: fake.baseUrl });
    const failures: FailureEvent[] = [];
    const brain = createProxyBrain({ presets: [preset], secrets: { proxyApiKey: wrong }, onFailure: (e) => failures.push(e) });
    const spec = specFor("codex") as never;
    const models = brain.decorateModels(createBotModels(brain.extraProviders(spec)), spec);
    const ref = await (models as unknown as { getModel: AnyFn }).getModel("acp-codex", "codex/gpt-x");
    const { result } = await collect((models as unknown as { streamSimple: AnyFn }).streamSimple(ref, { messages: [USER("hi")] }, { maxRetries: 0 }) as never);
    assert.equal(failures[0]?.failure.kind, "bad_key");
    assert.ok(!JSON.stringify(result).includes(wrong));
    assert.ok(!JSON.stringify(failures).includes(wrong));
  } finally {
    await fake.close();
  }
});

// ---- the wrapper against a hand-driven Models: concurrency, priority, abort, pass-through ----

interface Pending {
  model: { provider: string; id: string };
  finish(): void;
}

function fakeModels(): { models: Models; started: Pending[]; other: string[]; maxRunning: () => number } {
  const started: Pending[] = [];
  const other: string[] = [];
  let running = 0;
  let max = 0;
  const msg = (model: { provider: string; id: string }): AssistantMessage =>
    ({ role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-completions", provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 }) as AssistantMessage;
  const models = {
    streamSimple: (model: { provider: string; id: string }) => {
      running++;
      max = Math.max(max, running);
      let done!: () => void;
      const finished = new Promise<void>((r) => (done = r));
      started.push({ model, finish: () => done() });
      return {
        async *[Symbol.asyncIterator]() {
          await finished;
          running--;
          yield { type: "done", reason: "stop", message: msg(model) };
        },
        result: async () => {
          await finished;
          return msg(model);
        },
      };
    },
    getAuth: () => {
      other.push("getAuth");
      return "auth";
    },
  } as unknown as Models;
  return { models, started, other, maxRunning: () => max };
}

const tick = (n = 3): Promise<void> => new Promise((r) => setTimeout(r, n));

test("10 concurrent bot calls through the wrapper: never more than 3 at the proxy, P0 before P2", async () => {
  const fm = fakeModels();
  const limiters = new ProxyLimiters({ agingMs: 0, maxQueue: 50 });
  const prio: Record<string, 0 | 2> = {};
  const wrapped = (id: string): Models =>
    limitProxyModels(fm.models, { id }, { limiters, priorityFor: () => prio[id] ?? 0 });
  const model = { provider: "acp-codex", id: "codex/gpt-x" };
  const streams: Promise<unknown>[] = [];
  const bots = Array.from({ length: 10 }, (_, i) => `bot${i}`);
  // bot3 and bot4 are background (P2), the rest are the user's own messages (P0)
  prio["bot3"] = 2;
  prio["bot4"] = 2;
  const order: string[] = [];
  for (const b of bots) {
    const s = (wrapped(b) as unknown as { streamSimple: AnyFn }).streamSimple(model, {}) as { [Symbol.asyncIterator](): AsyncIterator<unknown> };
    streams.push(
      (async () => {
        for await (const _ of s as AsyncIterable<unknown>) void _;
        order.push(b);
      })(),
    );
    await tick(1);
  }
  await tick();
  // three are running, the rest wait
  assert.equal(fm.started.length, 3);
  assert.equal(limiters.for("acp-codex").stats().queued, 7);
  const startedBots: string[] = [];
  // finish them one at a time and record which bot is let in next
  let seen = 3;
  while (fm.started.length < 10 || order.length < 10) {
    const open = fm.started.find((s) => !(s as Pending & { done?: boolean }).done);
    if (!open) break;
    (open as Pending & { done?: boolean }).done = true;
    open.finish();
    await tick();
    if (fm.started.length > seen) {
      startedBots.push(`#${fm.started.length}`);
      seen = fm.started.length;
    }
    if (order.length >= 10) break;
  }
  await Promise.all(streams);
  assert.equal(fm.maxRunning() <= 3, true, `max running ${fm.maxRunning()}`);
  assert.equal(fm.started.length, 10);
  // bots 0..2 started first; of the queued ones, the P2 bots (3, 4) are the last two to run
  const runOrder = order; // completion order follows start order here
  assert.deepEqual(new Set(runOrder.slice(-2)), new Set(["bot3", "bot4"]));
  assert.equal(limiters.for("acp-codex").stats().active, 0);
});

test("abort while queued ends with an aborted message, and the slot is not leaked", async () => {
  const fm = fakeModels();
  const limiters = new ProxyLimiters({ defaultLimit: 1 });
  const model = { provider: "acp-codex", id: "m" };
  const w = (id: string): Models => limitProxyModels(fm.models, { id }, { limiters });
  const first = (w("a") as unknown as { streamSimple: AnyFn }).streamSimple(model, {}) as never as Parameters<typeof collect>[0];
  const firstDone = collect(first);
  await tick();
  const ctl = new AbortController();
  const second = (w("b") as unknown as { streamSimple: AnyFn }).streamSimple(model, {}, { signal: ctl.signal }) as never as Parameters<typeof collect>[0];
  const secondDone = collect(second);
  await tick();
  assert.equal(limiters.for("acp-codex").stats().queued, 1);
  ctl.abort();
  const { result } = await secondDone;
  assert.equal(result.stopReason, "aborted");
  assert.equal(fm.started.length, 1, "the aborted call never reached the proxy");
  fm.started[0]?.finish();
  await firstDone;
  assert.equal(limiters.for("acp-codex").stats().active, 0);
});

test("a depth-capped P2 call becomes a limiter_busy error event and is reported (never a fallback input)", async () => {
  const fm = fakeModels();
  const limiters = new ProxyLimiters({ defaultLimit: 1, maxQueue: 0 });
  const failures: FailureEvent[] = [];
  const model = { provider: "acp-codex", id: "m" };
  const hold = (limitProxyModels(fm.models, { id: "a" }, { limiters }) as unknown as { streamSimple: AnyFn }).streamSimple(model, {}) as never as Parameters<typeof collect>[0];
  const holdDone = collect(hold);
  await tick();
  const bg = limitProxyModels(fm.models, { id: "b" }, { limiters, priorityFor: () => 2, onFailure: (e) => failures.push(e) });
  const { result } = await collect((bg as unknown as { streamSimple: AnyFn }).streamSimple(model, {}) as never);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /\[a7-proxy:limiter_busy\]/);
  assert.equal(failures[0]?.failure.kind, "limiter_busy");
  fm.started[0]?.finish();
  await holdDone;
});

test("other providers and other methods pass through the wrapper untouched", async () => {
  const fm = fakeModels();
  const limiters = new ProxyLimiters();
  const w = limitProxyModels(fm.models, { id: "a" }, { limiters });
  const s = (w as unknown as { streamSimple: AnyFn }).streamSimple({ provider: "lmstudio", id: "q" }, {}) as never as Parameters<typeof collect>[0];
  const done = collect(s);
  await tick();
  assert.equal(limiters.stats()["lmstudio"], undefined, "no limiter for a local provider");
  assert.equal(limiters.stats()["acp-codex"], undefined);
  fm.started[0]?.finish();
  await done;
  assert.equal((w as unknown as { getAuth: AnyFn }).getAuth("x"), "auth");
  assert.deepEqual(fm.other, ["getAuth"]);
});

// ---- deviation 98: the retry lives inside the call -----------------------------------------------------------

async function retryRig(replies: ("busy" | "queue_full" | "auth" | "ok")[], over: { retry?: boolean } = {}) {
  const fake = await startFakeOpenAi({
    requireKey: FAKE_KEY,
    behavior: ({ count }) => {
      const r = replies[Math.min(count - 1, replies.length - 1)];
      if (r === "busy") return { type: "error", status: 503, body: { error: { message: "busy", type: "t", code: "provider_busy" } } };
      if (r === "queue_full") return { type: "error", status: 429, body: { error: { message: "full", type: "t", code: "provider_queue_full" } } };
      if (r === "auth") return { type: "error", status: 503, body: { error: { message: "log in", type: "t", code: "provider_auth_required" } } };
      return { type: "text", text: "PONG" };
    },
  });
  const waits: number[] = [];
  const failures: FailureEvent[] = [];
  const brain = createProxyBrain({
    presets: [acpPreset({ baseUrl: fake.baseUrl })],
    secrets: { proxyApiKey: FAKE_KEY },
    onFailure: (e) => failures.push(e),
    sleep: async (ms) => {
      waits.push(ms);
      return true;
    },
    ...over,
  });
  const spec = specFor("codex") as never;
  const models = brain.decorateModels(createBotModels(brain.extraProviders(spec)), spec);
  const modelRef = await (models as unknown as { getModel: AnyFn }).getModel("acp-codex", "codex/gpt-x");
  return { fake, models, modelRef, brain, waits, failures };
}

test("busy twice, then success: the wrapper retries inside the call, waits the table delay, the Harness sees one clean answer", async () => {
  const r = await retryRig(["busy", "busy", "ok"]);
  try {
    const { types, result } = await collect(call(r, { messages: [USER("go")] }));
    assert.equal(result.stopReason, "stop");
    assert.equal(types.filter((t) => t === "error").length, 0);
    assert.equal(types.filter((t) => t === "start").length, 1, "a retried try does not repeat the start event");
    assert.equal(r.fake.chatRequests().length, 3);
    assert.deepEqual(r.waits, [30_000, 30_000]);
    assert.equal(r.failures.length, 2, "each failed try is reported once");
    assert.equal(r.brain.limiters.stats()["acp-codex"]?.active, 0);
  } finally {
    await r.fake.close();
  }
});

test("busy forever: three tries (one plus two), then a MARKED error the Harness will not retry", async () => {
  const r = await retryRig(["busy"]);
  try {
    const { result } = await collect(call(r, { messages: [USER("go")] }));
    assert.equal(r.fake.chatRequests().length, 3);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /^\[a7-proxy:busy\]/);
    assert.doesNotMatch(result.errorMessage ?? "", /503|timeout|rate/i, "no word the Harness retry matches");
    assert.equal(r.failures.length, 3);
  } finally {
    await r.fake.close();
  }
});

test("queue_full is tried once more (5 s); a login problem is never retried", async () => {
  const q = await retryRig(["queue_full"]);
  try {
    await collect(call(q, { messages: [USER("go")] }));
    assert.equal(q.fake.chatRequests().length, 2);
    assert.deepEqual(q.waits, [5000]);
  } finally {
    await q.fake.close();
  }
  const a = await retryRig(["auth"]);
  try {
    const { result } = await collect(call(a, { messages: [USER("go")] }));
    assert.equal(a.fake.chatRequests().length, 1);
    assert.deepEqual(a.waits, []);
    assert.match(result.errorMessage ?? "", /^\[a7-proxy:auth_required\]/);
  } finally {
    await a.fake.close();
  }
});

test("retry: false reports once and never retries; an abort while waiting ends the call as aborted", async () => {
  const off = await retryRig(["busy"], { retry: false });
  try {
    await collect(call(off, { messages: [USER("go")] }));
    assert.equal(off.fake.chatRequests().length, 1);
  } finally {
    await off.fake.close();
  }
  const fake = await startFakeOpenAi({ requireKey: FAKE_KEY, behavior: () => ({ type: "error", status: 503, body: { error: { code: "provider_busy", message: "b", type: "t" } } }) });
  try {
    const brain = createProxyBrain({ presets: [acpPreset({ baseUrl: fake.baseUrl })], secrets: { proxyApiKey: FAKE_KEY }, sleep: async () => false });
    const spec = specFor("codex") as never;
    const models = brain.decorateModels(createBotModels(brain.extraProviders(spec)), spec);
    const modelRef = await (models as unknown as { getModel: AnyFn }).getModel("acp-codex", "codex/gpt-x");
    const { result } = await collect(call({ models, modelRef }, { messages: [USER("go")] }));
    assert.equal(result.stopReason, "aborted");
    assert.equal(fake.chatRequests().length, 1);
  } finally {
    await fake.close();
  }
});
