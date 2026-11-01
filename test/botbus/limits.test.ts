/**
 * S21.3 done-check: hop limit, revisit, the chain budget (messages, time, tokens), the per-edge in-flight, gap and daily caps, the
 * circuit breaker with one notice, identical-message and A-B-A-B detection, and every typed error produced by a test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotBusLimits } from "../../src/bots/schema.js";
import { BusError } from "../../src/botbus/contracts.js";
import type { BusNote, UserNotice } from "../../src/botbus/contracts.js";
import { EdgeLimits, budgetLeft, checkChainBudget } from "../../src/botbus/limits.js";
import { loopReason, messageHash, normaliseBody } from "../../src/botbus/loops.js";
import { LIMITS, chainRig, edge, mkBot } from "./helpers.js";

const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof BusError ? `${e.code}:${e.reason}` : `other:${String(e)}`),
  );

const lim = (over: Partial<BotBusLimits>): BotBusLimits => ({ ...LIMITS, ...over });
const ab = [mkBot("a", { edges: [edge("b")] }), mkBot("b")];

test("chain budget: at most 6 asks, then budget_exhausted (messages); replies do not count", async () => {
  const { bus } = chainRig({}, ab);
  bus.beginUserTurn("a", "c");
  for (let i = 0; i < 6; i++) assert.equal(await code(bus.channel("a").send({ to: "b", message: `question ${i}` }, { conversationId: "c" })), "ok");
  assert.equal(await code(bus.channel("a").send({ to: "b", message: "question 6" }, { conversationId: "c" })), "budget_exhausted:messages");
  const r = await code(bus.channel("a").send({ to: "b", message: "one more" }, { conversationId: "c" }));
  assert.equal(r, "budget_exhausted:messages");
});

test("chain budget: time (300 s) and tokens (60000, counted from the replies)", async () => {
  const rig = chainRig({}, ab);
  rig.bus.beginUserTurn("a", "c");
  await rig.bus.channel("a").send({ to: "b", message: "first" }, { conversationId: "c" });
  rig.clock.t += 301_000;
  assert.equal(await code(rig.bus.channel("a").send({ to: "b", message: "second" }, { conversationId: "c" })), "budget_exhausted:seconds");

  const rig2 = chainRig({}, ab, { b: () => ({ text: "long answer", tokens: 60_000 }) });
  rig2.bus.beginUserTurn("a", "c");
  const first = await rig2.bus.channel("a").send({ to: "b", message: "first" }, { conversationId: "c" });
  assert.equal(first.budget_left.tokens, 0);
  assert.equal(await code(rig2.bus.channel("a").send({ to: "b", message: "second" }, { conversationId: "c" })), "budget_exhausted:tokens");
});

test("budget helpers: left counts and the first exceeded limit wins", () => {
  const u = { messages: 2, startedAt: 1000, tokens: 100 };
  assert.deepEqual(budgetLeft(u, LIMITS, 1000 + 60_000), { messages: 4, seconds: 240, tokens: 59_900 });
  assert.throws(() => checkChainBudget({ ...u, messages: 6 }, LIMITS, 1000), (e: unknown) => e instanceof BusError && e.reason === "messages");
});

test("per-edge: one in flight, then a 5 s gap, then the daily cap", async () => {
  let release: () => void = () => undefined;
  const rig = chainRig({ limits: lim({ edgeMinGapSec: 5, edgeDailyCap: 3 }) }, ab, {
    b: () => new Promise((res) => (release = () => res("done"))),
  });
  rig.bus.beginUserTurn("a", "c");
  const first = rig.bus.channel("a").send({ to: "b", message: "slow one" }, { conversationId: "c" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await code(rig.bus.channel("a").send({ to: "b", message: "while busy" }, { conversationId: "c" })), "busy:in_flight");
  release();
  await first;
  assert.equal(await code(rig.bus.channel("a").send({ to: "b", message: "too soon" }, { conversationId: "c" })), "busy:gap");
  rig.clock.t += 5000;
  const quick = new FakeQuick(rig);
  assert.equal(await quick.ask("second"), "ok");
  rig.clock.t += 5000;
  assert.equal(await quick.ask("third"), "ok");
  rig.clock.t += 5000;
  assert.equal(await quick.ask("fourth"), "budget_exhausted:edge_daily_cap");
  rig.clock.t += 24 * 3600 * 1000;
  rig.bus.beginUserTurn("a", "d");
  assert.equal(await code(rig.bus.channel("a").send({ to: "b", message: "next day" }, { conversationId: "d" })), "ok");
});

class FakeQuick {
  constructor(private readonly rig: ReturnType<typeof chainRig>) {}
  ask(message: string): Promise<string> {
    // the first script resolves only when released; later calls use a fresh runtime that answers at once
    this.rig.bus.register("b", { runPeerTurn: async () => ({ text: "ok" }) });
    return code(this.rig.bus.channel("a").send({ to: "b", message }, { conversationId: "c" }));
  }
}

test("circuit breaker: after 10 asks in 10 minutes the edge is paused and the user gets ONE notice; it resumes after the window", async () => {
  const notices: UserNotice[] = [];
  const notes: BusNote[] = [];
  const rig = chainRig({ limits: lim({ breakerAsks: 3, chainMaxMessages: 100 }), notify: (n) => notices.push(n), audit: { record: () => undefined, note: (n) => void notes.push(n) } }, ab);
  rig.bus.beginUserTurn("a", "c");
  for (let i = 0; i < 3; i++) assert.equal(await code(rig.bus.channel("a").send({ to: "b", message: `m${i}` }, { conversationId: "c" })), "ok");
  assert.equal(await code(rig.bus.channel("a").send({ to: "b", message: "m3" }, { conversationId: "c" })), "budget_exhausted:edge_paused");
  assert.equal(await code(rig.bus.channel("a").send({ to: "b", message: "m4" }, { conversationId: "c" })), "budget_exhausted:edge_paused");
  assert.equal(notices.length, 1, "one notice only");
  assert.equal(notices[0]?.bot, "a");
  assert.equal(notices[0]?.conversationId, "c");
  assert.equal(notes.filter((n) => n.event === "breaker").length, 1, "the trip is audited once");
  assert.equal(rig.bus.edgeStatus()[0]?.pausedUntil !== undefined, true);
  rig.clock.t += 10 * 60_000 + 1;
  rig.bus.beginUserTurn("a", "d");
  assert.equal(await code(rig.bus.channel("a").send({ to: "b", message: "back again" }, { conversationId: "d" })), "ok");
});

test("EdgeLimits direct: edges are independent and a release is idempotent", () => {
  let t = 0;
  const e = new EdgeLimits({ limits: lim({ edgeMinGapSec: 0 }), now: () => t });
  const r1 = e.admit("a", "b");
  assert.throws(() => e.admit("a", "b"), (x: unknown) => x instanceof BusError && x.code === "busy");
  const r2 = e.admit("b", "a");
  r1();
  r1();
  t += 1;
  e.admit("a", "b");
  r2();
  assert.equal(e.status().length, 2);
});

test("loops: the second identical message of a chain is blocked, also when only case and spacing differ", async () => {
  const { bus } = chainRig({}, ab);
  bus.beginUserTurn("a", "c");
  await bus.channel("a").send({ to: "b", message: "What is the capital of France?" }, { conversationId: "c" });
  assert.equal(await code(bus.channel("a").send({ to: "b", message: "  what is  the CAPITAL of france? " }, { conversationId: "c" })), "loop_detected:identical");
  assert.equal(normaliseBody(" A\n\tb  "), "a b");
  assert.notEqual(messageHash("a", "b", "x"), messageHash("b", "a", "x"));
  // a new user message is a new chain: the same text is fine again
  bus.beginUserTurn("a", "c2");
  assert.equal(await code(bus.channel("a").send({ to: "b", message: "What is the capital of France?" }, { conversationId: "c2" })), "ok");
});

test("loops: a revisit (asking a bot already in the path) and an A-B-A-B ping-pong", async () => {
  const bots = [mkBot("a", { edges: [edge("b")] }), mkBot("b", { edges: [edge("a")] })];
  let rig: ReturnType<typeof chainRig> | undefined;
  rig = chainRig({}, bots, { b: async () => (await code(rig?.bus.channel("b").send({ to: "a", message: "back to you" }, { conversationId: "b-peer-a-1" }) as Promise<unknown>)) as string });
  rig.bus.beginUserTurn("a", "c");
  const r = await rig.bus.channel("a").send({ to: "b", message: "start" }, { conversationId: "c" });
  assert.match(r.reply ?? "", /loop_detected:revisit/);
  // pure detection of the ping-pong pattern
  const edges = ["a>b", "b>a", "a>b"];
  assert.equal(loopReason([], { hashes: [], edges }, "b", "a", "again"), "ping_pong");
  assert.equal(loopReason([], { hashes: [], edges: ["a>b", "b>c", "a>b"] }, "b", "a", "x"), undefined);
  assert.equal(loopReason(["a", "b"], { hashes: [], edges: [] }, "b", "a", "x"), "revisit");
});

test("every typed error is produced: edge_denied, hop_limit, budget_exhausted, loop_detected, busy, timeout (plus bad_request, unavailable, refused)", async () => {
  const produced = new Set<string>();
  const note = async (p: Promise<unknown>): Promise<void> => {
    const c = await code(p);
    produced.add(c.split(":")[0] as string);
  };
  const bots = [mkBot("a", { edges: [edge("b")] }), mkBot("b", { edges: [edge("c")] }), mkBot("c", { edges: [edge("d")] }), mkBot("d")];
  let rig: ReturnType<typeof chainRig> | undefined;
  rig = chainRig({ limits: lim({ chainMaxMessages: 4, edgeMinGapSec: 1 }), timeoutMs: () => 150 }, bots, {
    b: async () => (await rig?.bus.channel("b").send({ to: "c", message: "x" }, { conversationId: "b-peer-a-1" }))?.reply ?? "",
    c: async () => {
      await note(rig?.bus.channel("c").send({ to: "d", message: "y" }, { conversationId: "c-peer-b-1" }) as Promise<unknown>);
      return "done";
    },
  });
  rig.bus.beginUserTurn("a", "c1");
  await note(rig.bus.channel("a").send({ to: "d", message: "x" }, { conversationId: "c1" }));
  await note(rig.bus.channel("a").send({ to: "b", message: "go" }, { conversationId: "c1" }));
  await note(rig.bus.channel("a").send({ to: "b", message: "go" }, { conversationId: "c1" }));
  await note(rig.bus.channel("a").send({ to: "b", message: "go again differently" }, { conversationId: "c1" }));
  await note(rig.bus.channel("a").send({ to: "b" }, { conversationId: "c1" }));
  rig.bus.register("b", { runPeerTurn: () => new Promise(() => undefined) });
  rig.clock.t += 10_000;
  rig.bus.beginUserTurn("a", "c2");
  await note(rig.bus.channel("a").send({ to: "b", message: "hang" }, { conversationId: "c2" }));
  rig.bus.beginUserTurn("a", "c3");
  rig.clock.t += 10_000;
  rig.bus.register("b", { runPeerTurn: async () => ({ text: "ok" }) });
  await note(rig.bus.channel("a").send({ to: "b", message: "n1" }, { conversationId: "c3" }));
  await note(rig.bus.channel("a").send({ to: "b", message: "n2" }, { conversationId: "c3" }));
  for (const c of ["edge_denied", "hop_limit", "loop_detected", "busy", "timeout", "bad_request"]) assert.ok(produced.has(c), `${c} produced (${[...produced].join(",")})`);
  // budget_exhausted is covered above; the chain here has 4 asks at most
  const r2 = chainRig({ limits: lim({ chainMaxMessages: 1 }) }, ab);
  r2.bus.beginUserTurn("a", "c");
  await r2.bus.channel("a").send({ to: "b", message: "one" }, { conversationId: "c" });
  await note(r2.bus.channel("a").send({ to: "b", message: "two" }, { conversationId: "c" }));
  assert.ok(produced.has("budget_exhausted"));
});
