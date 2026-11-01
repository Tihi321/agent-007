import assert from "node:assert/strict";
import { test } from "node:test";
import { StallError, waitWithStall } from "../scripts/smoke/s4-stall.js";

/** A fake clock: `sleep(ms)` advances the clock instantly, so the tests take no real time. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: (ms: number) => { t += ms; return new Promise<void>((r) => setImmediate(r)); } };
}

test("S4 stall wait: steady progress keeps the wait alive past the stall window and records the longest stall", async () => {
  const c = clock();
  // the run lasts 10 s of fake time, the stall window is 3 s, a new revision arrives every 2 s
  const p = new Promise<string>((resolve) => {
    const tick = (): void => (c.now() >= 10_000 ? resolve("done") : void setImmediate(tick));
    setImmediate(tick);
  });
  const r = await waitWithStall(p, () => Math.floor(c.now() / 2000), "run", { stallMs: 3000, hardCapMs: 60_000, pollMs: 1000, ...c });
  assert.equal(r.value, "done");
  assert.ok(r.stats.elapsedMs >= 10_000, "waited longer than the stall window");
  assert.ok(r.stats.longestStallMs >= 1000 && r.stats.longestStallMs <= 3000, `longest stall ${r.stats.longestStallMs}`);
  assert.ok(r.stats.progressSteps >= 4);
});

test("S4 stall wait: silence for stallMs fails with a stall error that carries the stats", async () => {
  const c = clock();
  const never = new Promise<string>(() => undefined);
  let progress = 0;
  const probe = (): number => {
    if (c.now() <= 4000) progress = Math.floor(c.now() / 1000); // progress for 4 s, then silence
    return progress;
  };
  await assert.rejects(
    waitWithStall(never, probe, "run", { stallMs: 5000, hardCapMs: 600_000, pollMs: 1000, ...c }),
    (e: unknown) => e instanceof StallError && e.kind === "stall" && e.stats.longestStallMs >= 5000 && e.stats.progressSteps >= 3 && /no progress for 5000 ms/.test(e.message),
  );
});

test("S4 stall wait: constant progress still stops at the hard cap", async () => {
  const c = clock();
  const never = new Promise<string>(() => undefined);
  let n = 0;
  await assert.rejects(
    waitWithStall(never, () => n++, "run", { stallMs: 5000, hardCapMs: 20_000, pollMs: 1000, ...c }),
    (e: unknown) => e instanceof StallError && e.kind === "hardcap",
  );
});

test("S4 stall wait: a rejected run rejects with its own error, and a probe that throws counts as no progress", async () => {
  const c = clock();
  const boom = new Promise<string>((_, rej) => setImmediate(() => rej(new Error("boom"))));
  await assert.rejects(waitWithStall(boom, () => { throw new Error("locked"); }, "run", { stallMs: 5000, hardCapMs: 60_000, pollMs: 1000, ...c }), /boom/);
  await assert.rejects(
    waitWithStall(new Promise<string>(() => undefined), () => { throw new Error("locked"); }, "run", { stallMs: 3000, hardCapMs: 60_000, pollMs: 1000, ...c }),
    (e: unknown) => e instanceof StallError && e.kind === "stall",
  );
});
