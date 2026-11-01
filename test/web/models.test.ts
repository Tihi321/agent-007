/**
 * Model sources (plan agent-007-model-sources): the pure source library. AC1 classification, AC2 preset ids, AC3 parsers.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { PRESET_ID_PATTERN, parseBots, termsOf } from "../../src/bots/schema.js";
import type { PresetConfig } from "../../src/bots/schema.js";
import { createWebAudit } from "../../src/web/audit.js";
import type { WebAudit } from "../../src/web/audit.js";
import { createOpenAiEngine } from "../../src/web/chat/openaiEngine.js";
import { USER_TOOL_UNIVERSE } from "../../src/web/capabilities.js";
import type { Resolver } from "../../src/web/runtime/ssrf.js";
import { totpAt, totpStep } from "../../src/web/totp.js";
import { startFakeOpenAi } from "../helpers/fakeOpenAi.js";
import { BOT, ScriptedEngine, makeApp } from "./app.js";
import type { TestApp, Who } from "./app.js";
import { SecretBox, sha256Hex } from "../../src/web/crypto.js";
import { createPresetCatalog } from "../../src/web/models/catalog.js";
import type { PresetCatalog } from "../../src/web/models/catalog.js";
import type { FetchFn } from "../../src/web/models/fetch.js";
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

// ---- route tests (MS4): the Models page routes, caps and chat, against fake servers on 127.0.0.1 and a fake DNS resolver ----------------

interface Fake {
  url: string;
  close(): Promise<void>;
}
async function fakeServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Fake> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}
const sendJson = (res: ServerResponse, body: unknown): void => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));

const PROXY_KEY = "pk-proxy-test";

/** The catalogue of a test app: two settings presets (strata, claude-sonnet at the fake proxy), the fake runners, a fake resolver. */
function modelsEnv(urls: { proxy: string; lmstudio: string; strata: string }, extra: { fetch?: FetchFn } = {}) {
  const dns = new Map<string, string[]>([["api.example.test", ["93.184.216.34"]], ["evil.example.test", ["10.0.0.7"]]]);
  const resolver: Resolver = async (h) => dns.get(h) ?? [];
  const holder: { catalog?: PresetCatalog } = {};
  const settings: PresetConfig[] = [
    { id: "strata", kind: "local", runner: "strata", label: "Strata", modelId: "strata", contextWindow: 8192, maxTokens: 1024, privacy: "local", autoFallback: true },
    { id: "claude-sonnet", kind: "acp", baseUrl: `${urls.proxy}/v1`, providerId: "claude", apiKeyRef: "proxyApiKey", label: "Claude Sonnet", modelId: "claude/sonnet", contextWindow: 200000, maxTokens: 8192, privacy: "cloud", autoFallback: false },
  ];
  const config = { model: { runners: { lmstudio: { baseUrl: `${urls.lmstudio}/v1` }, strata: { baseUrl: urls.strata, contextWindow: 8192, maxTokens: 1024 } } } } as unknown as SecuritySnapshot["config"];
  const models = (dir: string, audit: WebAudit) => {
    const catalog = createPresetCatalog({ dataDir: dir, box: new SecretBox(SecretBox.generateKey()), audit, secrets: { proxyApiKey: PROXY_KEY }, loadSecurity: () => ({ presets: settings, terms: { claude: true, antigravity: false }, config }), securityHash: () => "fixed", resolver, intervalMs: 0 });
    holder.catalog = catalog;
    return { catalog, deps: { resolver, lastFetch: new Map<string, number>(), ...(extra.fetch ? { fetch: extra.fetch } : {}) } };
  };
  return { models, dns, holder };
}

async function stepUpOwner(t: TestApp): Promise<void> {
  const id = t.owner.userId;
  const sec = t.app.stack.box.open(t.app.stack.credentials.read().users[id]!.password!.totpSealed, id);
  t.clock.t += 31_000;
  t.app.stack.auth.stepUp(t.app.stack.sessions.resolve(t.owner.cookie.split("=")[1] as string, { ip: "x", ua: "t" })!, { totpCode: totpAt(sec, totpStep(t.clock.t)) }, { identity: { kind: "local" }, host: `localhost:${t.port}`, ip: "local", ua: "t" });
}

