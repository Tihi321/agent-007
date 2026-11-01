import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetProblem, compactionOverride, compactionSettings, compactionThreshold } from "../../src/prompt/budget.js";

test("the compaction threshold is 0.75 x contextWindow (within 1%)", () => {
  for (const cw of [8192, 32768, 73728, 81920, 122880, 131072, 262144]) {
    const t = compactionThreshold(cw);
    assert.ok(Math.abs(t - 0.75 * cw) <= 0.01 * cw, `${cw}: ${t}`);
  }
  assert.equal(compactionThreshold(73728), 55296);
  assert.throws(() => compactionThreshold(0), RangeError);
  assert.throws(() => compactionThreshold(Number.NaN), RangeError);
});

test("the Pi override puts the blocking threshold (contextWindow - reserveTokens) at 75% of the window", () => {
  for (const cw of [32768, 73728, 122880]) {
    const o = compactionOverride(cw);
    assert.equal(cw - o.reserveTokens, compactionThreshold(cw));
    assert.ok(o.backgroundTokens > 0 && o.backgroundTokens < o.reserveTokens + compactionThreshold(cw));
    assert.ok(o.keepRecentTokens <= 20_000 && o.keepRecentTokens > 0);
    assert.ok(compactionThreshold(cw) - o.backgroundTokens > 0, "background threshold stays positive");
  }
});

test("compactionSettings keys the override by provider/modelId", () => {
  const s = compactionSettings({ id: "lmstudio", modelId: "m1", contextWindow: 73728, maxTokens: 4096 });
  assert.deepEqual(Object.keys(s.modelOverrides), ["lmstudio/m1"]);
  assert.equal(s.modelOverrides["lmstudio/m1"]?.reserveTokens, 73728 - 55296);
  assert.throws(() => compactionSettings({ id: "x", modelId: "m", contextWindow: 4096, maxTokens: 4096 }), RangeError);
});

test("budgetProblem flags a reply size that does not fit above the threshold", () => {
  assert.equal(budgetProblem({ id: "lmstudio", modelId: "m", contextWindow: 73728, maxTokens: 4096 }), undefined);
  assert.match(String(budgetProblem({ id: "lmstudio", modelId: "m", contextWindow: 8192, maxTokens: 4096 })), /maxTokens/);
});
