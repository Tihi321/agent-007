import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createPersonaKind, INLINE_PROMPT_MAX } from "../../src/personas/propose.js";
import { DEFAULT_ROWS } from "../../src/settings/allowlist.js";
import { createSettingsAudit, readAuditTail } from "../../src/settings/audit.js";
import { SettingsError } from "../../src/settings/contracts.js";
import { DEFAULT_LIMITS, ProposalEngine, memoryProposalStore } from "../../src/settings/proposals.js";
import { TelegramSettingsUi } from "../../src/telegram/settingsUi.js";
import { callbackUpdate, waitFor } from "../telegram/helpers/fakeTelegram.js";
import { openRig } from "../telegram/helpers/bridgeRig.js";
import { draft, personaFixture } from "./helpers.js";

const USER = 4242;

async function world(over: { gate?: Promise<void> } = {}) {
  const f = personaFixture();
  f.chatOf.set("7", USER);
  const rig = await openRig({ noStart: true });
  const clock = { t: Date.now() };
  const audit = createSettingsAudit({ dir: join(f.dir, "audit"), writer: "agent", now: () => new Date(clock.t) });
  let first = true;
  const api = new Proxy(rig.tg.bot.api, {
    get(target, prop) {
      if (prop === "sendMessage" && over.gate) {
        return async (...args: Parameters<typeof target.sendMessage>) => {
          if (first) {
            first = false;
            await over.gate;
          }
          return target.sendMessage(...args);
        };
      }
      return (target as never)[prop];
    },
  });
  const ui = new TelegramSettingsUi({ api: api as never, allowedUserIds: [USER], logger: rig.log });
  const injected: { conv: string; text: string; id: string }[] = [];
  const engine = new ProposalEngine({
    store: memoryProposalStore(),
    audit,
    prefs: f.prefs,
    prefsFile: f.prefsFile,
    rows: DEFAULT_ROWS,
    allowedUserIds: [USER],
    limits: () => ({ ...DEFAULT_LIMITS, perHour: 50, maxPending: 5 }),
    transport: ui,
    now: () => clock.t,
    newId: (() => {
      let n = 0;
      return () => `p${String(++n).padStart(7, "0")}`;
    })(),
  });
  engine.registerKind(createPersonaKind({ store: f.store, ceiling: f.ceiling, audit }));
  ui.bind({
    engine,
    valueOf: () => "",
    personaIds: () => [],
    statusLine: () => "",
    validateSecurity: () => null,
    requestRestart: () => undefined,
    injectMessage: async (conv, text, id) => void injected.push({ conv, text, id }),
  });
  rig.bridge.extend(ui.extension());
  await rig.bridge.attach(rig.harness);
  await rig.bridge.start();
  return { f, rig, engine, ui, clock, injected, auditDir: join(f.dir, "audit") };
}

type W = Awaited<ReturnType<typeof world>>;
const done = async (w: W): Promise<void> => {
  await w.rig.shutdown();
  await w.rig.fake.close();
  rmSync(w.f.dir, { recursive: true, force: true });
};
const ctx = { conversationId: "7", chatId: USER };
const propose = (w: W, d: Record<string, unknown>) => w.engine.propose("persona", { draft: d, reason: "the user asked for a research mode" }, ctx);
const tap = (w: W, data: string) => w.rig.tg.bot.handleUpdate(callbackUpdate(USER, data, { messageId: 1000 }) as never);
const answers = (w: W): string[] => w.rig.tg.of("answerCallbackQuery").map((c) => String(c.payload["text"] ?? ""));
const code = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (e) {
    return e instanceof SettingsError ? e.code : `other:${String(e)}`;
  }
  return undefined;
};

