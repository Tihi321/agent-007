/**
 * Unit tests for smoke scripts S4 to S7, run-all, the soak probe and the bake-off helpers, against a fake
 * OpenAI-compatible server. They prove the script logic only. Live results are UNTESTED.
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run as runS4 } from "../scripts/smoke/s4-crash-resume.js";
import { runPlain as runS5, runRestart as runS5b } from "../scripts/smoke/s5-long-hook.js";
import { buildPrompt, run as runS6 } from "../scripts/smoke/s6-stream-timeout.js";
import { run as runS7 } from "../scripts/smoke/s7-runner-down.js";
import { runAll, SCRIPTS } from "../scripts/smoke/run-all.js";
import { parseArgs } from "../scripts/smoke/config.js";
import type { SmokeRunnerConfig } from "../scripts/smoke/config.js";
import { startFakeOpenAi } from "./helpers/fakeOpenAi.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "a7-smoke2-"));
}
function cfgFor(baseUrl: string, runner: "lmstudio" | "strata" = "lmstudio"): SmokeRunnerConfig {
  return { runner, baseUrl, modelId: "fake-model", contextWindow: 8192, maxTokens: 256 };
}
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

test("S4 (a): kill mid-stream, resume, exactly one final answer", async () => {
  const dir = tmp();
  const fake = await startFakeOpenAi();
  try {
    const out = await runS4(cfgFor(fake.baseUrl), { storageDir: dir, cases: ["a"], killAfterMs: 500, sleepMs: 1000, timeoutMs: 40_000 });
    assert.equal(out.pass, true, out.reason + JSON.stringify(out.details));
    const a = (out.details["results"] as Record<string, { details: { finalAssistantAnswers: number } }>)["a"];
    assert.equal(a?.details.finalAssistantAnswers, 1);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S4 (b): slow_unsafe runs once and is reported interrupted; slow_safe reruns", async () => {
  const dir = tmp();
  const fake = await startFakeOpenAi();
  try {
    const out = await runS4(cfgFor(fake.baseUrl), { storageDir: dir, cases: ["b"], sleepMs: 2500, timeoutMs: 40_000 });
    assert.equal(out.pass, true, out.reason + JSON.stringify(out.details));
    const b = (out.details["results"] as Record<string, { details: { slowUnsafeRuns: number; slowSafeRuns: number } }>)["b"];
    assert.equal(b?.details.slowUnsafeRuns, 1);
    assert.ok((b?.details.slowSafeRuns ?? 0) >= 2);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S5: the hook wait completes, then the tool runs and the turn finishes", async () => {
  const dir = tmp();
  const fake = await startFakeOpenAi();
  try {
    const out = await runS5(cfgFor(fake.baseUrl), { storageDir: dir, waitMs: 900, timeoutMs: 30_000 });
    assert.equal(out.pass, true, out.reason);
    assert.equal(out.details["callIdOnHookCall"], "string", "ToolHookCall carries a string id (U3)");
    assert.ok((out.details["waitedMs"] as number) >= 850);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S5b: after a restart the hook reruns with the original askedAt; the decision memo is found", async () => {
  const dir = tmp();
  const fake = await startFakeOpenAi();
  try {
    const out = await runS5b(cfgFor(fake.baseUrl), { storageDir: dir, longWaitMs: 60_000, shortWaitMs: 600, toolSleepMs: 5000, timeoutMs: 40_000 });
    assert.equal(out.pass, true, out.reason + JSON.stringify(out.details));
    const starts = out.details["hookStartsAcrossProcesses"] as { askedAt: number }[];
    assert.ok(starts.length >= 2);
    assert.ok(starts.every((s) => s.askedAt === starts[0]?.askedAt));
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S6: records TTFT, fails at the short timeout, succeeds at the long one, recommends 3x", async () => {
  const dir = tmp();
  const fake = await startFakeOpenAi({ firstDelayMs: 1200 });
  try {
    const out = await runS6(cfgFor(fake.baseUrl, "strata"), { storageDir: dir, smallTokens: 150, largeTokens: 600, shortTimeoutMs: 500, longTimeoutMs: 20_000, queueTest: true });
    assert.equal(out.pass, true, out.reason + JSON.stringify(out.details));
    const ttft = (out.details["ttft"] as { large: { ttftMs: number } }).large.ttftMs;
    assert.ok(ttft >= 1100, `ttft ${ttft}`);
    const h = out.details["harness"] as Record<string, { status: string }>;
    assert.notEqual(h["large_at_short_timeout"]?.status, "done");
    assert.equal(h["large_at_long_timeout"]?.status, "done");
    assert.ok((out.details["recommendedStreamTimeoutMs"] as number) >= 3 * ttft);
    assert.ok(out.details["queue"], "Strata runs record the queue measurement");
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S6 prompt builder is deterministic and about the requested size", () => {
  const p = buildPrompt(1500);
  assert.equal(p, buildPrompt(1500));
  assert.ok(p.includes("S6-NEEDLE-4471"));
  assert.ok(p.length > 4000 && p.length < 12_000, String(p.length));
});

test("S7: a request submitted while the proxy is down completes after the proxy comes up", async () => {
  const dir = tmp();
  const fake = await startFakeOpenAi();
  try {
    const proxyPort = await freePort();
    const out = await runS7(cfgFor(fake.baseUrl), { storageDir: dir, proxyPort, downMs: 1500, graceMs: 30_000, retry: { maxRetries: 100, baseDelayMs: 200, maxAgentDelayMs: 500 } });
    // Either outcome is a valid scripted result; the point is that the script reports it clearly.
    assert.match(out.reason, /./);
    console.log(`S7 against the fake runner: ${out.pass ? "PASS" : "FAIL"} ${out.reason}`);
    assert.equal(out.pass, true, out.reason + JSON.stringify(out.details));
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-all with the runner down: every runner script is an unreachable FAIL and nothing is started", async () => {
  const dev = tmp();
  const out = tmp();
  const fake = await startFakeOpenAi();
  const url = fake.baseUrl;
  await fake.close();
  const prevDev = process.env["A7_DEV_DIR"];
  const prevOut = process.env["A7_SMOKE_OUT"];
  try {
    mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, "config.json"), JSON.stringify({ model: { runner: "lmstudio", runners: { lmstudio: { baseUrl: url, modelId: "m" } } } }));
    process.env["A7_DEV_DIR"] = dev;
    process.env["A7_SMOKE_OUT"] = out;
    const only = SCRIPTS.filter((s) => s.needsRunner).map((s) => s.id);
    const { lines, failed } = await runAll(parseArgs(["--only", only.join(",")]));
    assert.equal(failed, only.length);
    for (const l of lines) assert.match(l, /^SMOKE S\d FAIL runner=lmstudio: runner unreachable/);
  } finally {
    if (prevDev === undefined) delete process.env["A7_DEV_DIR"];
    else process.env["A7_DEV_DIR"] = prevDev;
    if (prevOut === undefined) delete process.env["A7_SMOKE_OUT"];
    else process.env["A7_SMOKE_OUT"] = prevOut;
    rmSync(dev, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

