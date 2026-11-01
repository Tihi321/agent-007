import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, Harness, createRegistry, createRunnerModels, openNodeSqliteStorage } from "../../src/pi/adapter.js";
import { DEFAULT_ROWS } from "../../src/settings/allowlist.js";
import { createSettingsAudit, readAuditTail } from "../../src/settings/audit.js";
import { SettingsError } from "../../src/settings/contracts.js";
import type { ProposalCard, ProposalTransport } from "../../src/settings/contracts.js";
import { PrefsStore, defaultPrefs } from "../../src/settings/prefs.js";
import { ProposalEngine, DEFAULT_LIMITS, harnessProposalStore, memoryProposalStore } from "../../src/settings/proposals.js";
import type { ProposalLimits, ProposalStore } from "../../src/settings/proposals.js";
import { readLines, tempDir, writeJson } from "./helpers.js";

const USER = 4242;
const CHAT = 4242;

class FakeTransport implements ProposalTransport {
  cards: ProposalCard[] = [];
  updates: { id: string; text: string }[] = [];
  fail = false;
  cb: ((d: { proposalId: string; decision: "approve" | "reject" | "edit"; userId: number; chatId: number }) => void) | undefined;
  async present(card: ProposalCard): Promise<{ messageId: number }> {
    if (this.fail) throw new Error("telegram down");
    this.cards.push(card);
    return { messageId: 100 + this.cards.length };
  }
  async update(id: string, text: string): Promise<void> {
    this.updates.push({ id, text });
  }
  onDecision(cb: NonNullable<FakeTransport["cb"]>): void {
    this.cb = cb;
  }
}

interface Rig {
  dir: string;
  prefsFile: string;
  auditDir: string;
  prefs: PrefsStore;
  transport: FakeTransport;
  engine: ProposalEngine;
  limits: ProposalLimits;
  clock: { t: number };
  store: ProposalStore;
  frozen: { v: boolean };
  audit: ReturnType<typeof createSettingsAudit>;
}

function rig(over: { limits?: Partial<ProposalLimits>; store?: ProposalStore; dir?: string; audit?: ReturnType<typeof createSettingsAudit> } = {}): Rig {
  const dir = over.dir ?? tempDir("a7-prop-");
  const prefsFile = join(dir, "prefs", "prefs.json");
  const auditDir = join(dir, "audit");
  const limits: ProposalLimits = { ...DEFAULT_LIMITS, ...over.limits };
  const clock = { t: Date.parse("2026-10-30T10:00:00Z") };
  const prefs = new PrefsStore(prefsFile);
  const transport = new FakeTransport();
  const audit = over.audit ?? createSettingsAudit({ dir: auditDir, writer: "agent", now: () => new Date(clock.t) });
  let n = 0;
  const frozen = { v: false };
  const store = over.store ?? memoryProposalStore();
  const engine = new ProposalEngine({
    store,
    audit,
    prefs,
    prefsFile,
    rows: DEFAULT_ROWS,
    allowedUserIds: [USER],
    limits: () => limits,
    transport,
    now: () => clock.t,
    newId: () => `p${String(++n).padStart(7, "0")}`,
    currentPersona: () => "default",
    frozen: () => frozen.v,
    personaIds: () => ["default", "readonly"],
  });
  return { dir, prefsFile, auditDir, prefs, transport, engine, limits, clock, store, frozen, audit };
}

const ctx = { conversationId: "7", chatId: CHAT };
const prop = (r: Rig, path: string, value: string, reason = "the user asked") => r.engine.propose("setting", { path, value, reason }, ctx);
const code = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (e) {
    return e instanceof SettingsError ? e.code : `other:${String(e)}`;
  }
  return undefined;
};
const tap = (r: Rig, id: string, decision: "approve" | "reject" | "edit" = "approve", over: Partial<{ userId: number; chatId: number }> = {}) => r.engine.decide({ proposalId: id, decision, userId: USER, chatId: CHAT, messageId: 101, ...over });
const auditLines = (r: Rig) => readAuditTail(r.auditDir, 500);

test("a security path is not_writable BEFORE any card and writes one invalid audit line", async () => {
  const r = rig();
  for (const path of ["shell.enabled", "folders.allow", "telegram.allowedUserIds", "model.runner", "proposals.autoApplyCosmetic", "defaultPersona", "presets"]) {
    assert.equal(await code(prop(r, path, "true")), "not_writable", path);
  }
  assert.equal(r.transport.cards.length, 0, "no card was presented");
  const lines = auditLines(r);
  assert.equal(lines.length, 7);
  assert.ok(lines.every((l) => l.decision === "invalid" && l.source === "propose"));
  assert.equal(readLines(r.audit.fileFor()).length, 7);
  rmSync(r.dir, { recursive: true, force: true });
});

