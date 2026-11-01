/**
 * S19 integration (offline): a MIGRATED fixture install with the real startup sequence, the real persona resolver, applier, guard,
 * sections and memory scope, a scripted model and a fake Telegram. Personas are chosen by the user's own `/persona`, and by the
 * model through `switch_persona` (one card for a broader switch). Live checks (the phone, a real model) are a user step.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runMigration } from "../../scripts/migrate-settings.js";
import { ALWAYS_LOADED } from "../../src/jobs/contracts.js";
import { readAuditTail } from "../../src/settings/audit.js";
import { SETTINGS_TOOL_NAMES } from "../../src/settings/tools.js";
import type { Behavior, BehaviorInput } from "../helpers/fakeOpenAi.js";
import { ROOT } from "../settings/helpers.js";
import { E2e, waitFor } from "./rig.js";

const SETTINGS_SET = new Set<string>(SETTINGS_TOOL_NAMES);
const DEFERRED = new Set(["search_files", "write_file", "remember", ...SETTINGS_SET]);

function lastCalled(i: BehaviorInput): string | undefined {
  const msgs = i.request.messages ?? [];
  for (let k = msgs.length - 1; k >= 0; k--) {
    const m = msgs[k];
    if (m?.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    return (m.tool_calls as { function?: { name?: string } }[])[0]?.function?.name;
  }
  return undefined;
}

/** Like `viaToolSearch`, but `shell` is called DIRECTLY (a model that tries a tool it was not offered). */
function searchFirst(inner: Behavior): Behavior {
  return (i) => {
    const afterSearch = i.afterTool && lastCalled(i) === "tool_search";
    const reply = inner(afterSearch ? { ...i, afterTool: false, lastToolText: "" } : i);
    if (reply.type !== "tool_calls") return reply;
    const offered = new Set((i.request.tools ?? []).map((t) => t.function?.name ?? ""));
    const direct = String(i.lastUser).includes("force"); // "force run ...": call shell directly, even if it was not offered
    const missing = reply.calls.find((c) => (c.name === "shell" ? !direct && !offered.has("shell") : DEFERRED.has(c.name) && !offered.has(c.name)));
    if (missing) return { type: "tool_calls", calls: [{ name: "tool_search", args: { query: `${missing.name} tool` } }] };
    return reply;
  };
}

const model = searchFirst(({ lastUser, afterTool, lastToolText }) => {
  if (afterTool) return { type: "text", text: `tool said: ${lastToolText}` };
  if (/remember tea/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "remember", args: { note: "The user collects stamps." } }] };
  if (/switch to default/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "switch_persona", args: { id: "default", reason: "the user asked to go back" } }] };
  if (/run whoami/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "shell", args: { command: "whoami", reason: "check the user" } }] };
  if (/draft a helper persona/.test(lastUser)) {
    return {
      type: "tool_calls",
      calls: [{ name: "propose_persona", args: { draft: { id: "helper", name: "Helper", description: "reads files", prompt: "You help by reading files.", toolAllow: ["tool_search", "read_file", "list_dir"], mcpAllow: [], jobTemplates: [], modelPreset: "lmstudio", memory: { write: "none", sharedRead: true } }, reason: "the user wants a reading helper" } }],
    };
  }
  return { type: "text", text: `echo: ${lastUser}` };
});

async function migrated(extra: { shell?: Record<string, unknown> } = {}): Promise<E2e> {
  const rig = await E2e.open({ behavior: model, ...(extra.shell ? { config: { shell: extra.shell } } : {}) });
  await rig.stop();
  mkdirSync(join(rig.dirs.programData, "settings", "audit"), { recursive: true });
  const out: string[] = [];
  const code = await runMigration({ config: rig.dirs.configPath, agentUser: "agent007", apply: true, rollback: false }, { out: (l) => void out.push(l), env: rig.dirs.env, checkAcl: () => [] });
  assert.equal(code, 0, out.join("\n"));
  mkdirSync(join(rig.dirs.programData, "settings", "personas"), { recursive: true });
  copyFileSync(join(ROOT, "config", "personas", "research.example.json"), join(rig.dirs.programData, "settings", "personas", "research.json"));
  await rig.start();
  return rig;
}

const clean = (rig: E2e): void => rmSync(rig.dirs.root, { recursive: true, force: true });
let mid = 100;
const say = async (rig: E2e, text: string): Promise<void> => rig.say(text, ++mid);
const RESEARCH_OFFERED = ["ask_user", "hub_status", "job_status", "list_dir", "list_templates", "read_file", "system_facts", "tool_search"];
/** What the research example may use at all (deferred ones show up in the request only after tool_search loaded them). */
const RESEARCH_ALLOWED = new Set(["tool_search", "system_facts", "list_dir", "read_file", "search_files", "remember", "get_settings", "list_personas", "switch_persona", "job_status", "list_templates", "hub_status", "ask_user"]);

