import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TelegramPersonaUi } from "../../src/telegram/personaUi.js";
import { createSettingsAudit, readAuditTail } from "../../src/settings/audit.js";
import { DEFAULT_ROWS } from "../../src/settings/allowlist.js";
import type { ProposalCard, ProposalTransport } from "../../src/settings/contracts.js";
import { DEFAULT_LIMITS, ProposalEngine, memoryProposalStore } from "../../src/settings/proposals.js";
import { createSettingsTools } from "../../src/settings/tools.js";
import { BACKGROUND_CONTEXT } from "../../src/pi/adapter.js";
import type { ToolRegistration } from "../../src/pi/adapter.js";
import { callbackUpdate, textUpdate, waitFor } from "../telegram/helpers/fakeTelegram.js";
import { openRig } from "../telegram/helpers/bridgeRig.js";
import { draft, personaFixture } from "./helpers.js";

const USER = 4242;

async function world() {
  const f = personaFixture();
  f.chatOf.set("7", USER);
  const rig = await openRig({ noStart: true });
  const clock = { t: Date.now() };
  const audit = createSettingsAudit({ dir: join(f.dir, "audit"), writer: "agent", now: () => new Date(clock.t) });
  const ensured: number[] = [];
  const ui = new TelegramPersonaUi({
    api: rig.tg.bot.api,
    allowedUserIds: [USER],
    logger: rig.log,
    resolver: f.resolver,
    applier: { ensureApplied: async () => ({}) } as never,
    audit,
    store: f.store,
    ceiling: f.ceiling,
    ensureConversation: async (chatId) => {
      ensured.push(chatId);
      return "7";
    },
  });
  rig.bridge.extend(ui.extension());
  await rig.bridge.attach(rig.harness);
  await rig.bridge.start();
  return { f, rig, audit, clock, ui, ensured, auditDir: join(f.dir, "audit") };
}

type W = Awaited<ReturnType<typeof world>>;
const done = async (w: W): Promise<void> => {
  await w.rig.shutdown();
  await w.rig.fake.close();
  w.f.cleanup();
};
const cmd = (w: W, text: string, from = USER) => w.rig.tg.bot.handleUpdate(textUpdate(from, text) as never);
const tap = (w: W, data: string, o: { from?: number; chatId?: number } = {}) => w.rig.tg.bot.handleUpdate(callbackUpdate(o.from ?? USER, data, { ...(o.chatId !== undefined ? { chatId: o.chatId } : {}), messageId: 1000 }) as never);
const last = (w: W) => w.rig.tg.of("sendMessage").filter((c) => !c.failed).at(-1)!;
const answers = (w: W): string[] => w.rig.tg.of("answerCallbackQuery").map((c) => String(c.payload["text"] ?? ""));
const keyboard = (c: { payload: Record<string, unknown> }) => ((c.payload["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard ?? []).flat();

test("/persona: the picker labels each valid persona narrower, equal, broader or different relative to the current one, and lists invalid ones with the reason", async () => {
  const w = await world();
  try {
    w.f.write("user", draft({ id: "research", name: "Research", toolAllow: ["read_file", "list_dir"] }));
    w.f.write("user", draft({ id: "writer", name: "Writer", toolAllow: ["read_file", "write_file"] }));
    w.f.write("user", draft({ id: "broken", name: "Broken", toolAllow: ["read_file", "teleport"] }));
    await cmd(w, "/persona");
    await waitFor(() => w.rig.tg.sentTexts(USER).some((t) => t.startsWith("Persona now: default")), 5000, "the picker");
    const text = String(last(w).payload["text"]);
    assert.match(text, /- default \(current\)/);
    assert.match(text, /- readonly \(narrower\)/);
    assert.match(text, /- research \(narrower\)/);
    assert.match(text, /- broken: not usable \(tool "teleport" is not a known tool\)/);
    const buttons = keyboard(last(w));
    assert.ok(buttons.some((b) => b.callback_data === "pe:s:research" && /\(narrower\)/.test(b.text)));
    assert.ok(!buttons.some((b) => b.callback_data === "pe:s:broken"), "an invalid persona has no button");
    for (const b of buttons) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
    // from research: default is broader; writer swaps read for write: different
    await tap(w, "pe:s:research");
    await waitFor(() => w.f.resolver.current("7") === "research", 5000, "switched");
    await cmd(w, "/persona");
    await waitFor(() => w.rig.tg.sentTexts(USER).filter((t) => t.startsWith("Persona now: research")).length > 0, 5000, "second picker");
    const t2 = String(last(w).payload["text"]);
    assert.match(t2, /- default \(broader\)/);
    assert.match(t2, /- writer \(different\)/);
    assert.match(t2, /- research \(current\)/);
  } finally {
    await done(w);
  }
});

test("a narrower tap applies at once with one audit line; a BROADER tap by the user applies at once and is audited (their own authority)", async () => {
  const w = await world();
  try {
    w.f.write("user", draft({ id: "research", toolAllow: ["read_file"] }));
    await tap(w, "pe:s:research");
    await waitFor(() => answers(w).some((a) => /Now using the Research persona \(narrower\)/.test(a)), 5000, "narrower answer");
    assert.equal(w.f.resolver.current("7"), "research");
    let lines = readAuditTail(w.auditDir, 10);
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0]?.source, lines[0]?.kind, lines[0]?.decision, lines[0]?.note], ["telegram", "switch", "applied", "narrower"]);
    assert.deepEqual(lines[0]?.approver, { kind: "tg", userId: USER });
    await tap(w, "pe:s:default");
    await waitFor(() => w.f.resolver.current("7") === "default", 5000, "broader applied");
    assert.equal(w.rig.tg.of("sendMessage").filter((c) => (c.payload["reply_markup"] as { inline_keyboard?: unknown } | undefined) && /Approve/.test(JSON.stringify(c.payload))).length, 0, "no approval card for the user's own switch");
    lines = readAuditTail(w.auditDir, 10);
    assert.equal(lines.length, 2);
    assert.equal(lines[1]?.note, "broader");
    assert.equal(lines[1]?.decision, "applied");
    // /persona <id> selects directly; a persona that does not exist or is invalid says so
    await cmd(w, "/persona readonly");
    await waitFor(() => w.f.resolver.current("7") === "readonly", 5000, "direct switch");
    await cmd(w, "/persona ghost");
    await waitFor(() => w.rig.tg.sentTexts(USER).some((t) => /there is no persona called "ghost"/.test(t)), 5000, "unknown persona");
    await cmd(w, "/persona not a valid id!!");
    await waitFor(() => w.rig.tg.sentTexts(USER).some((t) => /Use \/persona to pick/.test(t)), 5000, "usage");
    assert.equal(w.f.resolver.current("7"), "readonly");
  } finally {
    await done(w);
  }
});