test("an approved change is applied, audited once, and the card is edited", async () => {
  const r = rig();
  const res = await prop(r, "style.verbosity", "detailed");
  assert.equal(res.status, "pending");
  const id = (res as { proposalId: string }).proposalId;
  assert.equal(r.transport.cards.length, 1);
  assert.match(r.transport.cards[0]?.lines.join("\n") ?? "", /Verbosity \(style\.verbosity, cosmetic\)[\s\S]*Now: "short"[\s\S]*Proposed: "detailed"/);
  assert.equal(r.transport.cards[0]?.reason, "the user asked");
  const out = await tap(r, id);
  assert.equal(out.result, "approved");
  assert.equal(JSON.parse(readFileSync(r.prefsFile, "utf8")).style.verbosity, "detailed");
  assert.equal(r.prefs.get().prefs.style.verbosity, "detailed", "the store sees it at once");
  const mine = auditLines(r).filter((l) => l.proposalId === id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.decision, "approved");
  assert.deepEqual(mine[0]?.approver, { kind: "tg", userId: USER });
  assert.equal(mine[0]?.messageId, 101);
  assert.equal(mine[0]?.persona, "default");
  assert.deepEqual(mine[0]?.diff, [{ path: "style.verbosity", op: "replace", before: "short", after: "detailed" }]);
  assert.notEqual(mine[0]?.baseRevision, mine[0]?.afterRevision);
  assert.match(r.transport.updates.at(-1)?.text ?? "", /^Approved\./);
  // a second tap on the same card does nothing
  assert.deepEqual(await tap(r, id), { result: "ignored", reason: "not_pending" });
  rmSync(r.dir, { recursive: true, force: true });
});

test("a rejected proposal leaves the file byte-identical; a timeout expires it; reap expires old entries", async () => {
  const r = rig();
  writeJson(r.prefsFile, { style: { tone: "concise" } });
  const before = readFileSync(r.prefsFile, "utf8");
  const a = (await prop(r, "style.verbosity", "normal")) as { proposalId: string };
  assert.equal((await tap(r, a.proposalId, "reject")).result, "rejected");
  assert.equal(readFileSync(r.prefsFile, "utf8"), before);
  assert.match(r.transport.updates.at(-1)?.text ?? "", /^Rejected/);
  const b = (await prop(r, "style.verbosity", "normal")) as { proposalId: string };
  r.clock.t += (r.limits.timeoutSec + 1) * 1000;
  assert.equal((await tap(r, b.proposalId)).result, "expired");
  assert.equal(readFileSync(r.prefsFile, "utf8"), before);
  assert.match(r.transport.updates.at(-1)?.text ?? "", /^Expired/);
  const c = (await prop(r, "style.verbosity", "detailed")) as { proposalId: string };
  r.clock.t += (r.limits.timeoutSec + 1) * 1000;
  assert.equal(await r.engine.reap(), 1);
  assert.deepEqual(await tap(r, c.proposalId), { result: "ignored", reason: "not_pending" });
  assert.deepEqual(auditLines(r).map((l) => l.decision).filter((d) => d !== "invalid"), ["rejected", "expired", "expired"]);
  rmSync(r.dir, { recursive: true, force: true });
});

test("a stale baseRevision applies nothing and the card says so", async () => {
  const r = rig();
  const a = (await prop(r, "style.verbosity", "detailed")) as { proposalId: string };
  writeJson(r.prefsFile, { style: { tone: "friendly" } }); // someone else changed the file
  r.prefs.invalidate();
  const out = await tap(r, a.proposalId);
  assert.equal(out.result, "stale");
  assert.equal(JSON.parse(readFileSync(r.prefsFile, "utf8")).style.verbosity, undefined);
  assert.match(r.transport.updates.at(-1)?.text ?? "", /Stale/);
  assert.equal(auditLines(r).filter((l) => l.decision === "approved").length, 0);
  rmSync(r.dir, { recursive: true, force: true });
});

test("limits: a second pending proposal in the same chat is refused; the sixth in an hour is rate_limited", async () => {
  const r = rig();
  await prop(r, "style.notes", "first");
  assert.equal(await code(prop(r, "style.notes", "second")), "too_many_pending");
  assert.equal(await code(r.engine.propose("setting", { path: "style.notes", value: "other chat", reason: "x" }, { conversationId: "8", chatId: 9999 })), undefined, "another chat has its own slot");
  const r2 = rig({ limits: { maxPending: 50, perHour: 5 } });
  for (let i = 0; i < 5; i++) assert.equal((await prop(r2, "style.notes", `note ${i}`)).status, "pending");
  assert.equal(await code(prop(r2, "style.notes", "note 5")), "rate_limited");
  r2.clock.t += 3601 * 1000;
  assert.equal((await prop(r2, "style.notes", "after an hour")).status, "pending");
  rmSync(r.dir, { recursive: true, force: true });
  rmSync(r2.dir, { recursive: true, force: true });
});

