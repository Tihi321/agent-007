/**
 * S20.1 done-check: a test per refusal of the bot loader, the implicit one-bot install, the settings rows, prefs and secrets.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { botRows, classifySwitch } from "../../src/bots/rows.js";
import { BOT_BUS_TOOLS, CODE_TOOL_NAMES, MAIN_BOT_ID, MAIN_DEFAULT_TOOLS, PEER_FORBIDDEN_TOOLS, effectiveReadRoots, effectiveTools, parseBots } from "../../src/bots/schema.js";
import { botTokenFor, parseSecrets, secretValues } from "../../src/config/secrets.js";
import { parseConfig } from "../../src/config/schema.js";
import { DEFAULT_ROWS, findRow, parseSettingPath, withRows } from "../../src/settings/allowlist.js";
import { schemaPaths, validate } from "../../src/settings/jsonschema.js";
import { PREFS_SCHEMA, SECURITY_SCHEMA } from "../../src/settings/schema.js";
import { mergeConfig, splitConfig } from "../../src/settings/split.js";
import { ENV, ROOT } from "../settings/helpers.js";
import { ACP_ANTI, ACP_CLAUDE, ACP_CODEX, DENIED, NOTES, READ_ONLY_TOOLS, SAFE, baseSecurity, bot, check, mutate, research, withBots } from "./helpers.js";

const ctxOf = (doc: Record<string, any>) => ({
  folderAllow: [{ alias: "notes", path: NOTES }],
  derivedPresets: [],
  defaultPreset: doc["model"].defaultPreset as string,
});

function refused(doc: unknown, re: RegExp): void {
  const r = check(doc);
  assert.equal(r.ok, false, `expected a refusal matching ${re}`);
  assert.ok(r.issues.some((i) => re.test(i)), `no issue matches ${re}: ${r.issues.join(" | ")}`);
}

const TWO = (): Record<string, any> => withBots({ main: bot(), research: research() });

test("a valid two-bot document passes; main comes first and every bot has its own folders", () => {
  const doc = TWO();
  const r = check(doc);
  assert.equal(r.ok, true, r.issues.join(" | "));
  const parsed = parseBots(doc, ctxOf(doc));
  assert.equal(parsed.implicit, false);
  assert.deepEqual(parsed.bots.map((b) => b.id), ["main", "research"]);
  assert.ok(parsed.bots.every((b) => b.layout === "bots" && !b.cloudCapable));
});

test("a document with no `bots` is valid and gives the implicit main with the Phase 1 to 3 behaviour (no ask_bot, no list_bots)", () => {
  const doc = baseSecurity();
  assert.equal(check(doc).ok, true);
  const parsed = parseBots(doc, ctxOf(doc));
  assert.equal(parsed.implicit, true);
  assert.equal(parsed.bots.length, 1);
  const main = parsed.bots[0]!;
  assert.equal(main.id, MAIN_BOT_ID);
  assert.equal(main.layout, "legacy");
  assert.equal(main.telegramTokenRef, "main");
  assert.deepEqual(main.edges, []);
  assert.ok(!effectiveTools(main).some((t) => (BOT_BUS_TOOLS as readonly string[]).includes(t)), "no bus tool without an edge");
  assert.deepEqual(effectiveReadRoots(main), [{ alias: "notes", path: NOTES }]);
  // legacy mode has no security document at all
  const legacy = parseBots(undefined, { folderAllow: [{ alias: "notes", path: NOTES }], derivedPresets: [], defaultPreset: "lmstudio" });
  assert.equal(legacy.implicit, true);
  assert.equal(legacy.bots[0]?.route.primary, "lmstudio");
});

test("the bus tools are registered only for a bot with an edge, and listing them without an edge warns", () => {
  const doc = withBots({ main: bot({ tools: [...bot().tools, "ask_bot", "list_bots"] }), research: research() });
  const r = check(doc);
  assert.equal(r.ok, true, r.issues.join(" | "));
  assert.ok(r.warnings.some((w) => /ask_bot and list_bots are not registered for a bot with no edge/.test(w)));
  const withEdge = mutate(doc, (d) => (d.bots.main.edges = [{ to: "research", allow: ["read_file"], egress: false }]));
  assert.equal(check(withEdge).ok, true);
  const p = parseBots(withEdge, ctxOf(withEdge)).bots;
  assert.ok(effectiveTools(p[0]!).includes("ask_bot") && effectiveTools(p[0]!).includes("list_bots"));
  assert.ok(!effectiveTools(p[1]!).includes("ask_bot"));
});

test("refuses a bad bot id and a missing main", () => {
  refused(withBots({ main: bot(), "Bad_Id": research() }), /bots\.Bad_Id: a bot id is 2 to 24/);
  refused(withBots({ main: bot(), x: research() }), /bots\.x: a bot id is 2 to 24/);
  refused(withBots({ research: research() }), /the bot "main" is required/);
  refused(withBots({}), /the bot "main" is required/);
});

test("refuses a duplicate token reference", () => {
  refused(withBots({ main: bot(), research: research({ telegramTokenRef: "main" }) }), /bots\.research\.telegramTokenRef: the token "main" is already used by bot "main"/);
});

test("refuses two bots with the shell tool", () => {
  refused(withBots({ main: bot(), research: research({ tools: ["tool_search", "shell"] }) }), /at most one bot may have the shell tool/);
});

test("refuses shell or dispatch_job on a cloud-capable bot unless the UI-25 flag is set", () => {
  const cloud = (over: Record<string, unknown>) =>
    withBots({ main: bot(), research: research({ route: { primary: "lmstudio", allowed: ["lmstudio", "codex"], fallback: [], onAuthRequired: "fallback" }, ...over }) }, { presets: [...baseSecurity().presets, ACP_CODEX] });
  assert.equal(check(cloud({})).ok, true, "a cloud-capable bot with read-only tools is fine");
  refused(cloud({ tools: ["tool_search", "dispatch_job"] }), /"dispatch_job" on a bot with a cloud preset/);
  const doc = withBots({ main: bot({ route: { primary: "lmstudio", allowed: ["lmstudio", "codex"], fallback: [], onAuthRequired: "fallback" } }) }, { presets: [...baseSecurity().presets, ACP_CODEX] });
  refused(doc, /"shell" on a bot with a cloud preset/);
  assert.equal(check(mutate(doc, (d) => (d.bots.main.relax = { privateRoots: false, privilegedTools: true }))).ok, true, "relaxed in the UI");
  // while the preset is merely in `allowed` (the active one is local) the bot already counts as cloud-capable
  const parsed = parseBots(doc, ctxOf(doc));
  assert.equal(parsed.bots[0]?.cloudCapable, true);
});

test("a cloud-capable bot reads only its cloud-safe roots unless relaxed (I42)", () => {
  const doc = withBots(
    { main: bot(), research: research({ route: { primary: "lmstudio", allowed: ["lmstudio", "codex"], fallback: [], onAuthRequired: "fallback" }, cloudSafeRoots: [{ alias: "safe", path: SAFE }] }) },
    { presets: [...baseSecurity().presets, ACP_CODEX] },
  );
  assert.equal(check(doc).ok, true);
  const b = parseBots(doc, ctxOf(doc)).bots[1]!;
  assert.deepEqual(effectiveReadRoots(b), [{ alias: "safe", path: SAFE }]);
  assert.deepEqual(effectiveReadRoots({ ...b, relax: { privateRoots: true, privilegedTools: false } }), [{ alias: "notes", path: NOTES }]);
});

test("refuses a claude or antigravity preset in a route without termsAccepted; the flag is accepted from the document", () => {
  const route = (id: string) => ({ primary: "lmstudio", allowed: ["lmstudio", id], fallback: [], onAuthRequired: "fallback" });
  const doc = (preset: Record<string, unknown>, id: string, extra: Record<string, unknown> = {}) => withBots({ main: bot(), research: research({ route: route(id) }) }, { presets: [...baseSecurity().presets, preset], ...extra });
  refused(doc(ACP_CLAUDE, "claude"), /termsAccepted\.claude/);
  refused(doc(ACP_ANTI, "anti"), /termsAccepted\.antigravity/);
  assert.equal(check(doc(ACP_CLAUDE, "claude", { termsAccepted: { claude: true } })).ok, true);
  assert.equal(check(doc(ACP_ANTI, "anti", { termsAccepted: { antigravity: true } })).ok, true);
  assert.equal(check(doc(ACP_CLAUDE, "claude", { termsAccepted: { antigravity: true } })).ok, false, "the other vendor's flag does not count");
  // Codex needs none; a defined but unused claude preset is not refused
  assert.equal(check(doc(ACP_CODEX, "codex")).ok, true);
  assert.equal(check(withBots({ main: bot() }, { presets: [...baseSecurity().presets, ACP_CLAUDE] })).ok, true);
});

test("a per-token-billed (API key) preset is not a kind, and no key reference other than the proxy key is accepted", () => {
  const withPreset = (p: Record<string, unknown>) => withBots({ main: bot() }, { presets: [...baseSecurity().presets, p] });
  refused(withPreset({ ...ACP_CODEX, kind: "api-key" }), /presets\[\d\]\.kind: must be one of: local, acp/);
  refused(withPreset({ ...ACP_CODEX, kind: "openai" }), /presets\[\d\]\.kind/);
  refused(withPreset({ ...ACP_CODEX, kind: "custom" }), /presets\[\d\]\.kind/); // AC8: custom providers live only in the web store
  refused(withPreset({ ...ACP_CODEX, apiKeyRef: "openaiKey" }), /presets\[\d\]\.apiKeyRef/);
  assert.equal(check(withPreset(ACP_CODEX)).ok, true);
});

test("refuses a non-loopback preset URL and the privacy/provider mismatches of a preset", () => {
  const withPreset = (p: Record<string, unknown>) => withBots({ main: bot() }, { presets: [...baseSecurity().presets, p] });
  refused(withPreset({ ...ACP_CODEX, baseUrl: "http://10.0.0.5:8787/v1" }), /presets\[\d\]\.baseUrl: must be an http URL on 127\.0\.0\.1 or localhost/);
  refused(withPreset({ ...ACP_CODEX, baseUrl: "https://api.openai.com/v1" }), /baseUrl/);
  const { baseUrl: _u, ...noUrl } = ACP_CODEX;
  const { providerId: _p, ...noProvider } = ACP_CODEX;
  void _u;
  void _p;
  refused(withPreset(noUrl), /an acp preset needs the proxy URL/);
  refused(withPreset(noProvider), /an acp preset needs providerId/);
  refused(withPreset({ ...ACP_CODEX, privacy: "local" }), /privacy: an acp preset sends data to a vendor/);
  refused(withPreset({ id: "lm2", kind: "local", modelId: "m", contextWindow: 8192, maxTokens: 512, label: "LM 2" }), /a local preset needs a runner/);
  refused(withPreset({ id: "lm2", kind: "local", runner: "lmstudio", baseUrl: "http://example.com/v1", modelId: "m", contextWindow: 8192, maxTokens: 512, label: "LM 2" }), /baseUrl/);
});

test("refuses readRoots and cloudSafeRoots outside the global allowlist or overlapping folders.deny", () => {
  refused(withBots({ main: bot({ readRoots: [{ alias: "other", path: "C:\\Elsewhere" }] }) }), /readRoots\[0\]\.path: .* is not inside a folder of the global allowlist/);
  refused(withBots({ main: bot({ cloudSafeRoots: [{ alias: "other", path: "D:\\Elsewhere" }] }) }), /cloudSafeRoots\[0\]\.path: .* is not inside a folder of the global allowlist/);
  const denied = (roots: unknown, key: "readRoots" | "cloudSafeRoots") => mutate(withBots({ main: bot({ readRoots: [{ alias: "ok", path: SAFE }], [key]: roots }) }), (d) => (d.folders.deny = [DENIED]));
  refused(denied([{ alias: "p", path: DENIED }], "readRoots"), /overlaps the denied path/);
  refused(denied([{ alias: "p", path: `${DENIED}\\sub` }], "cloudSafeRoots"), /overlaps the denied path/);
  // the whole allowed folder contains a denied folder: also an overlap (the bot must pick a narrower root)
  refused(denied([{ alias: "notes", path: NOTES }], "readRoots"), /overlaps the denied path/);
  assert.equal(check(denied([{ alias: "safe", path: SAFE }], "cloudSafeRoots")).ok, true);
  refused(withBots({ main: bot({ readRoots: [{ alias: "workspace", path: NOTES }] }) }), /reserved/);
  refused(withBots({ main: bot({ readRoots: [{ alias: "a", path: NOTES }, { alias: "A", path: SAFE }] }) }), /duplicate alias/);
});

test("refuses a tools list that is not a subset of the code's tools (an allowlist only narrows)", () => {
  refused(withBots({ main: bot({ tools: ["read_file", "format_disk"] }) }), /bots\.main\.tools\[1\]: "format_disk" is not a tool/);
  refused(withBots({ main: bot({ tools: ["mcp__nosuch__x"] }) }), /bots\.main\.tools\[0\]/);
  refused(withBots({ main: bot({ tools: ["read_file", "read_file"] }) }), /duplicate names/);
  assert.equal(check(withBots({ main: bot({ tools: ["read_file", "mcp__vibetts__speak", "ask_bot", "tts_line"] }) })).ok, true);
});

test("refuses a fallback entry whose preset has autoFallback false (S22 change request)", () => {
  const doc = withBots({ main: bot({ tools: READ_ONLY_TOOLS, route: { primary: "lmstudio", allowed: ["lmstudio"], fallback: ["codex"], onAuthRequired: "fallback" } }) });
  doc["presets"] = [...(doc["presets"] ?? []), { ...ACP_CODEX, autoFallback: false }];
  refused(doc, /route\.fallback: preset "codex" has autoFallback false/);
  doc["presets"] = doc["presets"].map((p: any) => (p.id === "codex" ? { ...p, autoFallback: true } : p));
  assert.equal(check(doc).ok, true, check(doc).issues.join(" | "));
});

test("refuses an edge to a missing bot, to itself, a duplicate, an elevated key and a tool a peer turn never gets", () => {
  const edge = (e: unknown) => withBots({ main: bot({ edges: [e] }), research: research() });
  assert.equal(check(edge({ to: "research", allow: ["read_file"], egress: false })).ok, true);
  refused(edge({ to: "ghost", allow: [] }), /edges\[0\]\.to: there is no bot "ghost"/);
  refused(edge({ to: "main", allow: [] }), /to itself/);
  refused(withBots({ main: bot({ edges: [{ to: "research" }, { to: "research" }] }), research: research() }), /duplicate edge/);
  refused(edge({ to: "research", allow: [], elevated: true }), /elevated edge is not an option in v1/);
  refused(edge({ to: "research", allow: [], elevated: false }), /elevated/);
  for (const t of PEER_FORBIDDEN_TOOLS.filter((x) => CODE_TOOL_NAMES.includes(x))) refused(edge({ to: "research", allow: [t] }), /a peer turn never gets/);
  refused(edge({ to: "research", allow: ["mcp__flow-music-mcp__make_music"] }), /a peer turn never gets/);
  refused(edge({ to: "research", allow: ["nonsense"] }), /not a tool of this build/);
});

test("refuses more bots with Strata as their primary preset than gate.localBotsOnStrata", () => {
  const strata = (id: string, ref: string) => (id === "main" ? bot({ route: { primary: "strata", allowed: ["strata"], fallback: [] } }) : research({ telegramTokenRef: ref, route: { primary: "strata", allowed: ["strata"], fallback: [] } }));
  const three = withBots({ main: strata("main", "main"), a1: strata("a1", "a1"), a2: strata("a2", "a2") });
  refused(three, /3 bots have Strata as their primary preset but gate\.localBotsOnStrata is 2/);
  assert.equal(check(mutate(three, (d) => (d.gate = { localBotsOnStrata: 3 }))).ok, true);
});

test("refuses a route that names an unknown preset or leaves out its own primary", () => {
  refused(withBots({ main: bot({ route: { primary: "ghost", allowed: ["ghost"] } }) }), /"ghost" is not one of the presets/);
  refused(withBots({ main: bot({ route: { primary: "lmstudio", allowed: ["strata"] } }) }), /allowed: must include the primary preset/);
  refused(withBots({ main: bot({ route: { primary: "lmstudio", allowed: ["lmstudio"], fallback: ["ghost"] } }) }), /"ghost"/);
});

test("the schema is strict: unknown bot keys and bad token references are refused", () => {
  refused(withBots({ main: bot({ surprise: 1 }) }), /bots\.main\.surprise: is not a known setting/);
  refused(withBots({ main: bot({ telegramTokenRef: "Has Space" }) }), /telegramTokenRef/);
  refused(mutate(baseSecurity(), (d) => (d.termsAccepted = { gemini: true })), /termsAccepted\.gemini/);
  refused(mutate(baseSecurity(), (d) => (d.gate = { proxyMaxConcurrent: 5 })), /gate\.proxyMaxConcurrent: must be at most 4/);
});

test("the Phase 4 keys are dropped by mergeConfig and the Phase 1/2 Config is unchanged by them", () => {
  const doc = TWO();
  const merged = mergeConfig({ paths: { programDataDir: "C:\\ProgramData\\agent-007", dataDir: "C:\\Users\\agent007\\AppData\\Local\\agent-007" }, mainUserProfile: "C:\\Users\\main" }, doc);
  for (const k of ["bots", "termsAccepted", "botBus", "botRoom", "gate", "presets"]) assert.equal(k in merged, false, k);
  const a = parseConfig(merged, ENV);
  const b = parseConfig(mergeConfig({ paths: { programDataDir: "C:\\ProgramData\\agent-007", dataDir: "C:\\Users\\agent007\\AppData\\Local\\agent-007" }, mainUserProfile: "C:\\Users\\main" }, baseSecurity()), ENV);
  assert.deepEqual(a, b);
  // a legacy config.json that carries a Phase 4 key is refused as unclassified (they live only in security.json)
  assert.throws(() => splitConfig({ ...(mergeConfig({}, baseSecurity()) as object), bots: {} } as Record<string, unknown>, "C:\\s"), /bots/);
});

test("botRows: one row per bot for activePreset and the I38 classification; no other bots.* or presets path is writable", () => {
  const doc = withBots(
    { main: bot({ route: { primary: "lmstudio", allowed: ["lmstudio", "strata", "codex", "claude"], fallback: [] }, tools: [...READ_ONLY_TOOLS] }), research: research({ telegramTokenRef: "research", route: { primary: "lmstudio", allowed: ["lmstudio"], fallback: [] } }) },
    { presets: [...baseSecurity().presets, ACP_CODEX, { ...ACP_CLAUDE, id: "claude" }], termsAccepted: { claude: true } },
  );
  assert.equal(check(doc).ok, true, check(doc).issues.join(" | "));
  const parsed = parseBots(doc, ctxOf(doc));
  const rows = botRows(parsed);
  assert.deepEqual(rows.map((r) => r.path), ["bots.main.activePreset", "bots.research.activePreset"]);
  const all = withRows(DEFAULT_ROWS, rows);
  const rowFor = (path: string) => findRow(all, parseSettingPath(path));
  const mainRow = rowFor("bots.main.activePreset")!;
  const cls = (from: string | undefined, to: string) => mainRow.classify!(from, to, { autoApplyCosmetic: false });
  assert.equal(cls("lmstudio", "strata"), "auto", "local -> local");
  assert.equal(cls("codex", "lmstudio"), "auto", "cloud -> local");
  assert.equal(cls("lmstudio", "codex"), "card", "local -> cloud");
  assert.equal(cls(undefined, "codex"), "card", "no stored value: the bot is on its primary (local)");
  assert.equal(cls("codex", "claude"), "card", "cloud -> cloud at another vendor");
  assert.equal(cls("codex", "codex"), "auto");
  assert.equal(rowFor("bots.research.activePreset")!.classify!("lmstudio", "strata", { autoApplyCosmetic: false }), "reject", "outside the bot's allowed list");
  assert.equal(mainRow.classify!("lmstudio", "nonexistent", { autoApplyCosmetic: false }), "reject");
  assert.equal(mainRow.classify!("lmstudio", 7, { autoApplyCosmetic: false }), "reject");
  assert.equal(classifySwitch(parsed.presets.find((p) => p.id === "claude")!, parsed.presets.find((p) => p.id === "claude")!), "auto");
  assert.equal(rowFor("bots.ghost.activePreset"), undefined, "a bot that does not exist has no row");
  // every other path of the security schema (bots.*, presets, route, edges, termsAccepted, ...) is rejected
  const paths = schemaPaths(SECURITY_SCHEMA).filter((p) => p !== "bots.*.activePreset");
  for (const p of paths) {
    const concrete = p.replace(/\*/g, "main").replace(/\[\]/g, "");
    let writable = false;
    try {
      writable = findRow(all, parseSettingPath(concrete)) !== undefined;
    } catch {
      writable = false;
    }
    assert.equal(writable, false, `${p} must not be writable`);
  }
  for (const p of ["bots.main.route.primary", "bots.main.route.allowed", "bots.main.edges", "bots.main.tools", "bots.main.telegramTokenRef", "presets", "termsAccepted.claude", "bots.main.route.fallback", "bots.main.relax.privilegedTools"]) {
    assert.equal(rowFor(p), undefined, p);
  }
  assert.equal(all.some((r) => (r.class as string) === "security"), false);
});

