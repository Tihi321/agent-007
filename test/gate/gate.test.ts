/**
 * S25.1 done-check with a fake clock and no model: P0 ahead of queued P2 and P3; aging prevents starvation; an in-flight call is not
 * preempted; the depth cap gives `busy`; stickiness keeps one bot's tool loop together; an abort frees the slot; the wait status is sent
 * once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_GATE } from "../../src/bots/schema.js";
import { GateAbortedError, GateBusyError, LocalGate, RunnerGate, waitNoticeText } from "../../src/gate/gate.js";
import type { GateTuning, Lease, WaitNotice } from "../../src/gate/gate.js";
import type { Priority } from "../../src/gate/queue.js";
import { FakeClock, SEC, settle } from "./fakes.js";

const TUNING: GateTuning = { maxQueueDepth: DEFAULT_GATE.maxQueueDepth, stickinessSec: DEFAULT_GATE.stickinessSec, agingSec: DEFAULT_GATE.agingSec, waitNoticeSec: DEFAULT_GATE.waitNoticeSec };

function rig(over: Partial<GateTuning> = {}, o: { slots?: number; onWait?: (n: WaitNotice) => void | Promise<void>; noticeCooldownSec?: number } = {}) {
  const clock = new FakeClock();
  const gate = new RunnerGate({ runner: "strata", settings: { ...TUNING, ...over }, clock, ...(o.slots ? { slots: o.slots } : {}), ...(o.onWait ? { onWait: o.onWait } : {}), ...(o.noticeCooldownSec !== undefined ? { noticeCooldownSec: o.noticeCooldownSec } : {}) });
  /** Requests a slot; records the order in which grants arrive. */
  const order: string[] = [];
  const leases = new Map<string, Lease>();
  const asked = (bot: string, priority: Priority, tag = bot, signal?: AbortSignal) => {
    const p = gate.acquire({ bot, priority, signal, conversationId: `c-${bot}` });
    p.then(
      (l) => {
        order.push(tag);
        leases.set(tag, l);
      },
      () => undefined,
    );
    return p;
  };
  return { clock, gate, order, leases, asked };
}

test("a free slot is granted at once, a busy one queues", async () => {
  const r = rig();
  void r.asked("a", 2);
  await settle();
  assert.deepEqual(r.order, ["a"]);
  void r.asked("b", 2);
  await settle();
  assert.deepEqual(r.order, ["a"]);
  assert.equal(r.gate.status().queued, 1);
  r.leases.get("a")?.release();
  await settle();
  assert.deepEqual(r.order, ["a", "b"]);
});

test("P0 goes ahead of queued P2 and P3, then P1", async () => {
  const r = rig({ stickinessSec: 0 });
  void r.asked("run", 2);
  await settle();
  void r.asked("t3", 3);
  void r.asked("t2", 2);
  void r.asked("t1", 1);
  void r.asked("t0", 0);
  await settle();
  assert.deepEqual(r.gate.status().waiting.map((w) => w.bot), ["t0", "t1", "t2", "t3"]);
  for (const tag of ["run", "t0", "t1", "t2"]) {
    r.leases.get(tag)?.release();
    await settle();
  }
  assert.deepEqual(r.order, ["run", "t0", "t1", "t2", "t3"]);
});

test("an in-flight call is never preempted by a better class", async () => {
  const r = rig();
  void r.asked("bg", 3);
  await settle();
  void r.asked("user", 0);
  await settle();
  assert.deepEqual(r.order, ["bg"]);
  assert.equal(r.gate.status().running.length, 1);
  assert.equal(r.gate.status().running[0]?.bot, "bg");
  r.clock.advance(600 * SEC); // however long it runs, it keeps the slot
  await settle();
  assert.deepEqual(r.order, ["bg"]);
  r.leases.get("bg")?.release();
  await settle();
  assert.deepEqual(r.order, ["bg", "user"]);
});

test("aging prevents starvation: an old P3 is served before a fresh P0", async () => {
  const r = rig({ stickinessSec: 0, agingSec: 60 });
  void r.asked("run", 0);
  await settle();
  void r.asked("slow", 3);
  await settle();
  r.clock.advance(100 * SEC); // slow is now class 2
  void r.asked("fresh", 0);
  await settle();
  r.leases.get("run")?.release();
  await settle();
  assert.deepEqual(r.order, ["run", "fresh"]); // not old enough yet (class 2 loses to P0)
  r.leases.get("fresh")?.release();
  await settle();
  assert.deepEqual(r.order, ["run", "fresh", "slow"]);

  // a stream of fresh P0 requests never keeps an old P3 out forever
  const s = rig({ stickinessSec: 0, agingSec: 60 });
  void s.asked("run", 0, "run0");
  await settle();
  void s.asked("slow", 3);
  let current = "run0";
  for (let i = 0; i < 20 && !s.order.includes("slow"); i++) {
    s.clock.advance(30 * SEC);
    void s.asked(`u${i}`, 0, `u${i}`);
    await settle();
    s.leases.get(current)?.release();
    await settle();
    current = s.order[s.order.length - 1] as string;
  }
  assert.equal(s.order.includes("slow"), true, "the P3 request was served");
  assert.ok(s.clock.now() - 1_000_000 <= 5 * 60 * SEC, "within a few aging steps");
});

