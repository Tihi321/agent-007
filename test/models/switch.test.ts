/** S22.2: switching (I38, U51, U43) over a real Harness and the real proposal engine. Nothing is contacted: no model call is made. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "../../src/pi/adapter.js";
import type { Conversation } from "../../src/pi/adapter.js";
import { SettingsError } from "../../src/settings/contracts.js";
import { ALL_TERMS, CHAT, CODEX, CLAUDE, LM, NO_TERMS, STRATA, USER, switchRig } from "./helpers.js";
import type { SwitchRig } from "./helpers.js";

async function using<T>(r: SwitchRig, fn: (r: SwitchRig) => Promise<T>): Promise<T> {
  try {
    return await fn(r);
  } finally {
    await r.close();
    rmSync(r.dir, { recursive: true, force: true });
  }
}

const model = async (r: SwitchRig) => (await r.conv.agent(BACKGROUND_CONTEXT)).model as { provider: string; modelId: string };
const req = (r: SwitchRig, presetId: string) => ({ presetId, userId: USER, chatId: CHAT, conversationId: r.convId, conversation: r.spy });
const prefOf = (r: SwitchRig): unknown => (existsSync(r.prefsFile) ? (JSON.parse(readFileSync(r.prefsFile, "utf8")) as { bots?: { main?: { activePreset?: string } } }).bots?.main?.activePreset : undefined);

test("local -> local applies at once, is audited, and the conversation follows with configure({model}) only (guard kept, transcript kept)", async () => {
  await using(await switchRig(), async (r) => {
    assert.deepEqual(await model(r), { provider: "lmstudio", modelId: "lm-model" });
    const out = await r.switcher.switchByUser(req(r, "strata"));
    assert.equal(out.status, "applied");
    assert.equal(r.transport.cards.length, 0, "no card");
    assert.equal(prefOf(r), "strata");
    const lines = r.audits().filter((l) => l.target?.path === "bots.main.activePreset");
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.source, "telegram");
    assert.deepEqual(lines[0]?.approver, { kind: "tg", userId: USER });
    assert.deepEqual(lines[0]?.diff, [{ path: "bots", op: "add", after: { main: { activePreset: "strata" } } }]);
    // the follow-up configured the SAME conversation, with the model only
    assert.equal(r.configureCalls.length, 1);
    assert.deepEqual(Object.keys(r.configureCalls[0] as object), ["model"], "extensions is never passed (footgun 30)");
    assert.deepEqual(await model(r), { provider: "strata", modelId: "strata-model" });
    const agent = await r.conv.agent(BACKGROUND_CONTEXT);
    const guard = agent.extensions.find((e) => e.name === "a7");
    assert.ok(guard && (guard.hooks ?? []).length >= 1, "the guard hook is still present after configure()");
    assert.equal(String(r.conv.id), r.convId, "the same conversation (the transcript is kept)");
    // the cached state: the next message does not configure again
    await r.switcher.ensureApplied(r.convId, r.spy);
    assert.equal(r.configureCalls.length, 1);
  });
});

test("cloud -> local applies at once and is audited", async () => {
  await using(await switchRig({ stored: "codex", startOn: CODEX }), async (r) => {
    assert.equal(r.switcher.effective().id, "codex");
    const out = await r.switcher.switchByUser(req(r, "lmstudio"));
    assert.equal(out.status, "applied");
    assert.equal(r.transport.cards.length, 0);
    assert.equal(prefOf(r), "lmstudio");
    assert.deepEqual(await model(r), { provider: "lmstudio", modelId: "lm-model" });
    const lines = r.audits().filter((l) => l.target?.path === "bots.main.activePreset");
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0]?.diff, [{ path: "bots.main.activePreset", op: "replace", before: "codex", after: "lmstudio" }]);
  });
});

test("same vendor (codex -> codex mini) applies at once", async () => {
  await using(await switchRig({ stored: "codex", startOn: CODEX }), async (r) => {
    assert.equal((await r.switcher.switchByUser(req(r, "codex2"))).status, "applied");
    assert.equal(r.transport.cards.length, 0);
    assert.deepEqual(await model(r), { provider: "acp-codex", modelId: "codex/mini" });
  });
});

for (const c of [
  { name: "local -> cloud", stored: undefined, start: undefined, to: "codex" },
  { name: "cloud -> cloud (another vendor)", stored: "codex", start: CODEX, to: "claude" },
]) {
  test(`${c.name} gives exactly one card and applies only after Approve`, async () => {
    await using(await switchRig({ ...(c.stored ? { stored: c.stored } : {}), ...(c.start ? { startOn: c.start } : {}) }), async (r) => {
      const before = await model(r);
      const out = await r.switcher.switchByUser(req(r, c.to));
      assert.equal(out.status, "card");
      assert.equal(r.transport.cards.length, 1, "exactly one card");
      assert.match(out.text, /only after you tap Approve/);
      // nothing changed yet: the pref, the conversation and the effective preset
      assert.equal(prefOf(r), c.stored);
      await r.switcher.ensureApplied(r.convId, r.spy);
      assert.deepEqual(await model(r), before);
      assert.equal(r.configureCalls.length, 0);
      // Approve
      const cardId = r.transport.cards[0]?.proposalId as string;
      assert.ok(cardId);
      assert.equal((await r.tap(cardId)).result, "approved");
      assert.equal(prefOf(r), c.to);
      assert.equal(r.transport.cards.length, 1, "still one card");
      assert.equal(r.switcher.effective().id, c.to);
      // the conversation follows on its next message
      await r.switcher.ensureApplied(r.convId, r.spy);
      assert.equal((await model(r)).modelId, c.to === "codex" ? "codex/gpt" : "claude/sonnet");
      const approved = r.audits().filter((l) => l.decision === "approved");
      assert.equal(approved.length, 1);
      assert.deepEqual(approved[0]?.approver, { kind: "tg", userId: USER });
    });
  });
}

test("a rejected card, a foreign user's tap and a stale tap change nothing", async () => {
  await using(await switchRig(), async (r) => {
    await r.switcher.switchByUser(req(r, "codex"));
    const cardId = r.transport.cards[0]?.proposalId as string;
    assert.deepEqual(await r.tap(cardId, { userId: 999 }), { result: "ignored", reason: "foreign_user" });
    assert.deepEqual(await r.tap(cardId, { chatId: 999 }), { result: "ignored", reason: "foreign_chat" });
    assert.deepEqual(await r.tap("p0000099"), { result: "ignored", reason: "unknown_proposal" });
    assert.equal(prefOf(r), undefined);
    const rej = await r.engine.decide({ proposalId: cardId, decision: "reject", userId: USER, chatId: CHAT, messageId: 101 });
    assert.equal(rej.result, "rejected");
    assert.deepEqual(await r.tap(cardId), { result: "ignored", reason: "not_pending" }, "a stale tap");
    assert.equal(prefOf(r), undefined);
    await r.switcher.ensureApplied(r.convId, r.spy);
    assert.equal(r.configureCalls.length, 0);
  });
});

test("a preset outside route.allowed, an unknown one and a claude preset without terms are rejected before any card", async () => {
  await using(await switchRig({ terms: NO_TERMS }), async (r) => {
    for (const id of ["anti", "ghost", "claude"]) {
      const out = await r.switcher.switchByUser(req(r, id));
      assert.equal(out.status, "rejected", id);
    }
    assert.equal(r.transport.cards.length, 0);
    assert.equal(prefOf(r), undefined);
    assert.equal(r.audits().length, 0);
  });
});

test("presets, route, fallback, bots and termsAccepted proposals are rejected before any Telegram message; an outside-allowed activePreset too", async () => {
  await using(await switchRig({ terms: NO_TERMS }), async (r) => {
    const paths = ["presets", "bots.main.route.primary", "bots.main.route.fallback", "bots.main.route", "bots.main.edges", "bots.main.tools", "bots.main", "bots", "termsAccepted", "termsAccepted.claude", "bots.main.termsAccepted", "bots.ghost.activePreset", "botBus.hopLimit", "gate.maxQueueDepth", "botRoom.mode"];
    for (const path of paths) {
      await assert.rejects(() => r.engine.propose("setting", { path, value: "x", reason: "test" }, { conversationId: r.convId, chatId: CHAT }), (e: unknown) => e instanceof SettingsError, path);
    }
    // the preset id itself: outside allowed, unknown, and one that needs the acknowledgment
    for (const value of ["anti", "ghost"]) {
      await assert.rejects(() => r.engine.propose("setting", { path: "bots.main.activePreset", value, reason: "test" }, { conversationId: r.convId, chatId: CHAT }), (e: unknown) => e instanceof SettingsError, value);
    }
    assert.equal(r.transport.cards.length, 0, "no card was presented for any of them");
    assert.equal(prefOf(r), undefined);
  });
});

test("propose_setting on bots.<id>.activePreset: cloud -> local applies at once, local -> cloud is one card", async () => {
  await using(await switchRig({ stored: "codex", startOn: CODEX }), async (r) => {
    const a = await r.engine.propose("setting", { path: "bots.main.activePreset", value: "lmstudio", reason: "go local" }, { conversationId: r.convId, chatId: CHAT });
    assert.equal(a.status, "applied");
    assert.equal(r.transport.cards.length, 0);
    assert.equal(prefOf(r), "lmstudio");
    const b = await r.engine.propose("setting", { path: "bots.main.activePreset", value: "codex", reason: "go cloud" }, { conversationId: r.convId, chatId: CHAT });
    assert.equal(b.status, "pending");
    assert.equal(r.transport.cards.length, 1);
    assert.equal(prefOf(r), "lmstudio");
    // the conversation follows the pref only after the write
    await r.switcher.ensureApplied(r.convId, r.spy);
    assert.deepEqual(await model(r), { provider: "lmstudio", modelId: "lm-model" });
  });
});

test("a stored activePreset outside allowed (a hand-edited prefs.json) is ignored with one notice; the bot stays on its primary", async () => {
  await using(await switchRig({ stored: "anti" }), async (r) => {
    assert.equal(r.switcher.effective().id, "lmstudio");
    const first = await r.switcher.ensureApplied(r.convId, r.spy);
    assert.match(first.notice ?? "", /cannot be used/);
    assert.equal((await r.switcher.ensureApplied("another-conversation", r.spy)).notice, undefined, "said once");
    assert.equal(r.configureCalls.length, 0);
  });
});

test("a widening switch with no way to ask is refused; a preset that is not answering is refused and nothing changes", async () => {
  await using(await switchRig({ noPropose: true }), async (r) => {
    const out = await r.switcher.switchByUser(req(r, "codex"));
    assert.equal(out.status, "rejected");
    assert.match(out.text, /no way to ask/);
    assert.equal(prefOf(r), undefined);
  });
  await using(await switchRig({ up: async (p) => p.id !== "strata" }), async (r) => {
    const out = await r.switcher.switchByUser(req(r, "strata"));
    assert.equal(out.status, "rejected");
    assert.match(out.text, /not answering/);
    assert.equal(prefOf(r), undefined);
    assert.equal(r.configureCalls.length, 0);
  });
});

test("choosing the active preset again is a no-op", async () => {
  await using(await switchRig(), async (r) => {
    assert.equal((await r.switcher.switchByUser(req(r, "lmstudio"))).status, "same");
    assert.equal(r.audits().length, 0);
  });
});

test("a fallback override is in memory only: the conversation follows it, the pref is untouched, going back clears it, liveModelRef follows", async () => {
  await using(await switchRig({ stored: "codex", startOn: CODEX }), async (r) => {
    const live = r.switcher.liveModelRef();
    assert.deepEqual({ ...live }, { provider: "acp-codex", modelId: "codex/gpt" });
    r.switcher.setFallback(LM, "codex needs a login");
    assert.equal(r.switcher.effective().id, "lmstudio");
    assert.equal(live.provider, "lmstudio", "the live ref is a getter, a persona change cannot undo the fallback");
    await r.switcher.ensureApplied(r.convId, r.spy);
    assert.deepEqual(await model(r), { provider: "lmstudio", modelId: "lm-model" });
    assert.equal(prefOf(r), "codex", "no pref write for a fallback");
    assert.equal(r.audits().length, 0);
    // the user taps the configured preset again: the override ends, no widening, no card, no pref write
    const out = await r.switcher.switchByUser(req(r, "codex"));
    assert.equal(out.status, "applied");
    assert.equal(r.transport.cards.length, 0);
    assert.equal(r.switcher.fallbackActive, undefined);
    assert.deepEqual(await model(r), { provider: "acp-codex", modelId: "codex/gpt" });
    assert.equal(r.audits().length, 0);
  });
});

test("if configure() does not hold (model not changed, or the guard hook lost) the switch is reverted and refused", async () => {
  await using(await switchRig(), async (r) => {
    r.switcher.setFallback(STRATA, "test");
    const stuck = { id: r.conv.id, agent: (c: typeof BACKGROUND_CONTEXT) => r.conv.agent(c), configure: async () => undefined } as unknown as Conversation;
    await assert.rejects(() => r.switcher.ensureApplied(r.convId, stuck), (e: unknown) => e instanceof SettingsError && e.code === "apply_failed");
    assert.equal(r.log.events("models.apply_readback_failed").length, 1);
    assert.deepEqual(await model(r), { provider: "lmstudio", modelId: "lm-model" }, "still on the old model");
  });
});

test("a preset the bot's Models does not hold is never configured", async () => {
  await using(await switchRig(), async (r) => {
    r.switcher.setFallback({ ...CLAUDE, id: "claude", modelId: "claude/missing" }, "test");
    assert.deepEqual(await r.switcher.ensureApplied(r.convId, r.spy), {});
    assert.equal(r.configureCalls.length, 0);
    assert.equal(r.log.events("models.preset_not_served").length, 1);
    assert.ok(ALL_TERMS && STRATA);
  });
});