test("prefs accepts bots.<id>.activePreset and nothing else under bots", () => {
  assert.deepEqual(validate(PREFS_SCHEMA, { bots: { research: { activePreset: "strata" } } }), []);
  assert.ok(validate(PREFS_SCHEMA, { bots: { research: { route: "x" } } }).length > 0);
  assert.ok(validate(PREFS_SCHEMA, { bots: { research: { activePreset: "Not Valid" } } }).length > 0);
  assert.deepEqual(validate(PREFS_SCHEMA, {}), [], "a Phase 3 prefs file is still valid");
});

test("secrets: botTokens, mirrorBotToken and proxyApiKey parse, resolve by reference, and are redacted", () => {
  const text = JSON.stringify({ telegramBotToken: "111:main-token-AAAAAAAAAAAAAAAAAAAA", botTokens: { research: "222:research-token-BBBBBBBBBBBBBBBBBB", empty: "" }, mirrorBotToken: "333:mirror-token-CCCCCCCCCCCCCCCCCCCC", proxyApiKey: "proxy-key-DDDDDDDDDDDD" });
  const s = parseSecrets(text);
  assert.equal(botTokenFor(s, "main"), "111:main-token-AAAAAAAAAAAAAAAAAAAA", "main falls back to telegramBotToken");
  assert.equal(botTokenFor(s, "research"), "222:research-token-BBBBBBBBBBBBBBBBBB");
  assert.equal(botTokenFor(s, "empty"), undefined);
  assert.equal(botTokenFor(s, "ghost"), undefined);
  assert.equal(botTokenFor({ ...s, botTokens: { main: "444:override-token-EEEEEEEEEEEEEEEEE" } }, "main"), "444:override-token-EEEEEEEEEEEEEEEEE");
  const values = secretValues(s);
  for (const v of ["222:research-token-BBBBBBBBBBBBBBBBBB", "333:mirror-token-CCCCCCCCCCCCCCCCCCCC", "proxy-key-DDDDDDDDDDDD"]) assert.ok(values.includes(v), "redacted");
  assert.throws(() => parseSecrets(JSON.stringify({ telegramBotToken: "1:x", botTokens: { "Bad Key": "t" } })), /not a bot id/);
  assert.throws(() => parseSecrets(JSON.stringify({ telegramBotToken: "1:x", botTokens: { ok: 5 } })), /must be a string/);
  assert.equal(parseSecrets(JSON.stringify({ telegramBotToken: "1:x" })).botTokens, undefined, "a Phase 1 secrets file is unchanged");
});