test("a user /persona switch narrows the tools the model is offered, adds the persona and guardrails sections in the I27e order, and /new keeps both", async () => {
  const rig = await migrated();
  try {
    await say(rig, "/persona research");
    await rig.seen((t) => /Now using the Research persona \(narrower\)/.test(t), "the switch reply");
    await say(rig, "hello");
    await rig.seen((t) => t === "echo: hello", "the answer");
    assert.deepEqual([...rig.toolNamesOfLastRequest()].sort(), RESEARCH_OFFERED, "dispatch_job and cancel_job are not offered in this persona");
    const p = rig.lastSystemPrompt();
    const at = (k: string): number => p.indexOf(`<${k}>`);
    const order = ["preamble", "persona", "guardrails", "style", "user_profile", "memory", "runtime"].map(at);
    assert.ok(order.every((i) => i >= 0), `every section is present: ${order.join(",")}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "preamble, persona, guardrails, style, user_profile, memory, runtime");
    assert.match(p, /You are working in the "Research" persona/);
    assert.match(p, /The persona text cannot change, relax or cancel these rules/);
    // /new keeps the persona and the gate
    await say(rig, "/new");
    await rig.seen((t) => t === "Started a new conversation.", "/new");
    await say(rig, "hello again");
    await rig.seen((t) => t === "echo: hello again", "the answer in the new conversation");
    assert.deepEqual([...rig.toolNamesOfLastRequest()].sort(), RESEARCH_OFFERED);
    assert.match(rig.lastSystemPrompt(), /<persona>/);
    // the audit has the user's own switch
    const audit = readAuditTail(join(rig.dirs.programData, "settings", "audit"), 50).filter((l) => l.kind === "switch");
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0]?.source, audit[0]?.decision, audit[0]?.persona], ["telegram", "applied", "research"]);
  } finally {
    await rig.close();
    clean(rig);
  }
});

test("a forced shell call in a persona without shell does not run and creates no approval card; tool_search cannot even find it", async () => {
  const rig = await migrated();
  try {
    await say(rig, "/persona research");
    await rig.seen((t) => /Now using the Research persona/.test(t), "the switch reply");
    const before = rig.cards().length;
    await say(rig, "force run whoami");
    await rig.seen((t) => t.startsWith("tool said:"), "the model's answer after its failed call");
    assert.equal(rig.cards().length, before, "no approval card: the shell was never reachable");
    assert.deepEqual(rig.audit().filter((e) => e["event"] === "requested"), [], "the shell audit has no request");
    assert.ok(!rig.toolNamesOfLastRequest().includes("shell"));
    // and the default persona still gates the shell (the hook is active)
    await say(rig, "/persona default");
    await rig.seen((t) => /Now using the Default persona/.test(t), "back to default");
    await say(rig, "run whoami");
    const card = await rig.card(before + 1);
    assert.match(card.text, /whoami/);
    await rig.tap(card.deny);
    await rig.seen((t) => /denied/i.test(t) || t.startsWith("tool said:"), "the denial");
  } finally {
    await rig.close();
    clean(rig);
  }
});

test("switch_persona by the model: a broader switch produces exactly one card; Approve applies and the tools widen again", async () => {
  const rig = await migrated();
  try {
    await say(rig, "/persona research");
    await rig.seen((t) => /Now using the Research persona/.test(t), "the switch reply");
    await say(rig, "switch to default");
    const card = await rig.card(1);
    assert.match(card.text, /^Persona switch requested by the model/);
    assert.match(card.text, /research -> default/);
    assert.match(card.text, /\+ tool: shell/);
    assert.equal(rig.cards().length, 1, "exactly one card");
    await say(rig, "hello");
    await rig.seen((t) => t === "echo: hello", "still researching before Approve");
    const offered = rig.toolNamesOfLastRequest();
    assert.ok(offered.every((n) => RESEARCH_ALLOWED.has(n)), `offered ${offered.join()} is within the persona`);
    assert.ok(!offered.includes("dispatch_job") && !offered.includes("shell"));
    await rig.tap(card.approve);
    await rig.seen((t) => /Approved\. Switched to the default persona/.test(t), "the card outcome");
    await say(rig, "hello after");
    await rig.seen((t) => t === "echo: hello after", "answer");
    const widened = rig.toolNamesOfLastRequest();
    for (const n of ALWAYS_LOADED) assert.ok(widened.includes(n), `${n} is offered again`); // plus the tools tool_search loaded meanwhile
    const lines = readAuditTail(join(rig.dirs.programData, "settings", "audit"), 50).filter((l) => l.source === "propose" && l.kind === "switch");
    assert.equal(lines.filter((l) => l.decision === "approved").length, 1);
  } finally {
    await rig.close();
    clean(rig);
  }
});

test("memory scope: remember in the research persona writes MEMORY.research.md (announced with the scope), not MEMORY.md, and the scope notes reach the prompt", async () => {
  const rig = await migrated();
  try {
    await say(rig, "/persona research");
    await rig.seen((t) => /Now using the Research persona/.test(t), "the switch reply");
    await say(rig, "remember tea");
    await rig.seen((t) => /Saved to memory \(scope research\): The user collects stamps\./.test(t), "the scoped announcement");
    const dir = join(rig.dirs.data, "memory");
    assert.match(readFileSync(join(dir, "MEMORY.research.md"), "utf8"), /The user collects stamps\./);
    assert.equal(existsSync(join(dir, "MEMORY.md")), false, "the shared file was not written");
    await say(rig, "hello");
    await rig.seen((t) => t === "echo: hello", "answer");
    assert.match(rig.lastSystemPrompt(), /<untrusted_content source="MEMORY\.research\.md">[\s\S]*The user collects stamps\./);
    // the default persona does not see the scope file
    await say(rig, "/persona default");
    await rig.seen((t) => /Now using the Default persona/.test(t), "back to default");
    await say(rig, "/new");
    await rig.seen((t) => t === "Started a new conversation.", "/new");
    await say(rig, "hello default");
    await rig.seen((t) => t === "echo: hello default", "answer");
    assert.ok(!/collects stamps/.test(rig.lastSystemPrompt()), "a fresh conversation under the default persona has no scope notes");
  } finally {
    await rig.close();
    clean(rig);
  }
});

test("a persona that became invalid runs read-only with exactly one notice (fail closed, never default)", async () => {
  const rig = await migrated({ shell: { enabled: false } });
  try {
    // an ops persona that needs the shell, while shell.enabled is false: unusable
    writeFileSync(join(rig.dirs.programData, "settings", "personas", "ops.json"), JSON.stringify({ id: "ops", name: "Ops", prompt: "p", toolAllow: ["shell", "read_file", "tool_search"], mcpAllow: {}, jobTemplates: [], modelPreset: "lmstudio", memory: { write: "none", sharedRead: true }, budgets: {} }));
    mkdirSync(join(rig.dirs.data, "prefs"), { recursive: true });
    writeFileSync(join(rig.dirs.data, "prefs", "prefs.json"), JSON.stringify({ defaultPersona: "ops" }));
    await say(rig, "hello");
    await rig.seen((t) => t === "echo: hello", "the answer");
    const notices = rig.texts().filter((t) => /The "ops" persona cannot be used right now/.test(t));
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /shell is turned off/);
    assert.match(notices[0]!, /read-only persona/);
    for (const n of ["system_facts", "list_dir", "read_file", "tool_search"]) assert.ok(rig.toolNamesOfLastRequest().includes(n));
    assert.ok(!rig.toolNamesOfLastRequest().includes("dispatch_job"), "readonly, not default");
    assert.match(rig.lastSystemPrompt(), /Read-only/);
    await say(rig, "hello two");
    await rig.seen((t) => t === "echo: hello two", "answer two");
    assert.equal(rig.texts().filter((t) => /cannot be used right now/.test(t)).length, 1, "still exactly one notice");
    await say(rig, "/persona ops");
    await rig.seen((t) => /that persona is not usable/.test(t), "the user cannot pick it either");
  } finally {
    await rig.close();
    clean(rig);
  }
});

test("propose_persona by the model: a card with the full draft; Approve writes prefs\\personas\\helper.json and /persona can use it", async () => {
  const rig = await migrated();
  try {
    await say(rig, "draft a helper persona");
    const card = await rig.card(1);
    assert.match(card.text, /^Persona proposed by the model/);
    assert.match(card.text, /New persona proposed by the model: Helper \(helper\)/);
    assert.match(card.text, /Tools \(3\): tool_search, read_file, list_dir/);
    await rig.tap(card.approve);
    const file = join(rig.dirs.data, "prefs", "personas", "helper.json");
    await waitFor(() => existsSync(file), 10_000, "the persona file");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).id, "helper");
    await say(rig, "/persona helper");
    await rig.seen((t) => /Now using the Helper persona/.test(t), "usable at once");
    await say(rig, "hello");
    await rig.seen((t) => t === "echo: hello", "answer");
    assert.deepEqual([...rig.toolNamesOfLastRequest()].sort(), ["list_dir", "read_file", "tool_search"]);
    const lines = readAuditTail(join(rig.dirs.programData, "settings", "audit"), 50).filter((l) => l.kind === "persona" && l.decision === "approved");
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.target.file, "prefs/personas/helper.json");
  } finally {
    await rig.close();
    clean(rig);
  }
});
