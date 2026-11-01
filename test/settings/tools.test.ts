import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { defaultsFromEnv, parseConfig } from "../../src/config/schema.js";
import { BACKGROUND_CONTEXT } from "../../src/pi/adapter.js";
import type { ToolRegistration } from "../../src/pi/adapter.js";
import { DEFAULT_ROWS } from "../../src/settings/allowlist.js";
import { createSettingsAudit, readAuditTail } from "../../src/settings/audit.js";
import type { EffectivePersona, PersonaRuntime, PersonaSummary, ProposalCard, ProposalTransport } from "../../src/settings/contracts.js";
import { PrefsStore } from "../../src/settings/prefs.js";
import { DEFAULT_LIMITS, ProposalEngine, memoryProposalStore } from "../../src/settings/proposals.js";
import { SETTINGS_TOOL_NAMES, createSettingsTools, redactedSecurityView } from "../../src/settings/tools.js";
import { tempDir } from "./helpers.js";

const USER = 4242424;
const CHAT = USER;

class Transport implements ProposalTransport {
  cards: ProposalCard[] = [];
  updates: string[] = [];
  async present(card: ProposalCard): Promise<{ messageId: number }> {
    this.cards.push(card);
    return { messageId: 7 };
  }
  async update(_id: string, text: string): Promise<void> {
    this.updates.push(text);
  }
  onDecision(): void {}
}

const eff = (id: string, over: Partial<EffectivePersona> = {}): EffectivePersona => ({
  id,
  tools: ["read_file", "list_dir", "shell"],
  mcp: {},
  jobTemplates: [],
  modelPreset: "lmstudio",
  memory: { write: "shared", sharedRead: true },
  maxJobsPerDay: undefined,
  prompt: "SECRET-PERSONA-PROMPT-TEXT",
  ...over,
});

function fakeRuntime(): PersonaRuntime & { applied: string[]; now: { v: string } } {
  const effs: Record<string, EffectivePersona> = {
    default: eff("default"),
    readonly: eff("readonly", { tools: ["read_file"], memory: { write: "none", sharedRead: true } }),
    peer: eff("peer", { tools: ["read_file", "write_file"] }), // removes shell, adds write_file: incomparable with default
    same: eff("same"),
  };
  const summaries: PersonaSummary[] = [
    ...Object.keys(effs).map((id) => ({ id, name: id.toUpperCase(), description: `the ${id} persona`, source: "builtin" as const, valid: true, reasons: [], summary: "n tools" })),
    { id: "broken", name: "Broken", description: "", source: "model", valid: false, reasons: ['tool "shell" is outside what the security settings allow'], summary: "" },
  ];
  const now = { v: "default" };
  const applied: string[] = [];
  return {
    applied,
    now,
    list: () => summaries,
    current: () => now.v,
    effective: () => effs[now.v],
    effectiveOf: (id) => effs[id],
    apply: async (_c, id) => {
      applied.push(id);
      now.v = id;
    },
  };
}