test("config.example.json ships the main bot only, as a comment block that nothing reads; its bots.main is valid and equals the implicit main's tools", () => {
  const example = JSON.parse(readFileSync(join(ROOT, "config", "config.example.json"), "utf8")) as Record<string, any>;
  const block = example["_bots"] as Record<string, any>;
  assert.deepEqual(Object.keys(block).filter((k) => !k.startsWith("_")), ["main"], "main only");
  assert.equal("bots" in example, false, "a real bots key would be refused by the migration (it lives in security.json)");
  const main = structuredClone(block["main"]);
  main.readRoots = [{ alias: "notes", path: NOTES }]; // the example path is a placeholder
  const doc = withBots({ main });
  assert.equal(check(doc).ok, true, check(doc).issues.join(" | "));
  assert.deepEqual(main.tools, [...MAIN_DEFAULT_TOOLS]);
  assert.deepEqual(main.edges, []);
  // the whole example still parses as a Phase 1/2 config (the block is a comment)
  assert.doesNotThrow(() => parseConfig(example, ENV));
  assert.equal(check(withBots({ main: bot({ tools: ["mcp__*"] }) })).ok, true);
  assert.equal(check(withBots({ main: bot({ tools: ["mcp__vibetts__*"] }) })).ok, true);
  assert.equal(check(withBots({ main: bot({ edges: [{ to: "research", allow: ["mcp__vibetts__*"] }] }), research: research() })).ok, true);
  refused(withBots({ main: bot({ edges: [{ to: "research", allow: ["mcp__*"] }] }), research: research() }), /a peer turn never gets "mcp__\*"/);
});