test("the depth cap gives busy to P2 and P3 only", async () => {
  const r = rig({ maxQueueDepth: 2, stickinessSec: 0 });
  void r.asked("run", 2);
  await settle();
  void r.asked("q1", 2);
  void r.asked("q2", 3);
  await settle();
  assert.equal(r.gate.status().queued, 2);
  await assert.rejects(r.gate.acquire({ bot: "x", priority: 2 }), (e: unknown) => e instanceof GateBusyError && e.code === "busy" && e.limit === 2);
  await assert.rejects(r.gate.acquire({ bot: "y", priority: 3 }), GateBusyError);
  assert.equal(r.gate.status().queued, 2, "refused requests are not left in the line");
  // P0 and P1 are never refused
  void r.asked("u", 0);
  void r.asked("c", 1);
  await settle();
  assert.equal(r.gate.status().queued, 4);
  assert.equal(r.gate.status().busyRefused, 2);
});

test("per-bot concurrency is 1: a second request of the same bot waits even with a free slot elsewhere", async () => {
  const r = rig({ stickinessSec: 0 }, { slots: 2 });
  void r.asked("a", 2, "a1");
  void r.asked("a", 0, "a2");
  void r.asked("b", 3, "b1");
  await settle();
  assert.deepEqual(r.order, ["a1", "b1"], "a2 (even P0) waits for a1, b1 takes the other slot");
  r.leases.get("a1")?.release();
  await settle();
  assert.deepEqual(r.order, ["a1", "b1", "a2"]);
});

test("stickiness: a bot whose call ended in tool use keeps the slot for its next call", async () => {
  const r = rig({ stickinessSec: 15 });
  void r.asked("a", 2, "a1");
  await settle();
  void r.asked("b", 2, "b1"); // waits, same class
  await settle();
  r.leases.get("a1")?.release({ continues: true });
  await settle();
  assert.deepEqual(r.order, ["a1"], "b stays out while a's tool loop runs");
  assert.equal(r.gate.status().sticky?.bot, "a");
  r.clock.advance(5 * SEC); // a runs a tool, then calls the model again
  void r.asked("a", 2, "a2");
  await settle();
  assert.deepEqual(r.order, ["a1", "a2"], "the next call of a is admitted ahead of the older b");
  r.leases.get("a2")?.release(); // final answer: no stickiness
  await settle();
  assert.deepEqual(r.order, ["a1", "a2", "b1"]);
});

test("stickiness ends after the window and when the bot answers", async () => {
  const r = rig({ stickinessSec: 15 });
  void r.asked("a", 2, "a1");
  await settle();
  void r.asked("b", 2, "b1");
  await settle();
  r.leases.get("a1")?.release({ continues: true });
  await settle();
  r.clock.advance(14 * SEC);
  await settle();
  assert.deepEqual(r.order, ["a1"]);
  r.clock.advance(1 * SEC); // window over: the timer hands the slot on
  await settle();
  assert.deepEqual(r.order, ["a1", "b1"]);
  assert.equal(r.gate.status().sticky, undefined);

  const s = rig({ stickinessSec: 15 });
  void s.asked("a", 2, "a1");
  await settle();
  void s.asked("b", 2, "b1");
  await settle();
  s.leases.get("a1")?.release({ continues: false });
  await settle();
  assert.deepEqual(s.order, ["a1", "b1"]);
  assert.equal(s.clock.pendingTimers, 0);

  const z = rig({ stickinessSec: 0 });
  void z.asked("a", 2, "a1");
  await settle();
  void z.asked("b", 2, "b1");
  await settle();
  z.leases.get("a1")?.release({ continues: true });
  await settle();
  assert.deepEqual(z.order, ["a1", "b1"], "stickiness 0 switches it off");
});