test("Approve writes prefs\\personas\\<id>.json equal to the draft and one audit line; the card shows the full diff", async () => {
  const w = await world();
  try {
    const d = draft({ id: "research", toolAllow: ["read_file", "list_dir"], mcpAllow: { vibetts: ["speak"] }, jobTemplates: ["tts-line"], budgets: { maxJobsPerDay: 3 } });
    const r = (await propose(w, d)) as { status: string; proposalId: string };
    assert.equal(r.status, "pending");
    const card = String(w.rig.tg.of("sendMessage").at(-1)!.payload["text"]);
    for (const needle of ["Persona proposed by the model", "New persona proposed by the model: Research (research)", "Model preset: lmstudio", "Tools (2): read_file, list_dir", "MCP tools: vibetts: speak", "Job templates: tts-line", "writes to its own file (research)", "Jobs per day: 3", `Prompt (${(d["prompt"] as string).length} characters)`]) assert.ok(card.includes(needle), `the card shows: ${needle}`);
    const kb = (w.rig.tg.of("sendMessage").at(-1)!.payload["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
    assert.deepEqual(kb.map((b) => b.text), ["Approve", "Edit", "Reject"]);
    await tap(w, `st:${r.proposalId}:y`);
    const file = join(w.f.modelDir, "research.json");
    await waitFor(() => existsSync(file), 5000, "the persona file");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), d, "the file equals the draft exactly");
    const lines = readAuditTail(w.auditDir, 10).filter((l) => l.proposalId === r.proposalId);
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0]?.kind, lines[0]?.persona, lines[0]?.decision, lines[0]?.target.file], ["persona", "research", "approved", "prefs/personas/research.json"]);
    assert.equal(w.f.store.entries(w.f.ceiling()).find((e) => e.id === "research")?.valid, true);
  } finally {
    await done(w);
  }
});

test("Reject writes nothing", async () => {
  const w = await world();
  try {
    const r = (await propose(w, draft({ id: "research" }))) as { proposalId: string };
    await tap(w, `st:${r.proposalId}:n`);
    await waitFor(() => answers(w).includes("Rejected."), 5000, "rejected");
    assert.equal(existsSync(join(w.f.modelDir, "research.json")), false);
    assert.equal(readAuditTail(w.auditDir, 10).filter((l) => l.decision === "rejected").length, 1);
  } finally {
    await done(w);
  }
});

test("a widening draft, a built-in id, a user-authored id, a malformed draft and a 13th persona are refused BEFORE any card", async () => {
  const w = await world();
  try {
    w.f.write("user", draft({ id: "mine" }));
    assert.equal(await code(propose(w, draft({ id: "x1", toolAllow: ["read_file", "teleport"] }))), "persona_invalid");
    w.f.sec.v = { ...w.f.sec.v, shell: { enabled: false } };
    assert.equal(await code(propose(w, draft({ id: "x2", toolAllow: ["shell"] }))), "persona_invalid");
    w.f.sec.v = { ...w.f.sec.v, shell: { enabled: true } };
    assert.equal(await code(propose(w, draft({ id: "x3", modelPreset: "gpt-cloud" }))), "persona_invalid");
    assert.equal(await code(propose(w, draft({ id: "x4", jobTemplates: ["secret-job"] }))), "persona_invalid");
    assert.equal(await code(propose(w, draft({ id: "x5", budgets: { maxJobsPerDay: 9999 } }))), "persona_invalid");
    assert.equal(await code(propose(w, draft({ id: "readonly" }))), "persona_invalid", "a built-in id");
    assert.equal(await code(propose(w, draft({ id: "default" }))), "persona_invalid");
    assert.equal(await code(propose(w, draft({ id: "mine" }))), "persona_invalid", "a user-authored id");
    assert.equal(await code(propose(w, { id: "x" })), "invalid_value", "malformed");
    assert.equal(w.rig.tg.of("sendMessage").length, 0, "no card was sent");
    for (let i = 0; i < 11; i++) w.f.write("model", draft({ id: `m${String(i).padStart(2, "0")}`, name: `M${i}` }));
    assert.equal(await code(propose(w, draft({ id: "thirteen" }))), "persona_invalid", "there are already 12");
    assert.equal(w.rig.tg.of("sendMessage").length, 0);
    assert.ok(readAuditTail(w.auditDir, 50).every((l) => l.decision === "invalid"));
    assert.equal(existsSync(join(w.f.modelDir, "x1.json")), false);
  } finally {
    await done(w);
  }
});

