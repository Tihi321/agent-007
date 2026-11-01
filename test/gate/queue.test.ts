/** S25.1: the aging priority queue on its own. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgingQueue, isPriority } from "../../src/gate/queue.js";

const AGE = 60_000;

test("serves by class, then by arrival", () => {
  const q = new AgingQueue<string>(AGE);
  q.add(2, "a", 0, "p2-first");
  q.add(3, "b", 0, "p3");
  q.add(0, "c", 0, "p0");
  q.add(1, "d", 0, "p1");
  q.add(2, "e", 0, "p2-second");
  assert.deepEqual(
    q.order(0).map((e) => e.item),
    ["p0", "p1", "p2-first", "p2-second", "p3"],
  );
  assert.equal(q.pick(0)?.item, "p0");
});

test("aging moves an entry up one class per step, never above P0", () => {
  const q = new AgingQueue<string>(AGE);
  const e = q.add(3, "a", 0, "old");
  assert.equal(q.effective(e, 0), 3);
  assert.equal(q.effective(e, AGE - 1), 3);
  assert.equal(q.effective(e, AGE), 2);
  assert.equal(q.effective(e, 2 * AGE), 1);
  assert.equal(q.effective(e, 3 * AGE), 0);
  assert.equal(q.effective(e, 100 * AGE), 0);
});

test("an aged P3 goes ahead of a fresh P0 (nothing waits forever)", () => {
  const q = new AgingQueue<string>(AGE);
  q.add(3, "slow", 0, "p3");
  const now = 3 * AGE;
  q.add(0, "fresh", now, "p0");
  assert.equal(q.pick(now)?.item, "p3");
  // and before it has aged, the P0 wins
  const q2 = new AgingQueue<string>(AGE);
  q2.add(3, "slow", 0, "p3");
  q2.add(0, "fresh", 10, "p0");
  assert.equal(q2.pick(10)?.item, "p0");
});

test("aging off (0) keeps the base classes", () => {
  const q = new AgingQueue<string>(0);
  const e = q.add(3, "a", 0, "x");
  assert.equal(q.effective(e, 10 ** 9), 3);
});

test("filter, rank, counts, remove and oldest wait", () => {
  const q = new AgingQueue<string>(AGE);
  const a = q.add(2, "a", 0, "a");
  const b = q.add(0, "b", 100, "b");
  const c = q.add(2, "a", 200, "c");
  assert.equal(q.rank(a, 300), 1);
  assert.equal(q.rank(b, 300), 0);
  assert.equal(q.rank(c, 300), 2);
  assert.deepEqual(q.counts(), [1, 0, 2, 0]);
  assert.equal(q.pick(300, (e) => e.bot === "a")?.item, "a");
  assert.equal(q.oldestWaitMs(300), 300);
  assert.equal(q.remove(a), true);
  assert.equal(q.remove(a), false);
  assert.equal(q.size, 2);
  assert.equal(q.pick(300, () => false), undefined);
});

test("isPriority", () => {
  assert.equal(isPriority(0), true);
  assert.equal(isPriority(3), true);
  assert.equal(isPriority(4), false);
  assert.equal(isPriority("1"), false);
});
