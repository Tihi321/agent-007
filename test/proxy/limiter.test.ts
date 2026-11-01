import assert from "node:assert/strict";
import { test } from "node:test";
import { LimiterBusyError, ProviderLimiter, ProxyLimiters, clampProviderLimit } from "../../src/proxy/limiter.js";
import type { Priority } from "../../src/proxy/limiter.js";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("the limit is 1..4 with a default of 3", () => {
  assert.equal(clampProviderLimit(undefined), 3);
  assert.equal(clampProviderLimit(9), 4);
  assert.equal(clampProviderLimit(0), 1);
  assert.equal(clampProviderLimit(Number.NaN), 3);
  assert.equal(new ProviderLimiter().limit, 3);
  assert.equal(new ProviderLimiter({ limit: 50 }).limit, 4);
  assert.equal(new ProxyLimiters().for("acp-codex").limit, 3);
  assert.equal(new ProxyLimiters({ defaultLimit: 7 }).for("acp-codex").limit, 4);
});

test("10 concurrent bot calls never exceed the per-provider limit", async () => {
  for (const limit of [undefined, 4]) {
    const l = new ProviderLimiter(limit === undefined ? {} : { limit });
    let running = 0;
    let max = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const release = await l.acquire({ botId: `bot${i}`, priority: (i % 4) as Priority });
        running++;
        max = Math.max(max, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        done++;
        release();
      }),
    );
    assert.equal(done, 10);
    assert.equal(max, limit ?? 3);
    assert.equal(l.stats().active, 0);
  }
});

test("P0 goes before P2 (and P1 before P3) when a slot frees", async () => {
  const l = new ProviderLimiter({ limit: 1, agingMs: 0, maxQueue: 50 });
  const first = await l.acquire({ botId: "a", priority: 0 });
  const order: string[] = [];
  const p2 = l.acquire({ botId: "b", priority: 2 }).then((r) => (order.push("b-P2"), r));
  const p3 = l.acquire({ botId: "c", priority: 3 }).then((r) => (order.push("c-P3"), r));
  const p0 = l.acquire({ botId: "d", priority: 0 }).then((r) => (order.push("d-P0"), r));
  const p1 = l.acquire({ botId: "e", priority: 1 }).then((r) => (order.push("e-P1"), r));
  await tick();
  assert.deepEqual(l.stats().queuedByPriority, [1, 1, 1, 1]);
  first();
  for (const p of [p0, p1, p2, p3]) {
    const r = await p;
    r();
  }
  assert.deepEqual(order, ["d-P0", "e-P1", "b-P2", "c-P3"]);
});

test("equal priority is first come, first served", async () => {
  const l = new ProviderLimiter({ limit: 1, agingMs: 0 });
  const first = await l.acquire({ botId: "a", priority: 0 });
  const order: string[] = [];
  const ps = ["b", "c", "d"].map((b) => l.acquire({ botId: b, priority: 2 }).then((r) => (order.push(b), r)));
  first();
  for (const p of ps) (await p)();
  assert.deepEqual(order, ["b", "c", "d"]);
});

test("aging: a waiting P3 rises one class per agingMs and then beats a newer P1", async () => {
  let t = 0;
  const l = new ProviderLimiter({ limit: 1, agingMs: 1000, now: () => t, maxQueue: 50 });
  const first = await l.acquire({ botId: "a", priority: 0 });
  const order: string[] = [];
  const old3 = l.acquire({ botId: "old", priority: 3 }).then((r) => (order.push("old-P3"), r));
  t = 2500; // P3 -> effective 1
  const new1 = l.acquire({ botId: "new", priority: 1 }).then((r) => (order.push("new-P1"), r));
  t = 3500; // old: 3 - 3 = 0, new: 1 - 1 = 0 -> tie, the older one (seq) wins
  first();
  const r1 = await Promise.race([old3, new1]);
  r1();
  (await old3)();
  (await new1)();
  assert.deepEqual(order, ["old-P3", "new-P1"]);
  // without aging the P1 would have won
  const l2 = new ProviderLimiter({ limit: 1, agingMs: 0, maxQueue: 50 });
  const f2 = await l2.acquire({ botId: "a", priority: 0 });
  const o2: string[] = [];
  const a = l2.acquire({ botId: "old", priority: 3 }).then((r) => (o2.push("P3"), r));
  const b = l2.acquire({ botId: "new", priority: 1 }).then((r) => (o2.push("P1"), r));
  f2();
  (await b)();
  (await a)();
  assert.deepEqual(o2, ["P1", "P3"]);
});

