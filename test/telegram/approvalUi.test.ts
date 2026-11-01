import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalRequest } from "../../src/contracts.js";
import { approvalCardText, INVALID_BY, TelegramApprovalTransport } from "../../src/telegram/approvalUi.js";
import { createAllowlist } from "../../src/telegram/allowlist.js";
import { callbackUpdate, createFakeTelegram, fakeKillSwitch, memoryLogger, sleep, USER_ID, waitFor } from "./helpers/fakeTelegram.js";

const OTHER_ID = 777;

function req(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    key: "k1",
    conversationId: "c1",
    chatId: USER_ID,
    tool: "shell",
    command: "Get-ChildItem C:\\temp",
    reason: "list the folder",
    cwd: "C:\\agent\\workspace",
    timeoutSec: 600,
    deadline: Date.now() + 600_000,
    ...over,
  };
}

function rig(opts: { allowed?: number[]; ids?: string[]; killSwitch?: ReturnType<typeof fakeKillSwitch> } = {}) {
  const tg = createFakeTelegram();
  const log = memoryLogger();
  const allowed = opts.allowed ?? [USER_ID, OTHER_ID];
  const ids = [...(opts.ids ?? ["aaaa0001", "aaaa0002", "aaaa0003"])];
  const transport = new TelegramApprovalTransport({ api: tg.bot.api, allowedUserIds: allowed, logger: log, killSwitch: opts.killSwitch, newId: () => ids.shift() ?? "ffffffff" });
  // same wiring as the bridge: allowlist first, then the callback handler
  tg.bot.use(createAllowlist(allowed, log).middleware);
  tg.bot.on("callback_query:data", (ctx) => transport.handleCallback(ctx));
  return { tg, log, transport };
}

