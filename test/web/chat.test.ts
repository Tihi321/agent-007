/** S34: chat API against a scripted engine: threads, streaming with resume, stop, regenerate, approvals, quotas, per-user isolation. Offline. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { userPaths } from "../../src/web/paths.js";
import { BOT, ScriptedEngine, makeApp, until, wait } from "./app.js";

async function setup(engine = new ScriptedEngine(), o: Parameters<typeof makeApp>[0] = {}) {
  const t = await makeApp({ engine, ...o });
  const alice = await t.addUser("alice@example.com");
  const created = await t.post(alice, "/api/bots/create", BOT);
  assert.equal(created.status, 200, created.text);
  return { t, alice, botId: created.json().bot.id as string };
}

const send = (t: Awaited<ReturnType<typeof makeApp>>, w: Parameters<typeof t.post>[0], bot: string, text: string, thread?: string) => t.post(w, "/api/chat/send", { bot, text, ...(thread ? { thread } : {}) });
const events = (raw: string): { id: number; type: string; data: any }[] =>
  raw
    .split("\n\n")
    .map((blk) => {
      const id = /^id: (\d+)/m.exec(blk)?.[1];
      const type = /^event: (\w+)/m.exec(blk)?.[1];
      const data = /^data: (.*)$/m.exec(blk)?.[1];
      return id && type && data ? { id: Number(id), type, data: JSON.parse(data) } : undefined;
    })
    .filter((e): e is { id: number; type: string; data: any } => e !== undefined);

test("a chat: send, stream (SSE), history is stored on the server and survives a reload; usage and the audit hold lengths, not text", async () => {
  const { t, alice, botId } = await setup();
  try {
    const sent = await send(t, alice, botId, "Hi there, secret-question-text");
    assert.equal(sent.status, 200, sent.text);
    const threadId = sent.json().threadId as string;
    const raw = await t.stream(alice, `bot=${botId}&thread=${threadId}`, { until: /event: done/ });
    assert.match(raw, /^HTTP 200/);
    const evs = events(raw);
    assert.deepEqual(evs.map((e) => e.type), ["start", "delta", "delta", "done"]);
    assert.equal(evs.filter((e) => e.type === "delta").map((e) => e.data.text).join(""), "Hello world");
    assert.deepEqual(evs.map((e) => e.id), [1, 2, 3, 4]);
    await t.app.chat.settle(alice.userId, threadId);
    // "reload": a fresh read of the thread has both messages
    const th = (await t.post(alice, "/api/chat/thread/get", { bot: botId, thread: threadId })).json();
    assert.deepEqual(th.thread.messages.map((m: any) => [m.role, m.text]), [["user", "Hi there, secret-question-text"], ["assistant", "Hello world"]]);
    assert.deepEqual(th.thread.messages[1].usage, { input: 10, output: 5 });
    assert.equal(th.thread.title, "Hi there, secret-question-text");
    const list = (await t.post(alice, "/api/chat/threads", { bot: botId })).json().threads;
    assert.equal(list.length, 1);
    assert.equal(list[0].preview, "Hello world");
    const u = (await t.post(alice, "/api/chat/usage", {})).json();
    assert.deepEqual([u.chatsToday, u.tokensToday], [1, 15]);
    // a second turn sees the history, and the engine got the persona fenced as data
    await until(() => !t.app.chat.run(alice.userId, threadId) || t.app.chat.run(alice.userId, threadId)!.done);
    await send(t, alice, botId, "and again", threadId);
    await t.app.chat.settle(alice.userId, threadId);
    const last = t.engine.calls[1]!;
    assert.deepEqual(last.history.map((h) => h.role), ["user", "assistant"]);
    assert.equal(last.userText, "and again");
    assert.match(last.system, /<persona>\nYou love tea\.\n<\/persona>/);
    assert.deepEqual(last.tools.map((x) => x.name).sort(), ["read_file", "remember", "tool_search", "write_file"]);
    // I54: audit has hashes and lengths, never the text
    const audit = JSON.stringify(t.audit.events);
    assert.ok(!audit.includes("secret-question-text") && !audit.includes("Hello world"));
    assert.ok(t.audit.events.some((e) => e.kind === "chat_turn" && typeof e.detail?.["q_sha256"] === "string"));
  } finally {
    await t.close();
  }
});

test("SSE resume: Last-Event-ID replays only what was missed; a late client replays the whole run; after it expires the stream is idle", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const engine = new ScriptedEngine(async (tr) => {
    tr.emit({ type: "delta", text: "one " });
    tr.emit({ type: "delta", text: "two " });
    await gate;
    tr.emit({ type: "delta", text: "three" });
  });
  const { t, alice, botId } = await setup(engine, { keepRunMs: 300 });
  try {
    const sent = (await send(t, alice, botId, "go")).json();
    const q = `bot=${botId}&thread=${sent.threadId}`;
    await until(() => (t.app.chat.run(alice.userId, sent.threadId)?.events.length ?? 0) >= 3);
    const first = events(await t.stream(alice, q, { until: /two/ }));
    assert.deepEqual(first.map((e) => e.type), ["start", "delta", "delta"]);
    // the browser went away and came back with the last id it saw
    release();
    const resumed = events(await t.stream(alice, q, { lastEventId: 3, until: /event: done/ }));
    assert.deepEqual(resumed.map((e) => [e.id, e.type]), [[4, "delta"], [5, "done"]]);
    // a client that connects after the end gets the whole run
    const late = events(await t.stream(alice, q, { until: /event: done/ }));
    assert.equal(late.map((e) => e.data.text ?? "").join(""), "one two three");
    await wait(450);
    const idle = await t.stream(alice, q, { timeoutMs: 1000 });
    assert.match(idle, /event: idle/);
  } finally {
    await t.close();
  }
});

test("stop keeps the partial answer and marks it stopped; regenerate replaces the last answer; a second send is refused while one runs", async () => {
  let n = 0;
  const engine = new ScriptedEngine(async (tr) => {
    n++;
    tr.emit({ type: "delta", text: n === 1 ? "partial " : `try ${n}` });
    if (n === 1) await new Promise<void>((r) => tr.signal.addEventListener("abort", () => r(), { once: true }));
    return n === 1 ? { stopReason: "aborted" as const } : undefined;
  });
  const { t, alice, botId } = await setup(engine);
  try {
    const { threadId } = (await send(t, alice, botId, "long task")).json();
    await until(() => (t.app.chat.run(alice.userId, threadId)?.events.length ?? 0) >= 2);
    const again = await send(t, alice, botId, "another", threadId);
    assert.equal(again.status, 409);
    assert.match(again.json().message, /still answering/);
    assert.equal((await t.post(alice, "/api/chat/stop", { thread: threadId })).json().stopped, true);
    await t.app.chat.settle(alice.userId, threadId);
    let th = (await t.post(alice, "/api/chat/thread/get", { bot: botId, thread: threadId })).json().thread;
    assert.deepEqual([th.messages[1].text, th.messages[1].stopped], ["partial ", true]);
    assert.equal((await t.post(alice, "/api/chat/stop", { thread: threadId })).json().stopped, false, "nothing left to stop");
    assert.equal((await t.post(alice, "/api/chat/regenerate", { bot: botId, thread: threadId })).status, 200);
    await t.app.chat.settle(alice.userId, threadId);
    th = (await t.post(alice, "/api/chat/thread/get", { bot: botId, thread: threadId })).json().thread;
    assert.deepEqual(th.messages.map((m: any) => m.text), ["long task", "try 2"], "the stopped answer was replaced");
    assert.equal(t.engine.calls[1]?.userText, "long task");
    assert.equal(t.engine.calls[1]?.history.length, 0);
  } finally {
    await t.close();
  }
});

test("quota: the day's messages and tokens are capped with a clear message; the hit is audited; nothing runs past it", async () => {
  const t = await makeApp();
  try {
    const bob = await t.addUser("bob@example.com", { maxChatsPerDay: 2, maxTokensPerDay: 1_000_000 });
    const bot = (await t.post(bob, "/api/bots/create", BOT)).json().bot.id as string;
    const th = (await send(t, bob, bot, "one")).json().threadId as string;
    await t.app.chat.settle(bob.userId, th);
    await send(t, bob, bot, "two", th);
    await t.app.chat.settle(bob.userId, th);
    const third = await send(t, bob, bot, "three", th);
    assert.equal(third.status, 429);
    assert.match(third.json().message, /used all 2 messages for today/);
    assert.equal(t.engine.calls.length, 2);
    assert.ok(t.audit.events.some((e) => e.kind === "quota_hit" && e.detail?.["which"] === "chats"));
    // tokens
    const carol = await t.addUser("carol@example.com", { maxTokensPerDay: 20, maxChatsPerDay: 100 });
    const cb = (await t.post(carol, "/api/bots/create", BOT)).json().bot.id as string;
    const ct = (await send(t, carol, cb, "x")).json().threadId as string;
    await t.app.chat.settle(carol.userId, ct);
    const over = await send(t, carol, cb, "y", ct);
    assert.equal(over.status, 200, "15 of 20 tokens used");
    await t.app.chat.settle(carol.userId, ct);
    const blocked = await send(t, carol, cb, "z", ct);
    assert.equal(blocked.status, 429);
    assert.match(blocked.json().message, /allowance of 20 tokens/);
    // the next UTC day starts fresh
    t.clock.t += 24 * 3_600_000;
    assert.equal(t.app.chat.usage(carol.userId).tokensToday, 0);
  } finally {
    await t.close();
  }
});

test("approval cards: write_file waits for the user's tap; only that user can answer; deny and timeout do nothing; the token is single use", async () => {
  let outcome: any;
  const engine = new ScriptedEngine(async (tr) => {
    outcome = await tr.callTool("write_file", { path: "note.txt", content: "hello from the bot" });
    tr.emit({ type: "delta", text: outcome.ok ? "saved" : "not saved" });
  });
  const { t, alice, botId } = await setup(engine);
  try {
    const bob = await t.addUser("bob@example.com");
    const run = async (decide: (token: string) => Promise<void>) => {
      const { threadId } = (await send(t, alice, botId, "write it")).json();
      await until(() => (t.app.chat.run(alice.userId, threadId)?.events.some((e) => e.ev.type === "approval") ?? false));
      const card = (t.app.chat.run(alice.userId, threadId)!.events.find((e) => e.ev.type === "approval")!.ev as any).card;
      assert.equal(card.tool, "write_file");
      assert.match(card.summary, /note\.txt/);
      assert.ok(!existsSync(join(userPaths(t.dir, alice.userId).bot(botId).workspaceDir, "note.txt")), "nothing is written before the tap");
      await decide(card.token);
      await t.app.chat.settle(alice.userId, threadId);
      return { threadId, card };
    };
    const file = join(userPaths(t.dir, alice.userId).bot(botId).workspaceDir, "note.txt");
    // another user and the owner cannot answer alice's card
    const first = await run(async (tok) => {
      assert.equal((await t.post(bob, "/api/chat/approval", { token: tok, decision: "approve" })).status, 404);
      assert.equal((await t.post(t.owner, "/api/chat/approval", { token: tok, decision: "approve" })).status, 404);
      assert.ok(t.audit.events.filter((e) => e.kind === "tool_denied" && e.detail?.["reason"] === "approval token of another user").length >= 2);
      assert.equal((await t.post(alice, "/api/chat/approval", { token: tok, decision: "deny" })).status, 200);
    });
    assert.equal(outcome.ok, false);
    assert.ok(!existsSync(file), "denied: not written");
    assert.equal((await t.post(alice, "/api/chat/approval", { token: first.card.token, decision: "approve" })).status, 404, "single use");
    // approve
    await run(async (tok) => {
      assert.equal((await t.post(alice, "/api/chat/approval", { token: tok, decision: "approve" })).status, 200);
    });
    assert.equal(outcome.ok, true);
    assert.equal(readFileSync(file, "utf8"), "hello from the bot");
    assert.ok(t.audit.events.some((e) => e.kind === "approval" && e.detail?.["decision"] === "approved"));
    // stop while a card is open denies it
    const { threadId } = (await send(t, alice, botId, "again")).json();
    await until(() => (t.app.chat.run(alice.userId, threadId)?.events.some((e) => e.ev.type === "approval") ?? false));
    t.app.chat.stop(alice.userId, threadId);
    await t.app.chat.settle(alice.userId, threadId);
    assert.equal(t.app.chat.approvals.pendingCount(), 0);
  } finally {
    await t.close();
  }
});

test("scheduling: one turn per user at a time, one model slot for everybody; a user cannot start a second thread's turn in parallel", async () => {
  let active = 0;
  let max = 0;
  const engine = new ScriptedEngine(async (tr) => {
    active++;
    max = Math.max(max, active);
    await wait(60);
    tr.emit({ type: "delta", text: "ok" });
    active--;
  });
  const { t, alice, botId } = await setup(engine);
  try {
    const bob = await t.addUser("bob@example.com");
    const bb = (await t.post(bob, "/api/bots/create", BOT)).json().bot.id as string;
    const t1 = (await send(t, alice, botId, "a1")).json().threadId as string;
    const t2 = (await t.post(alice, "/api/chat/thread/create", { bot: botId })).json().thread.id as string;
    const second = await send(t, alice, botId, "a2", t2);
    const other = await send(t, bob, bb, "b1");
    assert.equal(second.status, 200);
    assert.equal(other.status, 200);
    await Promise.all([t.app.chat.settle(alice.userId, t1), t.app.chat.settle(alice.userId, t2), t.app.chat.settle(bob.userId, other.json().threadId)]);
    assert.equal(max, 1, "never two turns at once on a one-slot model");
    assert.equal(t.engine.calls.length, 3);
  } finally {
    await t.close();
  }
});

test("IDOR: another user's bot id, thread id, stream, approval token and export are all just 'not found'", async () => {
  const { t, alice, botId } = await setup();
  try {
    const bob = await t.addUser("bob@example.com");
    const { threadId } = (await send(t, alice, botId, "alice private text")).json();
    await t.app.chat.settle(alice.userId, threadId);
    // bob has no bot named like alice's; alice's ids mean nothing in bob's folders
    const tries: [string, unknown][] = [
      ["/api/chat/thread/get", { bot: botId, thread: threadId }],
      ["/api/chat/thread/rename", { bot: botId, thread: threadId, title: "mine now" }],
      ["/api/chat/thread/pin", { bot: botId, thread: threadId, pinned: true }],
      ["/api/chat/thread/delete", { bot: botId, thread: threadId }],
      ["/api/chat/thread/export", { bot: botId, thread: threadId, format: "json" }],
      ["/api/chat/send", { bot: botId, thread: threadId, text: "hi" }],
      ["/api/chat/send", { bot: botId, text: "hi" }],
      ["/api/chat/regenerate", { bot: botId, thread: threadId }],
      ["/api/chat/thread/create", { bot: botId }],
      ["/api/bots/get", { id: botId }],
      ["/api/bots/update", { id: botId, ...BOT, name: "hijack" }],
      ["/api/bots/delete", { id: botId }],
    ];
    for (const [path, body] of tries) {
      const r = await t.post(bob, path, body);
      assert.equal(r.status, 404, `${path}: ${r.status} ${r.text}`);
      assert.ok(!r.text.includes("alice private text"), path);
    }
    assert.equal((await t.post(bob, "/api/chat/stop", { thread: threadId })).json().stopped, false);
    assert.match(await t.stream(bob, `bot=${botId}&thread=${threadId}`, { timeoutMs: 800 }), /^HTTP 404/);
    assert.deepEqual((await t.post(bob, "/api/chat/threads", {})).json().threads, []);
    assert.deepEqual((await t.post(bob, "/api/chat/thread/search", { q: "private" })).json().threads, []);
    assert.deepEqual((await t.post(bob, "/api/bots/list", {})).json().bots, []);
    // path-shaped ids never reach the file system
    for (const bad of ["../x", "..\\..\\x", "a/b", "C:\\x", "u:aaaa:b", ""]) {
      for (const [path, body] of [["/api/chat/thread/get", { bot: bad, thread: threadId }], ["/api/chat/thread/get", { bot: botId, thread: bad }], ["/api/bots/get", { id: bad }]] as const) {
        assert.equal((await t.post(alice, path, body)).status, 404, `${path} ${bad}`);
      }
    }
    // alice's data is untouched
    const th = (await t.post(alice, "/api/chat/thread/get", { bot: botId, thread: threadId })).json().thread;
    assert.equal(th.title, "alice private text");
    assert.equal(th.pinned, false);
    assert.equal((await t.post(alice, "/api/bots/get", { id: botId })).json().bot.name, "Helper");
  } finally {
    await t.close();
  }
});

test("threads: rename, pin (pinned first), search, export as markdown and json, delete", async () => {
  const { t, alice, botId } = await setup();
  try {
    const mk = async (text: string) => {
      const id = (await send(t, alice, botId, text)).json().threadId as string;
      await t.app.chat.settle(alice.userId, id);
      return id;
    };
    const a = await mk("apples and pears");
    const b = await mk("bananas");
    assert.equal((await t.post(alice, "/api/chat/thread/rename", { bot: botId, thread: a, title: "Fruit" })).status, 200);
    assert.equal((await t.post(alice, "/api/chat/thread/rename", { bot: botId, thread: a, title: "  " })).status, 400);
    await t.post(alice, "/api/chat/thread/pin", { bot: botId, thread: a, pinned: true });
    const list = (await t.post(alice, "/api/chat/threads", { bot: botId })).json().threads;
    assert.deepEqual(list.map((x: any) => [x.title, x.pinned]), [["Fruit", true], ["bananas", false]]);
    assert.deepEqual((await t.post(alice, "/api/chat/thread/search", { q: "BANANA" })).json().threads.map((x: any) => x.id), [b]);
    assert.deepEqual((await t.post(alice, "/api/chat/thread/search", { q: "x" })).json().threads, [], "one character is not a search");
    const md = (await t.post(alice, "/api/chat/thread/export", { bot: botId, thread: a, format: "md" })).json();
    assert.match(md.body, /^# Fruit/);
    assert.match(md.body, /apples and pears/);
    const js = (await t.post(alice, "/api/chat/thread/export", { bot: botId, thread: a, format: "json" })).json();
    assert.equal(JSON.parse(js.body).messages.length, 2);
    assert.equal((await t.post(alice, "/api/chat/thread/delete", { bot: botId, thread: a })).status, 200);
    assert.equal((await t.post(alice, "/api/chat/thread/get", { bot: botId, thread: a })).status, 404);
  } finally {
    await t.close();
  }
});

test("bots API: the editor cannot set roots, edges or host tools; options list only the user's own presets; maxBots is enforced; the cloud badge shows", async () => {
  const t = await makeApp();
  try {
    const bob = await t.addUser("bob@example.com", { presets: ["strata"], maxBots: 1, tools: ["tool_search", "read_file"] });
    const opts = (await t.post(bob, "/api/bots/options", {})).json();
    assert.deepEqual(opts.presets.map((p: any) => p.id), ["strata"], "the Claude preset is not in bob's caps");
    assert.deepEqual(opts.tools, ["tool_search", "read_file"]);
    assert.equal(opts.maxBots, 1);
    const bad = await t.post(bob, "/api/bots/create", { ...BOT, tools: ["tool_search"], readRoots: [{ alias: "x", path: "C:\\" }], edges: [{ to: "main" }] });
    assert.equal(bad.status, 400);
    assert.match(bad.json().issues.join(), /readRoots: this field cannot be set/);
    assert.equal((await t.post(bob, "/api/bots/create", { ...BOT, tools: ["shell"] })).status, 400);
    assert.equal((await t.post(bob, "/api/bots/create", { ...BOT, tools: ["write_file"] })).status, 400, "not in bob's caps");
    assert.equal((await t.post(bob, "/api/bots/create", { ...BOT, preset: "claude-sonnet", tools: ["tool_search"] })).status, 400);
    const ok = await t.post(bob, "/api/bots/create", { ...BOT, tools: ["tool_search"] });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json().bot.cloud, false);
    assert.equal((await t.post(bob, "/api/bots/create", { ...BOT, name: "Second", tools: ["tool_search"] })).status, 403, "maxBots");
    // the owner may use the Claude preset: the badge and egress note show
    const ob = await t.post(t.owner, "/api/bots/create", { ...BOT, preset: "claude-sonnet", fallback: "strata", name: "Claude bot" });
    assert.equal(ob.status, 200, ob.text);
    assert.equal(ob.json().bot.cloud, true);
    assert.match(ob.json().bot.egressNote, /cloud-safe|Claude/);
    assert.equal(ob.json().bot.fallback, "strata");
  } finally {
    await t.close();
  }
});

test("the gateway offers no route that returns another user's chat text, to the owner or an admin (UI-39)", async () => {
  const { t, alice, botId } = await setup();
  try {
    const { threadId } = (await send(t, alice, botId, "very private words")).json();
    await t.app.chat.settle(alice.userId, threadId);
    for (const path of ["/api/admin/users", "/api/admin/invites", "/api/admin/audit"]) {
      const r = await t.post(t.owner, path, {});
      assert.equal(r.status, 200, path);
      assert.ok(!r.text.includes("very private words") && !r.text.includes("Hello world"), path);
    }
    // the owner using alice's ids sees nothing either
    assert.equal((await t.post(t.owner, "/api/chat/thread/get", { bot: botId, thread: threadId })).status, 404);
  } finally {
    await t.close();
  }
});
