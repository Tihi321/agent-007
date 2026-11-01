/**
 * Model sources (plan agent-007-model-sources): the pure source library. AC1 classification, AC2 preset ids, AC3 parsers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PRESET_ID_PATTERN } from "../../src/bots/schema.js";
import { classify, groupOf, parseLmStudioModels, parseOpenAiModels, parseProxyModels, presetIdFor } from "../../src/models/sources.js";
import type { ModelSource } from "../../src/models/sources.js";

const PROXY: ModelSource = { id: "acp-proxy", kind: "acp-proxy", label: "ACP proxy", baseUrl: "http://127.0.0.1:8787/v1", keyRef: "proxyApiKey", privacy: "cloud" };
const LMS: ModelSource = { id: "lmstudio", kind: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", privacy: "local" };
const custom = (baseUrl: string, extra: Partial<ModelSource> = {}): ModelSource => ({ id: "myprov", kind: "custom", label: "Mine", baseUrl, privacy: "local", ...extra });

test("classify: source decides, payload cannot", () => {
  // a hostile proxy payload: lies about privacy, owner and billing on a codex id; none of it survives the parser
  const parsed = parseProxyModels({
    data: [
      { id: "codex/gpt-5", owned_by: "anthropic", privacy: "local", billing: "subscription", kind: "local", name: "<script>x</script>" },
      { id: "mystery/model-1" },
    ],
  });
  assert.deepEqual(parsed.rows.map((r) => Object.keys(r).sort()), [["group", "modelId"], ["group", "modelId"]]);
  const codex = classify(PROXY, parsed.rows[0]!.modelId);
  assert.deepEqual([codex.kind, codex.providerId, codex.privacy, codex.apiKeyRef, codex.needsTerms, codex.paidAllowed, codex.blocked], ["acp", "codex", "cloud", "proxyApiKey", false, true, undefined]);
  assert.equal(classify(PROXY, "claude/default").needsTerms, true);
  assert.equal(classify(PROXY, "antigravity/x").providerId, "antigravity");
  assert.equal(classify(PROXY, "gpt-5").providerId, "codex"); // a bare id is Codex
  assert.equal(classify(PROXY, parsed.rows[1]!.modelId).blocked, "unknown proxy provider");
  assert.equal(groupOf(PROXY, "mystery/model-1"), "custom");
  // built-ins: local, no key reference, not paid-capable
  const lm = classify(LMS, "qwen/qwen3-8b");
  assert.deepEqual([lm.kind, lm.runner, lm.privacy, lm.apiKeyRef, lm.paidAllowed], ["local", "lmstudio", "local", undefined, false]);
  // custom: only a literal loopback host is local, treatAsCloud only raises, a lying `privacy` field is ignored
  assert.equal(classify(custom("http://127.0.0.1:9000/v1"), "m").privacy, "local");
  assert.equal(classify(custom("http://localhost:9000/v1"), "m").privacy, "local");
  assert.equal(classify(custom("http://127.0.0.1:9000/v1", { treatAsCloud: true }), "m").privacy, "cloud");
  assert.equal(classify(custom("https://openrouter.ai/api/v1", { privacy: "local" }), "m").privacy, "cloud");
  assert.equal(classify(custom("http://127.0.0.1.evil.com/v1"), "m").privacy, "cloud");
  assert.equal(classify(custom("http://192.168.1.5:1234/v1"), "m").privacy, "cloud");
  const keyed = classify(custom("https://openrouter.ai/api/v1", { keyRef: "webkey:myprov" }), "m");
  assert.deepEqual([keyed.kind, keyed.apiKeyRef, keyed.paidAllowed, keyed.providerId], ["custom", "webkey:myprov", true, undefined]);
});

test("presetIdFor: valid, deterministic, collision-safe, existing ids reused", () => {
  const existing = [
    { id: "claude-sonnet", sourceId: "acp-proxy", modelId: "claude/claude-sonnet-4-5" },
    { id: "strata", sourceId: "strata", modelId: "strata-model" },
    { id: "codex-gpt-5", sourceId: "acp-proxy", modelId: "gpt-5" },
  ];
  const taken = new Set(existing.map((e) => e.id));
  // reuse (and Codex bare == codex/)
  assert.equal(presetIdFor("acp-proxy", "claude", "claude/claude-sonnet-4-5", taken, existing), "claude-sonnet");
  assert.equal(presetIdFor("strata", "strata", "strata-model", taken, existing), "strata");
  assert.equal(presetIdFor("acp-proxy", "codex", "codex/gpt-5", taken, existing), "codex-gpt-5");
  // simple, and the plan's own examples
  assert.equal(presetIdFor("acp-proxy", "claude", "claude/default", taken), "claude-default");
  assert.equal(presetIdFor("lmstudio", "lmstudio", "Qwen3 8B", taken), "lms-qwen3-8b");
  assert.equal(presetIdFor("myprov", "custom", "gpt-4o", taken), "myprov-gpt-4o");
  // too long: 24 chars, valid, stable, and different models do not collide
  const long = presetIdFor("acp-proxy", "claude", "claude/claude-haiku-4-5-20251001", taken);
  assert.ok(long.length <= 24 && PRESET_ID_PATTERN.test(long), long);
  assert.equal(presetIdFor("acp-proxy", "claude", "claude/claude-haiku-4-5-20251001", taken), long);
  const other = presetIdFor("acp-proxy", "claude", "claude/claude-haiku-4-5-20251002", taken);
  assert.notEqual(other, long);
  // taken: a second, then a third id for the same model, none already taken
  const t2 = new Set([...taken, "lms-qwen3-8b"]);
  const a = presetIdFor("lmstudio", "lmstudio", "Qwen3 8B", t2);
  const b = presetIdFor("lmstudio", "lmstudio", "Qwen3 8B", new Set([...t2, a]));
  for (const id of [a, b]) assert.ok(PRESET_ID_PATTERN.test(id) && id.length <= 24, id);
  assert.equal(new Set(["lms-qwen3-8b", a, b]).size, 3);
});

test("parsers: shapes, limits, embeddings hidden, codex normalised", () => {
  // proxy: bare and codex/ are one row stored as codex/; bad ids and non-strings are dropped and counted; embeddings hidden
  const p = parseProxyModels({ data: [{ id: "gpt-5" }, { id: "codex/gpt-5" }, { id: "claude/default" }, { id: "bad id with spaces" }, { id: 7 }, { id: "x".repeat(129) }, { id: "codex/text-embedding-3" }, null] });
  assert.deepEqual(p.rows.map((r) => [r.modelId, r.group]), [["codex/gpt-5", "codex"], ["claude/default", "claude"]]);
  assert.equal(p.ignored, 4);
  assert.deepEqual(parseProxyModels({ nope: 1 }).rows, []);
  // 500-row cap, the rest counted
  const many = parseOpenAiModels({ data: Array.from({ length: 503 }, (_, i) => ({ id: `m${i}` })) }, "strata");
  assert.equal(many.rows.length, 500);
  assert.equal(many.ignored, 3);
  assert.match(many.note ?? "", /500/);
  assert.equal(many.rows[0]!.group, "strata");
  // LM Studio v1: loaded from loaded_instances, context from the loaded config, embeddings hidden, max_context_length not a hint
  const v1 = parseLmStudioModels({
    v1: {
      models: [
        { key: "qwen/qwen3-8b", type: "llm", loaded_instances: [{ id: "a", config: { context_length: 16384 } }], max_context_length: 40960 },
        { key: "google/gemma-3-4b", type: "llm", loaded_instances: [], max_context_length: 131072 },
        { key: "nomic-embed", type: "embedding", loaded_instances: [] },
        { key: "tiny", type: "llm", loaded_instances: [{ id: "b", config: { context_length: 100 } }] },
      ],
    },
    v0: { data: [{ id: "ignored-because-v1-wins" }] },
  });
  assert.deepEqual(v1.rows, [
    { modelId: "qwen/qwen3-8b", group: "lmstudio", loaded: true, contextHint: 16384 },
    { modelId: "google/gemma-3-4b", group: "lmstudio", loaded: false },
    { modelId: "tiny", group: "lmstudio", loaded: true },
  ]);
  // v0 when v1 is unusable
  const v0 = parseLmStudioModels({ v1: { error: "x" }, v0: { data: [{ id: "a", type: "llm", state: "loaded", loaded_context_length: 8192 }, { id: "b", type: "vlm", state: "not-loaded", loaded_context_length: 4096 }, { id: "e", type: "embeddings", state: "not-loaded" }] } });
  assert.deepEqual(v0.rows, [{ modelId: "a", group: "lmstudio", loaded: true, contextHint: 8192 }, { modelId: "b", group: "lmstudio", loaded: false }]);
  // OpenAI fallback: ids only, loaded unknown, a note says so
  const oa = parseLmStudioModels({ openai: { data: [{ id: "m1" }, { id: "text-embedding-nomic" }] } });
  assert.deepEqual(oa.rows, [{ modelId: "m1", group: "lmstudio" }]);
  assert.ok(oa.note);
});
