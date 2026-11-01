/**
 * Bridge tests with a real Pi Harness (SQLite) over a fake OpenAI-compatible runner and a fake Telegram API.
 * No real Telegram or model runner is contacted.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "../../src/pi/adapter.js";
import { ChatConversations, chatMapDoc } from "../../src/telegram/conversations.js";
import { pendingDoc } from "../../src/telegram/delivery.js";
import type { HealthStatus } from "../../src/runtime/health.js";
import { startFakeOpenAi } from "../helpers/fakeOpenAi.js";
import { echoBehavior, MODEL_ID, openRig, tempDir } from "./helpers/bridgeRig.js";
import type { Rig } from "./helpers/bridgeRig.js";
import { createFakeTelegram, photoUpdate, sleep, textUpdate, USER_ID, waitFor } from "./helpers/fakeTelegram.js";

async function withRig(fn: (rig: Rig) => Promise<void>, o: Parameters<typeof openRig>[0] = {}): Promise<void> {
  const rig = await openRig(o);
  try {
    await fn(rig);
  } finally {
    await rig.shutdown();
    await rig.fake.close();
    rmSync(rig.dir, { recursive: true, force: true });
  }
}

const sent = (rig: Rig) => rig.tg.sentTexts(USER_ID);

test("bridge: an allowed DM is admitted, answered once, and recorded as delivered", async () => {
  await withRig(async (rig) => {
    await rig.tg.bot.handleUpdate(textUpdate(USER_ID, "hello there", { messageId: 11 }) as never);
    await waitFor(() => rig.tg.messageTexts().some((m) => m.text === "echo: hello there"), 8000, "the answer");
    assert.equal(rig.fake.chatRequests().length, 1);
    await rig.bridge.delivery()!.idle();
    const pending = await rig.harness.snapshot(pendingDoc, BACKGROUND_CONTEXT);
    const item = pending?.items[`tg:${USER_ID}:11`];
    assert.ok(item, "a durable PendingDelivery item exists");
    assert.equal(item.delivered, true);
    assert.equal(item.sentChunks, 1);
    // the ChatMap and ChatLookup know the conversation; the Notifier reaches the chat through it
    const map = await rig.harness.snapshot(chatMapDoc, BACKGROUND_CONTEXT);
    const convId = map?.chats[String(USER_ID)];
    assert.ok(convId);
    assert.equal(rig.bridge.chatLookup.chatForConversation(convId), USER_ID);
    await rig.bridge.notifier.notify(convId, "Remembered: tea");
    assert.ok(rig.tg.sentTexts(USER_ID).includes("Remembered: tea"));
    await rig.bridge.notifier.notify("999999", "nobody");
    assert.ok(!rig.tg.sentTexts().includes("nobody"), "unknown conversation: nothing sent");
  });
});

test("bridge: a duplicate message_id gives one submission and one answer", async () => {
  await withRig(async (rig) => {
    const u = textUpdate(USER_ID, "once only", { messageId: 55 });
    await rig.tg.bot.handleUpdate(u as never);
    await rig.tg.bot.handleUpdate(u as never); // Telegram redelivers the same update right away
    await waitFor(() => rig.tg.messageTexts().some((m) => m.text === "echo: once only"), 8000, "the answer");
    await rig.bridge.delivery()!.idle();
    await rig.tg.bot.handleUpdate(u as never); // and again after delivery
    await sleep(150);
    await rig.bridge.delivery()!.idle();
    assert.equal(rig.fake.chatRequests().length, 1, "the model ran once");
    assert.equal(rig.tg.messageTexts().filter((m) => m.text === "echo: once only").length, 1, "one answer");
  });
});

test("bridge: a stranger and a group message never reach the model and get no reply", async () => {
  await withRig(async (rig) => {
    await rig.tg.bot.handleUpdate(textUpdate(999, "let me in") as never);
    await rig.tg.bot.handleUpdate(textUpdate(USER_ID, "group hi", { chatId: -77, chatType: "group" }) as never);
    await sleep(100);
    assert.equal(rig.fake.chatRequests().length, 0);
    assert.equal(rig.tg.of("sendMessage").length, 0);
    assert.equal(rig.log.events("telegram.dropped").length, 2);
  });
});

test("bridge: non-text gets 'Only text is supported for now.'; unknown commands and stale updates never reach the model", async () => {
  await withRig(async (rig) => {
    await rig.tg.bot.handleUpdate(photoUpdate(USER_ID) as never);
    assert.deepEqual(sent(rig), ["Only text is supported for now."]);
    await rig.tg.bot.handleUpdate(textUpdate(USER_ID, "/frobnicate") as never);
    assert.match(sent(rig)[1] ?? "", /^Unknown command/);
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
    await rig.tg.bot.handleUpdate(textUpdate(USER_ID, "old news", { date: twoDaysAgo }) as never);
    await sleep(100);
    assert.equal(rig.fake.chatRequests().length, 0);
    assert.equal(sent(rig).length, 2);
    assert.equal(rig.log.events("telegram.stale_update_dropped").length, 1);
  });
});

test("conversations: the map survives a reopen, owners keep old ids, /new changes the id", async () => {
  const dir = tempDir();
  const fake = await startFakeOpenAi({ behavior: echoBehavior, modelId: MODEL_ID });
  try {
    const r1 = await openRig({ dir, fake, noStart: true });
    const c1 = new ChatConversations({ harness: r1.harness, modelRef: { provider: "lmstudio", modelId: MODEL_ID } });
    await c1.load();
    const a = await c1.current(USER_ID);
    const a2 = await c1.current(USER_ID);
    assert.equal(String(a.id), String(a2.id), "second call reuses the mapping");
    assert.equal(c1.chatForConversation(String(a.id)), USER_ID);
    await r1.shutdown();

    const r2 = await openRig({ dir, fake, noStart: true });
    const c2 = new ChatConversations({ harness: r2.harness, modelRef: { provider: "lmstudio", modelId: MODEL_ID } });
    await c2.load();
    assert.equal(c2.currentConversationId(USER_ID), String(a.id));
    const again = await c2.current(USER_ID);
    assert.equal(String(again.id), String(a.id), "the same conversation after reopen");
    const fresh = await c2.startNew(USER_ID);
    assert.notEqual(String(fresh.id), String(a.id), "/new changes the id");
    assert.equal(c2.currentConversationId(USER_ID), String(fresh.id));
    assert.equal(c2.chatForConversation(String(a.id)), USER_ID, "the old conversation still maps to its chat");
    assert.equal(c2.chatForConversation(String(fresh.id)), USER_ID);
    await r2.shutdown();

    const r3 = await openRig({ dir, fake, noStart: true });
    const c3 = new ChatConversations({ harness: r3.harness, modelRef: { provider: "lmstudio", modelId: MODEL_ID } });
    await c3.load();
    assert.equal(c3.currentConversationId(USER_ID), String(fresh.id), "the remap is durable");
    assert.deepEqual(c3.chatIds(), [USER_ID]);
    await r3.shutdown();
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: concurrent first messages from one chat create exactly one conversation", async () => {
  await withRig(async (rig) => {
    await Promise.all([
      rig.tg.bot.handleUpdate(textUpdate(USER_ID, "one", { messageId: 1 }) as never),
      rig.tg.bot.handleUpdate(textUpdate(USER_ID, "two", { messageId: 2 }) as never),
    ]);
    await waitFor(() => rig.tg.messageTexts().filter((m) => m.text.startsWith("echo:")).length === 2, 10_000, "both answers");
    const map = await rig.harness.snapshot(chatMapDoc, BACKGROUND_CONTEXT);
    assert.equal(Object.keys(map?.owners ?? {}).length, 1);
  });
});

test("bridge: a pending answer is delivered after a restart, exactly once, without re-running the model", async () => {
  const dir = tempDir();
  const fake = await startFakeOpenAi({ behavior: echoBehavior, modelId: MODEL_ID });
  try {
    // First life: Telegram is unreachable when the answer is ready, so the item stays pending.
    const tg1 = createFakeTelegram();
    const r1 = await openRig({ dir, fake, tg: tg1, bridge: { retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 }, redeliverDelayMs: 100_000 } });
    tg1.failNext("sendMessage", { kind: "network" }, Infinity);
    tg1.failNext("editMessageText", { kind: "network" }, Infinity);
    await r1.tg.bot.handleUpdate(textUpdate(USER_ID, "survive the restart", { messageId: 77 }) as never);
    await waitFor(() => r1.log.events("telegram.delivery_failed").length >= 1, 10_000, "a failed delivery");
    await r1.bridge.delivery()!.idle();
    const before = await r1.harness.snapshot(pendingDoc, BACKGROUND_CONTEXT);
    const item = before?.items[`tg:${USER_ID}:77`];
    assert.equal(item?.delivered, false, "still pending");
    assert.equal(item?.sentChunks, 0);
    assert.equal(tg1.sentTexts().length, 0, "nothing reached the user");
    await r1.shutdown(); // the process dies here

    // Second life: same SQLite file, working Telegram.
    const tg2 = createFakeTelegram();
    const r2 = await openRig({ dir, fake, tg: tg2 });
    await waitFor(() => tg2.messageTexts().some((m) => m.text === "echo: survive the restart"), 10_000, "the answer after restart");
    await r2.bridge.delivery()!.idle();
    assert.equal(tg2.messageTexts().filter((m) => m.text === "echo: survive the restart").length, 1);
    assert.equal(fake.chatRequests().length, 1, "the model was not asked again");
    const after = await r2.harness.snapshot(pendingDoc, BACKGROUND_CONTEXT);
    assert.equal(after?.items[`tg:${USER_ID}:77`]?.delivered, true);
    await r2.shutdown();

    // Third life: nothing left to deliver.
    const tg3 = createFakeTelegram();
    const r3 = await openRig({ dir, fake, tg: tg3 });
    await sleep(150);
    assert.equal(tg3.messageTexts().filter((m) => m.text.startsWith("echo:")).length, 0);
    // and a Telegram redelivery of the same update after the restart is still a no-op
    await r3.tg.bot.handleUpdate(textUpdate(USER_ID, "survive the restart", { messageId: 77 }) as never);
    await sleep(150);
    assert.equal(fake.chatRequests().length, 1);
    assert.equal(tg3.messageTexts().filter((m) => m.text.startsWith("echo:")).length, 0);
    await r3.shutdown();
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge: streaming edits one placeholder at most every interval, then the final answer replaces it", async () => {
  const text = "word ".repeat(600);
  const fake = await startFakeOpenAi({ modelId: MODEL_ID, behavior: () => ({ type: "text", text, chunkSize: 100, chunkDelayMs: 25 }) });
  await withRig(
    async (rig) => {
      await rig.tg.bot.handleUpdate(textUpdate(USER_ID, "stream please", { messageId: 5 }) as never);
      await waitFor(() => rig.tg.messageTexts().some((m) => m.text === text), 15_000, "the final answer");
      await rig.bridge.delivery()!.idle();
      const sends = rig.tg.of("sendMessage");
      const edits = rig.tg.of("editMessageText");
      assert.equal(sends.length, 1, "one message: the placeholder, which became the answer");
      assert.ok(edits.length >= 2, `placeholder was edited while streaming (${edits.length} edits)`);
      const streamEdits = edits.slice(0, -1);
      assert.ok(String(sends[0]!.payload["text"]).length < text.length, "the placeholder started small");
      const times = [sends[0]!.at, ...streamEdits.map((e) => e.at)];
      for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= 45, `edits are throttled (gap ${times[i]! - times[i - 1]!} ms for a 60 ms interval)`);
      assert.equal(String(edits.at(-1)!.payload["text"]), text, "the last edit is the final answer");
    },
    { fake },
  );
});

test("bridge: tool progress lines show while a tool runs", async () => {
  // Drive the pure reducer with events shaped like the Harness emits them.
  const { applyEvent, newStreamState, renderStream } = await import("../../src/telegram/stream.js");
  const st = newStreamState();
  applyEvent(st, { type: "run_start", inputs: [1] } as never);
  applyEvent(st, { type: "tool_execution_start", toolCallId: "t1", toolName: "read_file", args: {} } as never);
  assert.equal(renderStream(st), "running read_file…");
  applyEvent(st, { type: "tool_execution_end", toolCallId: "t1", toolName: "read_file", entry: {} } as never);
  applyEvent(st, { type: "message_start", message: { role: "assistant" } } as never);
  applyEvent(st, { type: "message_update", usage: {}, changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "Hel" } }, { type: "text_delta", contentIndex: 0, delta: "lo" }] } as never);
  assert.equal(renderStream(st), "read_file done\n\nHello");
  applyEvent(st, { type: "message_start", message: { role: "assistant" } } as never);
  assert.equal(renderStream(st), "read_file done", "a new assistant message starts empty");
});

test("bridge: a long answer is sent in chunks of at most 4096 characters and loses nothing", async () => {
  const text = Array.from({ length: 1500 }, (_, i) => `line ${i} ${"x".repeat(5)}`).join("\n"); // about 15 000 chars
  const fake = await startFakeOpenAi({ modelId: MODEL_ID, behavior: () => ({ type: "text", text }) });
  await withRig(
    async (rig) => {
      await rig.tg.bot.handleUpdate(textUpdate(USER_ID, "long please", { messageId: 9 }) as never);
      await waitFor(
        async () => {
          const item = (await rig.harness.snapshot(pendingDoc, BACKGROUND_CONTEXT))?.items[`tg:${USER_ID}:9`];
          return item?.delivered === true;
        },
        15_000,
        "delivery of all chunks",
      );
      const msgs = rig.tg.messageTexts();
      assert.ok(msgs.length >= 4, `at least 4 messages, got ${msgs.length}`);
      for (const m of msgs) assert.ok(m.text.length <= 4096, `message ${m.id} has ${m.text.length} characters`);
      assert.equal(msgs.map((m) => m.text).join(""), text);
    },
    { fake },
  );
});

test("bridge: offline notice once per outage while the answer still arrives", async () => {
  const listeners: ((s: HealthStatus) => void)[] = [];
  let status: HealthStatus = { runner: "lmstudio", up: true, since: 1, lastCheckedAt: 1, detail: "ok" };
  const health = { status: () => status, onChange: (cb: (s: HealthStatus) => void) => void listeners.push(cb) };
  await withRig(
    async (rig) => {
      status = { runner: "lmstudio", up: false, since: 2, lastCheckedAt: 2, detail: "runner unreachable: ECONNREFUSED" };
      for (const l of listeners) l(status);
      await rig.tg.bot.handleUpdate(textUpdate(USER_ID, "are you there", { messageId: 21 }) as never);
      await rig.tg.bot.handleUpdate(textUpdate(USER_ID, "hello?", { messageId: 22 }) as never);
      await waitFor(() => rig.tg.messageTexts().filter((m) => m.text.startsWith("echo:")).length === 2, 10_000, "both answers");
      const notices = sent(rig).filter((t) => t.startsWith("The model is offline (LM Studio not running)"));
      assert.equal(notices.length, 1, "one notice per outage");
    },
    { health },
  );
});

test("bridge: /stop aborts a running answer without a stray error message, and the chat keeps working", async () => {
  const fake = await startFakeOpenAi({ modelId: MODEL_ID, behavior: ({ lastUser }) => (/hang/.test(lastUser) ? { type: "hang" } : { type: "text", text: `echo: ${lastUser}` }) });
  await withRig(
    async (rig) => {
      await rig.tg.bot.handleUpdate(textUpdate(USER_ID, "please hang", { messageId: 31 }) as never);
      await waitFor(() => rig.fake.chatRequests().length === 1, 8000, "the model request");
      await rig.tg.bot.handleUpdate(textUpdate(USER_ID, "/stop", { messageId: 32 }) as never);
      assert.ok(sent(rig).some((t) => t.startsWith("Stopped.")), `got ${JSON.stringify(sent(rig))}`);
      await waitFor(() => rig.bridge.delivery()!.inFlight() === 0, 8000, "delivery to settle");
      assert.ok(!sent(rig).some((t) => /could not answer/i.test(t)), "an aborted run says nothing more");
      await rig.tg.bot.handleUpdate(textUpdate(USER_ID, "next question", { messageId: 33 }) as never);
      await waitFor(() => rig.tg.messageTexts().some((m) => m.text === "echo: next question"), 10_000, "the next answer");
    },
    { fake },
  );
});

test("bridge: /new maps the chat to a new conversation that answers independently", async () => {
  await withRig(async (rig) => {
    await rig.tg.bot.handleUpdate(textUpdate(USER_ID, "first", { messageId: 41 }) as never);
    await waitFor(() => rig.tg.messageTexts().some((m) => m.text === "echo: first"), 8000, "first answer");
    const before = (await rig.harness.snapshot(chatMapDoc, BACKGROUND_CONTEXT))?.chats[String(USER_ID)];
    await rig.tg.bot.handleUpdate(textUpdate(USER_ID, "/new", { messageId: 42 }) as never);
    assert.ok(sent(rig).includes("Started a new conversation."));
    const after = (await rig.harness.snapshot(chatMapDoc, BACKGROUND_CONTEXT))?.chats[String(USER_ID)];
    assert.ok(before && after && before !== after, "a different conversation id");
    await rig.tg.bot.handleUpdate(textUpdate(USER_ID, "second", { messageId: 43 }) as never);
    await waitFor(() => rig.tg.messageTexts().some((m) => m.text === "echo: second"), 8000, "second answer");
    // the new conversation's context holds only the new message
    const lastReq = rig.fake.chatRequests().at(-1)!.body!;
    const users = lastReq.messages.filter((m) => m.role === "user");
    assert.equal(users.length, 1, "no history from the old conversation");
  });
});

test("bridge: start() sets the commands, polls through getUpdates and handles a queued update; stop() ends polling", async () => {
  const tg = createFakeTelegram();
  tg.queueUpdate(textUpdate(USER_ID, "via polling", { messageId: 61 }));
  await withRig(
    async (rig) => {
      assert.equal(rig.tg.of("setMyCommands").length, 1);
      const cmds = (rig.tg.of("setMyCommands")[0]!.payload["commands"] as { command: string }[]).map((c) => c.command);
      assert.deepEqual(cmds, ["new", "stop", "status", "killshell"]);
      assert.ok(rig.tg.of("deleteWebhook").length >= 1, "long polling, no webhook");
      await waitFor(() => rig.tg.messageTexts().some((m) => m.text === "echo: via polling"), 10_000, "answer to the polled update");
    },
    { tg },
  );
});
