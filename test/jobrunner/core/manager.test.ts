/**
 * S11.1, S11.3, S11.4 done-checks through the job manager with FAKE drivers: the happy path and the event contract,
 * refusals, queueing, cancel (including a real process tree), caps, permissions, recovery and resume.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { test } from "node:test";
import { IpcHandlerError } from "../../../src/ipc/server.js";
import { BRIEF_END, BRIEF_START, TemplateRegistry } from "../../../src/jobrunner/templates.js";
import { isProcessAlive } from "../../../src/jobrunner/proc.js";
import type { CoreEngineHost } from "../../../src/jobrunner/manager.js";
import type { JobEvent } from "../../../src/jobs/contracts.js";
import { claudeTemplate, flowTemplate, makeEnv, makeRig, sleep, submitBody, waitFor } from "./helpers.js";
import type { FakeJob, Rig } from "./helpers.js";

const IS_WIN = process.platform === "win32";

function kinds(events: JobEvent[], jobId: string): string[] {
  return events.filter((e) => e.jobId === jobId).map((e) => (e.kind === "state" ? `state:${e.state}` : e.kind));
}
function forJob(events: JobEvent[], jobId: string): JobEvent[] {
  return events.filter((e) => e.jobId === jobId);
}
async function rejectsWith(p: Promise<unknown>, code: string, re?: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof IpcHandlerError, `expected IpcHandlerError, got ${String(e)}`);
    assert.equal(e.code, code);
    if (re) assert.match(e.message, re);
    return true;
  });
}
function hostOf(job: FakeJob): CoreEngineHost {
  return job.host as CoreEngineHost;
}

test("happy path: events are renumbered gapless from 1, the last two are result then a terminal state, and job_done is pushed", async () => {
  const rig = makeRig();
  try {
    const d = rig.drivers.claude;
    d.onStart = (job) => {
      job.emit({ kind: "init", engineSessionId: "sess-1", engineVersion: "2.1.0" });
      job.text("hello");
      job.emit({ kind: "tool_call", callId: "c1", tool: "Read", input: { path: "runs/a.txt" } });
      job.emit({ kind: "tool_result", callId: "c1", tool: "Read", ok: true, text: "contents" });
      job.finish("succeeded", "all done");
    };
    const reply = await rig.manager.submit(submitBody("job-1"));
    assert.deepEqual(reply, { jobId: "job-1", state: "running", duplicate: false });
    await rig.manager.idle();

    const evs = forJob(rig.events, "job-1");
    assert.deepEqual(evs.map((e) => e.seq), evs.map((_, i) => i + 1), "gapless from 1");
    assert.deepEqual(kinds(rig.events, "job-1"), ["state:queued", "state:running", "init", "text", "tool_call", "tool_result", "result", "state:succeeded"]);
    assert.ok(evs.every((e) => e.ts > 1000), "the core stamps the time, not the driver");
    assert.equal(rig.dones.length, 1);
    assert.equal(rig.dones[0]?.state, "succeeded");
    assert.equal(rig.dones[0]?.summary, "all done");
    assert.equal(rig.dones[0]?.engineVersion, "2.1.0", "the version the engine reports in init wins over version()");

    // the spec the driver got: validated real cwd, prompt with the brief in its markers, host with policy and channel
    const spec = d.starts[0]!;
    assert.equal(spec.cwd.toLowerCase(), rig.env.hub.toLowerCase());
    assert.ok(spec.prompt.includes(BRIEF_START) && spec.prompt.includes("make it nice") && spec.prompt.includes(BRIEF_END));
    assert.match(spec.prompt, /Topic: cats/);
    assert.equal(typeof spec.host.askPermission, "function");
    const host = spec.host as CoreEngineHost;
    assert.equal(host.channel?.host, "127.0.0.1");
    assert.equal(host.channel?.port, 47007);
    assert.equal(host.channel?.token.length, 43);
    assert.equal(rig.jobKeys.size, 0, "the per-job key is gone after the job");

    // audit and journal
    assert.deepEqual(rig.audit.events.map((e) => e.event), ["submitted", "started", "finished"]);
    const sub = rig.audit.events[0]!;
    assert.equal(sub.event === "submitted" && sub.approvalUserId, 42);
    assert.ok(!JSON.stringify(rig.audit.events).includes("make it nice"), "the brief itself is not in the audit");
    const replayed = rig.journal.replay().records.get("job-1")!;
    assert.equal(replayed.state, "succeeded");
    assert.equal(replayed.engineSessionId, "sess-1");
    assert.equal(replayed.engineVersion, "2.1.0");
    assert.equal(replayed.lastSeq, evs.length);

    // status
    const st = rig.manager.status({ jobId: "job-1", sinceSeq: 6 });
    assert.equal(st.jobs[0]?.state, "succeeded");
    assert.equal(st.jobs[0]?.done?.summary, "all done");
    assert.deepEqual(st.events?.map((e) => e.seq), [7, 8]);
    assert.equal(st.daily.jobs, 1);
    assert.equal(st.engines.claude?.enabled, true);
    assert.equal(st.engines.claude?.version, "fake 1.0");
    assert.equal(rig.manager.status({}).jobs.length, 1);
    assert.throws(() => rig.manager.status({ jobId: "nope" }), (e: unknown) => e instanceof IpcHandlerError && e.code === "not_found");
  } finally {
    rig.env.cleanup();
  }
});

test("submit is idempotent on jobId: a repeat returns duplicate:true and starts nothing", async () => {
  const rig = makeRig();
  try {
    await rig.manager.submit(submitBody("job-1"));
    const again = await rig.manager.submit(submitBody("job-1"));
    assert.equal(again.duplicate, true);
    assert.equal(again.state, "running");
    assert.equal(rig.drivers.claude.starts.length, 1);
    rig.drivers.claude.job("job-1").finish();
    await rig.manager.idle();
    const third = await rig.manager.submit(submitBody("job-1"));
    assert.deepEqual(third, { jobId: "job-1", state: "succeeded", duplicate: true });
    assert.equal(rig.drivers.claude.starts.length, 1);
    assert.equal(rig.audit.events.filter((e) => e.event === "submitted").length, 1);
  } finally {
    rig.env.cleanup();
  }
});

test("refusals: unknown template, invalid params, a denied cwd, a disabled engine; nothing is journaled or started and each is audited", async () => {
  const env = makeEnv();
  const rig = makeRig({
    env,
    templates: [
      claudeTemplate(env),
      claudeTemplate(env, { id: "in-pixotope", cwd: env.pixotope }),
      claudeTemplate(env, { id: "dsh-off", engine: "dsh" }),
      claudeTemplate(env, { id: "hub-scriptorium", engine: "hub", hubService: "scriptorium", prompt: "", disallowedTools: [], allowedTools: [], params: { type: "object", properties: {} }, paidModels: true }),
    ],
  });
  try {
    await rejectsWith(rig.manager.submit(submitBody("j1", { templateId: "nope" })), "unknown_template");
    await rejectsWith(rig.manager.submit(submitBody("j2", { params: { topic: "NOT OK" } })), "invalid_params", /wrong format/);
    await rejectsWith(rig.manager.submit(submitBody("j3", { params: { topic: "cats", cwd: "C:\\Pixotope" } })), "invalid_params", /unknown parameter "cwd"/);
    await rejectsWith(rig.manager.submit(submitBody("j4", { templateId: "in-pixotope" })), "cwd_refused", /denied path/);
    await rejectsWith(rig.manager.submit(submitBody("j5", { templateId: "dsh-off" })), "engine_disabled");
    await rejectsWith(rig.manager.submit(submitBody("j6", { templateId: "hub-scriptorium", params: {} })), "forbidden", /scriptorium/);
    assert.equal(rig.drivers.claude.starts.length, 0);
    assert.equal(rig.journal.replay().records.size, 0, "a refused job leaves no journal file");
    assert.deepEqual(rig.audit.events.map((e) => (e.event === "rejected" ? e.code : e.event)), ["unknown_template", "invalid_params", "invalid_params", "cwd_refused", "engine_disabled", "forbidden"]);
    // dsh needs both the engine switch and dsh.verified
    const off = makeRig({ env: makeEnv({ engines: { claude: { enabled: true }, dsh: { enabled: true, verified: false }, hub: { enabled: true } } }), templates: [claudeTemplate(env, { id: "dsh-on", engine: "dsh", enabled: true })] });
    await rejectsWith(off.manager.submit(submitBody("j7", { templateId: "dsh-on" })), "engine_disabled", /dsh\.verified is false/);
    assert.equal(off.manager.status({}).engines.dsh?.enabled, false);
    off.env.cleanup();
  } finally {
    env.cleanup();
  }
});

test("a dsh template with enabled:true runs when the engine is on and verified", async () => {
  const env = makeEnv();
  const rig = makeRig({ env, templates: [claudeTemplate(env, { id: "dsh-on", engine: "dsh", enabled: true })] });
  try {
    rig.drivers.dsh.onStart = (job) => job.finish("succeeded", "dsh ok");
    await rig.manager.submit(submitBody("d1", { templateId: "dsh-on" }));
    await rig.manager.idle();
    assert.equal(rig.dones[0]?.state, "succeeded");
    assert.equal(rig.drivers.claude.starts.length, 0);
  } finally {
    env.cleanup();
  }
});

test("caps: the daily job cap, the Flow budget rules and the daily credit cap are enforced on submit", async () => {
  const env = makeEnv({ limits: { dailyJobCap: 3, dailyCreditCap: 120 } });
  const rig = makeRig({ env, templates: [claudeTemplate(env), flowTemplate(env)] });
  try {
    rig.drivers.claude.onStart = (job) => job.finish();
    await rejectsWith(rig.manager.submit(submitBody("f1", { templateId: "video-clip" })), "bad_request", /credit budget/);
    await rejectsWith(rig.manager.submit(submitBody("f2", { templateId: "video-clip", flowBudgetCredits: 101 })), "limit_exceeded", /at most 100 credits/);
    await rejectsWith(rig.manager.submit(submitBody("f3", { flowBudgetCredits: 5 })), "bad_request", /does not use Flow/);
    assert.equal((await rig.manager.submit(submitBody("f4", { templateId: "video-clip", flowBudgetCredits: 100 }))).state, "running");
    await rig.manager.idle();
    await rejectsWith(rig.manager.submit(submitBody("f5", { templateId: "video-clip", flowBudgetCredits: 30 })), "limit_exceeded", /daily credit cap \(120\)/);
    await rig.manager.submit(submitBody("p1"));
    await rig.manager.idle();
    await rig.manager.submit(submitBody("p2"));
    await rig.manager.idle();
    await rejectsWith(rig.manager.submit(submitBody("p3")), "limit_exceeded", /daily job cap \(3\)/);
    const st = rig.manager.status({});
    assert.deepEqual(st.daily, { jobs: 3, jobCap: 3, credits: 100, creditCap: 120 });
    // the caps survive a restart: they come from the journal
    const again = rig.restart();
    again.manager.recover();
    await rejectsWith(again.manager.submit(submitBody("p4")), "limit_exceeded", /daily job cap/);
  } finally {
    env.cleanup();
  }
});

test("one job per engine at a time: the next is queued durably and starts when the first ends; other engines run in parallel", async () => {
  const env = makeEnv();
  const rig = makeRig({ env, templates: [claudeTemplate(env), claudeTemplate(env, { id: "dsh-on", engine: "dsh", enabled: true })] });
  try {
    const a = await rig.manager.submit(submitBody("a"));
    const b = await rig.manager.submit(submitBody("b"));
    const c = await rig.manager.submit(submitBody("c"));
    const x = await rig.manager.submit(submitBody("x", { templateId: "dsh-on" }));
    assert.equal(a.state, "running");
    assert.deepEqual([b.state, b.queuePosition], ["queued", 1]);
    assert.deepEqual([c.state, c.queuePosition], ["queued", 2]);
    assert.equal(x.state, "running", "a DeepSeek job runs next to a Claude job");
    assert.equal(rig.manager.status({}).engines.claude?.queued, 2);
    assert.equal(rig.drivers.claude.starts.length, 1);
    // the queue is in the journal
    assert.equal(rig.journal.replay().records.get("b")?.state, "queued");

    rig.drivers.claude.job("a").finish();
    await waitFor(() => rig.drivers.claude.starts.length === 2);
    assert.equal(rig.drivers.claude.starts[1]?.jobId, "b");
    assert.equal(rig.manager.status({ jobId: "c" }).jobs[0]?.state, "queued");
    rig.drivers.claude.job("b").finish();
    await waitFor(() => rig.drivers.claude.starts.length === 3);
    rig.drivers.claude.job("c").finish();
    rig.drivers.dsh.job("x").finish();
    await rig.manager.idle();
    assert.deepEqual(rig.dones.map((d) => d.jobId).sort(), ["a", "b", "c", "x"]);
  } finally {
    env.cleanup();
  }
});

test("cancel: a queued job ends without running; a running job is asked to stop and ends cancelled; a finished one is a no-op", async () => {
  const rig = makeRig();
  try {
    await rig.manager.submit(submitBody("a"));
    await rig.manager.submit(submitBody("b"));
    const cq = rig.manager.cancel({ jobId: "b", reason: "changed my mind" });
    assert.equal(cq.state, "cancelled");
    assert.deepEqual(kinds(rig.events, "b"), ["state:queued", "result", "state:cancelled"]);
    assert.equal(rig.drivers.claude.starts.length, 1);
    assert.equal(rig.dones.find((d) => d.jobId === "b")?.state, "cancelled");

    const cr = rig.manager.cancel({ jobId: "a" });
    assert.equal(cr.state, "cancelling");
    await rig.manager.idle();
    assert.deepEqual(rig.drivers.claude.cancels, ["a"]);
    assert.deepEqual(kinds(rig.events, "a").slice(-3), ["state:cancelling", "result", "state:cancelled"]);
    assert.equal(rig.manager.cancel({ jobId: "a" }).state, "cancelled", "terminal: no-op");
    assert.ok(rig.audit.events.some((e) => e.event === "cancelled" && e.jobId === "a" && e.by === "agent"));
    assert.ok(rig.audit.events.some((e) => e.event === "finished" && e.jobId === "a" && e.state === "cancelled"));
    assert.throws(() => rig.manager.cancel({ jobId: "zzz" }), (e: unknown) => e instanceof IpcHandlerError && e.code === "not_found");
  } finally {
    rig.env.cleanup();
  }
});

test("a driver that ignores cancel: after the grace period the core kills the reported child tree and still ends the job", async () => {
  const killed: number[] = [];
  const rig = makeRig({ overrides: { killTree: (pid) => (killed.push(pid), Promise.resolve(true)) } });
  try {
    const d = rig.drivers.claude;
    d.onCancel = () => undefined; // hangs: never ends its stream
    d.onStart = (job) => hostOf(job).reportChildPid(777_001);
    await rig.manager.submit(submitBody("a"));
    const t0 = Date.now();
    rig.manager.cancel({ jobId: "a" });
    await rig.manager.idle();
    assert.ok(Date.now() - t0 >= 900, "waited for the grace period (1 s in this config)");
    assert.deepEqual(killed, [777_001]);
    assert.equal(rig.dones[0]?.state, "cancelled");
    assert.equal(rig.journal.replay().records.get("a")?.pid, 777_001, "the child PID is in the journal");
  } finally {
    rig.env.cleanup();
  }
});

function pidsAlive(pids: number[]): number[] {
  return pids.filter((p) => isProcessAlive(p));
}

test("cancel kills a REAL process tree: a `cmd /c ping -t` child and its ping grandchild are gone", { skip: !IS_WIN && "Windows-only", timeout: 60_000 }, async () => {
  const rig = makeRig();
  try {
    const d = rig.drivers.claude;
    d.onCancel = () => undefined; // the driver does nothing: the core's tree kill must do it
    let childPid = 0;
    d.onStart = (job) => {
      const child = spawn("cmd.exe", ["/c", "ping -t 127.0.0.1 > nul"], { stdio: "ignore", windowsHide: true });
      childPid = child.pid ?? 0;
      hostOf(job).reportChildPid(childPid);
    };
    await rig.manager.submit(submitBody("a"));
    await waitFor(() => childPid > 0);
    let grandchild = 0;
    for (let i = 0; i < 40 && grandchild === 0; i++) {
      await sleep(100);
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${childPid}' | Select-Object -First 1).ProcessId`], { encoding: "utf8" }).trim();
      grandchild = Number(out) || 0;
    }
    assert.ok(grandchild > 0, "the ping grandchild was found");
    assert.deepEqual(pidsAlive([childPid, grandchild]), [childPid, grandchild]);
    rig.manager.cancel({ jobId: "a" });
    await rig.manager.idle();
    await waitFor(() => pidsAlive([childPid, grandchild]).length === 0, 10_000, "the process tree to die");
    assert.equal(rig.dones[0]?.state, "cancelled");
  } finally {
    rig.env.cleanup();
  }
});

test("duration cap: a job that runs past its limit is cancelled and ends failed with a timeout detail", async () => {
  const rig = makeRig();
  try {
    rig.manager.limits.timeoutMs = () => 150;
    await rig.manager.submit(submitBody("a"));
    await rig.manager.idle();
    const done = rig.dones[0]!;
    assert.equal(done.state, "failed");
    assert.match(done.error ?? "", /timed out/);
    assert.ok(rig.audit.events.some((e) => e.event === "cancelled" && e.by === "timeout"));
    assert.deepEqual(rig.drivers.claude.cancels, ["a"]);
  } finally {
    rig.env.cleanup();
  }
});

test("output cap: long events are cut, a job that keeps writing past the cap is stopped and ends failed", async () => {
  const env = makeEnv({ limits: { outputCapBytes: 2048, maxEventTextChars: 120 } });
  const rig = makeRig({ env });
  try {
    rig.drivers.claude.onStart = (job) => {
      for (let i = 0; i < 60; i++) job.text("z".repeat(300));
    };
    await rig.manager.submit(submitBody("a"));
    await rig.manager.idle();
    assert.equal(rig.dones[0]?.state, "failed");
    assert.match(rig.dones[0]?.error ?? "", /output cap/);
    const texts = forJob(rig.events, "a").filter((e) => e.kind === "text");
    assert.ok(texts.length > 0 && texts.length < 60, `kept ${texts.length} of 60`);
    assert.ok(texts.every((e) => e.kind === "text" && e.text.length < 200));
    const total = forJob(rig.events, "a").reduce((n, e) => n + JSON.stringify(e).length, 0);
    assert.ok(total < 6000, `bounded output (${total} bytes)`);
    assert.ok(rig.audit.events.some((e) => e.event === "cancelled" && e.by === "output_cap"));
  } finally {
    env.cleanup();
  }
});

test("a failing driver ends the job failed: no terminal state, a thrown start, an unreadable version", async () => {
  const rig = makeRig();
  try {
    const d = rig.drivers.claude;
    d.onStart = (job) => job.endSilently();
    await rig.manager.submit(submitBody("silent"));
    await rig.manager.idle();
    assert.match(rig.dones[0]?.error ?? "", /without a final state/);

    d.onStart = () => {
      throw new Error("spawn failed: ENOENT");
    };
    await rig.manager.submit(submitBody("throws"));
    await rig.manager.idle();
    assert.match(rig.dones[1]?.error ?? "", /spawn failed/);

    d.onStart = undefined;
    d.versionError = new Error("claude not found");
    await rig.manager.submit(submitBody("noversion"));
    await rig.manager.idle();
    assert.match(rig.dones[2]?.error ?? "", /cannot read the claude version: claude not found/);
    assert.equal(rig.dones.every((x) => x.state === "failed"), true);
    // the last two events are always result then a terminal state
    for (const id of ["silent", "throws", "noversion"]) assert.deepEqual(kinds(rig.events, id).slice(-2), ["result", "state:failed"]);
  } finally {
    rig.env.cleanup();
  }
});

test("secrets in tool output never reach events or the journal; a driver's own flow_call and non-terminal states are ignored", async () => {
  const rig = makeRig();
  try {
    rig.drivers.claude.onStart = (job) => {
      job.text("token is SECRET-VALUE-1234 end");
      job.emit({ kind: "flow_call", tool: "x", maxCredits: 1, allowed: true, chargedTotal: 1, remaining: 0 });
      job.emit({ kind: "state", state: "running" });
      job.finish();
    };
    await rig.manager.submit(submitBody("a"));
    await rig.manager.idle();
    assert.ok(!JSON.stringify(rig.events).includes("SECRET-VALUE-1234"));
    assert.ok(JSON.stringify(rig.events).includes("[REDACTED]"));
    assert.ok(!kinds(rig.events, "a").includes("flow_call"));
    assert.equal(kinds(rig.events, "a").filter((k) => k === "state:running").length, 1);
  } finally {
    rig.env.cleanup();
  }
});

// ---- permissions ---------------------------------------------------------------------------------

test("askPermission: a request goes to the agent, shows in status, and the agent's decision resolves it (audited)", async () => {
  const rig = makeRig();
  try {
    await rig.manager.submit(submitBody("a"));
    const host = hostOf(rig.drivers.claude.job("a"));
    const p = host.askPermission({ requestId: "r1", jobId: "ignored", engine: "dsh", tool: "Edit", input: { file: "x" }, cwd: "ignored", kind: "edit", summary: "Edit x", requestedAt: 0, timeoutSec: 1 });
    await waitFor(() => rig.permissions.length === 1);
    const pushed = rig.permissions[0]!;
    assert.equal(pushed.jobId, "a", "the core fills the job id");
    assert.equal(pushed.engine, "claude");
    assert.equal(pushed.cwd.toLowerCase(), rig.env.hub.toLowerCase());
    assert.equal(pushed.timeoutSec, 1800);
    assert.equal(rig.manager.status({ jobId: "a" }).jobs[0]?.pendingPermissions.length, 1);
    rig.manager.decidePermission({ requestId: "r1", jobId: "a", answer: "allow_once", by: "user", userId: 42, at: 5 });
    const d = await p;
    assert.deepEqual([d.answer, d.by, d.userId], ["allow_once", "user", 42]);
    assert.equal(rig.manager.status({ jobId: "a" }).jobs[0]?.pendingPermissions.length, 0);
    assert.deepEqual(rig.audit.events.filter((e) => e.event.startsWith("permission")).map((e) => e.event), ["permission_asked", "permission_decided"]);
    // an "always" style answer is not representable: anything but allow_once is a deny
    const p2 = host.askPermission({ requestId: "r2", jobId: "a", engine: "claude", tool: "Edit", input: {}, cwd: "", kind: "edit", requestedAt: 0, timeoutSec: 1 });
    await waitFor(() => rig.permissions.length === 2);
    rig.manager.decidePermission({ requestId: "r2", jobId: "a", answer: "allow_always" as never, by: "user", at: 5 });
    assert.equal((await p2).answer, "deny");
    // decisions for unknown requests or jobs are ignored
    rig.manager.decidePermission({ requestId: "nope", jobId: "a", answer: "allow_once", by: "user", at: 1 });
    rig.manager.decidePermission({ requestId: "r1", jobId: "other", answer: "allow_once", by: "user", at: 1 });
    rig.drivers.claude.job("a").finish();
    await rig.manager.idle();
  } finally {
    rig.env.cleanup();
  }
});

test("a permission request times out to deny; cancel and job end also deny; a shell-kind request is denied without asking", async () => {
  const env = makeEnv({ limits: { permissionTimeoutSec: 1 } });
  const rig = makeRig({ env });
  try {
    await rig.manager.submit(submitBody("a"));
    const host = hostOf(rig.drivers.claude.job("a"));
    const req = (id: string, kind: "edit" | "execute" = "edit") => host.askPermission({ requestId: id, jobId: "a", engine: "claude", tool: kind === "execute" ? "Bash" : "Edit", input: {}, cwd: "", kind, requestedAt: 0, timeoutSec: 99 });
    const t0 = Date.now();
    const timedOut = await req("t1");
    assert.ok(Date.now() - t0 >= 900);
    assert.deepEqual([timedOut.answer, timedOut.by], ["deny", "timeout"]);

    const shell = await req("s1", "execute");
    assert.deepEqual([shell.answer, shell.by], ["deny", "policy"]);
    assert.equal(rig.permissions.filter((p) => p.requestId === "s1").length, 0, "the shell request never reached the user");

    const pending = host.askPermission({ requestId: "c1", jobId: "a", engine: "claude", tool: "Edit", input: {}, cwd: "", kind: "edit", requestedAt: 0, timeoutSec: 99 });
    await waitFor(() => rig.permissions.some((p) => p.requestId === "c1"));
    rig.manager.cancel({ jobId: "a" });
    const cancelled = await pending;
    assert.deepEqual([cancelled.answer, cancelled.by], ["deny", "cancel"]);
    const late = await req("late");
    assert.equal(late.by, "cancel", "nothing is asked of a job that is ending");
    await rig.manager.idle();
  } finally {
    env.cleanup();
  }
});

test("helper path (I28): the core applies its own rules first, asks once for anything else, and refuses other jobs and ended jobs", async () => {
  const env = makeEnv();
  const rig = makeRig({ env, templates: [claudeTemplate(env), flowTemplate(env)] });
  try {
    await rig.manager.submit(submitBody("a", { templateId: "video-clip", flowBudgetCredits: 100 }));
    await rig.manager.submit(submitBody("other"));
    assert.equal(rig.jobKeys.size, 1, "only the running claude job has a key (the second is queued)");
    const h = (tool: string, input: unknown, requestId = `r-${tool}-${Math.random().toString(36).slice(2, 8)}`) =>
      rig.manager.handleHelperPermission({ requestId, jobId: "a", tool, input: input as never }, "a");

    // Bash and a Scriptorium start: denied without asking
    assert.equal((await h("Bash", { command: "dir" })).decision, "deny");
    assert.equal((await h("mcp__scriptorium__start_factory", {})).decision, "deny");
    // Flow: allowed within the budget, denied beyond it, each as a flow_call event and an audit line
    assert.equal((await h("mcp__flow-music-mcp__generate_video", { max_credits: 60 })).decision, "allow_once");
    assert.equal((await h("mcp__flow-music-mcp__generate_video", { max_credits: 60 })).decision, "deny");
    assert.equal((await h("mcp__flow-music-mcp__generate_video", {})).decision, "deny");
    assert.equal((await h("mcp__flow-music-mcp__generate_video", { max_credits: 40 })).decision, "allow_once");
    assert.equal(rig.permissions.length, 0, "none of those reached the user");
    const flowEvents = forJob(rig.events, "a").filter((e) => e.kind === "flow_call");
    assert.deepEqual(flowEvents.map((e) => (e.kind === "flow_call" ? [e.allowed, e.maxCredits, e.chargedTotal, e.remaining] : [])), [[true, 60, 60, 40], [false, 60, 60, 40], [false, 0, 60, 40], [true, 40, 100, 0]]);
    assert.equal(rig.audit.events.filter((e) => e.event === "flow_call").length, 4);
    assert.equal(rig.journal.replay().records.get("a")?.flowCharged, 100);

    // anything else: exactly one permission_request, and the answer comes back
    const asked = h("Edit", { file_path: "notes.md" }, "e1");
    await waitFor(() => rig.permissions.length === 1);
    assert.equal(rig.permissions[0]?.kind, "edit");
    assert.equal(rig.permissions[0]?.requestId, "e1");
    rig.manager.decidePermission({ requestId: "e1", jobId: "a", answer: "deny", by: "user", userId: 42, at: 1, message: "no" });
    assert.deepEqual(await asked, { decision: "deny", message: "no" });
    assert.equal(rig.permissions.length, 1);

    // the token of job `a` cannot speak for another job, nor for a job that is not running
    await assert.rejects(rig.manager.handleHelperPermission({ requestId: "x", jobId: "other", tool: "Edit", input: {} }, "a"), (e: unknown) => e instanceof IpcHandlerError && e.code === "forbidden");
    await assert.rejects(rig.manager.handleHelperPermission({ requestId: "x", jobId: "other", tool: "Edit", input: {} }, "other"), (e: unknown) => e instanceof IpcHandlerError && e.code === "forbidden", "queued, not running");
    rig.drivers.claude.job("a").finish();
    await waitFor(() => rig.drivers.claude.starts.length === 2);
    rig.drivers.claude.job("other").finish();
    await rig.manager.idle();
    await assert.rejects(h("Edit", {}), (e: unknown) => e instanceof IpcHandlerError && e.code === "forbidden");
    assert.equal(rig.jobKeys.get("a"), undefined);
  } finally {
    env.cleanup();
  }
});

// ---- crash, restart, resume -----------------------------------------------------------------------

test("restart: a running job becomes interrupted (no job_done), a queued job goes back in line, a cancelling job ends cancelled", async () => {
  const env = makeEnv();
  const rig = makeRig({ env });
  try {
    rig.drivers.claude.onStart = (job) => job.emit({ kind: "init", engineSessionId: "sess-7", engineVersion: "2.1.0" });
    await rig.manager.submit(submitBody("running"));
    await rig.manager.submit(submitBody("queued"));
    await waitFor(() => rig.journal.replay().records.get("running")?.engineSessionId === "sess-7");
    // simulate the crash: do not stop anything, build a fresh manager over the same journal
    const after = rig.restart();
    after.manager.recover();
    const st = after.manager.status({});
    const byId = Object.fromEntries(st.jobs.map((j) => [j.jobId, j]));
    // "queued" started at once (the engine slot of "running" is free after a restart)
    assert.equal(byId["running"]?.state, "interrupted");
    assert.equal(byId["running"]?.engineSessionId, "sess-7");
    assert.equal(byId["queued"]?.state, "running");
    await waitFor(() => after.drivers.claude.starts.length === 1);
    assert.equal(after.drivers.claude.starts[0]?.jobId, "queued");
    assert.deepEqual(kinds(after.events, "running"), ["state:interrupted"]);
    assert.equal(after.events.find((e) => e.jobId === "running")?.seq, 4, "seq continues where the journal left off");
    assert.equal(after.dones.length, 0, "interrupted is not terminal: no job_done");
    assert.ok(after.audit.events.some((e) => e.event === "interrupted" && e.jobId === "running"));
    after.drivers.claude.job("queued").finish();
    await after.manager.idle();
  } finally {
    env.cleanup();
  }
});

test("resume: submit {resume:true} continues an interrupted job with the recorded engine session; other cases are refused", async () => {
  const env = makeEnv();
  const rig = makeRig({ env });
  try {
    rig.drivers.claude.onStart = (job) => job.emit({ kind: "init", engineSessionId: "sess-7" });
    await rig.manager.submit(submitBody("a"));
    await waitFor(() => rig.journal.replay().records.get("a")?.engineSessionId === "sess-7");
    const after = rig.restart();
    after.manager.recover();
    assert.equal(after.manager.status({ jobId: "a" }).jobs[0]?.state, "interrupted");

    // a plain repeat of the submit does not restart it
    assert.equal((await after.manager.submit(submitBody("a"))).duplicate, true);
    assert.equal(after.drivers.claude.starts.length, 0);
    // resume of an unknown job
    await rejectsWith(after.manager.submit(submitBody("zzz", { resume: true })), "not_found");

    after.drivers.claude.onStart = (job) => job.finish("succeeded", "resumed fine");
    const r = await after.manager.submit(submitBody("a", { resume: true, approval: { userId: 42, at: 99 } }));
    assert.deepEqual([r.state, r.duplicate], ["running", false]);
    await after.manager.idle();
    assert.equal(after.drivers.claude.starts.length, 0);
    assert.equal(after.drivers.claude.resumes.length, 1);
    assert.equal(after.drivers.claude.resumes[0]?.engineSessionId, "sess-7");
    assert.equal(after.dones[0]?.state, "succeeded");
    assert.ok(after.audit.events.some((e) => e.event === "resumed" && e.jobId === "a"));
    assert.equal(after.journal.replay().records.get("a")?.resumeCount, 1);
    assert.ok(after.audit.events.some((e) => e.event === "started" && e.resumed === true));
    // resuming a finished job is just a duplicate
    assert.equal((await after.manager.submit(submitBody("a", { resume: true }))).duplicate, true);
    assert.equal(after.drivers.claude.resumes.length, 1);
  } finally {
    env.cleanup();
  }
});

test("a job with no recorded engine session cannot be resumed; cancel works on an interrupted job", async () => {
  const env = makeEnv();
  const rig = makeRig({ env });
  try {
    await rig.manager.submit(submitBody("a")); // the fake never emits init
    const after = rig.restart();
    after.manager.recover();
    await rejectsWith(after.manager.submit(submitBody("a", { resume: true })), "unsupported", /no engine session/);
    const c = after.manager.cancel({ jobId: "a" });
    assert.equal(c.state, "cancelled");
    assert.deepEqual(kinds(after.events, "a").slice(-2), ["result", "state:cancelled"]);
    assert.equal(after.dones[0]?.state, "cancelled");
  } finally {
    env.cleanup();
  }
});

test("a job that was cancelling at the crash ends cancelled after the restart", async () => {
  const env = makeEnv({ limits: { cancelGraceSec: 600 } });
  const rig = makeRig({ env });
  try {
    rig.drivers.claude.onCancel = () => undefined;
    await rig.manager.submit(submitBody("a"));
    rig.manager.cancel({ jobId: "a" });
    assert.equal(rig.manager.status({ jobId: "a" }).jobs[0]?.state, "cancelling");
    const after = rig.restart();
    after.manager.recover();
    assert.equal(after.manager.status({ jobId: "a" }).jobs[0]?.state, "cancelled");
    assert.equal(after.dones[0]?.state, "cancelled");
  } finally {
    env.cleanup();
  }
});

test("a template that disappears or a cwd that is no longer allowed fails a queued job instead of running it", async () => {
  const env = makeEnv();
  const rig = makeRig({ env });
  try {
    await rig.manager.submit(submitBody("a"));
    await rig.manager.submit(submitBody("b"));
    // the restarted runner has no templates at all
    const gone = makeRig({ env, templates: [], registry: new TemplateRegistry([]) });
    gone.manager.recover();
    await gone.manager.idle();
    assert.equal(gone.manager.status({ jobId: "a" }).jobs[0]?.state, "interrupted");
    assert.equal(gone.manager.status({ jobId: "b" }).jobs[0]?.state, "failed");
    assert.match(gone.dones.find((d) => d.jobId === "b")?.error ?? "", /no longer exists/);
  } finally {
    env.cleanup();
  }
});

test("shutdown stops running jobs as interrupted (resumable) and leaves the queue in the journal", async () => {
  const env = makeEnv();
  const rig = makeRig({ env });
  try {
    rig.drivers.claude.onStart = (job) => job.emit({ kind: "init", engineSessionId: "s" });
    await rig.manager.submit(submitBody("a"));
    await rig.manager.submit(submitBody("b"));
    await rig.manager.shutdown();
    assert.equal(rig.manager.status({ jobId: "a" }).jobs[0]?.state, "interrupted");
    assert.equal(rig.manager.status({ jobId: "b" }).jobs[0]?.state, "queued");
    assert.equal(rig.dones.length, 0);
    assert.equal(rig.drivers.claude.starts.length, 1, "the queued job was not started during shutdown");
    assert.equal(rig.jobKeys.size, 0);
  } finally {
    env.cleanup();
  }
});

// ---- hub -------------------------------------------------------------------------------------------

test("hub_start: refused for an unknown service and for scriptorium without the flag (audited); an approved start runs the fixed argv", async () => {
  const rig = makeRig();
  try {
    const approval = { userId: 42, at: 1 };
    await rejectsWith(rig.manager.hubStart({ service: "nope", approval }), "bad_request");
    await rejectsWith(rig.manager.hubStart({ service: "scriptorium", approval }), "forbidden");
    assert.equal(rig.hubCalls.length, 0, "nothing ran");
    const ok = await rig.manager.hubStart({ service: "vibetts", approval });
    assert.equal(ok.started, true);
    const start = rig.hubCalls.find((c) => c.args[3] === "start");
    assert.deepEqual(start?.args, ["-NoProfile", "-File", `${rig.env.hub}\\scripts\\hub.ps1`, "start", "vibetts"]);
    const sc = await rig.manager.hubStart({ service: "scriptorium", scriptoriumApproved: true, approval });
    assert.equal(sc.started, true);
    const outcomes = rig.audit.events.filter((e) => e.event === "hub_start").map((e) => (e.event === "hub_start" ? `${e.service}:${e.outcome}` : ""));
    assert.deepEqual(outcomes, ["nope:requested", "nope:refused", "scriptorium:requested", "scriptorium:refused", "vibetts:requested", "vibetts:started", "scriptorium:requested", "scriptorium:started"]);
    assert.deepEqual((await rig.manager.hubStatus()).services.map((s) => s.id), ["vibetts", "comfy", "scriptorium"]);
  } finally {
    rig.env.cleanup();
  }
});

test("an engine hub template runs as a job through the built-in hub driver", async () => {
  const env = makeEnv();
  const hubTpl = { id: "hub-vibetts", title: "VibeTTS", description: "Start VibeTTS", engine: "hub", cwd: env.hub, prompt: "", permissionMode: "default", allowedTools: [], disallowedTools: [], mcpServers: [], flow: { enabled: false }, paidModels: false, autostart: [], timeoutMin: 5, hubService: "vibetts" };
  const rig = makeRig({ env, templates: [hubTpl] });
  try {
    await rig.manager.submit(submitBody("h1", { templateId: "hub-vibetts", params: {}, brief: "" }));
    await rig.manager.idle();
    assert.equal(rig.dones[0]?.state, "succeeded");
    assert.ok(rig.hubCalls.some((c) => c.args[3] === "start" && c.args[4] === "vibetts"));
    assert.equal(rig.drivers.claude.starts.length, 0);
    assert.equal(rig.jobKeys.size, 0);
  } finally {
    env.cleanup();
  }
});

test("list_templates: summaries with the cloud list and an enabled flag that follows the engine switches", async () => {
  const env = makeEnv();
  const rig = makeRig({ env, templates: [claudeTemplate(env), flowTemplate(env), claudeTemplate(env, { id: "dsh-off", engine: "dsh" })] });
  try {
    const t = rig.manager.listTemplates().templates;
    assert.deepEqual(t.map((x) => [x.id, x.enabled]), [["dsh-off", false], ["list-runs", true], ["video-clip", true]]);
    assert.deepEqual(t.find((x) => x.id === "video-clip")?.cloud, ["claude-subscription", "google-flow"]);
    assert.equal(t.find((x) => x.id === "list-runs")?.cwd, env.hub);
  } finally {
    env.cleanup();
  }
});

// keep the type import used even if a test above is skipped
export type { Rig };