test("a stranger, a tap from another chat, a stale or malformed callback are ignored", async () => {
  const w = await world();
  try {
    w.f.write("user", draft({ id: "research" }));
    await tap(w, "pe:s:research", { from: 999 });
    await tap(w, "pe:s:research", { from: USER, chatId: 12345 });
    await tap(w, "pe:s:ghost");
    await tap(w, "pe:zz");
    await tap(w, "pe:s:../x");
    await cmd(w, "/persona research", 999);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(w.f.resolver.current("7"), "default");
    assert.ok(answers(w).some((a) => /no persona called/.test(a)), "a stale callback gets an answer");
    assert.equal(readAuditTail(w.auditDir, 10).length, 0);
    assert.ok(w.rig.log.lines.some((l) => l.event === "telegram.persona_callback_ignored"));
  } finally {
    await done(w);
  }
});

test("/persona delete removes a model-drafted persona (audited); a user-authored or built-in one is refused", async () => {
  const w = await world();
  try {
    const mine = w.f.write("model", draft({ id: "drafted" }));
    w.f.write("user", draft({ id: "research" }));
    await cmd(w, "/persona delete research");
    await waitFor(() => w.rig.tg.sentTexts(USER).some((t) => /written by you in the settings UI/.test(t)), 5000, "user-authored refused");
    await cmd(w, "/persona delete readonly");
    await cmd(w, "/persona delete default");
    await waitFor(() => w.rig.tg.sentTexts(USER).filter((t) => /is built in and cannot be deleted/.test(t)).length === 2, 5000, "built-ins refused");
    await cmd(w, "/persona delete ghost");
    await waitFor(() => w.rig.tg.sentTexts(USER).some((t) => /no model-drafted persona called ghost/.test(t)), 5000, "unknown");
    assert.equal(existsSync(mine), true);
    await w.f.resolver.apply("7", "drafted");
    await cmd(w, "/persona delete drafted");
    await waitFor(() => w.rig.tg.sentTexts(USER).some((t) => /Deleted the persona drafted/.test(t)), 5000, "deleted");
    assert.equal(existsSync(mine), false);
    const line = readAuditTail(w.auditDir, 10).at(-1)!;
    assert.deepEqual([line.kind, line.persona, line.target.file, line.decision, line.source], ["persona", "drafted", "prefs/personas/drafted.json", "applied", "telegram"]);
    assert.equal(w.f.resolver.current("7"), "default", "the chat of a deleted persona goes back to the default");
  } finally {
    await done(w);
  }
});