test("25 invalid proposals in an hour produce 20 audit lines plus one counter line", async () => {
  const r = rig({ limits: { perHour: 100, maxPending: 100 } });
  for (let i = 0; i < 25; i++) assert.equal(await code(prop(r, "shell.enabled", "true")), "not_writable");
  const lines = auditLines(r);
  assert.equal(lines.length, 21);
  assert.equal(lines.filter((l) => /counted, not logged/.test(l.note ?? "")).length, 1);
  r.clock.t += 3600 * 1000 + 1;
  assert.equal(await code(prop(r, "shell.enabled", "true")), "not_writable");
  const after = auditLines(r);
  assert.ok(after.length >= 23, "a summary of the suppressed ones plus the new line");
  rmSync(r.dir, { recursive: true, force: true });
});

test("a foreign user and a tap from another chat are ignored; the proposal stays pending", async () => {
  const r = rig();
  const a = (await prop(r, "style.notes", "hello")) as { proposalId: string };
  assert.deepEqual(await tap(r, a.proposalId, "approve", { userId: 1 }), { result: "ignored", reason: "foreign_user" });
  assert.deepEqual(await tap(r, a.proposalId, "approve", { chatId: 1 }), { result: "ignored", reason: "foreign_chat" });
  assert.deepEqual(await r.engine.decide({ proposalId: "nope", decision: "approve", userId: USER, chatId: CHAT }), { result: "ignored", reason: "unknown_proposal" });
  assert.equal((await r.engine.pending(CHAT)).length, 1);
  assert.equal((await tap(r, a.proposalId)).result, "approved");
  rmSync(r.dir, { recursive: true, force: true });
});

test("autoApplyCosmetic: true auto-applies style.tone with one auto line, while style.notes still gets a card", async () => {
  const r = rig({ limits: { autoApplyCosmetic: true } });
  const res = await prop(r, "style.tone", "friendly");
  assert.equal(res.status, "applied");
  assert.equal(r.transport.cards.length, 0);
  assert.equal(r.prefs.get().prefs.style.tone, "friendly");
  const lines = auditLines(r);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.decision, "auto");
  assert.equal(lines[0]?.source, "auto");
  assert.equal((await prop(r, "style.notes", "be kind")).status, "pending");
  assert.equal(r.transport.cards.length, 1);
  rmSync(r.dir, { recursive: true, force: true });
});

test("with autoApplyCosmetic off (the default) even a cosmetic change gets a card", async () => {
  const r = rig();
  assert.equal((await prop(r, "style.tone", "friendly")).status, "pending");
  assert.equal(r.prefs.get().prefs.style.tone, "neutral");
  rmSync(r.dir, { recursive: true, force: true });
});

test("an audit append failure at approval leaves the file unchanged and the card says it could not apply", async () => {
  const dir = tempDir("a7-prop-");
  let fail = false;
  const audit = createSettingsAudit({
    dir: join(dir, "audit"),
    writer: "agent",
    appendLine: (p, l) => {
      if (fail) throw new Error("disk full");
      writeFileSync(p, l, { flag: "a" });
    },
  });
  const r = rig({ dir, audit });
  const a = (await prop(r, "style.verbosity", "detailed")) as { proposalId: string };
  fail = true;
  const out = await tap(r, a.proposalId);
  assert.equal(out.result, "failed");
  assert.equal(existsSync(r.prefsFile), false, "the file was not created or changed");
  assert.match(r.transport.updates.at(-1)?.text ?? "", /^Could not apply/);
  assert.deepEqual(readdirSync(join(dir, "prefs")).filter((n) => n.endsWith(".tmp")), [], "no temp file left");
  rmSync(dir, { recursive: true, force: true });
});

test("secret-shaped values, no-op values and bad values are refused before a card", async () => {
  const r = rig();
  const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  assert.equal(await code(prop(r, "style.notes", `use ${secret}`)), "secret_shaped");
  assert.equal(await code(prop(r, "style.tone", "neutral")), "invalid_value", "already has this value");
  assert.equal(await code(prop(r, "style.tone", "sarcastic")), "invalid_value");
  assert.equal(r.transport.cards.length, 0);
  assert.ok(!readFileSync(r.audit.fileFor(new Date(r.clock.t)), "utf8").includes(secret));
  rmSync(r.dir, { recursive: true, force: true });
});

