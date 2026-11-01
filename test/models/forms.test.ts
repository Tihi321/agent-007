/**
 * S22.4: the Phase 4 settings forms (bots, terms, bot bus, bot room, gate) through the real S18.1 route over a real listener, and the
 * rule that termsAccepted exists only in the UI form (no allowlist row, tool, propose_* or Telegram button reaches it).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { botRows } from "../../src/bots/rows.js";
import { parseBots } from "../../src/bots/schema.js";
import { TERMS_ACK_TEXT, phase4Forms } from "../../src/jobrunner/settingsUi/forms/phase4.js";
import { shippedForms } from "../../src/jobrunner/settingsUi/forms/registry.js";
import { DEFAULT_ROWS, findRow, telegramRows, withRows } from "../../src/settings/allowlist.js";
import { readAuditTail } from "../../src/settings/audit.js";
import { validate } from "../../src/settings/jsonschema.js";
import type { Schema } from "../../src/settings/jsonschema.js";
import { SECURITY_SCHEMA } from "../../src/settings/schema.js";
import { readSecurity, signIn, startRig } from "../settingsUi/helpers.js";
import type { Session, UiRig } from "../settingsUi/helpers.js";
import { NOTES, READ_ONLY_TOOLS, baseSecurity, bot, research, withBots } from "../bots/helpers.js";

async function current(s: Session): Promise<{ doc: Record<string, any>; revision: string }> {
  return (await s.get("/api/security")).json() as never;
}

function botDoc(rig: UiRig, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: "a research bot",
    telegramTokenRef: "research",
    route: { primary: "lmstudio", allowed: ["lmstudio"], fallback: [], onAuthRequired: "fallback" },
    tools: [...READ_ONLY_TOOLS],
    readRoots: [{ alias: "notes", path: rig.notes }],
    cloudSafeRoots: [],
    shared: { read: false },
    edges: [],
    ...over,
  };
}

const lines = (rig: UiRig) => readAuditTail(rig.paths.auditDir, 50);

test("the five Phase 4 descriptors exist, are security forms over exactly their section, and every section of the schema now has a form", () => {
  const forms = phase4Forms();
  assert.deepEqual(forms.map((f) => [f.id, f.section.join()]), [["bots", "bots"], ["terms", "termsAccepted"], ["botbus", "botBus"], ["botroom", "botRoom"], ["gate", "gate"]]);
  const shipped = shippedForms().list();
  for (const f of forms) assert.ok(shipped.some((x) => x.id === f.id), f.id);
  assert.deepEqual(shipped.filter((f) => f.ack).map((f) => f.id), ["terms"], "only the terms form carries an acknowledgment");
  assert.equal(shipped.find((f) => f.id === "terms")?.ack?.text, TERMS_ACK_TEXT);
  assert.match(TERMS_ACK_TEXT, /terms/);
  // the models form edits the presets, with the Phase 4 fields (kind, proxy URL, provider, privacy, autoFallback)
  const models = shipped.find((f) => f.id === "models");
  assert.deepEqual(models?.section, ["model", "presets"]);
  const item = (models?.schema.properties?.["presets"] as Schema).items as Schema;
  for (const k of ["kind", "baseUrl", "providerId", "apiKeyRef", "privacy", "autoFallback"]) assert.ok(item.properties?.[k], `the presets form offers ${k}`);
  assert.deepEqual((item.properties?.["apiKeyRef"] as Schema).enum, ["proxyApiKey"], "no other key reference can be chosen");
  assert.ok(!Object.keys(item.properties ?? {}).includes("apiKey"), "no API-key field exists");
  // a bot's edge has the egress flag, in the bots form only
  const bots = shipped.find((f) => f.id === "bots");
  const botSchema = (bots?.schema.properties?.["bots"] as Schema).additionalProperties as Schema;
  assert.ok(((botSchema.properties?.["edges"] as Schema).items as Schema).properties?.["egress"]);
  for (const f of forms) assert.deepEqual(validate(f.schema, {}), [], f.id);
});

test("gate, botBus and botRoom save through the form route: file replaced, exactly one source:ui audit line each, with the diff", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const cases: [string, string, Record<string, unknown>][] = [
      ["gate", "gate", { maxQueueDepth: 5, proxyMaxConcurrent: 2 }],
      ["botbus", "botBus", { hopLimit: 3, edgeDailyCap: 12 }],
      ["botroom", "botRoom", { mode: "summary", maxChars: 120, maxPerMinute: 10, chatId: -100123 }],
    ];
    let n = 0;
    for (const [formId, section, value] of cases) {
      const cur = await current(s);
      const r = await s.post("/api/security/save", { formId, sections: { [section]: value }, baseRevision: cur.revision });
      assert.equal(r.status, 200, `${formId}: ${r.text}`);
      assert.deepEqual(readSecurity(rig).doc[section], value);
      const all = lines(rig);
      assert.equal(all.length, ++n, "one line per save");
      const l = all.at(-1)!;
      assert.equal(l.source, "ui");
      assert.equal(l.kind, "security");
      assert.deepEqual(l.target, { file: "security.json", path: section });
      assert.ok(l.diff.length > 0);
      assert.equal(l.approver?.kind, "ui");
    }
    // out-of-range values are refused by the loader's schema, file and log unchanged
    const before = readSecurity(rig).text;
    const cur = await current(s);
    for (const [formId, section, value] of [
      ["gate", "gate", { proxyMaxConcurrent: 9 }],
      ["botbus", "botBus", { hopLimit: 50 }],
      ["botroom", "botRoom", { mode: "everything" }],
    ] as [string, string, Record<string, unknown>][]) {
      const r = await s.post("/api/security/save", { formId, sections: { [section]: value }, baseRevision: cur.revision });
      assert.equal(r.status, 422, `${formId}: ${r.text}`);
    }
    assert.equal(readSecurity(rig).text, before);
    assert.equal(lines(rig).length, 3);
  } finally {
    await rig.cleanup();
  }
});

test("the bots form saves a second bot with an edge (egress flag), one ui audit line; a refused bot leaves file and log unchanged", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const cur = await current(s);
    const main = botDoc(rig, { description: "main", telegramTokenRef: "main", tools: ["tool_search", "system_facts", "list_dir", "read_file", "ask_user", "ask_bot", "list_bots"], edges: [{ to: "research", allow: ["read_file"], egress: false }] });
    const res = await s.post("/api/security/save", { formId: "bots", sections: { bots: { main, research: botDoc(rig, { edges: [{ to: "main", allow: ["read_file"], egress: true }], tools: [...READ_ONLY_TOOLS, "ask_bot", "list_bots"] }) } }, baseRevision: cur.revision });
    assert.equal(res.status, 200, res.text);
    const saved = readSecurity(rig).doc["bots"];
    assert.equal(saved.research.edges[0].egress, true);
    const all = lines(rig);
    assert.equal(all.length, 1);
    assert.equal(all[0]?.source, "ui");
    assert.deepEqual(all[0]?.target, { file: "security.json", path: "bots" });
    // refusals: a tool outside the catalog, an edge to a bot that does not exist, a non-loopback-looking route, a missing token ref
    const text = readSecurity(rig).text;
    const rev = (await current(s)).revision;
    const bad: Record<string, unknown>[] = [
      { main, research: botDoc(rig, { tools: ["no_such_tool"] }) },
      { main, research: botDoc(rig, { edges: [{ to: "ghost", allow: ["read_file"], egress: false }], tools: [...READ_ONLY_TOOLS, "ask_bot", "list_bots"] }) },
      { main, research: botDoc(rig, { route: { primary: "ghost", allowed: ["ghost"], fallback: [], onAuthRequired: "fallback" } }) },
      { main, research: botDoc(rig, { route: { primary: "lmstudio", allowed: ["lmstudio"], fallback: [], onAuthRequired: "fallback" }, telegramTokenRef: "main" }) },
    ];
    for (const b of bad) {
      const r = await s.post("/api/security/save", { formId: "bots", sections: { bots: b }, baseRevision: rev });
      assert.equal(r.status, 422, r.text);
    }
    assert.equal(readSecurity(rig).text, text, "the file is unchanged");
    assert.equal(lines(rig).length, 1, "and so is the log");
  } finally {
    await rig.cleanup();
  }
});

test("terms form: no ack is refused (file and log unchanged); ack:true saves, and the acknowledgment text is in the one audit line", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const cur = await current(s);
    const before = readSecurity(rig).text;
    const no = await s.post("/api/security/save", { formId: "terms", sections: { termsAccepted: { claude: true, antigravity: false } }, baseRevision: cur.revision });
    assert.equal(no.status, 422);
    assert.equal(no.json()["error"], "ack_required");
    assert.equal(no.json()["message"], TERMS_ACK_TEXT);
    assert.equal((await s.post("/api/security/save", { formId: "terms", sections: { termsAccepted: { claude: true } }, baseRevision: cur.revision, ack: "yes" })).status, 422);
    assert.equal(readSecurity(rig).text, before);
    assert.deepEqual(lines(rig), []);
    const ok = await s.post("/api/security/save", { formId: "terms", sections: { termsAccepted: { claude: true, antigravity: false } }, baseRevision: cur.revision, ack: true });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(readSecurity(rig).doc["termsAccepted"], { claude: true, antigravity: false });
    const l = lines(rig);
    assert.equal(l.length, 1);
    assert.equal(l[0]?.source, "ui");
    assert.match(l[0]?.note ?? "", /^ack: I understand that using Claude or Antigravity/);
    // the terms form cannot carry any other section
    const other = await s.post("/api/security/save", { formId: "terms", sections: { termsAccepted: { claude: true }, gate: { maxQueueDepth: 3 } }, baseRevision: (await current(s)).revision, ack: true });
    assert.equal(other.status, 400);
  } finally {
    await rig.cleanup();
  }
});

test("a claude preset is refused by the models form until the terms are acknowledged, then accepted", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    let cur = await current(s);
    const claude = { id: "claude", kind: "acp", baseUrl: "http://127.0.0.1:8787/v1", providerId: "claude", apiKeyRef: "proxyApiKey", modelId: "claude/sonnet", contextWindow: 100000, maxTokens: 4096, label: "Claude", privacy: "cloud", autoFallback: false };
    const lm = { id: "lmstudio", kind: "local", runner: "lmstudio", modelId: cur.doc["model"].runners.lmstudio.modelId, contextWindow: 8192, maxTokens: 512, label: "LM Studio", privacy: "local", autoFallback: true };
    // the presets themselves may be listed (an unused preset is only data) ...
    const p = await s.post("/api/security/save", { formId: "models", sections: { model: cur.doc["model"], presets: [lm, claude] }, baseRevision: cur.revision });
    assert.equal(p.status, 200, p.text);
    cur = await current(s);
    // ... but a bot whose route uses it is refused until the acknowledgment exists
    const route = { primary: "lmstudio", allowed: ["lmstudio", "claude"], fallback: [], onAuthRequired: "fallback" };
    const saveBot = (revision: string) => s.post("/api/security/save", { formId: "bots", sections: { bots: { main: botDoc(rig, { telegramTokenRef: "main", route }) } }, baseRevision: revision });
    const before = readSecurity(rig).text;
    const refused = await saveBot(cur.revision);
    assert.equal(refused.status, 422, refused.text);
    assert.match((refused.json()["issues"] as string[]).join("\n"), /claude|terms|acknowledg/i);
    assert.equal(readSecurity(rig).text, before);
    assert.equal(lines(rig).length, 1, "only the presets save was logged");
    const t = await s.post("/api/security/save", { formId: "terms", sections: { termsAccepted: { claude: true, antigravity: false } }, baseRevision: cur.revision, ack: true });
    assert.equal(t.status, 200, t.text);
    cur = await current(s);
    const ok = await saveBot(cur.revision);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(lines(rig).length, 3);
  } finally {
    await rig.cleanup();
  }
});

test("a save that names termsAccepted without a form id must not skip the acknowledgment", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const cur = await current(s);
    const r = await s.post("/api/security/save", { sections: { termsAccepted: { claude: true, antigravity: true } }, baseRevision: cur.revision });
    assert.notEqual(r.status, 200, "termsAccepted was written with no acknowledgment");
    assert.equal(readSecurity(rig).doc["termsAccepted"], undefined);
  } finally {
    await rig.cleanup();
  }
});

// ---- termsAccepted exists only in the UI form ------------------------------------------------------------------------

function securityPaths(schema: Schema, prefix: string[] = []): string[][] {
  const out: string[][] = [];
  for (const [k, sub] of Object.entries(schema.properties ?? {})) {
    out.push([...prefix, k]);
    out.push(...securityPaths(sub, [...prefix, k]));
  }
  const ap = schema.additionalProperties;
  if (ap && typeof ap === "object") out.push(...securityPaths(ap, [...prefix, "main"]));
  const items = schema.items;
  if (items && typeof items === "object" && !Array.isArray(items)) out.push(...securityPaths(items, prefix));
  return out;
}

test("no allowlist row reaches termsAccepted, or any security.json path: not for the model, not for a Telegram button", () => {
  const doc = withBots({ main: bot(), research: research() });
  const parsed = parseBots(doc, { folderAllow: [{ alias: "notes", path: NOTES }], derivedPresets: [], defaultPreset: "lmstudio" });
  const rows = withRows(DEFAULT_ROWS, botRows(parsed));
  assert.ok(rows.length > DEFAULT_ROWS.length, "the per-bot rows are in the table");
  const paths = securityPaths(SECURITY_SCHEMA);
  assert.ok(paths.some((p) => p.join(".") === "termsAccepted.claude"), "the walk reaches termsAccepted.claude");
  assert.ok(paths.length > 100, `walked ${paths.length} security paths`);
  for (const p of paths) assert.equal(findRow(rows, p), undefined, `a row matches the security path ${p.join(".")}`);
  for (const extra of [["termsAccepted"], ["termsAccepted", "claude"], ["termsAccepted", "antigravity"], ["bots", "main", "termsAccepted"], ["bots", "research", "termsAccepted", "claude"], ["presets"], ["bots", "main", "route"], ["bots", "main", "route", "fallback"], ["bots", "main", "edges"]]) {
    assert.equal(findRow(rows, extra), undefined, extra.join("."));
  }
  // the only Phase 4 row shape is bots.<id>.activePreset, and nothing mentions terms
  for (const r of rows) {
    assert.ok(!/terms/i.test(r.path) && !/terms/i.test(r.label), r.path);
    assert.ok(!/terms/i.test(JSON.stringify(r.schema)), r.path);
    if (r.path.startsWith("bots.")) assert.match(r.path, /^bots\.[a-z][a-z0-9-]*\.activePreset$/);
  }
  // no Telegram button (telegram rows) touches it either, nor offers a choice that names it
  for (const r of telegramRows(rows)) {
    assert.ok(!/terms/i.test(r.path), r.path);
    assert.ok(!/terms/i.test(JSON.stringify(r.choices ?? [])));
  }
  assert.ok(!rows.some((r) => r.path.startsWith("bots.") && r.telegram), "no per-bot row is reachable from a button");
});

test("no source file other than the schema, the loader, the split, the read-only runtime check and the UI form mentions termsAccepted (no writer exists)", () => {
  const root = join(process.cwd(), "src");
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(name) && readFileSync(p, "utf8").includes("termsAccepted")) hits.push(relative(root, p).replace(/\\/g, "/"));
    }
  };
  walk(root);
  // S26: `agent/multibot.ts` hands the loaded value to the model switcher and the fallback engine as a getter (read only)
  assert.deepEqual(hits.sort(), ["agent/multibot.ts", "bots/schema.ts", "jobrunner/settingsUi/forms/phase4.ts", "jobrunner/settingsUi/forms/registry.ts", "jobrunner/settingsUi/routes.ts", "models/presets.ts", "settings/schema.ts", "settings/split.ts"]);
  // the runtime reads it only through a getter (`terms()`), never assigns it
  assert.ok(!/termsAccepted\s*[=:]\s*\{?\s*(true|claude)/.test(readFileSync(join(root, "models", "presets.ts"), "utf8")));
  const host = readFileSync(join(root, "agent", "multibot.ts"), "utf8");
  assert.ok(!/termsAccepted\s*=[^=]|termsAccepted\s*:\s*\{?\s*(true|claude)/.test(host), "the host never assigns it");
  assert.ok(!/\.termsAccepted\.\w+\s*=[^=]/.test(host), "nor a member of it");
  assert.ok(baseSecurity());
});