const cardKeyboard = (tg: ReturnType<typeof createFakeTelegram>) =>
  ((tg.of("sendMessage")[0]?.payload["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0] ?? []);

test("approval: Approve resolves approved:true, edits the card and removes the buttons", async () => {
  const { tg, transport } = rig();
  const r = req();
  const p = transport.request(r, new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  const card = tg.of("sendMessage")[0]!;
  const text = String(card.payload["text"]);
  assert.ok(text.startsWith("Approve shell command?"));
  assert.ok(text.includes(r.command) && text.includes("list the folder") && text.includes("C:\\agent\\workspace"));
  assert.ok(text.includes("600 s") && /Expires: \d\d:\d\d/.test(text));
  assert.equal(card.payload["parse_mode"], undefined, "plain text, no parse mode");
  const [yes, no] = cardKeyboard(tg);
  assert.equal(yes?.text, "Approve");
  assert.equal(no?.text, "Deny");
  assert.match(yes?.callback_data ?? "", /^ap:[0-9a-f]{8}:y$/);
  assert.ok(Buffer.byteLength(yes?.callback_data ?? "") <= 64);
  assert.equal(transport.pendingCount(), 1);

  await tg.bot.handleUpdate(callbackUpdate(USER_ID, yes!.callback_data, { messageId: 1000 }) as never);
  const d = await p;
  assert.equal(d.approved, true);
  assert.equal(d.by, "user");
  assert.equal(d.userId, USER_ID);
  assert.equal(transport.pendingCount(), 0);
  const edit = tg.of("editMessageText").at(-1)!;
  assert.ok(String(edit.payload["text"]).startsWith("Approved"));
  assert.deepEqual((edit.payload["reply_markup"] as { inline_keyboard: unknown[] }).inline_keyboard, []);
  assert.equal(tg.of("answerCallbackQuery").length, 1);
});

test("approval: Deny resolves approved:false by the user", async () => {
  const { tg, transport } = rig();
  const p = transport.request(req(), new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  const [, no] = cardKeyboard(tg);
  await tg.bot.handleUpdate(callbackUpdate(USER_ID, no!.callback_data) as never);
  const d = await p;
  assert.equal(d.approved, false);
  assert.equal(d.by, "user");
  assert.ok(String(tg.of("editMessageText").at(-1)!.payload["text"]).startsWith("Denied"));
});

test("approval: a foreign from.id is ignored (not allowlisted, or allowlisted but not the request's chat)", async () => {
  const { tg, log, transport } = rig();
  const p = transport.request(req(), new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  const [yes] = cardKeyboard(tg);
  // a stranger: dropped by the allowlist middleware
  await tg.bot.handleUpdate(callbackUpdate(999, yes!.callback_data) as never);
  // an allowlisted user who is not the chat the card was sent to
  await tg.bot.handleUpdate(callbackUpdate(OTHER_ID, yes!.callback_data, { chatId: OTHER_ID }) as never);
  // the right user but the button is on a message in another chat
  await tg.bot.handleUpdate(callbackUpdate(USER_ID, yes!.callback_data, { chatId: OTHER_ID }) as never);
  assert.equal(transport.pendingCount(), 1, "still waiting");
  assert.equal(tg.of("answerCallbackQuery").length, 0);
  assert.equal(tg.of("editMessageText").length, 0);
  assert.ok(log.events("telegram.approval_wrong_chat").length >= 1);
  // the real user can still answer
  await tg.bot.handleUpdate(callbackUpdate(USER_ID, yes!.callback_data) as never);
  assert.equal((await p).approved, true);
});

test("approval: after a restart the old button answers 'Expired. A new request was sent.'", async () => {
  const first = rig();
  const p = first.transport.request(req(), new AbortController().signal);
  await waitFor(() => first.tg.of("sendMessage").length === 1);
  const [yes] = cardKeyboard(first.tg);
  void p; // the old process dies with this request pending

  const second = rig(); // a new process: empty id map
  await second.tg.bot.handleUpdate(callbackUpdate(USER_ID, yes!.callback_data, { messageId: 1000 }) as never);
  const answer = second.tg.of("answerCallbackQuery")[0]!;
  assert.equal(answer.payload["text"], "Expired. A new request was sent.");
  assert.equal(second.transport.pendingCount(), 0);
  const stripped = second.tg.of("editMessageReplyMarkup")[0]!;
  assert.deepEqual((stripped.payload["reply_markup"] as { inline_keyboard: unknown[] }).inline_keyboard, []);
  first.transport.cancelAll("stop");
});

test("approval: a second tap on a decided card answers Expired and decides nothing twice", async () => {
  const { tg, transport } = rig();
  const p = transport.request(req(), new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  const [yes, no] = cardKeyboard(tg);
  await tg.bot.handleUpdate(callbackUpdate(USER_ID, yes!.callback_data) as never);
  await tg.bot.handleUpdate(callbackUpdate(USER_ID, no!.callback_data) as never);
  assert.equal((await p).approved, true);
  assert.equal(tg.of("answerCallbackQuery")[1]?.payload["text"], "Expired. A new request was sent.");
});

test("approval: an abort signal edits the card to 'Cancelled (kill switch)' and denies", async () => {
  const { tg, transport } = rig();
  const ac = new AbortController();
  const p = transport.request(req(), ac.signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  ac.abort();
  const d = await p;
  assert.equal(d.approved, false);
  assert.equal(d.by, "killswitch");
  await waitFor(() => tg.of("editMessageText").length === 1);
  assert.ok(String(tg.of("editMessageText")[0]!.payload["text"]).startsWith("Cancelled (kill switch)"));
  assert.equal(transport.pendingCount(), 0);
});

test("approval: an already-aborted signal sends no card", async () => {
  const { tg, transport } = rig();
  const ac = new AbortController();
  ac.abort();
  const d = await transport.request(req(), ac.signal);
  assert.equal(d.approved, false);
  assert.equal(tg.calls.length, 0);
});

test("approval: the kill switch turning on cancels every open card", async () => {
  const ks = fakeKillSwitch();
  const { tg, transport } = rig({ killSwitch: ks });
  const p = transport.request(req(), new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  await ks.turnOn("test");
  const d = await p;
  assert.equal(d.approved, false);
  assert.equal(d.by, "killswitch");
  await waitFor(() => tg.of("editMessageText").length === 1);
  assert.ok(String(tg.of("editMessageText")[0]!.payload["text"]).startsWith("Cancelled (kill switch)"));
});

test("approval: cancelChat(stop) denies by 'stop' and edits to 'Cancelled (/stop)'", async () => {
  const { tg, transport } = rig();
  const p = transport.request(req(), new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  assert.equal(await transport.cancelChat(USER_ID, "stop"), 1);
  const d = await p;
  assert.equal(d.by, "stop");
  assert.equal(d.approved, false);
  assert.ok(String(tg.of("editMessageText")[0]!.payload["text"]).startsWith("Cancelled (/stop)"));
  assert.equal(await transport.cancelChat(USER_ID, "stop"), 0);
});

test("approval: a timeout denies, edits the card and removes the buttons", async () => {
  const { tg, transport } = rig();
  const p = transport.request(req({ deadline: Date.now() + 60 }), new AbortController().signal);
  const d = await p;
  assert.equal(d.approved, false);
  assert.equal(d.by, "timeout");
  await waitFor(() => tg.of("editMessageText").length === 1);
  assert.ok(String(tg.of("editMessageText")[0]!.payload["text"]).startsWith("Expired"));
  assert.deepEqual((tg.of("editMessageText")[0]!.payload["reply_markup"] as { inline_keyboard: unknown[] }).inline_keyboard, []);
});

test("approval: a deadline already in the past (after a restart) is restart-expired with no card", async () => {
  const { tg, transport } = rig();
  const d = await transport.request(req({ deadline: Date.now() - 1 }), new AbortController().signal);
  assert.equal(d.approved, false);
  assert.equal(d.by, "restart-expired");
  assert.equal(tg.calls.length, 0);
});

test("approval: a command over 3,500 characters is not shown and is denied at once", async () => {
  const { tg, transport } = rig();
  const long = "x".repeat(3501);
  const d = await transport.request(req({ command: long }), new AbortController().signal);
  assert.equal(d.approved, false);
  assert.equal(d.by, INVALID_BY);
  assert.equal(String(d.by), "invalid");
  const sent = tg.of("sendMessage");
  assert.equal(sent.length, 1);
  assert.ok(!String(sent[0]!.payload["text"]).includes(long), "the command is not echoed");
  assert.equal(sent[0]!.payload["reply_markup"], undefined, "no buttons");
  // exactly 3,500 is shown
  const ok = transport.request(req({ command: "y".repeat(3500) }), new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 2);
  assert.ok(String(tg.of("sendMessage")[1]!.payload["text"]).length <= 4096);
  await transport.cancelAll("stop");
  await ok;
});

test("approval: if the card cannot be sent the request fails closed", async () => {
  const { tg, transport } = rig();
  tg.failNext("sendMessage", { kind: "api", error_code: 400, description: "Bad Request: chat not found" });
  const d = await transport.request(req(), new AbortController().signal);
  assert.equal(d.approved, false);
  assert.equal(transport.pendingCount(), 0);
});

test("approval: card text keeps long reason and cwd within Telegram's limit", () => {
  const text = approvalCardText(req({ command: "c".repeat(3500), reason: "r".repeat(5000), cwd: "d".repeat(5000) }));
  assert.ok(text.length <= 4096, `card is ${text.length} characters`);
});

test("approval: concurrent cards get distinct ids and settle independently", async () => {
  const { tg, transport } = rig();
  const p1 = transport.request(req({ key: "a" }), new AbortController().signal);
  const p2 = transport.request(req({ key: "b", command: "second" }), new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 2);
  const k = (i: number) => (tg.of("sendMessage")[i]!.payload["reply_markup"] as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]![0]!.callback_data;
  assert.notEqual(k(0), k(1));
  await tg.bot.handleUpdate(callbackUpdate(USER_ID, k(1)) as never);
  assert.equal((await p2).approved, true);
  assert.equal(transport.pendingCount(), 1);
  await sleep(5);
  await transport.cancelAll("killswitch");
  assert.equal((await p1).approved, false);
});
