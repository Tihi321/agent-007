import assert from "node:assert/strict";
import { test } from "node:test";
import { createAllowlist } from "../../src/telegram/allowlist.js";
import { callbackUpdate, createFakeTelegram, memoryLogger, textUpdate, USER_ID } from "./helpers/fakeTelegram.js";

function rig(now = () => 1_000_000) {
  const tg = createFakeTelegram();
  const log = memoryLogger();
  const allow = createAllowlist([USER_ID], log, { now });
  const passed: string[] = [];
  tg.bot.use(allow.middleware);
  tg.bot.on("message", (ctx) => void passed.push(`message:${ctx.from?.id}`));
  tg.bot.on("callback_query", (ctx) => void passed.push(`callback:${ctx.from?.id}`));
  return { tg, log, passed, now };
}

test("allowlist: a stranger's DM is dropped and logged with no content, and gets no reply", async () => {
  const { tg, log, passed } = rig();
  await tg.bot.handleUpdate(textUpdate(999, "secret stranger text") as never);
  assert.deepEqual(passed, []);
  assert.equal(tg.calls.length, 0, "no reply to strangers");
  const dropped = log.events("telegram.dropped");
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]?.level, "warn");
  const fields = dropped[0]?.fields as { updateId: number; fromId: number; chatType: string; kind: string };
  assert.equal(fields.fromId, 999);
  assert.equal(fields.chatType, "private");
  assert.equal(fields.kind, "message");
  assert.equal(typeof fields.updateId, "number");
  assert.ok(!JSON.stringify(log.lines).includes("secret stranger text"), "no message content in the log");
});

test("allowlist: a group message from an ALLOWED user is dropped", async () => {
  const { tg, log, passed } = rig();
  await tg.bot.handleUpdate(textUpdate(USER_ID, "hi group", { chatId: -100123, chatType: "supergroup" }) as never);
  assert.deepEqual(passed, []);
  assert.equal(tg.calls.length, 0);
  const f = log.events("telegram.dropped")[0]?.fields as { chatType: string; fromId: number };
  assert.equal(f.chatType, "supergroup");
  assert.equal(f.fromId, USER_ID);
});

test("allowlist: a stranger's callback_query is dropped and logged", async () => {
  const { tg, log, passed } = rig();
  await tg.bot.handleUpdate(callbackUpdate(999, "ap:deadbeef:y") as never);
  assert.deepEqual(passed, []);
  assert.equal(tg.calls.length, 0, "not even answerCallbackQuery");
  const f = log.events("telegram.dropped")[0]?.fields as { kind: string; fromId: number };
  assert.equal(f.kind, "callback_query");
  assert.equal(f.fromId, 999);
  assert.ok(!JSON.stringify(log.lines).includes("deadbeef"));
});

test("allowlist: the allowed user's private message and callback pass", async () => {
  const { tg, log, passed } = rig();
  await tg.bot.handleUpdate(textUpdate(USER_ID, "hello") as never);
  await tg.bot.handleUpdate(callbackUpdate(USER_ID, "x") as never);
  assert.deepEqual(passed, [`message:${USER_ID}`, `callback:${USER_ID}`]);
  assert.equal(log.events("telegram.dropped").length, 0);
});

test("allowlist: a callback from the allowed user in a group is dropped; an update with no sender is dropped", async () => {
  const { tg, passed } = rig();
  await tg.bot.handleUpdate(callbackUpdate(USER_ID, "x", { chatType: "group", chatId: -5 }) as never);
  await tg.bot.handleUpdate({ update_id: 77, channel_post: { message_id: 1, date: 1, chat: { id: -9, type: "channel" }, text: "x" } } as never);
  assert.deepEqual(passed, []);
});

test("allowlist: logging is limited to one line per sender per minute", async () => {
  let t = 1_000_000;
  const { tg, log } = rig(() => t);
  await tg.bot.handleUpdate(textUpdate(999, "a") as never);
  await tg.bot.handleUpdate(textUpdate(999, "b") as never);
  t += 30_000;
  await tg.bot.handleUpdate(textUpdate(999, "c") as never);
  assert.equal(log.events("telegram.dropped").length, 1);
  await tg.bot.handleUpdate(textUpdate(555, "d") as never);
  assert.equal(log.events("telegram.dropped").length, 2, "another sender is logged separately");
  t += 31_000;
  await tg.bot.handleUpdate(textUpdate(999, "e") as never);
  assert.equal(log.events("telegram.dropped").length, 3, "after a minute the sender is logged again");
});
