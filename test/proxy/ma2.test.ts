import assert from "node:assert/strict";
import { test } from "node:test";
import { createBotModels } from "../../src/pi/adapter.js";
import type { Models } from "../../src/pi/adapter.js";
import { checkProxy, formatSetupReport, matchPresets } from "../../src/proxy/discover.js";
import { ProxyStatus, authRefusal, parseHealth } from "../../src/proxy/health.js";
import { toFallbackFailure, classifyProxyMessage, markedMessage, failureOf } from "../../src/proxy/errors.js";
import { createProxyBrain } from "../../src/proxy/provider.js";
import { presetProblem } from "../../src/models/presets.js";
import { CLAUDE_PRESET_TEMPLATES, claudeFormTemplates } from "../../src/models/templates.js";
import { shippedForms } from "../../src/jobrunner/settingsUi/forms/registry.js";
import { startFakeOpenAi } from "../helpers/fakeOpenAi.js";
import { FAKE_KEY, acpPreset, specFor, startFakeProxy } from "./helpers.js";

const health = (claude: Record<string, unknown>) => ({ status: "ok", uptime_seconds: 1, providers: { claude: { active: 0, queued: 0, max_concurrent: 2, ...claude } } });

test("parseHealth reads auth_method and ignores unknown values", () => {
  assert.equal(parseHealth(health({ auth_method: "subscription" }))?.providers[0]?.authMethod, "subscription");
  assert.equal(parseHealth(health({ auth_method: "api_key" }))?.providers[0]?.authMethod, "api_key");
  assert.equal(parseHealth(health({ auth_method: "weird" }))?.providers[0]?.authMethod, undefined);
  assert.equal(parseHealth(health({}))?.providers[0]?.authMethod, undefined);
});

test("matchPresets finds claude/sonnet and the Opus id; api_key marks the Claude presets needs attention", () => {
  const p = CLAUDE_PRESET_TEMPLATES;
  const ok = matchPresets(p, ["claude/sonnet", "claude/opus"], { claude: "subscription" });
  assert.deepEqual(ok.map((x) => x.available), [true, true]);
  const bad = matchPresets(p, ["claude/sonnet", "claude/opus"], { claude: "api_key" });
  assert.deepEqual(bad.map((x) => [x.available, x.needsAttention]), [[false, true], [false, true]]);
  assert.equal(matchPresets(p, ["claude/sonnet"], {})[1]?.available, false);
  assert.equal(authRefusal("codex", "api_key"), undefined);
});

test("setup check against a fake proxy: subscription ok, api_key refused, missing auth_method is a warning only", async () => {
  const presets = CLAUDE_PRESET_TEMPLATES;
  const run = async (h: unknown) => {
    const px = await startFakeProxy({ health: h, modelIds: ["claude/sonnet", "claude/opus"] });
    try {
      const r = await checkProxy({ port: px.port, apiKey: FAKE_KEY, presets });
      return { r, lines: formatSetupReport(r) };
    } finally {
      await px.close();
    }
  };
  const sub = await run(health({ auth_method: "subscription" }));
  assert.equal(sub.r.ok, true);
  assert.ok(sub.lines.includes("healthz claude auth_method: subscription"));
  const key = await run(health({ auth_method: "api_key" }));
  assert.equal(key.r.ok, false);
  assert.ok(key.lines.some((l) => l.includes("NEEDS ATTENTION")));
  const old = await run(health({}));
  assert.equal(old.r.ok, true, "an older proxy is a warning, not a block");
  assert.equal(old.r.warnings.length, 1);
  assert.ok(old.lines.some((l) => l.startsWith("warning:")));
});

test("a refused provider makes no call to the proxy and falls back like a missing login", async () => {
  const fake = await startFakeOpenAi({ requireKey: FAKE_KEY });
  try {
    const preset = acpPreset({ id: "claude-sonnet", providerId: "claude", modelId: "claude/sonnet", baseUrl: fake.baseUrl });
    const status = new ProxyStatus();
    const failures: string[] = [];
    const brain = createProxyBrain({ presets: [preset], secrets: { proxyApiKey: FAKE_KEY }, retry: false, status, onFailure: (e) => failures.push(e.failure.kind) });
    const spec = specFor("claude-sonnet") as never;
    const models = brain.decorateModels(createBotModels(brain.extraProviders(spec)), spec);
    const ref = await (models as unknown as { getModel(a: string, b: string): Promise<unknown> }).getModel("acp-claude", "claude/sonnet");
    assert.ok(ref);
    status.noteAuthMethod("claude", "api_key");
    assert.equal(status.refused("claude"), true);
    assert.equal(status.snapshot()[0]?.refused, true);
    const s = (models as unknown as { streamSimple: (...a: unknown[]) => AsyncIterable<unknown> & { result(): Promise<{ stopReason: string; errorMessage?: string }> } }).streamSimple(ref, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
    for await (const _ of s) void _;
    const res = await s.result();
    assert.equal(res.stopReason, "error");
    assert.equal(classifyProxyMessage(res.errorMessage).kind, "refused");
    assert.deepEqual(failures, ["refused"]);
    assert.equal(fake.chatRequests().length, 0, "no request reached the proxy");
    assert.deepEqual(toFallbackFailure(failureOf("refused")), { kind: "auth_required" });
    assert.match(markedMessage(failureOf("refused")), /needs attention/);
    // a later healthz with the subscription clears it
    status.noteAuthMethod("claude", "subscription");
    assert.equal(status.refused("claude"), false);
  } finally {
    await fake.close();
  }
});

test("templates: both Claude presets pass the loader rules only with the terms flag, keep proxyApiKey, and show in the models form", () => {
  for (const t of CLAUDE_PRESET_TEMPLATES) {
    assert.equal(t.apiKeyRef, "proxyApiKey");
    assert.equal(t.autoFallback, false);
    assert.equal(t.privacy, "cloud");
    assert.match(String(presetProblem(t, { claude: false, antigravity: false })), /acknowledgment/);
    assert.equal(presetProblem(t, { claude: true, antigravity: false }), undefined);
    assert.notEqual(presetProblem({ ...t, apiKeyRef: "someOtherKey" }, { claude: true, antigravity: false }), undefined);
  }
  assert.deepEqual(CLAUDE_PRESET_TEMPLATES.map((p) => p.id), ["claude-sonnet", "claude-opus"]);
  const f = shippedForms().get("models");
  assert.equal(f?.templates?.length, 2);
  assert.deepEqual(f?.templates, claudeFormTemplates());
  for (const t of f?.templates ?? []) assert.equal(JSON.parse(t.json).providerId, "claude");
});