test("per-bot concurrency is 1: a bot's second call waits even when slots are free", async () => {
  const l = new ProviderLimiter({ limit: 3 });
  const r1 = await l.acquire({ botId: "x", priority: 0 });
  let second = false;
  const p = l.acquire({ botId: "x", priority: 0 }).then((r) => ((second = true), r));
  await tick();
  assert.equal(second, false);
  assert.equal(l.stats().active, 1);
  assert.equal(l.stats().queued, 1);
  // another bot is not blocked by it
  const other = await l.acquire({ botId: "y", priority: 3 });
  assert.equal(l.stats().active, 2);
  r1();
  (await p)();
  other();
  assert.equal(l.stats().active, 0);
});

test("a blocked bot does not hold up another bot behind it", async () => {
  const l = new ProviderLimiter({ limit: 2, agingMs: 0 });
  const a1 = await l.acquire({ botId: "a", priority: 0 });
  const a2 = l.acquire({ botId: "a", priority: 0 }); // blocked by its own first call
  const b = await l.acquire({ botId: "b", priority: 3 }); // takes the free slot
  assert.equal(l.stats().active, 2);
  a1();
  (await a2)();
  b();
});

test("the depth cap refuses P2 and P3 only", async () => {
  const l = new ProviderLimiter({ limit: 1, maxQueue: 2, agingMs: 0 });
  const hold = await l.acquire({ botId: "a", priority: 0 });
  const w1 = l.acquire({ botId: "b", priority: 0 });
  const w2 = l.acquire({ botId: "c", priority: 1 });
  await assert.rejects(() => l.acquire({ botId: "d", priority: 2 }), LimiterBusyError);
  await assert.rejects(() => l.acquire({ botId: "e", priority: 3 }), (e: unknown) => e instanceof LimiterBusyError && e.failure.kind === "limiter_busy" && e.failure.fallback === "never");
  const w3 = l.acquire({ botId: "f", priority: 0 }); // P0 still queues past the cap
  assert.equal(l.stats().queued, 3);
  hold();
  for (const p of [w1, w3, w2]) (await p)(); // the P0 calls go before the P1 one
});

test("abort while queued frees the queue position and rejects with AbortError", async () => {
  const l = new ProviderLimiter({ limit: 1 });
  const hold = await l.acquire({ botId: "a", priority: 0 });
  const ctl = new AbortController();
  const waiting = l.acquire({ botId: "b", priority: 0, signal: ctl.signal });
  await tick();
  assert.equal(l.stats().queued, 1);
  ctl.abort();
  await assert.rejects(waiting, (e: unknown) => (e as Error).name === "AbortError");
  assert.equal(l.stats().queued, 0);
  // an already aborted signal never queues
  await assert.rejects(l.acquire({ botId: "c", priority: 0, signal: ctl.signal }), (e: unknown) => (e as Error).name === "AbortError");
  hold();
  // the slot is still usable
  (await l.acquire({ botId: "d", priority: 0 }))();
  assert.equal(l.stats().active, 0);
});

test("release is idempotent", async () => {
  const l = new ProviderLimiter({ limit: 1 });
  const r = await l.acquire({ botId: "a", priority: 0 });
  r();
  r();
  assert.equal(l.stats().active, 0);
  const r2 = await l.acquire({ botId: "a", priority: 0 });
  r(); // a stale release must not free r2's slot
  assert.equal(l.stats().active, 1);
  r2();
});

test("ProxyLimiters keeps one limiter per provider and reports stats", async () => {
  const ls = new ProxyLimiters({ limitFor: (id) => (id === "acp-claude" ? 1 : undefined) });
  assert.equal(ls.for("acp-codex"), ls.for("acp-codex"));
  assert.equal(ls.for("acp-claude").limit, 1);
  const r = await ls.for("acp-codex").acquire({ botId: "a", priority: 0 });
  const stats = ls.stats();
  assert.equal(stats["acp-codex"]?.active, 1);
  assert.equal(stats["acp-claude"]?.limit, 1);
  r();
});