test("a model-initiated switch: narrower or equal applies with no card; broader or incomparable produces exactly one card listing what is added, and applies only after Approve (not on Reject or timeout)", async () => {
  const f = personaFixture();
  f.write("user", draft({ id: "research", toolAllow: ["read_file"] }));
  f.write("user", draft({ id: "writer", toolAllow: ["read_file", "write_file"] }));
  const dir = f.dir;
  const cards: ProposalCard[] = [];
  const transport: ProposalTransport = { present: async (c) => (cards.push(c), { messageId: 1 }), update: async () => undefined, onDecision: () => undefined };
  const clock = { t: Date.now() };
  const audit = createSettingsAudit({ dir: join(dir, "audit"), writer: "agent", now: () => new Date(clock.t) });
  const engine = new ProposalEngine({ store: memoryProposalStore(), audit, prefs: f.prefs, prefsFile: f.prefsFile, rows: DEFAULT_ROWS, allowedUserIds: [USER], limits: () => DEFAULT_LIMITS, transport, now: () => clock.t, currentPersona: (c) => f.resolver.current(c) });
  engine.registerSwitchKind(f.resolver);
  const tools = createSettingsTools({ engine, prefs: f.prefs, runtime: f.resolver, securityView: () => ({}), chats: { chatForConversation: (id) => (id === "7" ? USER : undefined) }, audit });
  const call = async (args: unknown): Promise<string> => {
    const t = tools.find((x) => x.name === "switch_persona") as unknown as ToolRegistration & { execute(a: unknown, api: unknown, c: unknown): Promise<{ output: { text: string }[] }> };
    return (await t.execute(args, { conversationId: "7", callId: "c" }, BACKGROUND_CONTEXT)).output.map((o) => o.text).join("");
  };
  assert.match(await call({ id: "research" }), /Switched to the research persona \(narrower\)/);
  assert.equal(cards.length, 0);
  assert.equal(f.resolver.current("7"), "research");
  // readonly has more read tools than research but cannot write notes: incomparable, so a card (then cancelled by moving on)
  assert.equal((JSON.parse(await call({ id: "readonly" })) as { status: string }).status, "pending");
  assert.equal(cards.length, 1);
  await engine.cancel(cards[0]!.proposalId, USER, USER);
  cards.length = 0;
  clock.t += 700_000;
  await f.resolver.apply("7", "readonly");
  const back = JSON.parse(await call({ id: "default", reason: "back" })) as { status: string };
  assert.equal(back.status, "pending", "broader: a card");
  assert.equal(cards.length, 1);
  assert.match(cards[0]!.lines.join("\n"), /\+ tool: shell/);
  assert.equal(f.resolver.current("7"), "readonly", "not applied before Approve");
  assert.equal((await engine.decide({ proposalId: cards[0]!.proposalId, decision: "reject", userId: USER, chatId: USER })).result, "rejected");
  assert.equal(f.resolver.current("7"), "readonly");
  clock.t += 700_000;
  const again = JSON.parse(await call({ id: "writer" })) as { status: string };
  assert.equal(again.status, "pending", "incomparable with readonly (removes nothing, adds write_file)");
  assert.equal(cards.length, 2);
  clock.t += 700_000;
  assert.equal((await engine.decide({ proposalId: cards[1]!.proposalId, decision: "approve", userId: USER, chatId: USER })).result, "expired");
  assert.equal(f.resolver.current("7"), "readonly", "a timeout applies nothing");
  clock.t += 700_000;
  const third = JSON.parse(await call({ id: "writer" })) as { status: string };
  assert.equal(third.status, "pending");
  const ok = await engine.decide({ proposalId: cards[2]!.proposalId, decision: "approve", userId: USER, chatId: USER });
  assert.equal(ok.result, "approved");
  assert.equal(f.resolver.current("7"), "writer");
  assert.equal(readAuditTail(join(dir, "audit"), 50).filter((l) => l.kind === "switch" && l.decision === "approved").length, 1);
  rmSync(dir, { recursive: true, force: true });
});
