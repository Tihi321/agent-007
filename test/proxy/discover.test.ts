import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProxy, formatSetupReport, matchPresets, unusedIds } from "../../src/proxy/discover.js";
import { DEFAULT_PROXY_PORT, EndpointError, fetchHealth, fetchModelIds, parseHealth, parseModelIds, proxyEndpoint, ProxyStatus } from "../../src/proxy/health.js";
import { failureOf } from "../../src/proxy/errors.js";
import { FAKE_KEY, HEALTH_BODY, freePort, startFakeProxy, violations } from "./helpers.js";

const PRESETS = [
  { id: "codex", kind: "acp" as const, modelId: "codex/gpt-x", providerId: "codex" as const },
  { id: "claude", kind: "acp" as const, modelId: "claude/sonnet", providerId: "claude" as const },
  { id: "local", kind: "local" as const, modelId: "qwen", providerId: undefined },
];

test("parseHealth: the proxy's /healthz shape", () => {
  const h = parseHealth(HEALTH_BODY);
  assert.ok(h);
  assert.equal(h.status, "ok");
  assert.equal(h.uptimeSeconds, 123);
  assert.deepEqual(h.providers, [
    { id: "codex", active: 1, queued: 0, maxConcurrent: 4, maxQueue: 20 },
    { id: "claude", active: 0, queued: 2, maxConcurrent: 4 },
  ]);
  // providers is optional
  assert.deepEqual(parseHealth({ status: "ok", uptime_seconds: 5 })?.providers, []);
  // an array form with ids is accepted
  assert.equal(parseHealth({ status: "ok", providers: [{ id: "codex", active: 2 }] })?.providers[0]?.active, 2);
  // not the proxy
  assert.equal(parseHealth({ ok: true }), undefined);
  assert.equal(parseHealth(null), undefined);
  assert.equal(parseHealth([]), undefined);
  assert.equal(parseHealth("ok"), undefined);
  // junk numbers are dropped, not trusted
  assert.deepEqual(parseHealth({ status: "ok", providers: { a: { active: "many" } } })?.providers, [{ id: "a" }]);
});

test("parseModelIds", () => {
  assert.deepEqual(parseModelIds({ data: [{ id: "a" }, { id: "" }, {}, { id: 3 }, { id: "b" }] }), ["a", "b"]);
  assert.equal(parseModelIds({}), undefined);
  assert.equal(parseModelIds(null), undefined);
});

test("proxyEndpoint: loopback http only", () => {
  assert.equal(proxyEndpoint({ port: 8787 }).baseUrl, "http://127.0.0.1:8787/v1");
  assert.equal(proxyEndpoint({ baseUrl: "http://localhost:9000/v1" }).origin, "http://127.0.0.1:9000");
  assert.equal(DEFAULT_PROXY_PORT, 8787);
  for (const bad of ["https://127.0.0.1:8787/v1", "http://10.0.0.5:8787/v1", "http://example.com/v1", "http://u:p@127.0.0.1:8787/v1", "http://127.0.0.1:8787/other", "nonsense"]) {
    assert.throws(() => proxyEndpoint({ baseUrl: bad }), EndpointError, bad);
  }
  assert.throws(() => proxyEndpoint({}), EndpointError);
  assert.throws(() => proxyEndpoint({ port: 0 }), EndpointError);
  assert.throws(() => proxyEndpoint({ port: 70000 }), EndpointError);
});

test("matchPresets: a missing model id marks that preset unavailable; local presets are ignored", () => {
  const m = matchPresets(PRESETS, ["codex/gpt-x", "claude/other"]);
  assert.deepEqual(m.map((x) => [x.presetId, x.available]), [["codex", true], ["claude", false]]);
  assert.match(m[1]?.reason ?? "", /does not list/);
  // Codex is listed both bare and prefixed
  assert.equal(matchPresets([{ id: "c", kind: "acp", modelId: "gpt-x", providerId: "codex" }], ["codex/gpt-x"])[0]?.available, true);
  assert.deepEqual(unusedIds(PRESETS, ["codex/gpt-x", "claude/sonnet", "claude/extra"]), ["claude/extra"]);
});

test("setup check against a good fake proxy: healthz parsed, key accepted, presets available", async () => {
  const px = await startFakeProxy();
  try {
    const r = await checkProxy({ port: px.port, apiKey: FAKE_KEY, presets: PRESETS });
    assert.equal(r.ok, true);
    assert.equal(r.health.ok && r.health.health.providers.length, 2);
    assert.equal(r.models.ok && r.models.ids.length, 2);
    const lines = formatSetupReport(r);
    assert.ok(lines.includes("setup check: OK"));
    assert.ok(lines.some((l) => l.startsWith("healthz codex:") && l.includes("proxy cap 4")));
    // only the two GETs were made, and /healthz carried no key
    assert.deepEqual(px.requests.map((q) => `${q.method} ${q.url}`), ["GET /healthz", "GET /v1/models"]);
    assert.equal(px.requests[0]?.authorization, undefined);
    assert.equal(px.requests[1]?.authorization, `Bearer ${FAKE_KEY}`);
    assert.deepEqual(violations(px.requests.map((q) => ({ method: q.method, url: q.url }))), []);
  } finally {
    await px.close();
  }
});