function setup() {
  const dir = tempDir("a7-tools-");
  const clock = { t: Date.parse("2026-10-30T10:00:00Z") };
  const transport = new Transport();
  const audit = createSettingsAudit({ dir: join(dir, "audit"), writer: "agent", now: () => new Date(clock.t) });
  const prefs = new PrefsStore(join(dir, "prefs", "prefs.json"));
  const runtime = fakeRuntime();
  let n = 0;
  const engine = new ProposalEngine({
    store: memoryProposalStore(),
    audit,
    prefs,
    prefsFile: prefs.file,
    rows: DEFAULT_ROWS,
    allowedUserIds: [USER],
    limits: () => DEFAULT_LIMITS,
    transport,
    now: () => clock.t,
    newId: () => `t${String(++n).padStart(7, "0")}`,
    currentPersona: () => runtime.now.v,
  });
  engine.registerSwitchKind(runtime);
  const config = parseConfig(
    {
      telegram: { allowedUserIds: [USER] },
      model: { runner: "strata", runners: { strata: { baseUrl: "http://127.0.0.1:8080/v1", modelId: "q", contextWindow: 9999, maxTokens: 99, installDir: "D:\\Strata", dataDir: "D:\\Strata-data", configFile: "C:\\ProgramData\\agent-007\\strata\\strata.json", logDir: "C:\\ProgramData\\agent-007\\logs" } } },
      folders: { allow: [{ alias: "notes", path: "C:\\Users\\main\\Documents\\notes" }], deny: ["C:\\Pixotope", "C:\\Work"] },
      mcp: { servers: [{ id: "vibetts", url: "http://127.0.0.1:7101/mcp", allowTools: ["speak"], macros: ["tts_line"] }] },
      paths: { programDataDir: "C:\\ProgramData\\agent-007", dataDir: "C:\\Users\\agent007\\AppData\\Local\\agent-007" },
      mainUserProfile: "C:\\Users\\main",
    },
    defaultsFromEnv(),
  );
  const tools = createSettingsTools({
    engine,
    prefs,
    runtime,
    securityView: () => redactedSecurityView(config, { presets: [{ id: "strata", label: "Strata", runner: "strata", modelId: "q" }], budgets: { maxJobsPerDay: 20 }, proposals: DEFAULT_LIMITS }),
    chats: { chatForConversation: (id) => (id === "7" ? CHAT : undefined) },
    audit,
  });
  const byName = (name: string): ToolRegistration => tools.find((t) => t.name === name) as ToolRegistration;
  const call = async (name: string, args: unknown, conv = "7"): Promise<{ isError: boolean; text: string }> => {
    const r = await (byName(name) as unknown as { execute(a: unknown, api: unknown, c: unknown): Promise<{ isError?: boolean; output: { type: string; text: string }[] }> }).execute(args, { conversationId: conv, callId: "c1" }, BACKGROUND_CONTEXT);
    return { isError: r.isError === true, text: r.output.map((o) => o.text).join("") };
  };
  return { dir, transport, audit, prefs, runtime, engine, tools, call, config, clock, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the five tools exist, are all deferred, and their descriptions carry the words tool_search matches on", () => {
  const s = setup();
  assert.deepEqual(s.tools.map((t) => t.name), [...SETTINGS_TOOL_NAMES]);
  for (const t of s.tools) assert.equal((t as { deferred?: boolean }).deferred, true, `${t.name} is deferred`);
  const text = s.tools.map((t) => `${t.name} ${t.description}`).join(" ").toLowerCase();
  for (const w of ["settings", "preference", "tone", "persona"]) assert.ok(text.includes(w), w);
  s.cleanup();
});

test("get_settings: prefs in full, a REDACTED security view (no absolute path, user id, secret or token ref), personas, all untrusted", async () => {
  const s = setup();
  const prefs = await s.call("get_settings", {});
  assert.match(prefs.text, /^<untrusted_content source="settings:prefs">/);
  assert.match(prefs.text, /"tone": "neutral"/);
  const sec = await s.call("get_settings", { scope: "security" });
  assert.match(sec.text, /^<untrusted_content source="settings:security">/);
  for (const forbidden of ["C:\\\\", "C:/", "D:\\\\", String(USER), "Pixotope", "Work", "strata.json", "installDir", "token", "apiKey", "secret", "allowedUserIds"]) {
    assert.ok(!sec.text.includes(forbidden), `the security view must not contain ${forbidden}`);
  }
  assert.match(sec.text, /"allowedAliases": \[\s*"notes"\s*\]/);
  assert.match(sec.text, /"denyEntries": 2/);
  assert.match(sec.text, /http:\/\/127\.0\.0\.1:8080\/v1/);
  const view = redactedSecurityView(s.config);
  assert.equal(JSON.stringify(view).includes("C:\\\\"), false);
  const personas = await s.call("get_settings", { scope: "personas" });
  assert.match(personas.text, /"id": "readonly"/);
  assert.ok(!personas.text.includes("SECRET-PERSONA-PROMPT-TEXT"));
  s.cleanup();
});

test("list_personas shows validity and reasons but never the prompt text", async () => {
  const s = setup();
  const r = await s.call("list_personas", {});
  assert.match(r.text, /"current": "default"/);
  assert.match(r.text, /"id": "broken"[\s\S]*"valid": false[\s\S]*outside what the security settings allow/);
  assert.ok(!r.text.includes("SECRET-PERSONA-PROMPT-TEXT"));
  s.cleanup();
});