const CAPS = (presets: string[]) => ({ presets, tools: [...USER_TOOL_UNIVERSE], maxBots: 3, maxChatsPerDay: 200, maxTokensPerDay: 200_000, maxJobsPerDay: 0, storageMB: 200 });
const idsOf = (r: { json(): any }): string[] => r.json().presets.map((p: { id: string }) => p.id);

async function chat(t: TestApp, who: Who, bot: string) {
  const r = await t.post(who, "/api/chat/send", { bot, text: "hello" });
  if (r.status === 200) await t.app.chat.settle(who.userId, r.json().threadId);
  return r;
}

test("owner fetch, tick, use; users need caps", async () => {
  const px = await fakeServer((req, res) => {
    if (req.url === "/v1/models" && req.headers.authorization === `Bearer ${PROXY_KEY}`) return sendJson(res, { data: [{ id: "codex/gpt-5" }, { id: "claude/sonnet" }, { id: "claude/claude-haiku-4-5-20251001" }, { id: "mystery/x" }] });
    res.writeHead(404).end();
  });
  const lm = await fakeServer((req, res) => {
    if (req.url === "/api/v1/models") return sendJson(res, { models: [{ key: "qwen/qwen3-8b", type: "llm", loaded_instances: [{ id: "a", config: { context_length: 16384 } }] }, { key: "google/gemma-3-4b", type: "llm", loaded_instances: [] }] });
    res.writeHead(404).end();
  });
  const env = modelsEnv({ proxy: px.url, lmstudio: lm.url, strata: "http://127.0.0.1:9/v1" });
  const engine = new ScriptedEngine();
  const t = await makeApp({ engine, models: env.models });
  try {
    const adm = await t.addUser("adm@example.com", {}, "admin");
    const bob = await t.addUser("bob@example.com", { presets: ["strata"] });
    assert.equal((await t.post(adm, "/api/admin/models/list")).status, 403, "an admin is not the owner");
    assert.equal((await t.post(bob, "/api/admin/models/fetch", { sourceId: "lmstudio" })).status, 403);
    assert.deepEqual(idsOf(await t.post(t.owner, "/api/admin/models/list")), ["strata", "claude-sonnet"]);

    // a write without a fresh step-up is refused
    t.clock.t += 6 * 60_000;
    const stale = await t.post(t.owner, "/api/admin/models/fetch", { sourceId: "acp-proxy" });
    assert.deepEqual([stale.status, stale.json().error], [401, "step_up_required"]);
    await stepUpOwner(t);

    // fetch from the fake proxy and the fake LM Studio
    const f1 = await t.post(t.owner, "/api/admin/models/fetch", { sourceId: "acp-proxy" });
    assert.equal(f1.status, 200, f1.text);
    const rows = Object.fromEntries(f1.json().rows.map((r: { modelId: string }) => [r.modelId, r]));
    assert.equal(rows["claude/sonnet"].presetId, "claude-sonnet", "an existing preset is shown as added");
    assert.deepEqual([rows["codex/gpt-5"].classified.kind, rows["codex/gpt-5"].proposedId], ["acp", "codex-gpt-5"]);
    assert.deepEqual([rows["claude/claude-haiku-4-5-20251001"].classified.needsTerms, rows["claude/claude-haiku-4-5-20251001"].termsOk], [true, true]);
    assert.equal(rows["mystery/x"].blocked, "unknown proxy provider");
    const f2 = await t.post(t.owner, "/api/admin/models/fetch", { sourceId: "lmstudio" });
    assert.equal(f2.status, 200, f2.text);
    assert.deepEqual(f2.json().rows.map((r: { modelId: string; loaded: boolean; contextHint?: number }) => [r.modelId, r.loaded, r.contextHint]), [["qwen/qwen3-8b", true, 16384], ["google/gemma-3-4b", false, undefined]]);

    // tick one from each; the server ignores a client's own kind/privacy/provider and refuses the unknown proxy provider
    const a1 = await t.post(t.owner, "/api/admin/models/presets/add", { sourceId: "acp-proxy", models: [{ modelId: "codex/gpt-5", kind: "local", privacy: "local", providerId: "claude" }, { modelId: "mystery/x" }] });
    assert.deepEqual(a1.json().added, [{ presetId: "codex-gpt-5", modelId: "codex/gpt-5" }]);
    assert.deepEqual(a1.json().skipped, [{ modelId: "mystery/x", reason: "unknown proxy provider" }]);
    const a2 = await t.post(t.owner, "/api/admin/models/presets/add", { sourceId: "lmstudio", models: [{ modelId: "qwen/qwen3-8b" }] });
    assert.equal(a2.json().added[0].presetId, "lms-qwen-qwen3-8b");
    const list = (await t.post(t.owner, "/api/admin/models/list")).json();
    const view = (id: string) => list.presets.find((p: { id: string }) => p.id === id);
    assert.deepEqual([view("codex-gpt-5").kind, view("codex-gpt-5").privacy, view("codex-gpt-5").origin, view("lms-qwen-qwen3-8b").contextWindow], ["acp", "cloud", "web", 16384]);
    assert.equal(JSON.parse(view("codex-gpt-5").copyJson).providerId, "codex");
    assert.equal(view("claude-sonnet").copyJson, undefined, "settings presets are not copied");

    // the owner uses them at once, no restart; a user does not see them
    const opts = await t.post(t.owner, "/api/bots/options");
    assert.ok(["codex-gpt-5", "lms-qwen-qwen3-8b"].every((id) => opts.json().presets.some((p: { id: string }) => p.id === id)));
    const made = await t.post(t.owner, "/api/bots/create", { ...BOT, preset: "lms-qwen-qwen3-8b", tools: ["tool_search"] });
    assert.equal(made.status, 200, made.text);
    assert.equal((await chat(t, t.owner, made.json().bot.id)).status, 200);
    assert.equal(engine.calls.at(-1)!.bot.route.primary, "lms-qwen-qwen3-8b");
    assert.deepEqual((await t.post(bob, "/api/bots/options")).json().presets.map((p: { id: string }) => p.id), ["strata"]);

    // ... until the owner grants them in the user's caps (this rotates the user's session)
    assert.equal((await t.post(t.owner, "/api/admin/users/caps", { id: bob.userId, caps: CAPS(["strata", "codex-gpt-5"]) })).status, 200);
    t.clock.t += 31_000;
    const li = await t.post({ cookie: "", csrf: "", login: bob.login, userId: bob.userId }, "/api/login/password", { login: bob.login, password: bob.password, totpCode: totpAt(bob.secret, totpStep(t.clock.t)) });
    assert.equal(li.status, 200, li.text);
    const bob2: Who = { ...bob, cookie: String(li.headers["set-cookie"]).split(";")[0] as string, csrf: li.json().csrf };
    assert.deepEqual((await t.post(bob2, "/api/bots/options")).json().presets.map((p: { id: string }) => p.id), ["strata", "codex-gpt-5"]);
  } finally {
    await t.close();
    await px.close();
    await lm.close();
  }
});

