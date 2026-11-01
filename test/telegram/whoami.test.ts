import assert from "node:assert/strict";
import { test } from "node:test";
import { devSecretsPath, runWhoami, whoamiLine } from "../../scripts/whoami-telegram.js";
import { createFakeTelegram, photoUpdate, textUpdate } from "./helpers/fakeTelegram.js";

test("whoami: prints from.id, chat.id and chat.type of every message and never replies", async () => {
  const tg = createFakeTelegram();
  tg.queueUpdate(textUpdate(4242, "secret words that must not be printed"));
  tg.queueUpdate(textUpdate(999, "hi", { chatId: -50, chatType: "group" }));
  tg.queueUpdate(photoUpdate(4242));
  const lines: string[] = [];
  const res = await runWhoami(tg.bot, { durationMs: 120, print: (l) => lines.push(l) });
  assert.equal(res.seen, 3);
  assert.deepEqual(lines, ["from.id=4242 chat.id=4242 chat.type=private", "from.id=999 chat.id=-50 chat.type=group", "from.id=4242 chat.id=4242 chat.type=private"]);
  assert.ok(!lines.join("\n").includes("secret words"));
  assert.equal(tg.of("sendMessage").length, 0, "never replies");
  assert.equal(tg.of("editMessageText").length, 0);
  assert.deepEqual(tg.of("getUpdates").map((c) => c.method), []); // getUpdates is not recorded by the fake
});

test("whoami: line format and the dev secrets path", () => {
  assert.equal(whoamiLine(undefined, 5, "channel"), "from.id=unknown chat.id=5 chat.type=channel");
  assert.equal(devSecretsPath(["--secrets", "C:\\x\\s.json"], {}), "C:\\x\\s.json");
  assert.match(devSecretsPath([], { A7_DEV_DIR: "D:\\dev" }), /D:\\dev[\\/]secrets\.json$/);
  assert.match(devSecretsPath([], { LOCALAPPDATA: "C:\\L" }), /agent-007-dev[\\/]secrets\.json$/);
});
