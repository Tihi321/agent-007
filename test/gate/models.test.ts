/**
 * S25.1 decorator tests (no model, no network): the slot is held until the stream ends; other methods and ungated providers pass through;
 * `/stop` frees the slot; busy becomes an error event; a crashing stream releases the slot; `complete*` run at P3; stickiness works.
 *
 * S25.3 measurement protocol (LIVE, UNTESTED, needs the user's [GO]; nothing here runs it): with Strata up, send one P0 turn from bot A while
 * bot B holds a P2 call and note (1) the wait notice time, (2) tokens/s of the first call alone vs. under a queued second call, (3) the
 * first-token latency of bot B's call after a different-system-prompt call by bot A (U57 re-prefill cost) with and without stickiness.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_GATE } from "../../src/bots/schema.js";
import { LocalGate } from "../../src/gate/gate.js";
import type { GateTuning } from "../../src/gate/gate.js";
import { PriorityHints } from "../../src/gate/hints.js";
import { createGateDecorator, gateModels } from "../../src/gate/models.js";
import type { Models } from "../../src/pi/adapter.js";
import { FakeClock, fakeModels, modelOf, settle } from "./fakes.js";

const TUNING: GateTuning = { maxQueueDepth: DEFAULT_GATE.maxQueueDepth, stickinessSec: DEFAULT_GATE.stickinessSec, agingSec: DEFAULT_GATE.agingSec, waitNoticeSec: DEFAULT_GATE.waitNoticeSec };

function rig(over: Partial<GateTuning> = {}) {
  const clock = new FakeClock();
  const gate = new LocalGate({ settings: { ...TUNING, ...over }, clock });
  const hints = new PriorityHints();
  const fake = fakeModels({ strata: ["m"], lmstudio: ["m"], "acp-claude": ["m"] });
  const admits: { bot: string; priority: number }[] = [];
  const decorate = createGateDecorator({ gate, hints, clock, onAdmit: (i) => admits.push({ bot: i.bot, priority: i.priority }) });
  const forBot = (id: string): Models => decorate(fake.models, { id });
  return { clock, gate, hints, fake, admits, forBot };
}

type Any = (...a: unknown[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (m: Models, fn: "stream" | "streamSimple" | "complete" | "completeSimple", provider: string, signal?: AbortSignal): any => (m[fn] as unknown as Any)(modelOf(provider), {}, signal ? { signal } : {}); // eslint-disable-line @typescript-eslint/no-explicit-any

async function drain(stream: AsyncIterable<{ type: string }>): Promise<string[]> {
  const types: string[] = [];
  for await (const e of stream) types.push(e.type);
  return types;
}

test("the slot is held until the stream ends", async () => {
  const r = rig();
  const a = call(r.forBot("a"), "streamSimple", "strata");
  const b = call(r.forBot("b"), "streamSimple", "strata");
  await settle();
  assert.equal(r.fake.calls.length, 1, "only the first call reached the provider");
  assert.equal(r.gate.status().runners.find((x) => x.runner === "strata")?.queued, 1);
  r.fake.calls[0]?.emit("hi");
  r.fake.calls[0]?.finish("stop");
  const types = await drain(a);
  assert.deepEqual(types, ["text_delta", "done"]);
  assert.equal((await a.result()).stopReason, "stop");
  await settle();
  assert.equal(r.fake.calls.length, 2, "the second call starts when the first ended");
  r.fake.calls[1]?.finish("stop");
  await drain(b);
  await settle();
  assert.equal(r.gate.status().runners.find((x) => x.runner === "strata")?.running.length, 0);
});

test("stream and streamSimple are both gated; lmstudio too", async () => {
  const r = rig();
  const a = call(r.forBot("a"), "stream", "lmstudio");
  const b = call(r.forBot("b"), "stream", "lmstudio");
  await settle();
  assert.equal(r.fake.calls.length, 1);
  assert.equal(r.fake.calls[0]?.variant, "stream");
  r.fake.calls[0]?.finish();
  await drain(a);
  await settle();
  assert.equal(r.fake.calls.length, 2);
  r.fake.calls[1]?.finish();
  await drain(b);
});

test("ungated providers and other methods pass through untouched", async () => {
  const r = rig();
  const m = r.forBot("a");
  // The proxy provider is not gated: two bots run side by side with no queue.
  const s1 = call(m, "streamSimple", "acp-claude");
  const s2 = call(r.forBot("b"), "streamSimple", "acp-claude");
  await settle();
  assert.equal(r.fake.calls.length, 2);
  assert.equal(r.gate.status().runners.every((x) => x.queued === 0 && x.running.length === 0), true);
  r.fake.calls.forEach((c) => c.finish());
  await drain(s1);
  await drain(s2);
  // complete* on an ungated provider goes to the original method.
  await call(m, "complete", "acp-claude");
  await call(m, "completeSimple", "acp-claude");
  assert.deepEqual(r.fake.other, ["complete", "completeSimple"]);
  // Non-request methods are the original ones.
  assert.equal(m.getModel("strata" as never, "m" as never)?.id, "m");
  assert.equal(m.getModel("strata" as never, "nope" as never), undefined);
  await m.refresh();
  assert.ok(r.fake.other.includes("refresh"));
});

test("a busy refusal becomes an error event, not a throw", async () => {
  const r = rig({ maxQueueDepth: 1 });
  const a = call(r.forBot("a"), "streamSimple", "strata"); // running
  const b = call(r.forBot("b"), "streamSimple", "strata"); // waiting (1)
  await settle();
  const c = call(r.forBot("c"), "streamSimple", "strata"); // refused: P2, queue over the cap
  const types = await drain(c);
  assert.deepEqual(types, ["error"]);
  const final = await c.result();
  assert.equal(final.stopReason, "error");
  assert.match(final.errorMessage ?? "", /^server_busy:/);
  assert.equal(r.gate.status().runners.find((x) => x.runner === "strata")?.busyRefused, 1);
  r.fake.calls[0]?.finish();
  await drain(a);
  await settle();
  r.fake.calls[1]?.finish();
  await drain(b);
});

test("a P0 turn is not refused by a full queue", async () => {
  const r = rig({ maxQueueDepth: 1 });
  const a = call(r.forBot("a"), "streamSimple", "strata");
  const b = call(r.forBot("b"), "streamSimple", "strata");
  await settle();
  const end = r.hints.begin("c", { priority: 0 });
  const c = call(r.forBot("c"), "streamSimple", "strata");
  await settle();
  assert.equal(r.gate.status().runners.find((x) => x.runner === "strata")?.queued, 2);
  end();
  r.fake.calls[0]?.finish();
  await drain(a);
  await settle();
  r.admits.length = 0;
  r.fake.calls[1]?.finish();
  await settle();
  assert.equal(r.fake.calls.length, 3);
  r.fake.calls[2]?.finish();
  await Promise.all([drain(b), drain(c)]);
});

test("/stop while waiting gives an aborted error event and leaves the slot to the others", async () => {
  const r = rig();
  const a = call(r.forBot("a"), "streamSimple", "strata");
  const ac = new AbortController();
  const b = call(r.forBot("b"), "streamSimple", "strata", ac.signal);
  await settle();
  ac.abort();
  const types = await drain(b);
  assert.deepEqual(types, ["error"]);
  assert.equal((await b.result()).stopReason, "aborted");
  assert.equal(r.gate.status().runners.find((x) => x.runner === "strata")?.queued, 0);
  r.fake.calls[0]?.finish();
  await drain(a);
  assert.equal(r.fake.calls.length, 1, "the aborted call never reached the provider");
});

test("/stop while running frees the slot at once", async () => {
  const r = rig();
  const ac = new AbortController();
  const a = call(r.forBot("a"), "streamSimple", "strata", ac.signal);
  const b = call(r.forBot("b"), "streamSimple", "strata");
  await settle();
  assert.equal(r.fake.calls.length, 1);
  ac.abort();
  await settle();
  assert.equal(r.fake.calls.length, 2, "b started although a's provider stream has not wound down");
  r.fake.calls[0]?.finish("aborted");
  r.fake.calls[1]?.finish();
  await drain(a);
  await drain(b);
  await settle();
  const s = r.gate.status().runners.find((x) => x.runner === "strata");
  assert.equal(s?.running.length, 0);
});

test("a crashing stream releases the slot and reports an error event", async () => {
  const r = rig();
  const a = call(r.forBot("a"), "streamSimple", "strata");
  const b = call(r.forBot("b"), "streamSimple", "strata");
  await settle();
  r.fake.calls[0]?.crash("provider exploded");
  const types = await drain(a);
  assert.deepEqual(types, ["error"]);
  const final = await a.result();
  assert.equal(final.stopReason, "error");
  assert.match(final.errorMessage ?? "", /provider exploded/);
  await settle();
  assert.equal(r.fake.calls.length, 2, "the next bot got the slot");
  r.fake.calls[1]?.finish();
  await drain(b);
});

test("a stream that throws synchronously also releases the slot", async () => {
  const r = rig();
  const bad = { ...(r.fake.models as object), streamSimple: () => { throw new Error("sync boom"); } } as unknown as Models;
  const wrapped = gateModels(bad, "a", { gate: r.gate, hints: r.hints, clock: r.clock });
  const a = call(wrapped, "streamSimple", "strata");
  const final = await a.result();
  assert.equal(final.stopReason, "error");
  assert.match(final.errorMessage ?? "", /sync boom/);
  await settle();
  assert.equal(r.gate.status().runners.find((x) => x.runner === "strata")?.running.length, 0);
});

test("complete and completeSimple on a local runner run at P3 through the gate", async () => {
  const r = rig();
  const endTurn = r.hints.begin("a", { priority: 0 }); // an active P0 turn must not lift a summary
  const p = call(r.forBot("a"), "completeSimple", "strata");
  const q = call(r.forBot("b"), "complete", "lmstudio");
  await settle();
  assert.deepEqual(r.admits, [{ bot: "a", priority: 3 }, { bot: "b", priority: 3 }]);
  assert.equal(r.fake.completeCalls.length, 0, "the gated path uses the stream, not the original complete");
  assert.equal(r.fake.calls[0]?.variant, "streamSimple");
  assert.equal(r.fake.calls[1]?.variant, "stream");
  r.fake.calls.forEach((c) => c.finish());
  assert.equal((await p).stopReason, "stop");
  assert.equal((await q).stopReason, "stop");
  endTurn();
});

test("a turn call runs at the hinted class, default P2", async () => {
  const r = rig();
  const a = call(r.forBot("a"), "streamSimple", "strata");
  await settle();
  const end = r.hints.begin("b", { priority: 1 });
  const b = call(r.forBot("b"), "streamSimple", "strata");
  await settle();
  r.fake.calls[0]?.finish();
  await drain(a);
  await settle();
  r.fake.calls[1]?.finish();
  await drain(b);
  end();
  assert.deepEqual(r.admits, [{ bot: "a", priority: 2 }, { bot: "b", priority: 1 }]);
});

test("stickiness after a tool-use call is applied through the decorator", async () => {
  const r = rig();
  const a1 = call(r.forBot("a"), "streamSimple", "strata");
  await settle();
  const b = call(r.forBot("b"), "streamSimple", "strata"); // queued behind a
  await settle();
  r.fake.calls[0]?.finish("toolUse");
  await drain(a1);
  await settle();
  assert.equal(r.fake.calls.length, 1, "the slot is kept for a, b keeps waiting");
  assert.equal(r.gate.status().runners.find((x) => x.runner === "strata")?.sticky?.bot, "a");
  const a2 = call(r.forBot("a"), "streamSimple", "strata"); // a's next round of its tool loop
  await settle();
  assert.equal(r.fake.calls.length, 2);
  assert.equal(r.admits.at(-1)?.bot, "a");
  r.fake.calls[1]?.finish("stop");
  await drain(a2);
  await settle();
  assert.equal(r.fake.calls.length, 3, "b gets the slot after a's loop ended");
  r.fake.calls[2]?.finish();
  await drain(b);
});

test("an error or aborted final message gives no stickiness", async () => {
  const r = rig();
  const a = call(r.forBot("a"), "streamSimple", "strata");
  const b = call(r.forBot("b"), "streamSimple", "strata");
  await settle();
  r.fake.calls[0]?.finish("error");
  await drain(a);
  await settle();
  assert.equal(r.fake.calls.length, 2);
  r.fake.calls[1]?.finish();
  await drain(b);
});