test("custom provider: SSRF, key secrecy, billing", async () => {
  const KEY = "sk-SECRET-key-AbCd1234";
  const strata = await startFakeOpenAi({ behavior: () => ({ type: "text", text: "local answer" }), modelId: "m" });
  const logs: string[] = [];
  const calls: { url: string; auth: string | undefined }[] = [];
  const env = modelsEnv({ proxy: "http://127.0.0.1:9", lmstudio: "http://127.0.0.1:9", strata: strata.baseUrl }, {
    fetch: async (url, init) => {
      calls.push({ url, auth: init.headers["authorization"] });
      return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 });
    },
  });
  const t = await makeApp({ models: env.models, realEngine: createOpenAiEngine({ endpoint: (id) => env.holder.catalog!.endpoint(id), log: (l) => logs.push(l) }) });
  const seen: string[] = [];
  const call = async (path: string, body: unknown = {}) => {
    const r = await t.post(t.owner, `/api/admin/models/${path}`, body);
    seen.push(r.text);
    return r;
  };
  const source = async () => (await call("list")).json().sources.find((s: { id: string }) => s.id === "exampleai");
  try {
    await stepUpOwner(t);
    const good = { label: "Example AI", baseUrl: "https://api.example.test/v1", apiKey: KEY, billing: "subscription" };
    // refused at save: plain http off this PC, a host that resolves to a private address, credentials, a query, no billing for a cloud URL
    for (const bad of [{ baseUrl: "http://api.example.test/v1" }, { baseUrl: "https://evil.example.test/v1" }, { baseUrl: "https://u:p@api.example.test/v1" }, { baseUrl: "https://api.example.test/v1?x=1" }, { billing: undefined }]) {
      const r = await call("sources/add", { ...good, ...bad });
      assert.equal(r.status, 400, JSON.stringify(bad) + r.text);
    }
    assert.equal((await call("list")).json().sources.length, 3, "nothing was saved");
    const added = await call("sources/add", good);
    assert.deepEqual([added.status, added.json().sourceId], [200, "exampleai"]);
    const s1 = await source();
    assert.deepEqual([s1.privacy, s1.hasKey, s1.baseUrl, "apiKey" in s1], ["cloud", true, "https://api.example.test/v1", false]);
    // the base URL is immutable
    assert.equal((await call("sources/update", { sourceId: "exampleai", baseUrl: "https://evil.example.test/v1" })).status, 400);
    assert.equal((await source()).baseUrl, "https://api.example.test/v1");
    // the server uses the key for the fetch and never returns it
    const fetched = await call("fetch", { sourceId: "exampleai" });
    assert.equal(fetched.status, 200, fetched.text);
    assert.deepEqual(calls.map((c) => [c.url, c.auth]), [["https://api.example.test/v1/models", `Bearer ${KEY}`]]);
    const add = await call("presets/add", { sourceId: "exampleai", models: [{ modelId: "m1" }, { modelId: "m2", billing: "paid" }] });
    assert.deepEqual(add.json().added.map((a: { presetId: string }) => a.presetId), ["exampleai-m1", "exampleai-m2"]);
    assert.equal(env.holder.catalog!.endpoint("exampleai-m1")?.apiKey, KEY, "the sealed key is usable server-side");
    // a local model cannot be paid
    assert.equal((await call("presets/add", { sourceId: "lmstudio", models: [{ modelId: "q", billing: "paid" }] })).json().skipped.length, 1);

    // billing: the paid custom preset is dropped (paid_off) without an owner grant; the bot answers from its local fallback
    const paidBot = (await t.post(t.owner, "/api/bots/create", { ...BOT, name: "Paid", preset: "exampleai-m2", fallback: "strata", tools: ["tool_search"] })).json().bot.id;
    const plainBot = (await t.post(t.owner, "/api/bots/create", { ...BOT, name: "Plain", preset: "exampleai-m1", fallback: "strata", tools: ["tool_search"] })).json().bot.id;
    const reply = async (bot: string) => {
      const sent = await chat(t, t.owner, bot);
      assert.equal(sent.status, 200, sent.text);
      const th = (await t.post(t.owner, "/api/chat/thread/get", { bot, thread: sent.json().threadId })).json().thread;
      seen.push(JSON.stringify(th));
      return th.messages[1];
    };
    assert.equal((await reply(paidBot)).text, "local answer");
    assert.ok(t.audit.events.some((e) => e.kind === "route_changed" && e.detail?.["preset"] === "exampleai-m2" && e.detail?.["why"] === "paid_off"));
    // at chat time the address is checked again: the host now resolves to a private address, so the chat falls back without any request to it
    env.dns.set("api.example.test", ["10.0.0.5"]);
    const down = await reply(plainBot);
    assert.equal(down.text, "local answer");
    assert.ok(down.notice, "the user is told the main model was not reachable");
    assert.equal(strata.chatRequests().length, 2);

    // the key is nowhere: no API answer, no store file, no audit line, no log, no stored chat
    const files = ["web/models.json", "web/model-keys.json"].map((f) => readFileSync(`${t.dir}/${f}`, "utf8"));
    const auditDir = `${t.dir}/web-audit`;
    const auditFiles = readdirSync(auditDir).map((f) => readFileSync(`${auditDir}/${f}`, "utf8"));
    for (const [what, blob] of [["api", seen.join("\n")], ["files", files.join("\n")], ["audit", auditFiles.join("\n") + JSON.stringify(t.audit.events)], ["log", logs.join("\n")]] as const) {
      assert.ok(!blob.includes(KEY), `the key leaked into the ${what}`);
    }
    assert.ok(files[1]!.includes("v1."), "the key file holds a sealed value");
  } finally {
    await t.close();
    await strata.close();
  }
});