test("M2 / I58: an owner Telegram bot cannot list a paid preset (only web bots have a spending cap); billing is validated", () => {
  const route = (id: string) => ({ primary: "lmstudio", allowed: ["lmstudio", id], fallback: [], onAuthRequired: "fallback" });
  const paid = { ...ACP_CODEX, id: "deepseek", modelId: "deepseek/chat", label: "DeepSeek API", billing: "paid" };
  const doc = (preset: Record<string, unknown>, id: string) => withBots({ main: bot(), research: research({ route: route(id) }) }, { presets: [...baseSecurity().presets, preset] });
  refused(doc(paid, "deepseek"), /paid route/);
  assert.equal(check(withBots({ main: bot(), research: research() }, { presets: [...baseSecurity().presets, paid] })).ok, true, "a paid preset that no Telegram bot uses is fine (the web uses it)");
  refused(doc({ ...paid, billing: "metered" }, "deepseek"), /billing/);
  assert.equal(check(doc({ ...ACP_CODEX, billing: "subscription" }, "codex")).ok, true);
});

test("N1: with no `bots` key a paid preset is not in the implicit main's allowed list and a switch to it is rejected", () => {
  const doc = baseSecurity();
  doc["presets"] = [...doc["presets"], { ...ACP_CLAUDE, id: "claude", billing: "paid" }];
  doc["termsAccepted"] = { claude: true };
  const parsed = parseBots(doc, ctxOf(doc));
  const main = parsed.bots[0]!;
  assert.ok(!main.route.allowed.includes("claude"));
  const row = findRow(withRows(DEFAULT_ROWS, botRows(parsed)), parseSettingPath("bots.main.activePreset"))!;
  assert.equal(row.classify!("lmstudio", "claude", { autoApplyCosmetic: false }), "reject");
});