test("the user's own /settings tap applies at once, audited source telegram; only telegram rows; no free text", async () => {
  const r = rig();
  const msg = await r.engine.applyDirect("style.tone", "concise", { userId: USER, chatId: CHAT });
  assert.match(msg, /Tone is now concise/);
  assert.equal(r.prefs.get().prefs.style.tone, "concise");
  assert.equal(auditLines(r).at(-1)?.source, "telegram");
  assert.equal(await code(r.engine.applyDirect("style.notes", "hi", { userId: USER, chatId: CHAT })), "not_writable", "style.notes is not a Telegram row");
  assert.equal(await code(r.engine.applyDirect("shell.enabled", "false", { userId: USER, chatId: CHAT })), "not_writable");
  assert.equal(await code(r.engine.applyDirect("style.tone", "sarcastic", { userId: USER, chatId: CHAT })), "invalid_value");
  assert.equal(await code(r.engine.applyDirect("style.tone", "friendly", { userId: 7, chatId: CHAT })), "not_allowed");
  assert.equal(await code(r.engine.applyDirect("defaultPersona", "ghost", { userId: USER, chatId: CHAT })), "unknown_persona");
  assert.match(await r.engine.applyDirect("defaultPersona", "readonly", { userId: USER, chatId: CHAT }), /Default persona is now readonly/);
  assert.equal(await r.engine.applyDirect("style.tone", "concise", { userId: USER, chatId: CHAT }), "Already set; nothing to change.");
  rmSync(r.dir, { recursive: true, force: true });
});

test("a frozen engine (settings ACL violation) accepts and applies nothing; no transport or a failing card is an error", async () => {
  const r = rig();
  const a = (await prop(r, "style.notes", "one")) as { proposalId: string };
  r.frozen.v = true;
  assert.equal(await code(prop(r, "style.notes", "two")), "not_allowed");
  assert.equal((await tap(r, a.proposalId)).result, "failed");
  assert.equal(r.prefs.get().prefs.style.notes, "");
  r.frozen.v = false;
  r.transport.fail = true;
  r.clock.t += 700_000;
  assert.equal(await code(prop(r, "style.notes", "three")), "not_allowed");
  rmSync(r.dir, { recursive: true, force: true });
});

test("/proposals cancel withdraws a pending proposal (the allowlisted user, in the chat only)", async () => {
  const r = rig();
  const a = (await prop(r, "style.notes", "cancel me")) as { proposalId: string };
  assert.equal(await r.engine.cancel(a.proposalId, 1, CHAT), false);
  assert.equal(await r.engine.cancel(a.proposalId, USER, 1), false);
  assert.equal(await r.engine.cancel(a.proposalId, USER, CHAT), true);
  assert.equal((await r.engine.pending()).length, 0);
  assert.match(r.transport.updates.at(-1)?.text ?? "", /Cancelled/);
  assert.deepEqual(await tap(r, a.proposalId), { result: "ignored", reason: "not_pending" });
  rmSync(r.dir, { recursive: true, force: true });
});

test("restart: a pending proposal is durable and the same callback id still works after the Harness is reopened", async () => {
  const dir = tempDir("a7-prop-");
  const sqlite = join(dir, "agent.sqlite");
  const open = async (): Promise<Harness> => {
    const { models } = createRunnerModels({ id: "lmstudio", baseUrl: "http://127.0.0.1:9/v1", modelId: "m", apiKey: "k", contextWindow: 8192, maxTokens: 256 });
    return Harness.open(await openNodeSqliteStorage(sqlite), { models, registry: createRegistry(), settings: {} }, BACKGROUND_CONTEXT);
  };
  let h = await open();
  const r1 = rig({ dir, store: harnessProposalStore(() => h) });
  const res = (await prop(r1, "style.verbosity", "detailed")) as { proposalId: string };
  assert.equal(r1.transport.cards.length, 1);
  await h.close(BACKGROUND_CONTEXT);
  h = await open();
  const r2 = rig({ dir, store: harnessProposalStore(() => h) });
  assert.equal((await r2.engine.pending(CHAT)).length, 1, "the entry survived");
  const out = await r2.engine.decide({ proposalId: res.proposalId, decision: "approve", userId: USER, chatId: CHAT });
  assert.equal(out.result, "approved");
  assert.equal(JSON.parse(readFileSync(join(dir, "prefs", "prefs.json"), "utf8")).style.verbosity, "detailed");
  await h.close(BACKGROUND_CONTEXT);
  mkdirSync(dir, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  void defaultPrefs;
});
