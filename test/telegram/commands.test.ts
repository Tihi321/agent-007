import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMAND_LIST, formatDuration, registerCommands } from "../../src/telegram/commands.js";
import type { CommandDeps } from "../../src/telegram/commands.js";
import type { HealthStatus } from "../../src/runtime/health.js";
import { createFakeTelegram, fakeKillSwitch, textUpdate, USER_ID } from "./helpers/fakeTelegram.js";

function rig(over: Partial<CommandDeps> = {}) {
  const tg = createFakeTelegram();
  const order: string[] = [];
  const ks = fakeKillSwitch();
  const deps: CommandDeps = {
    conversations: {
      startNew: async (chatId) => void order.push(`new:${chatId}`),
      abort: async (chatId) => void order.push(`abort:${chatId}`),
    },
    approvals: {
      cancelChat: async (chatId, by) => {
        order.push(`cancelChat:${chatId}:${by}`);
        return 2;
      },
      cancelAll: async (by) => {
        order.push(`cancelAll:${by}`);
        return 1;
      },
      pendingCount: () => 3,
    },
    killSwitch: ks,
    killFlagPath: "C:\\ProgramData\\agent-007\\control\\killshell.flag",
    health: { status: (): HealthStatus => ({ runner: "lmstudio", up: true, since: Date.UTC(2026, 9, 29, 8, 0), lastCheckedAt: 1, detail: "ok" }) },
    runner: { name: "lmstudio", modelId: "qwen-test" },
    shellEnabled: true,
    delivery: { inFlight: () => 0 },
    startedAt: 1_000_000,
    now: () => 1_000_000 + 3 * 3600_000 + 12 * 60_000,
    lastError: () => undefined,
    ...over,
  };
  registerCommands(tg.bot, deps);
  return { tg, deps, order, ks };
}

const reply = (tg: ReturnType<typeof createFakeTelegram>) => String(tg.of("sendMessage").at(-1)?.payload["text"]);

test("/new starts a new conversation for the chat and confirms", async () => {
  const { tg, order } = rig();
  await tg.bot.handleUpdate(textUpdate(USER_ID, "/new") as never);
  assert.deepEqual(order, [`new:${USER_ID}`]);
  assert.match(reply(tg), /new conversation/i);
});

test("/stop cancels pending approvals first (by 'stop'), then aborts the conversation", async () => {
  const { tg, order } = rig();
  await tg.bot.handleUpdate(textUpdate(USER_ID, "/stop") as never);
  assert.deepEqual(order, [`cancelChat:${USER_ID}:stop`, `abort:${USER_ID}`]);
  assert.match(reply(tg), /^Stopped\./);
  assert.match(reply(tg), /2 pending approvals cancelled/);
});

test("/stop answers even if the abort does not finish in time", async () => {
  const { tg } = rig({ conversations: { startNew: async () => undefined, abort: () => new Promise(() => undefined) }, stopWaitMs: 30 });
  await tg.bot.handleUpdate(textUpdate(USER_ID, "/stop") as never);
  assert.match(reply(tg), /Stop requested; it is still winding down/);
});

test("/status shows runner, model, up/down, state, shell, approvals, uptime and last error", async () => {
  const { tg } = rig({ lastError: () => "2026-10-29T10:00:00.000Z GrammyError: boom" });
  await tg.bot.handleUpdate(textUpdate(USER_ID, "/status") as never);
  const t = reply(tg);
  assert.match(t, /Runner: LM Studio \(qwen-test\)/);
  assert.match(t, /Runner status: up since \d{4}-\d\d-\d\d \d\d:\d\d \(ok\)/);
  assert.match(t, /State: idle/);
  assert.match(t, /Shell: enabled/);
  assert.match(t, /Pending approvals: 3/);
  assert.match(t, /Uptime: 3h 12m/);
  assert.match(t, /Last error: .*boom/);
});

test("/status for Strata, busy with a queue, runner down, shell off by kill switch", async () => {
  const ks = fakeKillSwitch(true);
  const { tg } = rig({
    runner: { name: "strata", modelId: "qwen3.8-flash-next-iq3_s" },
    health: { status: (): HealthStatus => ({ runner: "strata", up: false, since: Date.UTC(2026, 9, 29, 9, 0), lastCheckedAt: 5, detail: "runner unreachable: ECONNREFUSED" }) },
    delivery: { inFlight: () => 3 },
    killSwitch: ks,
  });
  await tg.bot.handleUpdate(textUpdate(USER_ID, "/status") as never);
  const t = reply(tg);
  assert.match(t, /Runner: Strata \(qwen3\.8-flash-next-iq3_s\)/);
  assert.match(t, /Runner status: DOWN since .*ECONNREFUSED/);
  assert.match(t, /State: busy \(2 queued/);
  assert.match(t, /Shell: disabled \(kill switch is on/);
  assert.match(t, /Last error: none/);
});

test("/status says why the shell is off when config disables it, and 'not checked yet' before the first probe", async () => {
  const { tg } = rig({ shellEnabled: false, health: { status: (): HealthStatus => ({ runner: "lmstudio", up: false, since: 0, lastCheckedAt: 0, detail: "not checked yet" }) } });
  await tg.bot.handleUpdate(textUpdate(USER_ID, "/status") as never);
  const t = reply(tg);
  assert.match(t, /Shell: disabled \(shell\.enabled is false/);
  assert.match(t, /Runner status: not checked yet/);
});

test("/killshell turns the kill switch on for telegram:<id>, cancels approvals and names the flag path", async () => {
  const { tg, order, ks } = rig();
  await tg.bot.handleUpdate(textUpdate(USER_ID, "/killshell") as never);
  assert.deepEqual(ks.turnedOnBy, [`telegram:${USER_ID}`]);
  assert.equal(ks.isOn(), true);
  assert.deepEqual(order, ["cancelAll:killswitch"]);
  assert.equal(reply(tg), "Shell disabled. Re-enable locally by deleting C:\\ProgramData\\agent-007\\control\\killshell.flag.");
});

test("/killshell still cancels approvals and warns if the flag cannot be written", async () => {
  const bad = { isOn: () => false, turnOn: async () => Promise.reject(new Error("disk full")), onChange: () => undefined };
  const { tg, order } = rig({ killSwitch: bad });
  await tg.bot.handleUpdate(textUpdate(USER_ID, "/killshell") as never);
  assert.deepEqual(order, ["cancelAll:killswitch"]);
  assert.match(reply(tg), /Could not write the kill-switch flag/);
});

test("command list covers /new /stop /status /killshell; duration formatting", () => {
  assert.deepEqual(COMMAND_LIST.map((c) => c.command), ["new", "stop", "status", "killshell"]);
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(125_000), "2m 5s");
  assert.equal(formatDuration(26 * 3600_000), "1d 2h 0m");
});
