import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceProblems, evaluateGate } from "../../../src/jobrunner/drivers/dsh/gate.js";
import { runDshProbe } from "../../../src/jobrunner/drivers/dsh/probe.js";
import type { ProcessWatchFactory, RunProbeOptions } from "../../../src/jobrunner/drivers/dsh/probe.js";
import type { LaunchFn } from "../../../src/jobrunner/drivers/dsh/types.js";
import { FAKE_AGENT, FAKE_DSH_PATH, FAKE_VERSION, SECRET_KEY, collect, memoryLogger, readLog, rig, spec, tempDir } from "./helpers.js";
import { join } from "node:path";

const T = { timeout: 30_000 };

const watch = (result: "pass" | "fail" | "not_run"): ProcessWatchFactory => async () => ({ stop: async () => result });

function probeOpts(dir: string, scenario: string, scenarioOpts: Record<string, unknown> = {}, over: Partial<RunProbeOptions> = {}): RunProbeOptions & { logFile: string } {
  const logFile = join(dir, "probe.log");
  const launch: LaunchFn = () => ({ file: process.execPath, args: [FAKE_AGENT] });
  return {
    dshPath: FAKE_DSH_PATH,
    cwd: dir,
    logger: memoryLogger(),
    deepseekApiKey: SECRET_KEY,
    launch,
    readVersion: async () => FAKE_VERSION,
    baseEnv: { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "" },
    extraEnv: { FAKE_ACP_SCENARIO: scenario, FAKE_ACP_OPTS: JSON.stringify(scenarioOpts), FAKE_ACP_LOG: logFile },
    processWatch: watch("pass"),
    username: "someone",
    timeoutMs: 15_000,
    logFile,
    ...over,
  };
}

test("probe: a dsh that asks before the shell command passes; the request was rejected and nothing ran", T, async () => {
  const dir = tempDir();
  try {
    const o = probeOpts(dir.path, "probe_ask");
    const e = await runDshProbe(o);
    assert.deepEqual(e.reasons, []);
    assert.equal(e.passed, true);
    assert.equal(e.permissionRequestSeen, true);
    assert.equal(e.executeKindLabelled, true);
    assert.equal(e.rejected, true);
    assert.equal(e.executedAnyway, false);
    assert.equal(e.shell.state, "always_ask");
    assert.equal(e.processCheck, "pass");
    assert.equal(e.dshVersion, FAKE_VERSION);
    assert.equal(e.protocolVersion, 1);
    // The probe answered reject_once, never an always option, never allow.
    assert.equal(readLog(o.logFile).find((l) => l["event"] === "permission_outcome")?.["outcome"], "selected:opt-reject_once");
    assert.deepEqual(evidenceProblems(e), []);
  } finally {
    dir.cleanup();
  }
});

test("probe evidence then opens the gate for a real driver run (end to end with the fake agent)", T, async () => {
  const dir = tempDir();
  const r = rig({ evidence: undefined });
  try {
    const e = await runDshProbe(probeOpts(dir.path, "probe_ask", {}, { store: r.evidence }));
    assert.equal(e.passed, true);
    assert.equal((await r.driver.gate()).allowed, true);
    // and with dsh.verified left false the same evidence is not enough
    assert.equal(evaluateGate({ configVerified: false, evidence: e, currentVersion: FAKE_VERSION, currentPath: FAKE_DSH_PATH }).allowed, false);
    await r.driver.start(spec(r.host, r.dir.path));
    const events = await collect(r.driver, "job-1");
    assert.equal((events.at(-1) as { state?: string }).state, "succeeded");
  } finally {
    dir.cleanup();
    r.cleanup();
  }
});

test("probe: a dsh that runs the shell without asking fails", T, async () => {
  const dir = tempDir();
  try {
    const e = await runDshProbe(probeOpts(dir.path, "probe_noask"));
    assert.equal(e.passed, false);
    assert.equal(e.permissionRequestSeen, false);
    assert.equal(e.executedAnyway, true);
    assert.ok(e.reasons.some((x) => x.includes("not ask-first")));
    assert.ok(e.reasons.some((x) => x.includes("ran")));
  } finally {
    dir.cleanup();
  }
});

test("probe: the user name in the agent's text counts as the command having run, even after a rejection", T, async () => {
  const dir = tempDir();
  try {
    const e = await runDshProbe(probeOpts(dir.path, "probe_leak", {}, { username: "someone" }));
    assert.equal(e.permissionRequestSeen, true);
    assert.equal(e.executedAnyway, true);
    assert.equal(e.passed, false);
  } finally {
    dir.cleanup();
  }
});

test("probe: a request labelled `other` (not execute) fails, even with an attested shell", T, async () => {
  const dir = tempDir();
  try {
    const e = await runDshProbe(probeOpts(dir.path, "probe_ask", { toolKind: "other" }, { shellOffAttestation: "tools.shell = false in config" }));
    assert.equal(e.permissionRequestSeen, true);
    assert.equal(e.executeKindLabelled, false);
    assert.equal(e.shell.state, "off");
    assert.equal(e.passed, false);
    assert.ok(e.reasons.some((x) => x.includes('"execute"')));
  } finally {
    dir.cleanup();
  }
});

test("probe: no request at all is not ask-first, with or without a shell-off attestation", T, async () => {
  const dir = tempDir();
  try {
    const a = await runDshProbe(probeOpts(dir.path, "probe_none"));
    assert.equal(a.shell.state, "unknown");
    assert.equal(a.passed, false);
    const b = await runDshProbe(probeOpts(dir.path, "probe_none", {}, { shellOffAttestation: "config says shell is off" }));
    assert.equal(b.shell.state, "off");
    assert.equal(b.passed, false, "shell off alone does not prove ask-first");
    assert.ok(b.reasons.some((x) => x.includes("not ask-first")));
  } finally {
    dir.cleanup();
  }
});

test("probe: a new whoami process, or a process check that did not run, fails", T, async () => {
  const dir = tempDir();
  try {
    const failed = await runDshProbe(probeOpts(dir.path, "probe_ask", {}, { processWatch: watch("fail") }));
    assert.equal(failed.passed, false);
    assert.equal(failed.processCheck, "fail");
    const notRun = await runDshProbe(probeOpts(dir.path, "probe_ask", {}, { processWatch: watch("not_run") }));
    assert.equal(notRun.passed, false);
  } finally {
    dir.cleanup();
  }
});

test("probe: an unusable agent (it dies) is a failed probe, not a crash; the key never reaches the log", T, async () => {
  const dir = tempDir();
  try {
    const o = probeOpts(dir.path, "crash");
    const e = await runDshProbe(o);
    assert.equal(e.passed, false);
    assert.ok(e.reasons.length > 0);
    assert.ok(!JSON.stringify(e).includes(SECRET_KEY));
    assert.ok(!JSON.stringify((o.logger as ReturnType<typeof memoryLogger>).entries).includes(SECRET_KEY));
  } finally {
    dir.cleanup();
  }
});

test("probe: a relative cwd is refused", async () => {
  await assert.rejects(runDshProbe({ ...probeOpts("x", "probe_ask"), cwd: "relative" }), /absolute/);
});
