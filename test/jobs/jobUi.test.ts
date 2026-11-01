/** S14.3: the Telegram job UI, against the fake Telegram API (a real grammY Bot with its HTTP layer replaced). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildJobCard, PAID_MODELS_NOTICE } from "../../src/jobs/approval.js";
import type { HubStartCard, JobApprovalCard, JobDone, PermissionRequest } from "../../src/jobs/contracts.js";
import { createAllowlist } from "../../src/telegram/allowlist.js";
import { SCRIPTORIUM_WARNING, TelegramJobUi, briefFitsInCard, finalText, jobCardText } from "../../src/telegram/jobUi.js";
import { TPL_BOOK, TPL_FLOW, TPL_PLAIN, TPL_VN, template } from "./helpers/fixtures.js";
import { USER_ID, callbackUpdate, createFakeTelegram, memoryLogger, sleep, waitFor } from "../telegram/helpers/fakeTelegram.js";
import type { FakeTelegram } from "../telegram/helpers/fakeTelegram.js";

const OTHER_ID = 777;

function rig(opts: { ids?: string[]; chat?: number | undefined; minEditIntervalMs?: number } = {}) {
  const tg = createFakeTelegram();
  const log = memoryLogger();
  const ids = [...(opts.ids ?? ["aaaa0001", "aaaa0002", "aaaa0003", "aaaa0004"])];
  const ui = new TelegramJobUi({
    api: tg.bot.api,
    allowedUserIds: [USER_ID, OTHER_ID],
    chats: { chatForConversation: (c) => (opts.chat === undefined && "chat" in opts ? undefined : (opts.chat ?? (c === "1" ? USER_ID : undefined))) },
    logger: log,
    newId: () => ids.shift() ?? "ffffffff",
    minEditIntervalMs: opts.minEditIntervalMs ?? 50,
  });
  tg.bot.use(createAllowlist([USER_ID, OTHER_ID], log).middleware);
  tg.bot.on("callback_query:data", (ctx) => ui.handleCallback(ctx));
  return { tg, log, ui };
}

const jobCard = (over: Partial<Parameters<typeof buildJobCard>[0]> = {}): JobApprovalCard =>
  buildJobCard({ jobId: "job-1", conversationId: "1", template: TPL_PLAIN, params: { idea: "gulls" }, brief: "Make a short loop about gulls.", askedAt: Date.now(), timeoutSec: 600, ...over });

const keyboard = (tg: FakeTelegram, index = -1): { text: string; callback_data: string }[][] => {
  const sends = tg.of("sendMessage");
  const call = sends.at(index)!;
  return ((call.payload["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? []);
};

const tap = (tg: FakeTelegram, data: string, from = USER_ID, o: { chatId?: number; messageId?: number } = {}) => tg.bot.handleUpdate(callbackUpdate(from, data, { messageId: 1000, ...o }) as never);

test("card: template, params, cwd, engine, cloud, the full brief, Approve and Reject; plain text; short callback ids", async () => {
  const { tg, ui } = rig();
  const brief = "Make a short loop about gulls.\nKeep it under ten seconds.";
  const p = ui.requestJobApproval(jobCard({ brief }), new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  const text = String(tg.of("sendMessage")[0]!.payload["text"]);
  for (const part of ["Approve this job?", "Template: chiptune-loop", "Engine: claude", "Cwd: C:\\projects\\Personal\\creative-hub", 'Params: {"idea":"gulls"}', "Uses cloud: Claude subscription", brief, "Approval timeout: 600 s", "Expires:"]) {
    assert.ok(text.includes(part), `card has "${part}"`);
  }
  assert.equal(tg.of("sendMessage")[0]!.payload["parse_mode"], undefined);
  const [yes, no] = keyboard(tg)[0]!;
  assert.deepEqual([yes?.text, no?.text], ["Approve", "Reject"]);
  assert.match(yes!.callback_data, /^jb:[0-9a-f]{8}:y$/);
  assert.ok(Buffer.byteLength(yes!.callback_data) <= 64 && Buffer.byteLength(no!.callback_data) <= 64);
  assert.equal(ui.pendingCount(), 1);

  await tap(tg, yes!.callback_data);
  const d = await p;
  assert.deepEqual([d.approved, d.by, d.userId], [true, "user", USER_ID]);
  assert.equal(ui.pendingCount(), 0);
  assert.equal(tg.of("answerCallbackQuery").length, 1);
  const edit = tg.of("editMessageText").at(-1)!;
  assert.ok(String(edit.payload["text"]).startsWith("Approved"));
  assert.deepEqual((edit.payload["reply_markup"] as { inline_keyboard: unknown[] }).inline_keyboard, []);
});

test("card: Reject resolves rejected by the user", async () => {
  const { tg, ui } = rig();
  const p = ui.requestJobApproval(jobCard(), new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  await tap(tg, keyboard(tg)[0]![1]!.callback_data);
  const d = await p;
  assert.deepEqual([d.approved, d.by], [false, "user"]);
  assert.ok(String(tg.of("editMessageText").at(-1)!.payload["text"]).startsWith("Rejected"));
});

test("card: a Flow job shows its estimate and approving it carries that number", async () => {
  const { tg, ui } = rig();
  const p = ui.requestJobApproval(jobCard({ template: TPL_FLOW, flowEstimateCredits: 40 }), new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  const text = String(tg.of("sendMessage")[0]!.payload["text"]);
  assert.match(text, /Flow estimate: 40 credits/);
  assert.match(text, /Uses cloud: Claude subscription, Google Flow/);
  await tap(tg, keyboard(tg)[0]![0]!.callback_data);
  assert.equal((await p).approvedCredits, 40);
});

test("card: the paid-models line on a paidModels template, the autostart line on a VN Studio template, neither on a plain one", async () => {
  const text = (c: JobApprovalCard) => jobCardText(c, true);
  assert.ok(text(jobCard({ template: TPL_BOOK })).includes(PAID_MODELS_NOTICE));
  assert.ok(text(jobCard({ template: TPL_BOOK })).includes("agent-007 does not estimate or cap their cost"));
  assert.ok(text(jobCard({ template: TPL_VN })).includes("VN Studio may start Pixel Studio, Chiptune Studio and ComfyUI"));
  const plain = text(jobCard());
  assert.ok(!plain.includes("paid models") && !plain.includes("VN Studio"));
  // and on the real message
  const { tg, ui } = rig();
  void ui.requestJobApproval(jobCard({ template: TPL_BOOK }), new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  assert.ok(String(tg.of("sendMessage")[0]!.payload["text"]).includes("may use paid models"));
  ui.cancelChat(USER_ID);
});

test("a 10,000-character brief is delivered in full, in order, BEFORE the card; Approve is refused until it has been shown", async () => {
  const { tg, ui } = rig();
  const brief = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(3, "0")} of the brief, all of it matters.`).join("\n").slice(0, 10_000);
  assert.equal(brief.length, 10_000);
  const c = jobCard({ brief });
  assert.equal(briefFitsInCard(c), false);

  // While the second part is being sent the user taps Approve on the id that already exists: it must not count.
  let sends = 0;
  let early: Promise<unknown> | undefined;
  tg.bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === "sendMessage" && ++sends === 2) early = tg.bot.handleUpdate(callbackUpdate(USER_ID, "jb:aaaa0001:y", { messageId: 1000 }) as never);
    return prev(method, payload, signal);
  });
  const p = ui.requestJobApproval(c, new AbortController().signal);
  let resolved = false;
  void p.then(() => (resolved = true));
  await waitFor(() => tg.of("sendMessage").length >= 4 && keyboard(tg).length > 0);
  await early;
  assert.equal(resolved, false, "an early Approve did not decide anything");
  assert.equal(tg.of("answerCallbackQuery")[0]?.payload["text"], "Read the whole brief first.");

  const texts = tg.of("sendMessage").map((m) => String(m.payload["text"]));
  const parts = texts.slice(0, -1);
  const cardText = texts.at(-1)!;
  assert.ok(parts.length >= 3, `the brief went out in ${parts.length} parts`);
  assert.ok(parts.every((t) => t.length <= 4096));
  const rebuilt = parts.map((t) => t.slice(t.indexOf(":\n") + 2)).join("");
  assert.equal(rebuilt, brief, "every character of the brief was delivered, in order");
  assert.match(parts[0]!, /^Brief for job job-1 \(part 1 of \d+\):/);
  assert.ok(cardText.startsWith("Approve this job?") && cardText.length <= 4096);
  assert.match(cardText, /Brief: shown in full above \(10000 characters\)/);
  assert.ok(!cardText.includes("line 399"), "the brief is not repeated in the card");
  assert.equal(keyboard(tg).length, 1, "only the last message (the card) has buttons");
  for (const earlier of tg.of("sendMessage").slice(0, -1)) assert.equal(earlier.payload["reply_markup"], undefined);

  await tap(tg, "jb:aaaa0001:y");
  assert.equal((await p).approved, true, "after the whole brief was shown, Approve counts");
});

test("a brief of 3,500 characters fits in the card; one over 3,500 goes before it", () => {
  assert.equal(briefFitsInCard(jobCard({ brief: "x".repeat(300) })), true);
  assert.equal(briefFitsInCard(jobCard({ brief: "x".repeat(3501) })), false);
  assert.equal(jobCardText(jobCard({ brief: "" }), true).includes("Brief:\n(none)"), true);
});

test("a long brief with a send failure in the middle: no card, no approval, the error reaches the caller", async () => {
  const { tg, ui } = rig();
  tg.failNext("sendMessage", { kind: "network" }, 1);
  await assert.rejects(ui.requestJobApproval(jobCard({ brief: "y".repeat(9000) }), new AbortController().signal));
  assert.equal(ui.pendingCount(), 0);
  assert.equal(keyboard(tg).length, 0, "no card was sent");
});

test("stale callback after a restart: 'Expired. A new request was sent.', buttons removed", async () => {
  const first = rig();
  void first.ui.requestJobApproval(jobCard(), new AbortController().signal);
  await waitFor(() => first.tg.of("sendMessage").length === 1);
  const yes = keyboard(first.tg)[0]![0]!.callback_data;
  const second = rig(); // the new process has an empty id map
  await tap(second.tg, yes);
  assert.equal(second.tg.of("answerCallbackQuery")[0]!.payload["text"], "Expired. A new request was sent.");
  assert.deepEqual((second.tg.of("editMessageReplyMarkup")[0]!.payload["reply_markup"] as { inline_keyboard: unknown[] }).inline_keyboard, []);
  assert.equal(second.ui.pendingCount(), 0);
  first.ui.cancelChat(USER_ID);
});

test("a second tap on a decided card answers Expired and decides nothing twice", async () => {
  const { tg, ui } = rig();
  const p = ui.requestJobApproval(jobCard(), new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  const [yes, no] = keyboard(tg)[0]!;
  await tap(tg, yes!.callback_data);
  assert.equal((await p).approved, true);
  await tap(tg, no!.callback_data);
  assert.equal(tg.of("answerCallbackQuery").at(-1)!.payload["text"], "Expired. A new request was sent.");
});

test("a foreign user is ignored: not allowlisted, or allowlisted but not the chat the card went to", async () => {
  const { tg, log, ui } = rig();
  const p = ui.requestJobApproval(jobCard(), new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  const yes = keyboard(tg)[0]![0]!.callback_data;
  await tap(tg, yes, 999); // a stranger: dropped by the allowlist
  await tap(tg, yes, OTHER_ID, { chatId: OTHER_ID }); // allowlisted, other chat
  await tap(tg, yes, USER_ID, { chatId: OTHER_ID }); // right user, button in another chat
  assert.equal(ui.pendingCount(), 1, "still waiting");
  assert.equal(tg.of("answerCallbackQuery").length, 0);
  assert.equal(tg.of("editMessageText").length, 0);
  assert.ok(log.events("telegram.job_wrong_chat").length >= 1);
  await tap(tg, yes);
  assert.equal((await p).approved, true);
});

test("the timeout is a rejection by timeout and the card says so", async () => {
  const { tg, ui } = rig();
  const d = await ui.requestJobApproval(jobCard({ askedAt: Date.now() - 600_000 + 80 }), new AbortController().signal);
  assert.deepEqual([d.approved, d.by], [false, "timeout"]);
  await waitFor(() => tg.of("editMessageText").length === 1);
  assert.ok(String(tg.of("editMessageText")[0]!.payload["text"]).startsWith("Expired"));
});

test("an expired card is never sent", async () => {
  const { tg, ui } = rig();
  const d = await ui.requestJobApproval(jobCard({ askedAt: 0 }), new AbortController().signal);
  assert.deepEqual([d.approved, d.by], [false, "restart-expired"]);
  assert.equal(tg.of("sendMessage").length, 0);
});

test("an abort (restart) cancels the card and strips its buttons; no chat linked is an error, not an approval", async () => {
  const { tg, ui } = rig();
  const ac = new AbortController();
  const p = ui.requestJobApproval(jobCard(), ac.signal);
  await waitFor(() => tg.of("sendMessage").length === 1 && ui.pendingCount() === 1);
  await sleep(10);
  ac.abort();
  const d = await p;
  assert.equal(d.approved, false);
  await waitFor(() => tg.of("editMessageText").length === 1);
  assert.ok(String(tg.of("editMessageText")[0]!.payload["text"]).startsWith("Cancelled"));

  const lost = rig({ chat: undefined });
  await assert.rejects(lost.ui.requestJobApproval({ ...jobCard(), conversationId: "99" }, new AbortController().signal), /no Telegram chat/);
});

// ---- progress and the final message -------------------------------------------------------------------------------------

test("progress: one message edited in place, and edits are rate limited", async () => {
  const { tg, ui } = rig({ minEditIntervalMs: 120 });
  const post = (n: number) => ui.postProgress({ jobId: "job-1", conversationId: "1", state: "running", text: `Job x: running\nEvents: ${n}`, eventCount: n });
  await post(1);
  for (let i = 2; i <= 12; i++) await post(i);
  await sleep(300);
  assert.equal(tg.of("sendMessage").length, 1, "one status message");
  const edits = tg.of("editMessageText");
  assert.ok(edits.length >= 1 && edits.length <= 3, `${edits.length} edits for 11 updates inside the interval`);
  assert.ok(edits.every((e) => e.payload["message_id"] === 1000), "always the same message");
  assert.equal(String(edits.at(-1)!.payload["text"]), "Job x: running\nEvents: 12", "the newest text won");
  for (let i = 1; i < edits.length; i++) assert.ok(edits[i]!.at - edits[i - 1]!.at >= 100, "edits are spaced");
});

test("progress for a conversation with no chat is dropped quietly", async () => {
  const { tg, ui } = rig();
  await ui.postProgress({ jobId: "job-1", conversationId: "99", state: "running", text: "x", eventCount: 1 });
  assert.equal(tg.calls.length, 0);
});

test("final message: plain text with state, time, cost, approved/charged/reported Flow credits, summary and artifacts", async () => {
  const { tg, ui } = rig();
  const done: JobDone = {
    jobId: "job-1",
    state: "succeeded",
    summary: "Made the video.\n<b>not bold</b> *not markdown*",
    artifacts: ["runs/video.mp4"],
    durationMs: 192_000,
    costUsd: 0.4321,
    flow: { approved: 40, charged: 35, reported: 28 },
  };
  await ui.postProgress({ jobId: "job-1", conversationId: "1", state: "running", text: "Job x: running", eventCount: 1 });
  await ui.postFinal(done, "1");
  const last = String(tg.of("sendMessage").at(-1)!.payload["text"]);
  assert.equal(tg.of("sendMessage").at(-1)!.payload["parse_mode"], undefined);
  for (const part of ["Job job-1 succeeded.", "Time: 3 min 12 s", "Cost: $0.43", "Flow credits: approved 40, charged 35, reported spent 28.", "<b>not bold</b> *not markdown*", "- runs/video.mp4"]) assert.ok(last.includes(part), part);
  assert.ok(finalText({ ...done, flow: { approved: 40, charged: 35 } }).includes("reported spend not available"));
});

test("final message: a long summary is split into parts under the Telegram limit", async () => {
  const { tg, ui } = rig();
  await ui.postFinal({ jobId: "job-1", state: "failed", summary: "s".repeat(9000), artifacts: [], durationMs: 0, error: "boom" }, "1");
  const sends = tg.of("sendMessage");
  assert.ok(sends.length >= 3);
  assert.ok(sends.every((m) => String(m.payload["text"]).length <= 4096));
});

// ---- permission prompts ---------------------------------------------------------------------------------------------------

const permReq = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  requestId: "perm-1",
  jobId: "job-1",
  engine: "claude",
  tool: "Write",
  input: { file_path: "runs/out.txt", content: "hello" },
  cwd: "C:\\projects\\Personal\\creative-hub",
  kind: "edit",
  requestedAt: Date.now(),
  timeoutSec: 600,
  ...over,
});

test("permission card: tool, input and cwd, Allow once or Deny; Allow carries the user id", async () => {
  const { tg, ui } = rig();
  const p = ui.requestPermission(permReq(), "1", new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  const text = String(tg.of("sendMessage")[0]!.payload["text"]);
  for (const part of ["Allow this tool use in job job-1?", "Tool: Write", "runs/out.txt", "Cwd: C:\\projects\\Personal\\creative-hub", "Expires:"]) assert.ok(text.includes(part), part);
  const rows = keyboard(tg);
  assert.deepEqual(rows[0]!.map((b) => b.text), ["Allow once", "Deny"]);
  assert.equal(rows.length, 1, "no 'Show full input' for a short input");
  await tap(tg, rows[0]![0]!.callback_data);
  const d = await p;
  assert.deepEqual([d.answer, d.by, d.userId, d.requestId], ["allow_once", "user", USER_ID, "perm-1"]);
});

test("permission card: Deny, timeout, and an abort are all denies; there is no 'always' button", async () => {
  const a = rig();
  const p1 = a.ui.requestPermission(permReq(), "1", new AbortController().signal);
  await waitFor(() => a.tg.of("sendMessage").length === 1);
  const labels = keyboard(a.tg).flat().map((b) => b.text.toLowerCase());
  assert.ok(!labels.some((l) => l.includes("always")));
  await tap(a.tg, keyboard(a.tg)[0]![1]!.callback_data);
  assert.deepEqual([(await p1).answer, (await p1).by], ["deny", "user"]);

  const b = rig();
  const t = await b.ui.requestPermission(permReq({ requestedAt: Date.now() - 600_000 + 60 }), "1", new AbortController().signal);
  assert.deepEqual([t.answer, t.by], ["deny", "timeout"]);

  const c = rig();
  const ac = new AbortController();
  const p3 = c.ui.requestPermission(permReq(), "1", ac.signal);
  await waitFor(() => c.tg.of("sendMessage").length === 1);
  await sleep(10);
  ac.abort("cancel");
  assert.deepEqual([(await p3).answer, (await p3).by], ["deny", "cancel"]);

  const d = rig();
  const ac2 = new AbortController();
  const p4 = d.ui.requestPermission(permReq(), "1", ac2.signal);
  await waitFor(() => d.tg.of("sendMessage").length === 1);
  await sleep(10);
  ac2.abort("dispose");
  assert.equal((await p4).by, "restart");

  const expired = await rig().ui.requestPermission(permReq({ requestedAt: 0 }), "1", new AbortController().signal);
  assert.equal(expired.answer, "deny");
});

test("permission card: a long input is cut with a 'Show full input' button that sends the rest", async () => {
  const { tg, ui } = rig();
  const big = "x".repeat(5000);
  const p = ui.requestPermission(permReq({ input: { content: big } }), "1", new AbortController().signal);
  await waitFor(() => tg.of("sendMessage").length === 1);
  const text = String(tg.of("sendMessage")[0]!.payload["text"]);
  assert.ok(text.includes("tap Show full input") && text.length < 2000);
  const rows = keyboard(tg);
  assert.deepEqual(rows[1]!.map((b) => b.text), ["Show full input"]);
  await tap(tg, rows[1]![0]!.callback_data);
  await waitFor(() => tg.of("sendMessage").length >= 2);
  const full = tg.of("sendMessage").slice(1).map((m) => String(m.payload["text"])).map((t) => t.slice(t.indexOf("\n") + 1)).join("");
  assert.ok(full.includes(big), "the whole input was sent");
  assert.equal(ui.pendingCount(), 1, "still waiting for Allow or Deny");
  await tap(tg, rows[0]![1]!.callback_data);
  assert.equal((await p).answer, "deny");
});

// ---- hub start --------------------------------------------------------------------------------------------------------------

const hubCard = (service: string): HubStartCard => ({ conversationId: "1", service, scriptorium: service === "scriptorium", timeoutSec: 600, deadline: Date.now() + 600_000 });

test("hub start card: Scriptorium has its own warning; other services do not", async () => {
  const s = rig();
  const p = s.ui.requestHubStartApproval(hubCard("scriptorium"), new AbortController().signal);
  await waitFor(() => s.tg.of("sendMessage").length === 1);
  const text = String(s.tg.of("sendMessage")[0]!.payload["text"]);
  assert.ok(text.includes(SCRIPTORIUM_WARNING) && text.includes("resumes its whole book factory and may spend on paid models"));
  await tap(s.tg, keyboard(s.tg)[0]![0]!.callback_data);
  assert.equal((await p).approved, true);

  const o = rig();
  const p2 = o.ui.requestHubStartApproval(hubCard("vibetts"), new AbortController().signal);
  await waitFor(() => o.tg.of("sendMessage").length === 1);
  assert.ok(!String(o.tg.of("sendMessage")[0]!.payload["text"]).includes("book factory"));
  await tap(o.tg, keyboard(o.tg)[0]![1]!.callback_data);
  assert.equal((await p2).approved, false);
});

test("cancelChat settles every open card of the chat", async () => {
  const { tg, ui } = rig();
  const p = ui.requestJobApproval(jobCard(), new AbortController().signal);
  await waitFor(() => ui.pendingCount() === 1 && tg.of("sendMessage").length === 1);
  await sleep(10);
  assert.equal(ui.cancelChat(USER_ID), 1);
  assert.equal((await p).approved, false);
  assert.equal(ui.cancelChat(USER_ID), 0);
  void template;
});
