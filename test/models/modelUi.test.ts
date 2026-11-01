/** S22.2: the /model picker as a bridge extension (md: callbacks) over the fake Telegram API. */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "../../src/pi/adapter.js";
import { FallbackEngine } from "../../src/models/fallback.js";
import { TelegramModelUi } from "../../src/telegram/modelUi.js";
import { callbackUpdate, createFakeTelegram, memoryLogger, textUpdate, USER_ID, waitFor } from "../telegram/helpers/fakeTelegram.js";
import { ALL_PRESETS, ALL_TERMS, CHAT, switchRig, botOf } from "./helpers.js";
import type { SwitchRig } from "./helpers.js";

interface Ui {
  r: SwitchRig;
  ui: TelegramModelUi;
  tg: ReturnType<typeof createFakeTelegram>;
  fb: FallbackEngine;
  ext: ReturnType<TelegramModelUi["extension"]>;
  done(): Promise<void>;
}

async function mk(o: Parameters<typeof switchRig>[0] = {}): Promise<Ui> {
  const r = await switchRig(o);
  const tg = createFakeTelegram();
  const bot = botOf({ route: o.route });
  const fb = new FallbackEngine({ bot, presets: ALL_PRESETS, terms: () => ALL_TERMS });
  const ui = new TelegramModelUi({ api: tg.bot.api, allowedUserIds: [USER_ID], logger: memoryLogger(), switcher: r.switcher, bot, presets: ALL_PRESETS, ensureConversation: async () => r.convId, conversation: async () => r.spy, fallback: fb });
  const ext = ui.extension();
  ext.registerCommands?.(tg.bot);
  tg.bot.on("callback_query:data", (ctx, next) => (ctx.callbackQuery.data.startsWith("md:") ? ext.callback?.(ctx) : next()));
  await tg.bot.init();
  return {
    r,
    ui,
    tg,
    fb,
    ext,
    done: async () => {
      await r.close();
      rmSync(r.dir, { recursive: true, force: true });
    },
  };
}

const modelOf = async (r: SwitchRig) => ((await r.conv.agent(BACKGROUND_CONTEXT)).model as { modelId: string }).modelId;
const answers = (t: Ui) => t.tg.of("answerCallbackQuery");

test("the extension declares the md: prefix and /model, and every callback_data is under 64 bytes", async () => {
  const t = await mk();
  try {
    assert.deepEqual(t.ext.prefixes, ["md:"]);
    assert.deepEqual(t.ext.commandList?.map((c) => c.command), ["model"]);
    const p = t.ui.picker();
    const all = p.keyboard.flat();
    assert.equal(all.length, 6, "five presets and Close");
    for (const b of all) assert.ok(Buffer.byteLength(b.callback_data) < 64, b.callback_data);
    assert.match(p.text, /Model now: LM Studio/);
    assert.match(p.text, /\(current\)/);
    assert.match(p.text, /Codex \[cloud, codex\] \(asks you first\)/);
    assert.match(p.text, /Strata \[on this PC\] \(applies at once\)/);
    // the longest legal preset id still fits
    assert.ok(Buffer.byteLength(`md:s:${"a".repeat(24)}`) < 64);
  } finally {
    await t.done();
  }
});

test("/model shows the picker; a local tap applies at once and the picker is edited", async () => {
  const t = await mk();
  try {
    await t.tg.bot.handleUpdate(textUpdate(USER_ID, "/model") as never);
    const sent = t.tg.of("sendMessage").at(-1);
    assert.match(String(sent?.payload["text"]), /Model now/);
    await t.tg.bot.handleUpdate(callbackUpdate(USER_ID, "md:s:strata", { messageId: 1000 }) as never);
    await waitFor(() => t.tg.of("editMessageText").length > 0);
    assert.match(String(t.tg.of("editMessageText").at(-1)?.payload["text"]), /Now using Strata/);
    assert.equal(t.r.transport.cards.length, 0);
    assert.equal(await modelOf(t.r), "strata-model", "the conversation followed at once");
    assert.match(String(answers(t).at(-1)?.payload["text"] ?? ""), /Now using Strata/);
    assert.equal(t.r.audits().filter((l) => l.source === "telegram").length, 1);
  } finally {
    await t.done();
  }
});