test("remove in use", async () => {
  const env = modelsEnv({ proxy: "http://127.0.0.1:9", lmstudio: "http://127.0.0.1:9", strata: "http://127.0.0.1:9/v1" });
  const engine = new ScriptedEngine();
  const t = await makeApp({ engine, models: env.models });
  try {
    await stepUpOwner(t);
    const call = (path: string, body: unknown = {}) => t.post(t.owner, `/api/admin/models/${path}`, body);
    assert.equal((await call("presets/add", { sourceId: "acp-proxy", models: [{ modelId: "codex/gpt-5", billing: "paid" }] })).json().added[0].presetId, "codex-gpt-5");
    const alice = await t.addUser("alice@example.com", { presets: ["strata", "codex-gpt-5"] });
    const paidBot = (await t.post(alice, "/api/bots/create", { ...BOT, name: "Paid", preset: "codex-gpt-5", fallback: "strata", tools: ["tool_search"] })).json().bot.id;
    const solo = (await t.post(alice, "/api/bots/create", { ...BOT, name: "Solo", preset: "codex-gpt-5", tools: ["tool_search"] })).json().bot.id;
    const grant = await t.post(t.owner, "/api/admin/paid/set", { userId: alice.userId, botId: paidBot, preset: "codex-gpt-5", enabled: true, perDay: 100, perMonth: 1000 });
    assert.equal(grant.status, 200, grant.text);
    assert.equal((await chat(t, alice, paidBot)).status, 200);
    assert.equal(engine.calls.at(-1)!.bot.route.primary, "codex-gpt-5");

    // settings presets are read-only; a preset in use is refused with the bots using it
    assert.equal((await call("presets/remove", { presetId: "strata" })).status, 400);
    const refused = await call("presets/remove", { presetId: "codex-gpt-5" });
    assert.deepEqual([refused.status, refused.json().error], [409, "in_use"]);
    assert.deepEqual(refused.json().bots.map((b: { user: string; bot: string }) => `${b.user}/${b.bot}`).sort(), ["alice@example.com/Paid", "alice@example.com/Solo"]);
    assert.ok(idsOf(await call("list")).includes("codex-gpt-5"), "still there");
    assert.ok(t.app.chat.paid.grant(alice.userId, paidBot, "codex-gpt-5"));

    // force removes it and its paid grants; the next turn falls back or is refused
    assert.equal((await call("presets/remove", { presetId: "codex-gpt-5", force: true })).status, 200);
    assert.ok(!idsOf(await call("list")).includes("codex-gpt-5"));
    assert.equal(t.app.chat.paid.grant(alice.userId, paidBot, "codex-gpt-5"), undefined, "its paid grants went with it");
    assert.ok(!(await t.post(t.owner, "/api/bots/options")).json().presets.some((p: { id: string }) => p.id === "codex-gpt-5"));
    assert.equal((await chat(t, alice, paidBot)).status, 200);
    assert.equal(engine.calls.at(-1)!.bot.route.primary, "strata", "falls back to the local link");
    assert.ok(t.audit.events.some((e) => e.kind === "route_changed" && e.detail?.["preset"] === "codex-gpt-5" && e.detail?.["why"] === "missing"));
    const gone = await chat(t, alice, solo);
    assert.equal(gone.status, 403);
    assert.match(gone.json().message, /no longer set up/);
  } finally {
    await t.close();
  }
});
