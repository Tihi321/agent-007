import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nextAction, restartDelayMs, Supervisor } from "../../src/desktop/supervisor.js";
import type { ExitRecord, SupervisorState } from "../../src/desktop/supervisor.js";

test("nextAction: exit codes, backoff and the crash-loop window", () => {
  const at = (code: number | null, ms: number): ExitRecord => ({ code, at: ms });
  assert.equal(nextAction(0, [at(0, 0)]), "stopped");
  assert.equal(nextAction(4, [at(4, 0)]), "restart");
  assert.equal(restartDelayMs(4, [at(4, 0)]), 0);
  assert.deepEqual(nextAction(2, [at(2, 0)]), { error: "bad configuration" });
  assert.deepEqual(nextAction(3, [at(3, 0)]), { error: "already running elsewhere" });

  const h: ExitRecord[] = [];
  const delays: number[] = [];
  for (let i = 0; i < 3; i++) {
    h.push(at(1, i * 60_000));
    assert.equal(nextAction(1, h), "restart");
    delays.push(restartDelayMs(1, h));
  }
  assert.deepEqual(delays, [2_000, 10_000, 30_000]);
  h.push(at(1, 3 * 60_000));
  assert.deepEqual(nextAction(1, h), { error: "keeps crashing" });

  // the same four crashes spread over more than 10 minutes are not a loop; a restart (4) does not count
  const spread = [at(1, 0), at(4, 1), at(1, 400_000), at(1, 800_000), at(1, 1_200_000)];
  assert.equal(nextAction(1, spread), "restart");
  assert.equal(nextAction(null, spread), "restart");
});

function setup(script: string): { dir: string; file: string; states: SupervisorState[]; sup: Supervisor } {
  const dir = mkdtempSync(join(tmpdir(), "a7-sup-"));
  const file = join(dir, "child.js");
  writeFileSync(file, script);
  const states: SupervisorState[] = [];
  const sup = new Supervisor({ name: "t", nodeExe: process.execPath, script: file, cwd: dir, logFile: join(dir, "logs", "t.log"), onState: (s) => states.push(s) });
  return { dir, file, states, sup };
}

test("Supervisor.stop: graceful shutdown over IPC, taskkill when ignored, no respawn, logs captured", async () => {
  const ok = setup(`console.log("hello-out"); process.on("message", (m) => { if (m && m.type === "shutdown") process.exit(0); }); setInterval(() => {}, 1000);`);
  try {
    ok.sup.start();
    await new Promise((r) => setTimeout(r, 1000));
    const pid = ok.sup.pid;
    assert.ok(pid);
    await ok.sup.stop(5000);
    assert.equal(ok.states.at(-1)?.state, "stopped");
    assert.ok(ok.states.some((s) => s.state === "running"));
    assert.equal(ok.sup.pid, undefined);
    assert.match(readFileSync(join(ok.dir, "logs", "t.log"), "utf8"), /hello-out/);
  } finally {
    await ok.sup.stop(100);
    rmSync(ok.dir, { recursive: true, force: true });
  }

  const stubborn = setup(`process.on("message", () => {}); setInterval(() => {}, 1000);`);
  try {
    stubborn.sup.start();
    await new Promise((r) => setTimeout(r, 1000));
    const pid = stubborn.sup.pid;
    assert.ok(pid);
    await stubborn.sup.stop(300);
    assert.equal(stubborn.states.at(-1)?.state, "stopped");
    assert.throws(() => process.kill(pid!, 0)); // gone
  } finally {
    rmSync(stubborn.dir, { recursive: true, force: true });
  }
});

test("Supervisor: stop during backoff does not respawn; exit 2 reports the last stderr line", async () => {
  const crash = setup(`console.error("boom line"); process.exit(1);`);
  const timers: Array<() => void> = [];
  let cleared = 0;
  const sup = new Supervisor({
    name: "t", nodeExe: process.execPath, script: crash.file, cwd: crash.dir, logFile: join(crash.dir, "t.log"),
    onState: (s) => crash.states.push(s),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => { cleared++; },
  });
  try {
    sup.start();
    for (let i = 0; i < 50 && timers.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(timers.length, 1);
    await sup.stop();
    assert.equal(cleared, 1);
    timers[0]?.(); // a late timer must not spawn
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sup.pid, undefined);
  } finally {
    rmSync(crash.dir, { recursive: true, force: true });
  }

  const bad = setup(`console.error("bad config here"); process.exit(2);`);
  try {
    bad.sup.start();
    for (let i = 0; i < 50 && bad.states.at(-1)?.state !== "error"; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(bad.states.at(-1), { state: "error", reason: "bad configuration", lastStderrLine: "bad config here" });
  } finally {
    rmSync(bad.dir, { recursive: true, force: true });
  }
});
