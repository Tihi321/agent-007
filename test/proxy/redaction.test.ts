/**
 * S23.1 done-check: the proxy API key never appears in logs, errors, status output or the setup-check output.
 * The key here is a fake. Every run below is against a local fake server or an injected fetch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBotModels } from "../../src/pi/adapter.js";
import { createRedactor } from "../../src/logging/redact.js";
import { checkProxy, formatSetupReport } from "../../src/proxy/discover.js";
import { classifyProxyMessage, classifyProxyResponse, failureOf, markedMessage } from "../../src/proxy/errors.js";
import { fetchModelIds, proxyEndpoint, ProxyStatus } from "../../src/proxy/health.js";
import type { FetchLike } from "../../src/proxy/health.js";
import { createProxyBrain } from "../../src/proxy/provider.js";
import type { FailureEvent } from "../../src/proxy/provider.js";
import { runSetupCheck } from "../../src/proxy/setupCheck.js";
import { startFakeOpenAi } from "../helpers/fakeOpenAi.js";
import { FAKE_KEY, acpPreset, freePort, specFor, startFakeProxy } from "./helpers.js";

const SECRETS_JSON = JSON.stringify({ telegramBotToken: "123456:fake-telegram-token-for-tests", proxyApiKey: FAKE_KEY });

test("setupCheck output never holds the key (good proxy, wrong key, dead port, bad secrets file)", async () => {
  const px = await startFakeProxy();
  const dead = await freePort();
  try {
    const cases: { name: string; argv: string[]; readFile?: (p: string) => string; code: number }[] = [
      { name: "good", argv: ["--port", String(px.port), "--secrets", "s.json", "--model", "codex/gpt-x"], readFile: () => SECRETS_JSON, code: 0 },
      { name: "missing model", argv: ["--port", String(px.port), "--secrets", "s.json", "--model", "claude/nope"], readFile: () => SECRETS_JSON, code: 1 },
      { name: "wrong key", argv: ["--port", String(px.port), "--secrets", "s.json"], readFile: () => JSON.stringify({ telegramBotToken: "1:x", proxyApiKey: "sk-wrong-key-abcdefghijk" }), code: 1 },
      { name: "dead port", argv: ["--port", String(dead), "--secrets", "s.json"], readFile: () => SECRETS_JSON, code: 1 },
      { name: "bad secrets", argv: ["--port", String(px.port), "--secrets", "s.json"], readFile: () => `{"proxyApiKey":"${FAKE_KEY}", broken`, code: 2 },
      { name: "no key in secrets", argv: ["--port", String(px.port), "--secrets", "s.json"], readFile: () => JSON.stringify({ telegramBotToken: "1:x" }), code: 1 },
      { name: "bad url", argv: ["--url", `http://example.com/v1?key=${FAKE_KEY}`, "--secrets", "s.json"], readFile: () => SECRETS_JSON, code: 2 },
      { name: "bad args", argv: ["--bogus"], code: 2 },
    ];
    for (const c of cases) {
      const lines: string[] = [];
      const code = await runSetupCheck(c.argv, { out: (l) => lines.push(l), ...(c.readFile ? { readFile: c.readFile } : {}) });
      assert.equal(code, c.code, c.name);
      const text = lines.join("\n");
      assert.ok(!text.includes(FAKE_KEY), `${c.name}: key in output`);
      assert.ok(!text.includes("sk-wrong-key"), `${c.name}: key in output`);
      assert.ok(!text.includes("fake-telegram-token"), `${c.name}: other secret in output`);
    }
  } finally {
    await px.close();
  }
});

test("the setup-check report is redacted even if a line were to carry the key", () => {
  const redact = createRedactor([FAKE_KEY]);
  const leaky = { endpoint: proxyEndpoint({ port: 1 }), health: { ok: false as const, reason: "down" as const, failure: failureOf("down") }, models: { ok: false as const, reason: "down" as const, failure: failureOf("down") }, presets: [{ presetId: `p-${FAKE_KEY}`, providerId: "codex", modelId: FAKE_KEY, available: false }], unusedModelIds: [FAKE_KEY], ok: false };
  const text = formatSetupReport(leaky, redact).join("\n");
  assert.ok(!text.includes(FAKE_KEY));
});

test("the key is only in the Authorization header: not in the URL, not in any result, not in /v1/models errors", async () => {
  const seen: string[] = [];
  const f: FetchLike = async (url, init) => {
    seen.push(url);
    assert.equal(init?.headers?.["authorization"], `Bearer ${FAKE_KEY}`);
    return { ok: false, status: 500, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: `server echoes ${FAKE_KEY}` } }) };
  };
  const r = await fetchModelIds(proxyEndpoint({ port: 9 }), FAKE_KEY, { fetch: f });
  assert.ok(!r.ok);
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY), "a proxy body that echoes the key is not copied into the result");
  assert.ok(seen.every((u) => !u.includes(FAKE_KEY)));
  const report = await checkProxy({ port: 9, apiKey: FAKE_KEY, presets: [], fetch: async (url) => (url.endsWith("/healthz") ? { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status: "ok" }) } : f(url)) });
  assert.ok(!JSON.stringify(report).includes(FAKE_KEY));
  assert.ok(!formatSetupReport(report).join("\n").includes(FAKE_KEY));
});

test("classified failures, status and marked messages never carry a body that echoes the key", () => {
  const body = { error: { message: `bad key ${FAKE_KEY}`, code: "invalid_api_key" } };
  const f = classifyProxyResponse({ status: 401, body });
  const status = new ProxyStatus();
  status.noteFailure("acp-codex", f);
  assert.ok(!JSON.stringify(f).includes(FAKE_KEY));
  assert.ok(!JSON.stringify(status.snapshot()).includes(FAKE_KEY));
  assert.ok(!markedMessage(classifyProxyMessage(`401 ${JSON.stringify(body)}`)).includes(FAKE_KEY));
});

test("provider path: a failing call leaves the key out of the error text, the failure event and /status data", async () => {
  const fake = await startFakeOpenAi({ behavior: () => ({ type: "error", status: 503, body: { error: { message: `auth failed for ${FAKE_KEY}`, code: "provider_auth_required" } } }) });
  try {
    const events: FailureEvent[] = [];
    const logs: string[] = [];
    const brain = createProxyBrain({ presets: [acpPreset({ baseUrl: fake.baseUrl })], secrets: { proxyApiKey: FAKE_KEY }, onFailure: (e) => (events.push(e), logs.push(JSON.stringify(e))), redact: createRedactor([FAKE_KEY]) });
    const spec = specFor("codex") as never;
    const models = brain.decorateModels(createBotModels(brain.extraProviders(spec)), spec);
    const ref = await (models as unknown as { getModel: (p: string, i: string) => unknown }).getModel("acp-codex", "codex/gpt-x");
    const stream = (models as unknown as { streamSimple: (...a: unknown[]) => AsyncIterable<unknown> & { result(): Promise<unknown> } }).streamSimple(ref, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { maxRetries: 0 });
    const seenEvents: unknown[] = [];
    for await (const e of stream) seenEvents.push(e);
    const result = await stream.result();
    for (const blob of [JSON.stringify(result), JSON.stringify(seenEvents), logs.join("\n"), JSON.stringify(brain.status.snapshot()), JSON.stringify(brain.limiters.stats())]) {
      assert.ok(!blob.includes(FAKE_KEY));
    }
    assert.equal(events.length, 1);
  } finally {
    await fake.close();
  }
});
