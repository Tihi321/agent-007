/**
 * S17.8 integration (offline): a MIGRATED fixture install (the real `migrate-settings --apply`), the real startup sequence, the
 * real proposal engine, store and audit, a scripted model and a fake card transport. Live parts (U48 on the real folders) are
 * a user step.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runMigration } from "../../scripts/migrate-settings.js";
import { lastRevisions, readAuditTail } from "../../src/settings/audit.js";
import { verifyAuditText } from "../../src/settings/chain.js";
import type { ProposalCard, ProposalTransport } from "../../src/settings/contracts.js";
import { SETTINGS_TOOL_NAMES } from "../../src/settings/tools.js";
import { E2e, viaToolSearch, waitFor } from "./rig.js";

class FakeCards implements ProposalTransport {
  cards: ProposalCard[] = [];
  updates: string[] = [];
  cb: ((d: { proposalId: string; decision: "approve" | "reject" | "edit"; userId: number; chatId: number }) => void) | undefined;
  async present(card: ProposalCard): Promise<{ messageId: number }> {
    this.cards.push(card);
    return { messageId: 500 + this.cards.length };
  }
  async update(_id: string, text: string): Promise<void> {
    this.updates.push(text);
  }
  onDecision(cb: NonNullable<FakeCards["cb"]>): void {
    this.cb = cb;
  }
  tap(card: ProposalCard, decision: "approve" | "reject"): void {
    this.cb?.({ proposalId: card.proposalId, decision, userId: 4242, chatId: card.chatId });
  }
}

const model = viaToolSearch(
  ({ lastUser, afterTool, lastToolText }) => {
    if (afterTool) return { type: "text", text: `tool said: ${lastToolText}` };
    if (/be more concise/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "propose_setting", args: { path: "style.verbosity", value: "normal", reason: "the user asked for a different length" } }] };
    if (/turn shell on/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "propose_setting", args: { path: "shell.enabled", value: "true", reason: "the user asked" } }] };
    if (/read-only persona/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "switch_persona", args: { id: "readonly" } }] };
    return { type: "text", text: `echo: ${lastUser}` };
  },
  { extraDeferred: (n) => (SETTINGS_TOOL_NAMES as readonly string[]).includes(n) },
);

async function migratedRig(cards: FakeCards): Promise<E2e> {
  const rig = await E2e.open({ behavior: model, start: { phase3: { transport: cards } } });
  await rig.stop();
  const settings = join(rig.dirs.programData, "settings");
  mkdirSync(join(settings, "audit"), { recursive: true });
  const out: string[] = [];
  const code = await runMigration(
    { config: rig.dirs.configPath, agentUser: "agent007", apply: true, rollback: false },
    { out: (l) => void out.push(l), env: rig.dirs.env, checkAcl: () => [] },
  );
  assert.equal(code, 0, out.join("\n"));
  await rig.start();
  return rig;
}

const clean = (rig: E2e): void => rmSync(rig.dirs.root, { recursive: true, force: true });
const auditDir = (rig: E2e): string => join(rig.dirs.programData, "settings", "audit");

test("migrated install: the agent starts under schemaVersion 2 with the security snapshot; /status data shows the revision", async () => {
  const cards = new FakeCards();
  const rig = await migratedRig(cards);
  try {
    assert.equal(rig.agent.settings.mode, "migrated");
    assert.ok(rig.agent.settings.security);
    const lines = rig.agent.phase3.statusLines();
    assert.match(lines[0] ?? "", /^Settings: running rev [0-9a-f]{8}, file rev [0-9a-f]{8}$/);
    assert.ok(!/restart required/.test(lines[0] ?? ""));
    // the migration audited security.json, so the start finds no out-of-band edit (I29b)
    assert.equal(lastRevisions(auditDir(rig))["security.json"], rig.agent.settings.securityRevision);
    assert.equal(readAuditTail(auditDir(rig), 50).filter((l) => l.decision === "external_edit").length, 0);
  } finally {
    await rig.close();
    clean(rig);
  }
});

test("propose a style change: a card, Approve, applied, audited, and the next turn's prompt shows it", async () => {
  const cards = new FakeCards();
  const rig = await migratedRig(cards);
  try {
    await rig.say("be more concise", 11);
    await waitFor(() => cards.cards.length === 1, 20_000, "the settings card");
    const card = cards.cards[0] as ProposalCard;
    assert.match(card.lines.join("\n"), /Proposed: "normal"/);
    await rig.seen((t) => /tool said: .*"status":"pending"/.test(t), "the model told the user to look at the card");
    cards.tap(card, "approve");
    const prefsFile = join(rig.dirs.data, "prefs", "prefs.json");
    await waitFor(() => existsSync(prefsFile) && JSON.parse(readFileSync(prefsFile, "utf8")).style.verbosity === "normal", 10_000, "prefs.json updated");
    const lines = readAuditTail(auditDir(rig), 50).filter((l) => l.proposalId === card.proposalId);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.decision, "approved");
    assert.equal(lines[0]?.writer, "agent");
    assert.deepEqual(lines[0]?.approver, { kind: "tg", userId: 4242 });
    assert.match(cards.updates.at(-1) ?? "", /^Approved\./);
    await rig.say("what now", 12);
    await rig.seen((t) => t === "echo: what now", "the next answer");
    assert.match(rig.lastSystemPrompt(), /Length: normal answers/);
    const text = readFileSync(join(auditDir(rig), readAuditFile(rig)), "utf8");
    assert.equal(verifyAuditText(text).ok, true, "the live chain verifies");
  } finally {
    await rig.close();
    clean(rig);
  }
});

function readAuditFile(rig: E2e): string {
  const lines = readAuditTail(auditDir(rig), 1);
  assert.ok(lines.length > 0);
  return `settings-${new Date().toISOString().slice(0, 7).replace("-", "")}.jsonl`;
}

test("propose a security path: refused, no card, one invalid audit line, shell stays as configured", async () => {
  const cards = new FakeCards();
  const rig = await migratedRig(cards);
  try {
    await rig.say("turn shell on", 21);
    await rig.seen((t) => /tool said: .*not_writable:/.test(t), "the typed refusal");
    assert.equal(cards.cards.length, 0);
    const invalid = readAuditTail(auditDir(rig), 50).filter((l) => l.decision === "invalid" && l.target.path === "shell.enabled");
    assert.equal(invalid.length, 1);
    assert.equal(rig.agent.config.shell.enabled, true);
    assert.equal(JSON.parse(readFileSync(join(rig.dirs.data, "prefs", "prefs.json"), "utf8")).style.verbosity, "short", "prefs are unchanged");
  } finally {
    await rig.close();
    clean(rig);
  }
});

test("switch_persona to a narrower persona applies at once with no card (the S19 resolver replaced the S17 stub)", async () => {
  const cards = new FakeCards();
  const rig = await migratedRig(cards);
  try {
    await rig.say("switch to the read-only persona", 31);
    await rig.seen((t) => /tool said: .*Switched to the readonly persona \(narrower\)/.test(t), "the switch");
    assert.equal(cards.cards.length, 0);
    assert.ok(readAuditTail(auditDir(rig), 50).some((l) => l.kind === "switch" && l.decision === "auto" && l.persona === "readonly"), "one audit line for the switch");
  } finally {
    await rig.close();
    clean(rig);
  }
});