test("a wrong port: nothing listens -> healthz FAILED, the key is never sent, models skipped", async () => {
  const port = await freePort();
  const r = await checkProxy({ port, apiKey: FAKE_KEY, presets: PRESETS, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.health.ok, false);
  assert.equal(!r.health.ok && r.health.reason, "down");
  assert.equal(r.models.ok, false);
  const text = formatSetupReport(r).join("\n");
  assert.match(text, /healthz: FAILED, nothing answers/);
  assert.match(text, /models: SKIPPED/);
  assert.match(text, /setup check: NOT OK/);
  assert.ok(!text.includes(FAKE_KEY));
});

test("a wrong port: something else answers -> not_proxy, the key is not sent to it", async () => {
  const px = await startFakeProxy({ health: false });
  try {
    const r = await checkProxy({ port: px.port, apiKey: FAKE_KEY, presets: PRESETS });
    assert.equal(r.ok, false);
    assert.equal(r.health.ok, false);
    assert.ok(px.requests.every((q) => q.url === "/healthz"), "no request after /healthz");
    const px2 = await startFakeProxy({ health: { hello: "world" } });
    try {
      const r2 = await checkProxy({ port: px2.port, apiKey: FAKE_KEY, presets: PRESETS });
      assert.equal(!r2.health.ok && r2.health.reason, "not_proxy");
      assert.match(formatSetupReport(r2).join("\n"), /not the proxy/);
      assert.equal(px2.requests.length, 1);
    } finally {
      await px2.close();
    }
  } finally {
    await px.close();
  }
});

test("a wrong key: 401 -> bad_key, reported without the key", async () => {
  const px = await startFakeProxy();
  try {
    const wrong = "sk-WRONG-key-9999999999";
    const r = await checkProxy({ port: px.port, apiKey: wrong, presets: PRESETS });
    assert.equal(r.ok, false);
    assert.equal(r.health.ok, true);
    assert.equal(!r.models.ok && r.models.reason, "unauthorized");
    assert.equal(!r.models.ok && r.models.failure.kind, "bad_key");
    const text = formatSetupReport(r, (s) => s).join("\n");
    assert.match(text, /rejected the key \(HTTP 401\)/);
    assert.ok(!text.includes(wrong));
    // an absent key is skipped without a request
    const before = px.requests.length;
    const none = await fetchModelIds(proxyEndpoint({ port: px.port }), undefined);
    assert.equal(!none.ok && none.reason, "no_key");
    assert.equal(px.requests.length, before);
  } finally {
    await px.close();
  }
});

test("a missing model id: the preset is marked unavailable and the check is NOT OK", async () => {
  const px = await startFakeProxy({ modelIds: ["codex/gpt-x"] });
  try {
    const r = await checkProxy({ port: px.port, apiKey: FAKE_KEY, presets: PRESETS });
    assert.equal(r.ok, false);
    assert.equal(r.presets.find((p) => p.presetId === "claude")?.available, false);
    assert.equal(r.presets.find((p) => p.presetId === "codex")?.available, true);
    const text = formatSetupReport(r).join("\n");
    assert.match(text, /preset claude \(claude\/claude\/sonnet\): UNAVAILABLE/);
  } finally {
    await px.close();
  }
});

test("models endpoint errors are classified (503 busy with Retry-After, 429)", async () => {
  const px = await startFakeProxy({ modelsReply: { status: 503, body: { error: { code: "provider_busy" } }, headers: { "retry-after": "12" } } });
  try {
    const r = await fetchModelIds(proxyEndpoint({ port: px.port }), FAKE_KEY);
    assert.ok(!r.ok);
    assert.equal(r.failure.kind, "busy");
    assert.equal(r.failure.retry.delaySec, 12);
  } finally {
    await px.close();
  }
  const px2 = await startFakeProxy({ modelsReply: { status: 429, body: {} } });
  try {
    const r = await fetchModelIds(proxyEndpoint({ port: px2.port }), FAKE_KEY);
    assert.ok(!r.ok);
    assert.equal(r.failure.kind, "queue_full");
  } finally {
    await px2.close();
  }
});

test("a slow endpoint times out", async () => {
  const f = (_u: string, init?: { signal?: AbortSignal }): Promise<never> =>
    new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const r = await fetchHealth(proxyEndpoint({ port: 1234 }), { fetch: f as never, timeoutMs: 20 });
  assert.equal(!r.ok && r.reason, "timeout");
});

test("ProxyStatus: needs-login flags come from classified failures, and clear on success", () => {
  let now = 1000;
  const s = new ProxyStatus(() => now);
  s.noteFailure("acp-codex", failureOf("auth_required"));
  s.noteFailure("acp-claude", failureOf("bad_key"));
  s.noteFailure("acp-claude", failureOf("aborted"));
  s.noteFailure("acp-x", failureOf("limiter_busy"));
  assert.equal(s.needsLogin("acp-codex"), true);
  const snap = s.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap.find((p) => p.providerId === "acp-claude")?.needsKeyFix, true);
  now = 2000;
  s.noteSuccess("acp-codex");
  assert.equal(s.needsLogin("acp-codex"), false);
});