test("propose_setting returns pending at once with a proposal id; a security path is a typed error and no card", async () => {
  const s = setup();
  const ok = await s.call("propose_setting", { path: "style.verbosity", value: "detailed", reason: "the user asked for more detail" });
  assert.equal(ok.isError, false);
  const body = JSON.parse(ok.text) as { status: string; proposalId: string; note: string };
  assert.equal(body.status, "pending");
  assert.match(body.proposalId, /^t\d{7}$/);
  assert.match(body.note, /look at the card/);
  assert.equal(s.transport.cards.length, 1);
  const bad = await s.call("propose_setting", { path: "folders.allow", value: "C:\\", reason: "x" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /^not_writable:/);
  assert.equal(s.transport.cards.length, 1);
  const again = await s.call("propose_setting", { path: "style.notes", value: "x", reason: "y" });
  assert.match(again.text, /^too_many_pending:/);
  const noChat = await s.call("propose_setting", { path: "style.notes", value: "x", reason: "y" }, "999");
  assert.match(noChat.text, /^not_allowed:/);
  s.cleanup();
});

test("switch_persona: equal or narrower applies without a card, with one audit line", async () => {
  const s = setup();
  const r = await s.call("switch_persona", { id: "readonly" });
  assert.equal(r.isError, false);
  assert.match(r.text, /Switched to the readonly persona \(narrower\)/);
  assert.deepEqual(s.runtime.applied, ["readonly"]);
  assert.equal(s.transport.cards.length, 0);
  const lines = readAuditTail(join(s.dir, "audit"), 10);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.kind, "switch");
  assert.equal(lines[0]?.decision, "auto");
  s.runtime.now.v = "default";
  s.runtime.applied.length = 0;
  const same = await s.call("switch_persona", { id: "same" });
  assert.match(same.text, /\(equal\)/);
  assert.deepEqual(s.runtime.applied, ["same"]);
  const unchanged = await s.call("switch_persona", { id: "same" });
  assert.match(unchanged.text, /"unchanged"/);
  s.cleanup();
});

test("switch_persona: broader or incomparable produces exactly one card listing what is added and applies only after Approve", async () => {
  const s = setup();
  s.runtime.now.v = "readonly";
  const r = await s.call("switch_persona", { id: "default", reason: "the user asked to go back" });
  assert.equal(JSON.parse(r.text).status, "pending");
  assert.deepEqual(s.runtime.applied, [], "nothing applied before Approve");
  assert.equal(s.transport.cards.length, 1);
  const card = s.transport.cards[0] as ProposalCard;
  assert.match(card.title, /Persona switch requested by the model/);
  assert.match(card.lines.join("\n"), /readonly -> default/);
  assert.match(card.lines.join("\n"), /\+ tool: shell/);
  assert.equal(await s.engine.pending(CHAT).then((p) => p.length), 1);
  const out = await s.engine.decide({ proposalId: card.proposalId, decision: "approve", userId: USER, chatId: CHAT });
  assert.equal(out.result, "approved");
  assert.deepEqual(s.runtime.applied, ["default"]);
  const lines = readAuditTail(join(s.dir, "audit"), 10);
  assert.equal(lines.filter((l) => l.kind === "switch" && l.decision === "approved").length, 1);
  // incomparable (removes shell, adds write_file)
  s.runtime.now.v = "default";
  s.clock.t += 700_000;
  const inc = await s.call("switch_persona", { id: "peer" });
  assert.equal(JSON.parse(inc.text).status, "pending");
  const card2 = s.transport.cards[1] as ProposalCard;
  assert.match(card2.lines.join("\n"), /\+ tool: write_file/);
  assert.equal((await s.engine.decide({ proposalId: card2.proposalId, decision: "reject", userId: USER, chatId: CHAT })).result, "rejected");
  assert.deepEqual(s.runtime.applied, ["default"], "a reject applies nothing");
  s.cleanup();
});

test("switch_persona: unknown and invalid personas are typed errors, and propose_persona says personas are not active until S19 registers the kind", async () => {
  const s = setup();
  assert.match((await s.call("switch_persona", { id: "ghost" })).text, /^unknown_persona:/);
  assert.match((await s.call("switch_persona", { id: "broken" })).text, /^persona_invalid:.*outside what the security settings allow/);
  const draft = { id: "research", name: "R", prompt: "p", toolAllow: [], mcpAllow: [], jobTemplates: [], modelPreset: "lmstudio", memory: { write: "none", sharedRead: true } };
  const r = await s.call("propose_persona", { draft, reason: "because" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^personas_not_active:/);
  s.cleanup();
});