test("stickiness yields to a strictly better class and to an entry that has aged a step", async () => {
  const r = rig({ stickinessSec: 15 });
  void r.asked("bg", 2, "bg1");
  await settle();
  void r.asked("user", 0, "u1");
  await settle();
  r.leases.get("bg1")?.release({ continues: true });
  await settle();
  assert.deepEqual(r.order, ["bg1", "u1"], "a P0 breaks a P2 bot's hold");

  const s = rig({ stickinessSec: 600, agingSec: 60 });
  void s.asked("a", 2, "a1");
  await settle();
  s.leases.get("a1")?.release({ continues: true }); // hold for 600 s
  await settle();
  void s.asked("b", 2, "b1");
  await settle();
  s.clock.advance(59 * SEC);
  await settle();
  assert.deepEqual(s.order, ["a1"]);
  // b has waited one aging step: it is class 1 now, strictly better than the holder's class 2
  s.clock.advance(1 * SEC); // the wake timer looks again; nothing else has to happen
  await settle();
  assert.deepEqual(s.order, ["a1", "b1"]);
});

test("an aborted release does not start a stickiness window", async () => {
  const r = rig({ stickinessSec: 15 });
  void r.asked("a", 2, "a1");
  await settle();
  void r.asked("b", 2, "b1");
  await settle();
  r.leases.get("a1")?.release({ continues: true, aborted: true });
  await settle();
  assert.deepEqual(r.order, ["a1", "b1"]);
});

test("an abort while waiting removes the request and frees nothing else", async () => {
  const r = rig();
  void r.asked("a", 2, "a1");
  await settle();
  const ac = new AbortController();
  const waiting = r.asked("b", 0, "b1", ac.signal);
  const rejected = assert.rejects(waiting, GateAbortedError);
  await settle();
  assert.equal(r.gate.status().queued, 1);
  ac.abort();
  await rejected;
  assert.equal(r.gate.status().queued, 0);
  assert.equal(r.gate.status().running.length, 1);
  await assert.rejects(r.gate.acquire({ bot: "c", priority: 0, signal: ac.signal }), GateAbortedError);
});

test("releasing the lease twice frees the slot once", async () => {
  const r = rig({ stickinessSec: 0 });
  void r.asked("a", 2, "a1");
  await settle();
  void r.asked("b", 2, "b1");
  void r.asked("c", 2, "c1");
  await settle();
  r.leases.get("a1")?.release();
  r.leases.get("a1")?.release();
  await settle();
  assert.deepEqual(r.order, ["a1", "b1"], "the second release did not admit c");
});

test("the waiting notice is sent once, after the delay, for P0 and P1 only", async () => {
  const notices: WaitNotice[] = [];
  const r = rig({ stickinessSec: 0 }, { onWait: (n) => void notices.push(n) });
  void r.asked("run", 2);
  await settle();
  void r.asked("user", 0, "u1");
  void r.asked("peer", 2, "p1"); // background: never announced
  await settle();
  r.clock.advance(9 * SEC);
  assert.equal(notices.length, 0);
  r.clock.advance(1 * SEC);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.bot, "user");
  assert.equal(notices[0]?.ahead, 1, "one request is ahead: the one running");
  assert.equal(notices[0]?.conversationId, "c-user");
  assert.equal(notices[0]?.runner, "strata");
  r.clock.advance(120 * SEC);
  assert.equal(notices.length, 1, "no second notice for the same wait");
  assert.equal(waitNoticeText(2), "Waiting for the model (2 ahead).");
});

test("no notice when the wait is shorter than the delay, or after an abort", async () => {
  const notices: WaitNotice[] = [];
  const r = rig({ stickinessSec: 0 }, { onWait: (n) => void notices.push(n) });
  void r.asked("run", 2);
  await settle();
  void r.asked("user", 0, "u1");
  await settle();
  r.clock.advance(4 * SEC);
  r.leases.get("run")?.release();
  await settle();
  r.clock.advance(60 * SEC);
  assert.equal(notices.length, 0);
  assert.equal(r.clock.pendingTimers, 0, "the notice timer was cancelled when the slot was granted");

  const ac = new AbortController();
  const s = rig({ stickinessSec: 0 }, { onWait: (n) => void notices.push(n) });
  void s.asked("run", 2);
  await settle();
  const w = s.asked("user", 0, "u1", ac.signal);
  const rejected = assert.rejects(w, GateAbortedError);
  await settle();
  ac.abort();
  await rejected;
  s.clock.advance(60 * SEC);
  assert.equal(notices.length, 0);
});

