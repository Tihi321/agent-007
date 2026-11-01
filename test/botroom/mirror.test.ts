/**
 * S24.1 and S24.2 evidence with fakes only: the rate cap and the single "dropped n" line, batching, 429 backoff without a loop,
 * a throwing API never reaching the bus, no `getUpdates`/handlers, disabled states, redaction of the mirror token, stop.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBotRoomMirror, botRoomDisabledReason, startBotRoomMirror } from "../../src/botroom/mirror.js";
import type { BotRoomMirror, RoomApi } from "../../src/botroom/mirror.js";
import { DEFAULT_BOT_ROOM } from "../../src/bots/schema.js";
import type { BotRoomSettings } from "../../src/bots/schema.js";
import { createRedactor } from "../../src/logging/redact.js";
import { memoryLogger } from "../telegram/helpers/fakeTelegram.js";
import { ROOM_CHAT_ID, ManualClock, ask, createFakeAuditSource, createRecordingApi } from "./helpers.js";

const settings = (over: Partial<BotRoomSettings> = {}): BotRoomSettings => ({ ...DEFAULT_BOT_ROOM, mode: "truncated", chatId: ROOM_CHAT_ID, ...over });

function rig(over: Partial<BotRoomSettings> = {}, extra: { api?: RoomApi; linesPerPost?: number } = {}) {
  const clock = new ManualClock();
  const rec = createRecordingApi(clock);
  const source = createFakeAuditSource();
  const log = memoryLogger();
  const mirror = createBotRoomMirror({
    source,
    api: extra.api ?? rec.api,
    settings: settings(over),
    chatId: ROOM_CHAT_ID,
    redact: createRedactor(["TOP-SECRET-VALUE"]),
    logger: log,
    now: clock.now,
    timers: clock,
    ...(extra.linesPerPost !== undefined ? { linesPerPost: extra.linesPerPost } : {}),
  });
  mirror.start();
  return { clock, rec, source, log, mirror };
}

const textOf = (c: { payload: Record<string, unknown> }): string => String(c.payload["text"]);

test("a line is posted to the room chat as plain text after the batch window", async () => {
  const { clock, rec, source, mirror } = rig();
  source.emit(ask("hello ops"));
  await clock.advance(1000);
  assert.equal(rec.sends().length, 0, "still inside the batch window");
  await clock.advance(1500);
  assert.equal(rec.sends().length, 1);
  const call = rec.sends()[0]!;
  assert.equal(call.payload["chat_id"], ROOM_CHAT_ID);
  assert.equal(textOf(call), "[research → ops, hop 1, chain 7f3a9c1e] hello ops");
  assert.equal(call.payload["parse_mode"], undefined, "no markup is ever requested");
  assert.equal(call.payload["disable_notification"], true);
  assert.equal(mirror.stats().posts, 1);
});

test("lines inside one batch window share a post; no more than five lines per post", async () => {
  const { clock, rec, source } = rig();
  for (let i = 0; i < 3; i++) source.emit(ask(`m${i}`));
  await clock.advance(2500);
  assert.equal(rec.sends().length, 1);
  assert.equal(textOf(rec.sends()[0]!).split("\n").length, 3);
  for (let i = 0; i < 7; i++) source.emit(ask(`n${i}`));
  await clock.advance(20_000);
  assert.deepEqual(rec.sends().slice(1).map((c) => textOf(c).split("\n").length), [5, 2]);
});

test("a burst of 100 events gives at most 15 posts a minute and exactly one 'dropped n' line", async () => {
  const { clock, rec, source, mirror } = rig();
  for (let i = 0; i < 100; i++) source.emit(ask(`burst ${i}`));
  await clock.advance(60_000);
  const firstMinute = rec.sends().length;
  assert.ok(firstMinute <= 15, `posted ${firstMinute} in the first minute`);
  await clock.advance(240_000);
  const sends = rec.sends();
  assert.ok(sends.length <= 15, `queue is bounded to 15 posts of 5 lines, got ${sends.length}`);
  // Sliding window: no 60 s span holds more than 15 posts.
  for (const s of sends) assert.ok(sends.filter((o) => o.at >= s.at && o.at < s.at + 60_000).length <= 15);
  const notices = sends.flatMap((c) => textOf(c).split("\n")).filter((l) => l.includes("dropped"));
  assert.equal(notices.length, 1, "one dropped line for the whole burst");
  assert.match(notices[0]!, /^… 25 lines dropped/);
  const stats = mirror.stats();
  assert.equal(stats.droppedLines, 25);
  assert.equal(stats.postedLines, 76, "75 mirrored lines plus the one notice line");
  assert.equal(stats.queued, 0);
});

test("sustained traffic never exceeds the configured maxPerMinute in any 60 s window", async () => {
  const { clock, rec, source } = rig({ maxPerMinute: 6 }, { linesPerPost: 1 });
  for (let s = 0; s < 300; s++) {
    source.emit(ask(`tick ${s}`));
    source.emit(ask(`tock ${s}`));
    await clock.advance(1000);
  }
  await clock.advance(120_000);
  const sends = rec.sends();
  assert.ok(sends.length > 6);
  for (const s of sends) assert.ok(sends.filter((o) => o.at >= s.at && o.at < s.at + 60_000).length <= 6);
});

test("maxPerMinute is never above Telegram's 20 even when the setting says more", async () => {
  const { clock, rec, source } = rig({ maxPerMinute: 500 }, { linesPerPost: 1 });
  for (let i = 0; i < 200; i++) source.emit(ask(`m${i}`));
  await clock.advance(60_000);
  assert.ok(rec.sends().length <= 20);
});

test("a 429 pauses posting for retry_after, retries the same post once and does not loop", async () => {
  const { clock, rec, source, log, mirror } = rig();
  rec.failNext({ kind: "api", error_code: 429, description: "Too Many Requests: retry after 30", retry_after: 30 });
  source.emit(ask("will be retried"));
  await clock.advance(2500);
  assert.equal(rec.sends().length, 1, "the failed attempt");
  await clock.advance(25_000);
  assert.equal(rec.sends().length, 1, "no retry before retry_after");
  await clock.advance(10_000);
  assert.equal(rec.sends().length, 2, "one retry");
  assert.equal(textOf(rec.sends()[1]!), textOf(rec.sends()[0]!));
  assert.equal(mirror.stats().posts, 1);
  assert.equal(log.events("botroom.post_failed").length, 1);
  assert.equal(log.events("botroom.post_failed")[0]!.fields && (log.events("botroom.post_failed")[0]!.fields as { code: unknown }).code, 429);
});

test("two 429s in a row drop the post: exactly two attempts, however long we wait", async () => {
  const { clock, rec, source, mirror } = rig();
  rec.failNext({ kind: "api", error_code: 429, description: "Too Many Requests", retry_after: 5 }, 2);
  source.emit(ask("never delivered"));
  await clock.advance(10 * 60_000);
  assert.equal(rec.sends().length, 2);
  assert.equal(mirror.stats().failedPosts, 1);
  assert.equal(mirror.stats().failedLines, 1);
  // The mirror recovers for the next line.
  source.emit(ask("later"));
  await clock.advance(60_000);
  assert.ok(rec.sends().length >= 3);
});

test("a network failure drops that post, counts it, backs off and keeps going afterwards", async () => {
  const { clock, rec, source, mirror } = rig();
  rec.failNext({ kind: "network" });
  source.emit(ask("lost"));
  await clock.advance(2500);
  assert.equal(mirror.stats().failedPosts, 1);
  source.emit(ask("kept"));
  await clock.advance(60_000);
  assert.equal(mirror.stats().posts, 1);
  assert.equal(rec.sends().length, 2);
  assert.match(textOf(rec.sends()[1]!), /kept$/);
});

test("a throwing API leaves the bus untouched: emit never throws, the listener is synchronous, errors are counted", async () => {
  const throwing: RoomApi = {
    sendMessage: () => {
      throw new Error("boom https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_x/sendMessage");
    },
  };
  const { clock, source, log, mirror } = rig({}, { api: throwing });
  let delivered = 0;
  source.subscribe(() => void delivered++);
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) assert.doesNotThrow(() => source.emit(ask(`m${i}`)));
  assert.ok(Date.now() - t0 < 1000, "the listener does not wait for Telegram");
  await clock.advance(10 * 60_000);
  assert.equal(delivered, 50, "the other bus subscriber saw every event");
  assert.ok(mirror.stats().failedPosts >= 1);
  const text = JSON.stringify(log.lines);
  assert.ok(!text.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_x"), "the error text (which can carry the token) is never logged");
});

test("a malformed event does not throw into the bus", () => {
  const { source, mirror } = rig();
  const hostile = {
    get kind(): string {
      throw new Error("getter");
    },
  };
  assert.doesNotThrow(() => source.emit(hostile as never));
  assert.doesNotThrow(() => source.emit(null as never));
  assert.equal(mirror.stats().queued, 0);
});

test("only the Api is used: sendMessage is the only call, never getUpdates, and the module has no handlers or Bot", async () => {
  const { clock, rec, source } = rig();
  for (let i = 0; i < 40; i++) source.emit(ask(`m${i}`));
  await clock.advance(5 * 60_000);
  assert.ok(rec.calls.length > 0);
  assert.deepEqual([...new Set(rec.calls.map((c) => c.method))], ["sendMessage"]);
  const dir = join(process.cwd(), "src", "botroom");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 3);
  for (const f of files) {
    const code = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    assert.ok(!/getUpdates|\.start\(\)|new Bot\(|\bComposer\b|\.on\(|\.command\(|\.use\(/.test(code.replace(/mirror\.start\(\)|start\(\)\s*\{/g, "")), `${f} must not read or register handlers`);
    assert.ok(!code.includes(["@earendil", "works"].join("-")), `${f} must not import Pi packages`);
    assert.ok(!/import[^;]*\bBot\b[^;]*from "grammy"/.test(code), `${f} must not import Bot`);
  }
});

test("events the room never shows (approvals and the like) are ignored and counted", async () => {
  const { clock, rec, source, mirror } = rig();
  source.emit(ask("approve rm -rf?", { kind: "approval" }));
  source.emit(ask("tool output", { kind: "tool_output" }));
  await clock.advance(10_000);
  assert.equal(rec.sends().length, 0);
  assert.equal(mirror.stats().ignored, 2);
});

test("text with secrets reaches the room redacted", async () => {
  const { clock, rec, source } = rig();
  source.emit(ask("token TOP-SECRET-VALUE and key sk-abcdefghijklmnop123456 and password=letmein"));
  await clock.advance(3000);
  const t = textOf(rec.sends()[0]!);
  for (const leak of ["TOP-SECRET-VALUE", "sk-abcdefghijklmnop", "letmein"]) assert.ok(!t.includes(leak), t);
});

test("stop unsubscribes, cancels timers and discards the queue", async () => {
  const { clock, rec, source, mirror } = rig();
  source.emit(ask("queued"));
  assert.equal(source.listeners, 1);
  mirror.stop();
  assert.equal(source.listeners, 0);
  assert.equal(clock.pending(), 0);
  await clock.advance(60_000);
  assert.equal(rec.sends().length, 0);
  mirror.stop(); // idempotent
});

// ---- host wiring (startBotRoomMirror) -----------------------------------------------------------------------------------

test("disabled when mode is none, there is no chat id or there is no mirror token: no subscription, no API", () => {
  const cases: [Partial<BotRoomSettings>, string | undefined, string][] = [
    [{ mode: "none" }, "123456:TOKEN-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "mode_none"],
    [{ chatId: undefined as never }, "123456:TOKEN-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "no_chat_id"],
    [{}, undefined, "no_token"],
    [{}, "   ", "no_token"],
  ];
  for (const [over, token, reason] of cases) {
    const source = createFakeAuditSource();
    const log = memoryLogger();
    const room: BotRoomSettings = { ...settings(over) };
    if ("chatId" in over) delete room.chatId;
    assert.equal(botRoomDisabledReason(room, token), reason);
    const mirror = startBotRoomMirror({ botRoom: room, mirrorToken: token, source, logger: log });
    assert.equal(mirror, undefined);
    assert.equal(source.listeners, 0);
    assert.equal(log.events("botroom.disabled").length, 1);
    assert.deepEqual(log.events("botroom.disabled")[0]!.fields, { reason });
  }
  assert.equal(botRoomDisabledReason(settings(), "123456:TOKEN"), undefined);
});

test("startBotRoomMirror builds an enabled mirror, redacts the mirror token itself, and logs no token", async () => {
  const clock = new ManualClock();
  const rec = createRecordingApi(clock);
  const source = createFakeAuditSource();
  const log = memoryLogger();
  const token = "555000:MIRROR-token-value_zzzzzzzzzzzzzzzzzzzz";
  const mirror = startBotRoomMirror({ botRoom: settings({ mode: "summary" }), mirrorToken: token, source, logger: log, api: rec.api, now: clock.now, timers: clock }) as BotRoomMirror;
  assert.ok(mirror);
  assert.equal(source.listeners, 1);
  source.emit(ask(`leak ${token} here`));
  await clock.advance(3000);
  assert.ok(!textOf(rec.sends()[0]!).includes("MIRROR-token-value"));
  assert.ok(!JSON.stringify(log.lines).includes("MIRROR-token-value"));
  assert.deepEqual(Object.keys(mirror).sort(), ["start", "stats", "stop"], "the mirror exposes no way to read or handle updates");
  mirror.stop();
});

test("startBotRoomMirror with the real Api constructs without any network call and only subscribes", () => {
  const source = createFakeAuditSource();
  const log = memoryLogger();
  const mirror = startBotRoomMirror({ botRoom: settings(), mirrorToken: "555000:MIRROR-token-value_zzzzzzzzzzzzzzzzzzzz", source, logger: log }) as BotRoomMirror;
  assert.ok(mirror);
  assert.equal(source.listeners, 1);
  mirror.stop();
  assert.equal(source.listeners, 0);
});