test("a 4,000-character prompt is delivered in full BEFORE the card, and Approve is refused until it was shown", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const w = await world({ gate });
  try {
    const prompt = "word ".repeat(800); // 4000 characters
    assert.ok(prompt.length > INLINE_PROMPT_MAX);
    const pending = propose(w, draft({ id: "long", prompt }));
    await new Promise((r) => setTimeout(r, 50));
    // while the full text is still being sent, the (not yet existing) card cannot be approved
    await tap(w, "st:p0000001:y");
    await waitFor(() => answers(w).some((a) => /Read the full text above first/.test(a)), 5000, "refused before it was shown");
    assert.equal(existsSync(join(w.f.modelDir, "long.json")), false);
    open();
    const r = (await pending) as { proposalId: string };
    const sent = w.rig.tg.of("sendMessage").map((c) => String(c.payload["text"]));
    const prefaceAt = sent.findIndex((t) => t.startsWith("Full text for proposal p0000001"));
    const cardAt = sent.findIndex((t) => t.startsWith("Persona proposed by the model"));
    assert.ok(prefaceAt >= 0 && cardAt > prefaceAt, "the full text goes first, the card after it");
    assert.ok(sent.slice(prefaceAt, cardAt).join("").replace(/Full text for proposal p0000001 \(part \d+ of \d+\):\n/g, "").includes(prompt.trim()), "the whole prompt was sent");
    assert.match(sent[cardAt]!, /Prompt: 4000 characters, sent in full above this card\./);
    await tap(w, `st:${r.proposalId}:y`);
    await waitFor(() => existsSync(join(w.f.modelDir, "long.json")), 5000, "approved after it was shown");
    assert.equal(JSON.parse(readFileSync(join(w.f.modelDir, "long.json"), "utf8")).prompt.length, 4000);
  } finally {
    open();
    await done(w);
  }
});

test("Edit supersedes the proposal: the old card's buttons answer expired, nothing is written, and the model is told the user wants changes", async () => {
  const w = await world();
  try {
    const r = (await propose(w, draft({ id: "research" }))) as { proposalId: string };
    await tap(w, `st:${r.proposalId}:e`);
    await waitFor(() => w.injected.length === 1, 5000, "the model was told");
    assert.equal(w.injected[0]?.conv, "7");
    assert.match(w.injected[0]!.text, /did not approve your persona draft "research" and wants it changed\. Ask the user what to change/);
    assert.match(w.injected[0]!.text, /^\[agent-007 notice, not written by the user\]/);
    assert.equal(w.injected[0]?.id, `persona-edit:${r.proposalId}`);
    assert.match(String(w.rig.tg.of("editMessageText").at(-1)?.payload["text"]), /Superseded/);
    await tap(w, `st:${r.proposalId}:y`);
    await waitFor(() => answers(w).some((a) => /no longer active/.test(a)), 5000, "the old buttons answer expired");
    assert.equal(existsSync(join(w.f.modelDir, "research.json")), false);
    // a revised draft with the same id can be proposed again
    const r2 = (await propose(w, draft({ id: "research", name: "Research v2" }))) as { status: string };
    assert.equal(r2.status, "pending");
  } finally {
    await done(w);
  }
});

test("at approval the draft is checked again against the CURRENT ceiling and the file's revision (stale applies nothing)", async () => {
  const w = await world();
  try {
    const a = (await propose(w, draft({ id: "research", toolAllow: ["shell", "read_file"] }))) as { proposalId: string };
    w.f.sec.v = { ...w.f.sec.v, shell: { enabled: false } }; // narrowed after the card was sent
    await tap(w, `st:${a.proposalId}:y`);
    await waitFor(() => w.rig.tg.of("editMessageText").some((e) => /Could not apply/.test(String(e.payload["text"]))), 5000, "refused at approval");
    assert.equal(existsSync(join(w.f.modelDir, "research.json")), false);
    w.f.sec.v = { ...w.f.sec.v, shell: { enabled: true } };
    const b = (await propose(w, draft({ id: "other" }))) as { proposalId: string };
    w.f.write("model", draft({ id: "other", name: "Written meanwhile" })); // the file appeared after the card
    await tap(w, `st:${b.proposalId}:y`);
    await waitFor(() => w.rig.tg.of("editMessageText").some((e) => /Stale/.test(String(e.payload["text"]))), 5000, "stale");
    assert.equal(JSON.parse(readFileSync(join(w.f.modelDir, "other.json"), "utf8")).name, "Written meanwhile");
  } finally {
    await done(w);
  }
});

test("the kind refuses to be created with a user-authored id even directly (the engine's apply re-checks)", () => {
  const f = personaFixture();
  f.write("user", draft({ id: "mine" }));
  const kind = createPersonaKind({ store: f.store, ceiling: f.ceiling, audit: { append: () => { throw new Error("no"); } } as never });
  assert.throws(() => kind.prepare({ draft: draft({ id: "mine" }) }, { conversationId: "7", chatId: 1 }) as never, /belongs to a persona the user wrote/);
  f.cleanup();
});