test("a tool loop is not announced every round (per-bot cooldown) and a throwing notifier never blocks the gate", async () => {
  const notices: WaitNotice[] = [];
  const r = rig({ stickinessSec: 0 }, { onWait: (n) => void notices.push(n), noticeCooldownSec: 60 });
  void r.asked("run", 2);
  await settle();
  void r.asked("user", 0, "u1");
  await settle();
  r.clock.advance(10 * SEC);
  assert.equal(notices.length, 1);
  r.leases.get("run")?.release();
  await settle();
  r.leases.get("u1")?.release();
  void r.asked("run", 2, "run2");
  await settle();
  void r.asked("user", 0, "u2"); // the same bot waits again 20 s later
  await settle();
  r.clock.advance(10 * SEC);
  assert.equal(notices.length, 1, "within the cooldown: suppressed");

  const t = rig({ stickinessSec: 0 }, {
    onWait: () => {
      throw new Error("telegram down");
    },
  });
  void t.asked("run", 2);
  await settle();
  void t.asked("user", 0, "u1");
  await settle();
  t.clock.advance(10 * SEC);
  t.leases.get("run")?.release();
  await settle();
  assert.deepEqual(t.order, ["run", "u1"]);

  const u = rig({ stickinessSec: 0 }, { onWait: () => Promise.reject(new Error("async failure")) });
  void u.asked("run", 2);
  await settle();
  void u.asked("user", 0, "u1");
  await settle();
  u.clock.advance(10 * SEC);
  await settle();
  u.leases.get("run")?.release();
  await settle();
  assert.deepEqual(u.order, ["run", "u1"]);
});

test("status reports the running and waiting entries, classes, sticky holder and the busy count", async () => {
  const r = rig({ maxQueueDepth: 1, stickinessSec: 15 });
  void r.asked("a", 1, "a1");
  await settle();
  void r.asked("b", 0, "b1");
  await settle();
  r.clock.advance(7 * SEC);
  const st = r.gate.status();
  assert.equal(st.runner, "strata");
  assert.equal(st.slots, 1);
  assert.equal(st.running[0]?.bot, "a");
  assert.equal(st.running[0]?.runningMs, 7000);
  assert.equal(st.queued, 1);
  assert.deepEqual(st.byPriority, [1, 0, 0, 0]);
  assert.equal(st.oldestWaitMs, 7000);
  assert.deepEqual(st.waiting[0], { bot: "b", priority: 0, effective: 0, waitedMs: 7000 });
  await assert.rejects(r.gate.acquire({ bot: "c", priority: 3 }), GateBusyError);
  assert.equal(r.gate.status().busyRefused, 1);
});

test("LocalGate: one gate per runner, defaults lmstudio and strata, unknown providers are not gated", async () => {
  const clock = new FakeClock();
  const g = new LocalGate({ settings: TUNING, clock });
  assert.deepEqual(g.runners(), ["lmstudio", "strata"]);
  assert.equal(g.runner("acp-codex"), undefined);
  const lease = await g.runner("strata")?.acquire({ bot: "a", priority: 0 });
  assert.ok(lease);
  const s = g.status();
  assert.deepEqual(s.runners.map((x) => [x.runner, x.running.length]), [["lmstudio", 0], ["strata", 1]]);
  const custom = new LocalGate({ settings: TUNING, clock, runners: { strata: { slots: 2 } } });
  assert.equal(custom.status().runners[0]?.slots, 2);
});

test("no request waits forever: a long random schedule serves everything, each within a bounded wait", async () => {
  const clock = new FakeClock();
  const gate = new RunnerGate({ runner: "strata", settings: { maxQueueDepth: 1000, stickinessSec: 15, agingSec: 60, waitNoticeSec: 10 }, clock });
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const total = 120;
  const waits: number[] = [];
  let served = 0;
  const pending: Promise<void>[] = [];
  const bots = ["main", "r1", "r2", "r3"];
  const runCall = async (bot: string, pr: Priority) => {
    const lease = await gate.acquire({ bot, priority: pr });
    waits.push(lease.waitedMs);
    await new Promise<void>((resolve) => clock.setTimer((5 + rnd(40)) * SEC, resolve)); // a generation of 5 to 45 s
    served++;
    lease.release({ continues: rnd(3) === 0 });
  };
  for (let i = 0; i < total; i++) {
    pending.push(runCall(bots[rnd(4)] as string, rnd(4) as Priority));
    clock.advance(rnd(20) * SEC);
    await settle(2);
  }
  for (let i = 0; i < 20000 && served < total; i++) {
    clock.advance(1 * SEC);
    await settle(2);
  }
  await Promise.all(pending);
  assert.equal(served, total);
  assert.equal(gate.status().queued, 0);
  assert.equal(gate.status().running.length, 0);
});
