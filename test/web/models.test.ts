/**
 * Model sources (plan agent-007-model-sources): the pure source library. AC1 classification, AC2 preset ids, AC3 parsers.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { PRESET_ID_PATTERN, parseBots, termsOf } from "../../src/bots/schema.js";
import { createWebAudit } from "../../src/web/audit.js";
import { SecretBox, sha256Hex } from "../../src/web/crypto.js";
import { createPresetCatalog } from "../../src/web/models/catalog.js";
import type { SecuritySnapshot } from "../../src/web/models/catalog.js";
import { webPaths } from "../../src/web/paths.js";
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

test("catalog reload and tamper", () => {
  const root = mkdtempSync("C:/projects/Personal/agent-007/.claude/temp/models-catalog-");
  const dataDir = `${root}/data`;
  const secFile = `${root}/security.json`;
  const paths = webPaths(dataDir);
  mkdirSync(paths.webDir, { recursive: true });
  const preset = (id: string, kind: "local" | "acp") =>
    kind === "local"
      ? { id, kind, label: id, runner: "strata", modelId: "m", contextWindow: 8192, maxTokens: 1024 }
      : { id, kind, label: id, baseUrl: "http://127.0.0.1:8787/v1", modelId: "claude/sonnet", providerId: "claude", apiKeyRef: "proxyApiKey", contextWindow: 200000, maxTokens: 8192 };
  const writeSec = (presets: unknown[], claude: boolean): void => writeFileSync(secFile, JSON.stringify({ presets, termsAccepted: { claude, antigravity: false } }));
  const config = { model: { runners: { lmstudio: { baseUrl: "http://127.0.0.1:1234/v1" }, strata: { baseUrl: "http://127.0.0.1:8080/v1", contextWindow: 8192, maxTokens: 1024 } } } } as unknown as SecuritySnapshot["config"];
  // the fake loader is parseBots over the file, like boot; unparsable JSON throws
  const loadSecurity = (): SecuritySnapshot => {
    const b = parseBots(JSON.parse(readFileSync(secFile, "utf8")), { folderAllow: [], derivedPresets: [], defaultPreset: "strata" });
    return { presets: b.presets, terms: termsOf(b), config };
  };
  writeSec([preset("strata", "local"), preset("claude-sonnet", "acp")], true);
  const box = new SecretBox(SecretBox.generateKey());
  const catalog = createPresetCatalog({ dataDir, box, audit: createWebAudit({ dir: paths.auditDir }), secrets: {}, loadSecurity, securityHash: () => sha256Hex(readFileSync(secFile)), intervalMs: 0 });
  try {
    const ids = (): string[] => catalog.presets().map((p) => p.id);
    assert.deepEqual(ids(), ["strata", "claude-sonnet"]);
    // the owner saves one proxy model, one LM Studio model and a custom cloud provider with a key
    catalog.update((d) => {
      d.doc.sources.push({ id: "myprov", label: "Mine", baseUrl: "https://api.example.com/v1", billing: "subscription", hasKey: false });
      d.keys.set("myprov", "sk-secret-123");
      d.doc.presets.push(
        { id: "codex-gpt-5", sourceId: "acp-proxy", modelId: "codex/gpt-5", label: "Codex", contextWindow: 200000, maxTokens: 8192, billing: "subscription" },
        { id: "lms-qwen", sourceId: "lmstudio", modelId: "qwen", label: "Qwen", contextWindow: 8192, maxTokens: 2048, billing: "subscription" },
        { id: "myprov-m", sourceId: "myprov", modelId: "m", label: "M", contextWindow: 32768, maxTokens: 4096, billing: "subscription" },
        { id: "strata", sourceId: "strata", modelId: "x", label: "dup", contextWindow: 8192, maxTokens: 1024, billing: "subscription" },
      );
    });
    assert.deepEqual(ids(), ["strata", "claude-sonnet", "codex-gpt-5", "lms-qwen", "myprov-m"]);
    assert.ok(catalog.banners().some((b) => b.includes('"strata"')), "a security id wins a collision, with a banner");
    const custom = catalog.endpoint("myprov-m");
    assert.deepEqual([custom?.apiKey, custom?.viaProxy, typeof custom?.preflight], ["sk-secret-123", false, "function"]);
    assert.ok(!readFileSync(paths.modelsFile, "utf8").includes("sk-secret") && !readFileSync(paths.modelKeysFile, "utf8").includes("sk-secret"));
    assert.equal(catalog.presets().find((p) => p.id === "codex-gpt-5")?.kind, "acp");

    // security.json changes: a new preset and the terms flag off are seen without a restart
    writeSec([preset("strata", "local"), preset("claude-sonnet", "acp"), preset("lms2", "local")], false);
    catalog.reloadSecurity();
    assert.ok(ids().includes("lms2"));
    assert.equal(catalog.terms().claude, false);
    // an invalid one keeps the last good snapshot and shows a banner
    writeFileSync(secFile, "{ not json");
    catalog.reloadSecurity();
    assert.ok(ids().includes("lms2") && catalog.terms().claude === false);
    assert.ok(catalog.banners().some((b) => b.includes("security.json is invalid")));
    writeSec([preset("strata", "local")], true);
    catalog.reloadSecurity();
    assert.deepEqual(ids().slice(0, 1), ["strata"]);
    assert.ok(!catalog.banners().some((b) => b.includes("security.json is invalid")));

    // an extra key (strict parse) rejects the whole file: web presets off
    const good = readFileSync(paths.modelsFile, "utf8");
    const bad = JSON.parse(good) as { presets: Record<string, unknown>[] };
    bad.presets[0]!["privacy"] = "local";
    writeFileSync(paths.modelsFile, JSON.stringify(bad));
    catalog.reloadSecurity();
    assert.deepEqual(ids(), ["strata"]);
    assert.ok(catalog.banners().some((b) => b.includes("models.json is invalid")));
    // a valid file with other bytes than the last save: hash mismatch, custom sources and web presets off
    writeFileSync(paths.modelsFile, JSON.stringify(JSON.parse(good)));
    catalog.reloadSecurity();
    assert.deepEqual(ids(), ["strata"]);
    assert.equal(catalog.sources().some((s) => s.id === "myprov"), false);
    assert.ok(catalog.banners().includes("models.json was changed outside the Models page"));
    // restoring the saved bytes is trusted again (the hash matches the last models_saved line)
    writeFileSync(paths.modelsFile, good);
    catalog.reloadSecurity();
    assert.ok(ids().includes("myprov-m"));
    // saving from the Models page after tampering starts from a clean slate and trusts the new file
    writeFileSync(paths.modelsFile, JSON.stringify(JSON.parse(good)));
    catalog.reloadSecurity();
    catalog.update((d) => void d.doc.presets.push({ id: "lms-qwen", sourceId: "lmstudio", modelId: "qwen", label: "Qwen", contextWindow: 8192, maxTokens: 2048, billing: "subscription" }));
    assert.deepEqual(ids(), ["strata", "lms-qwen"]);
    assert.equal(catalog.banners().length, 0);
  } finally {
    catalog.close();
    rmSync(root, { recursive: true, force: true });
  }
});
