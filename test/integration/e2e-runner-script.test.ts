/**
 * The manual `@runner` suite (`scripts/e2e-runner.ts`, S6.2/S8.2) checked offline: pointed at the fake runner through a
 * temp dev dir it must PASS every check; pointed at a closed port it must FAIL cleanly with "runner unreachable".
 * The real-runner run is a live step (UNTESTED here).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSuite } from "../../scripts/e2e-runner.js";
import { startFakeOpenAi } from "../helpers/fakeOpenAi.js";
import type { Behavior } from "../helpers/fakeOpenAi.js";
import { LM_TOKEN, MODEL_ID, viaToolSearch } from "./rig.js";

const scripted: Behavior = viaToolSearch(({ lastUser, afterTool, lastToolText }) => {
  if (afterTool) return { type: "text", text: `After: ${lastToolText}` };
  if (/12 plus 30/.test(lastUser)) return { type: "text", text: "42" };
  if (/whoami/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "shell", args: { command: "whoami", reason: "who am I" } }] };
  if (/hostname/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "shell", args: { command: "hostname", reason: "host" } }] };
  if (/Get-Date/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "shell", args: { command: "Get-Date", reason: "date" } }] };
  if (/Get-Process/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "shell", args: { command: "Get-Process | Select-Object -First 3", reason: "procs" } }] };
  if (/Remember that/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "remember", args: { note: "The user's favourite colour is green." } }] };
  return { type: "text", text: "ok" };
});

function devDirFor(baseUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "a7-e2e-dev-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ model: { runner: "lmstudio", runners: { lmstudio: { baseUrl, modelId: MODEL_ID, contextWindow: 8192, maxTokens: 512 } } } }),
  );
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ lmStudioApiToken: LM_TOKEN }));
  return dir;
}

async function withDevDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env["A7_DEV_DIR"];
  process.env["A7_DEV_DIR"] = dir;
  try {
    return await fn();
  } finally {
    if (old === undefined) delete process.env["A7_DEV_DIR"];
    else process.env["A7_DEV_DIR"] = old;
  }
}

test("e2e-runner script: all six checks PASS against the scripted fake runner", async () => {
  const fake = await startFakeOpenAi({ behavior: scripted, modelId: MODEL_ID, requireKey: LM_TOKEN });
  const dir = devDirFor(fake.baseUrl);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    const code = await withDevDir(dir, () => runSuite([]));
    console.log = log;
    assert.equal(code, 0, lines.join("\n"));
    for (const id of ["question", "shell-approve", "shell-deny", "new-gated", "restart-deadline", "remember"]) {
      assert.ok(lines.some((l) => l.startsWith(`E2E ${id} PASS`)), `${id} did not pass:\n${lines.join("\n")}`);
    }
    assert.ok(lines.some((l) => l.startsWith("E2E SUMMARY 6/6")));
  } finally {
    console.log = log;
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e-runner script: a runner that is down fails cleanly (exit 1) and starts nothing", async () => {
  const fake = await startFakeOpenAi({ modelId: MODEL_ID });
  const baseUrl = fake.baseUrl;
  await fake.close();
  const dir = devDirFor(baseUrl);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    const code = await withDevDir(dir, () => runSuite([]));
    console.log = log;
    assert.equal(code, 1);
    assert.ok(lines.some((l) => /^E2E runner FAIL runner unreachable/.test(l)), lines.join("\n"));
  } finally {
    console.log = log;
    rmSync(dir, { recursive: true, force: true });
  }
});