test("a cloud tap gives exactly one card and no change; Approve (through the engine) applies; tapping again after approval is 'already using'", async () => {
  const t = await mk();
  try {
    await t.tg.bot.handleUpdate(callbackUpdate(USER_ID, "md:s:codex", { messageId: 1000 }) as never);
    await waitFor(() => t.tg.of("editMessageText").length > 0);
    assert.match(String(t.tg.of("editMessageText").at(-1)?.payload["text"]), /only after you tap Approve/);
    assert.equal(t.r.transport.cards.length, 1);
    assert.equal(await modelOf(t.r), "lm-model");
    assert.equal(t.ui.picker().text.includes("Model now: LM Studio"), true);
    assert.equal((await t.r.tap(t.r.transport.cards[0]?.proposalId as string)).result, "approved");
    assert.equal(t.ui.picker().text.includes("Model now: Codex"), true);
    // the next admitted message moves the conversation (beforeSubmit)
    assert.equal(await modelOf(t.r), "lm-model");
    await t.ext.beforeSubmit?.({ conversation: t.r.spy, conversationId: t.r.convId, chatId: CHAT });
    assert.equal(await modelOf(t.r), "codex/gpt");
    await t.tg.bot.handleUpdate(callbackUpdate(USER_ID, "md:s:codex", { messageId: 1000 }) as never);
    await waitFor(() => t.tg.of("editMessageText").length > 1);
    assert.match(String(t.tg.of("editMessageText").at(-1)?.payload["text"]), /Already using Codex/);
    assert.equal(t.r.transport.cards.length, 1);
  } finally {
    await t.done();
  }
});

test("a foreign user, a group chat, malformed data and a preset that is not allowed are ignored (no change, no card)", async () => {
  const t = await mk({ route: { allowed: ["lmstudio", "strata", "codex"] } });
  try {
    await t.tg.bot.handleUpdate(callbackUpdate(999, "md:s:strata") as never);
    await t.tg.bot.handleUpdate(callbackUpdate(USER_ID, "md:s:strata", { chatId: -55, chatType: "group" }) as never);
    await t.tg.bot.handleUpdate(callbackUpdate(USER_ID, "md:s:Strata;drop") as never);
    await t.tg.bot.handleUpdate(callbackUpdate(USER_ID, "md:q:strata") as never);
    await t.tg.bot.handleUpdate(callbackUpdate(USER_ID, "md:s:claude") as never); // a stale button: no longer in allowed
    await t.tg.bot.handleUpdate(callbackUpdate(USER_ID, "md:s:ghost") as never);
    assert.equal(t.tg.of("editMessageText").length, 0);
    assert.equal(t.r.transport.cards.length, 0);
    assert.equal(t.r.audits().length, 0);
    assert.equal(await modelOf(t.r), "lm-model");
    assert.equal(t.r.configureCalls.length, 0);
    assert.equal(answers(t).length, 6, "every tap is answered so the button stops spinning");
    // a foreign user's /model gets no reply at all
    await t.tg.bot.handleUpdate(textUpdate(999, "/model strata") as never);
    assert.equal(t.tg.of("sendMessage").length, 0);
  } finally {
    await t.done();
  }
});

test("/model <id> switches directly; a bad id gets a hint; Close edits the picker away", async () => {
  const t = await mk();
  try {
    await t.tg.bot.handleUpdate(textUpdate(USER_ID, "/model strata") as never);
    await waitFor(() => t.tg.sentTexts().some((x) => /Now using Strata/.test(x)));
    await t.tg.bot.handleUpdate(textUpdate(USER_ID, "/model not a preset!") as never);
    await waitFor(() => t.tg.sentTexts().some((x) => /Use \/model/.test(x)));
    await t.tg.bot.handleUpdate(textUpdate(USER_ID, "/model anti") as never);
    await waitFor(() => t.tg.sentTexts().some((x) => /cannot be used/.test(x)));
    await t.tg.bot.handleUpdate(callbackUpdate(USER_ID, "md:x", { messageId: 1000 }) as never);
    await waitFor(() => t.tg.of("editMessageText").length > 0);
    assert.match(String(t.tg.of("editMessageText").at(-1)?.payload["text"]), /closed/);
    assert.equal(t.r.transport.cards.length, 0);
  } finally {
    await t.done();
  }
});

test("beforeSubmit follows a fallback and sends the one-time notice for an unusable saved choice; statusLines show the model and needs-login", async () => {
  const t = await mk({ stored: "anti" });
  try {
    await t.ext.beforeSubmit?.({ conversation: t.r.spy, conversationId: t.r.convId, chatId: CHAT });
    assert.equal(t.tg.sentTexts().filter((x) => /cannot be used/.test(x)).length, 1);
    await t.ext.beforeSubmit?.({ conversation: t.r.spy, conversationId: t.r.convId, chatId: CHAT });
    assert.equal(t.tg.sentTexts().filter((x) => /cannot be used/.test(x)).length, 1, "said once");
    t.fb.handle({ kind: "auth_required" }, "codex");
    assert.deepEqual(await t.ext.statusLines?.(), ["model: LM Studio", "needs login: codex"]);
    t.r.switcher.setFallback(ALL_PRESETS[1] as never, "lmstudio is down");
    await t.ext.beforeSubmit?.({ conversation: t.r.spy, conversationId: t.r.convId, chatId: CHAT });
    assert.equal(await modelOf(t.r), "strata-model");
    assert.match(String((await t.ext.statusLines?.())?.[0]), /fallback: lmstudio is down/);
  } finally {
    await t.done();
  }
});
