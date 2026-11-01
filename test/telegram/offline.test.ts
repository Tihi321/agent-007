import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunnerName } from "../../src/config/schema.js";
import type { HealthStatus } from "../../src/runtime/health.js";
import { OfflineNotifier, offlineNotice } from "../../src/telegram/offline.js";
import { createFakeTelegram, memoryLogger, sleep } from "./helpers/fakeTelegram.js";

function stub(runner: RunnerName, initial: Partial<HealthStatus> = {}) {
  let status: HealthStatus = { runner, up: true, since: 1, lastCheckedAt: 1, detail: "ok", ...initial };
  const listeners: ((s: HealthStatus) => void)[] = [];
  return {
    status: () => status,
    onChange: (cb: (s: HealthStatus) => void) => void listeners.push(cb),
    set(up: boolean, detail = up ? "ok" : "runner unreachable: ECONNREFUSED") {
      status = { ...status, up, detail, lastCheckedAt: status.lastCheckedAt + 1, since: status.lastCheckedAt + 1 };
      for (const l of listeners) l(status);
    },
  };
}

for (const [runner, label] of [
  ["lmstudio", "LM Studio"],
  ["strata", "Strata"],
] as const) {
  test(`offline (${label}): in-flight chats are told once per outage, new messages once, no spam`, async () => {
    const tg = createFakeTelegram();
    const health = stub(runner);
    let inflight = [11];
    const n = new OfflineNotifier({ api: tg.bot.api, health, runner, inFlightChats: () => inflight, logger: memoryLogger() });
    const expected = `The model is offline (${label} not running). Your message is queued and will be answered when it is back.`;
    assert.equal(offlineNotice(runner), expected);

    n.noteMessage(11); // runner is up: nothing
    assert.equal(tg.calls.length, 0);

    health.set(false); // down: chat 11 has a message in flight
    await sleep(10);
    assert.deepEqual(tg.sentTexts(11), [expected]);

    health.set(false); // another failed probe: no change event content, still down
    n.noteMessage(11); // same chat again within the outage
    n.noteMessage(11);
    await sleep(10);
    assert.equal(tg.of("sendMessage").length, 1, "no repeat within one outage");

    n.noteMessage(22); // a different chat writes during the outage
    n.noteMessage(22);
    await sleep(10);
    assert.deepEqual(tg.sentTexts(22), [expected]);

    health.set(true); // recovery clears the memory
    inflight = [11];
    health.set(false); // a second outage
    await sleep(10);
    assert.equal(tg.sentTexts(11).length, 2, "a new outage notifies again");
  });
}

test("offline: 'not checked yet' and a busy-but-up Strata send nothing", async () => {
  const tg = createFakeTelegram();
  const health = stub("strata", { up: false, lastCheckedAt: 0, detail: "not checked yet" });
  const n = new OfflineNotifier({ api: tg.bot.api, health, runner: "strata", inFlightChats: () => [5], logger: memoryLogger() });
  n.noteMessage(5);
  health.set(true, "busy (health probe timed out)"); // Strata busy with another sequence: UP
  n.noteMessage(5);
  await sleep(10);
  assert.equal(tg.calls.length, 0);
});

test("offline: a failed notice is retried on the next message of the outage", async () => {
  const tg = createFakeTelegram();
  const health = stub("lmstudio");
  const n = new OfflineNotifier({ api: tg.bot.api, health, runner: "lmstudio", inFlightChats: () => [], logger: memoryLogger() });
  health.set(false);
  tg.failNext("sendMessage", { kind: "network" });
  n.noteMessage(9);
  await sleep(10);
  n.noteMessage(9);
  await sleep(10);
  assert.equal(tg.of("sendMessage").length, 2, "two attempts");
  assert.equal(tg.sentTexts(9).length, 1, "first attempt failed, second delivered");
});
