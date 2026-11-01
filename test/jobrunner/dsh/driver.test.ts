import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CONTINUE_PROMPT } from "../../../src/jobrunner/drivers/dsh/driver.js";
import { DshRefusedError, DshStartError, DshUnsupportedError } from "../../../src/jobrunner/drivers/dsh/types.js";
import type { JobEvent } from "../../../src/jobs/contracts.js";
import { FAKE_AGENT, FAKE_DSH_PATH, FAKE_VERSION, SECRET_KEY, collect, goodEvidence, kinds, pidAlive, readLog, rig, spec, waitFor } from "./helpers.js";
import { DshDriver } from "../../../src/jobrunner/drivers/dsh/driver.js";
import { MemoryEvidenceStore } from "../../../src/jobrunner/drivers/dsh/gate.js";

const T = { timeout: 30_000 };

function ev<K extends JobEvent["kind"]>(events: JobEvent[], kind: K): Array<Extract<JobEvent, { kind: K }>> {
  return events.filter((e): e is Extract<JobEvent, { kind: K }> => e.kind === kind);
}

test("lifecycle: initialize, session/new, prompt, updates mapped to JobEvents, stop reason, gapless seq", T, async () => {
  const r = rig({ scenario: "basic" });
  try {
    await r.driver.start(spec(r.host, r.dir.path));
    const events = await collect(r.driver, "job-1");
    assert.deepEqual(kinds(events), [
      "state:running",
      "init",
      "text", // "Hello " flushed before the tool call
      "tool_call",
      "tool_result",
      "progress", // plan
      "progress", // notice
      "text", // "world" flushed at the end
      "result",
      "state:succeeded",
    ]);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.ok(events.every((e) => e.jobId === "job-1" && e.ts > 0));

    const init = ev(events, "init")[0];
    assert.equal(init?.engineSessionId, "s-1");
    assert.equal(init?.engineVersion, FAKE_VERSION);
    assert.deepEqual(ev(events, "text").map((t) => t.text), ["Hello ", "world"]);
    const call = ev(events, "tool_call")[0];
    assert.deepEqual({ callId: call?.callId, tool: call?.tool, input: call?.input }, { callId: "t1", tool: "read_file", input: { path: "a.txt" } });
    const res = ev(events, "tool_result")[0];
    assert.deepEqual({ callId: res?.callId, tool: res?.tool, ok: res?.ok, text: res?.text }, { callId: "t1", tool: "read_file", ok: true, text: "file contents" });
    const progress = ev(events, "progress");
    assert.equal(progress[0]?.message, "plan 1/2: step two");
    assert.equal(progress[0]?.fraction, 0.5);
    assert.equal(progress[1]?.message, "warning: careful");
    const result = ev(events, "result")[0];
    assert.equal(result?.text, "Hello world");
    assert.equal(result?.costUsd, 0.02);
    assert.ok(!JSON.stringify(events).includes("thinking..."), "agent thoughts are not forwarded");

    const log = readLog(r.logFile);
    assert.deepEqual(log.map((l) => l["event"]).filter((x) => x !== "start"), ["initialize", "session_new", "prompt"]);
    assert.equal(log.find((l) => l["event"] === "session_new")?.["cwd"], r.dir.path);
    assert.equal(log.find((l) => l["event"] === "prompt")?.["text"], "do the thing: brief");
    assert.deepEqual(r.launches, [["--profile", "acp"]]);
    assert.ok(r.logger.entries.some((x) => x.event === "dsh.job.finished"));
  } finally {
    r.cleanup();
  }
});

test("events() of an unknown job ends at once", T, async () => {
  const r = rig();
  try {
    assert.deepEqual(await collect(r.driver, "nope"), []);
    await r.driver.cancel("nope");
  } finally {
    r.cleanup();
  }
});

test("the DeepSeek key is in the child's environment only: not argv, not events, not logs; other secrets are not inherited", T, async () => {
  const r = rig({ scenario: "echo_key" });
  try {
    await r.driver.start(spec(r.host, r.dir.path));
    const events = await collect(r.driver, "job-1");
    const start = readLog(r.logFile).find((l) => l["event"] === "start");
    assert.equal(start?.["hasKey"], true);
    assert.equal(start?.["key"], SECRET_KEY);
    assert.ok(!(start?.["argv"] as string[]).some((a) => a.includes(SECRET_KEY)));
    assert.ok(!(start?.["envNames"] as string[]).includes("SOME_OTHER_SECRET"), "the parent's other variables are not passed on");
    const text = ev(events, "text").map((t) => t.text).join("");
    assert.ok(text.includes("[REDACTED]") && !text.includes(SECRET_KEY));
    assert.ok(!JSON.stringify(events).includes(SECRET_KEY));
    assert.ok(!JSON.stringify(r.logger.entries).includes(SECRET_KEY));
    assert.ok(!r.launches.flat().some((a) => a.includes(SECRET_KEY)));
  } finally {
    r.cleanup();
  }
});

test("terminal/create is refused (the client implements no terminal methods) and the job carries on", T, async () => {
  const r = rig({ scenario: "terminal" });
  try {
    await r.driver.start(spec(r.host, r.dir.path));
    const events = await collect(r.driver, "job-1");
    assert.equal(events.at(-1)?.kind, "state");
    assert.equal((events.at(-1) as Extract<JobEvent, { kind: "state" }>).state, "succeeded");
    assert.equal(readLog(r.logFile).find((l) => l["event"] === "terminal_result")?.["message"], "-32601");
    assert.ok(r.logger.entries.some((x) => x.event === "dsh.request.refused" && x.fields["method"] === "terminal/create"));
  } finally {
    r.cleanup();
  }
});

test("ask-first mode: a configured mode is set after session/new; a mode dsh does not offer fails the job closed", T, async () => {
  const ok = rig({ driver: { askFirstModeId: "ask" } });
  try {
    await ok.driver.start(spec(ok.host, ok.dir.path));
    await collect(ok.driver, "job-1");
    assert.equal(readLog(ok.logFile).find((l) => l["event"] === "set_mode")?.["modeId"], "ask");
  } finally {
    ok.cleanup();
  }
  const bad = rig({ driver: { askFirstModeId: "nope" } });
  try {
    await assert.rejects(bad.driver.start(spec(bad.host, bad.dir.path)), (e: unknown) => e instanceof DshStartError && /nope/.test(e.message));
    assert.equal(readLog(bad.logFile).some((l) => l["event"] === "prompt"), false);
    // The process was killed: nothing is left running.
    const pid = readLog(bad.logFile).find((l) => l["event"] === "start")?.["pid"] as number;
    await waitFor(() => !pidAlive(pid), 10_000, "the fake agent to exit");
  } finally {
    bad.cleanup();
  }
});

test("only one DeepSeek job runs at a time", T, async () => {
  const r = rig({ scenario: "hang" });
  try {
    await r.driver.start(spec(r.host, r.dir.path));
    await assert.rejects(r.driver.start(spec(r.host, r.dir.path, { jobId: "job-2" })), (e: unknown) => e instanceof DshRefusedError && e.code === "dsh_busy");
    await r.driver.cancel("job-1");
  } finally {
    r.cleanup();
  }
});

test("protocol mismatch fails the start; a missing session/resume capability is reported", T, async () => {
  const v2 = rig({ scenarioOpts: { protocolVersion: 2 } });
  try {
    await assert.rejects(v2.driver.start(spec(v2.host, v2.dir.path)), (e: unknown) => e instanceof DshStartError && /v2/.test(e.message));
  } finally {
    v2.cleanup();
  }
  const noResume = rig({ scenarioOpts: { noResume: true } });
  try {
    await assert.rejects(
      noResume.driver.resume({ ...spec(noResume.host, noResume.dir.path), engineSessionId: "old" }),
      (e: unknown) => e instanceof DshUnsupportedError,
    );
  } finally {
    noResume.cleanup();
  }
});

test("stop reasons: refusal and max_tokens fail the job; the result event still comes before the terminal state", T, async () => {
  for (const stopReason of ["refusal", "max_tokens", "max_turn_requests"]) {
    const r = rig({ scenario: "stop_reason", scenarioOpts: { stopReason } });
    try {
      await r.driver.start(spec(r.host, r.dir.path));
      const events = await collect(r.driver, "job-1");
      assert.deepEqual(kinds(events).slice(-2), ["result", "state:failed"]);
      assert.equal((events.at(-1) as Extract<JobEvent, { kind: "state" }>).detail, `dsh stopped: ${stopReason}`);
    } finally {
      r.cleanup();
    }
  }
});

test("dsh dying in the middle of the prompt fails the job with a connection-lost detail", T, async () => {
  const r = rig({ scenario: "crash" });
  try {
    await r.driver.start(spec(r.host, r.dir.path));
    const events = await collect(r.driver, "job-1");
    assert.deepEqual(kinds(events).slice(-2), ["result", "state:failed"]);
    const last = events.at(-1) as Extract<JobEvent, { kind: "state" }>;
    assert.match(last.detail ?? "", /connection lost/);
    assert.match(last.detail ?? "", /code 3/);
  } finally {
    r.cleanup();
  }
});

test("MCP servers: resolved by id, sent to session/new; a non-loopback server or a missing resolver refuses the job", T, async () => {
  const r = rig({
    driver: {
      resolveMcpServers: (ids) =>
        ids.map((id) => ({ name: id, url: id === "evil" ? "http://example.com:9/mcp" : `http://127.0.0.1:8000/${id}`, headers: [{ name: "Authorization", value: "Bearer tok" }] })),
    },
  });
  try {
    const t = { ...spec(r.host, r.dir.path).template, mcpServers: ["flow-music-mcp"] };
    await r.driver.start(spec(r.host, r.dir.path, { template: t }));
    await collect(r.driver, "job-1");
    const servers = readLog(r.logFile).find((l) => l["event"] === "session_new")?.["mcpServers"] as Array<Record<string, unknown>>;
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.["name"], "flow-music-mcp");
    assert.equal(servers[0]?.["url"], "http://127.0.0.1:8000/flow-music-mcp");
    assert.equal(servers[0]?.["type"], "http");
    await assert.rejects(
      r.driver.start(spec(r.host, r.dir.path, { jobId: "job-2", template: { ...t, mcpServers: ["evil"] } })),
      (e: unknown) => e instanceof DshRefusedError && /loopback/.test(e.message),
    );
  } finally {
    r.cleanup();
  }
  const none = rig();
  try {
    const t = { ...spec(none.host, none.dir.path).template, mcpServers: ["x"] };
    await assert.rejects(none.driver.start(spec(none.host, none.dir.path, { template: t })), (e: unknown) => e instanceof DshRefusedError && e.code === "dsh_bad_spec");
  } finally {
    none.cleanup();
  }
});

// ---- cancel and resume (S13.4) ---------------------------------------------------------------------------

test("cancel: session/cancel is sent, the agent stops, the job ends cancelled and the process is gone", T, async () => {
  const r = rig({ scenario: "hang" });
  try {
    await r.driver.start(spec(r.host, r.dir.path));
    await waitFor(() => readLog(r.logFile).some((l) => l["event"] === "prompt"), 10_000, "the prompt");
    const done = collect(r.driver, "job-1");
    await r.driver.cancel("job-1");
    const events = await done;
    const k = kinds(events);
    assert.deepEqual(k.slice(-2), ["result", "state:cancelled"]);
    assert.ok(k.indexOf("state:cancelling") > k.indexOf("state:running") && k.indexOf("state:cancelling") < k.indexOf("result"));
    assert.ok(readLog(r.logFile).some((l) => l["event"] === "cancel" && l["sessionId"] === "s-1"));
    const pid = readLog(r.logFile).find((l) => l["event"] === "start")?.["pid"] as number;
    await waitFor(() => !pidAlive(pid), 10_000, "the fake agent to exit");
    await r.driver.cancel("job-1"); // a second cancel of a finished job is a no-op
  } finally {
    r.cleanup();
  }
});

test("cancel: an agent that ignores session/cancel is killed after the grace period", T, async () => {
  const r = rig({ scenario: "hang", scenarioOpts: { ignoreCancel: true }, driver: { cancelGraceMs: 300 } });
  try {
    await r.driver.start(spec(r.host, r.dir.path));
    await waitFor(() => readLog(r.logFile).some((l) => l["event"] === "prompt"), 10_000, "the prompt");
    const pid = readLog(r.logFile).find((l) => l["event"] === "start")?.["pid"] as number;
    const t0 = Date.now();
    await r.driver.cancel("job-1");
    const events = await collect(r.driver, "job-1");
    assert.equal((events.at(-1) as Extract<JobEvent, { kind: "state" }>).state, "cancelled");
    assert.ok(Date.now() - t0 >= 250, "the grace period was observed");
    assert.ok(r.logger.entries.some((x) => x.event === "dsh.job.cancel_kill"));
    await waitFor(() => !pidAlive(pid), 10_000, "the fake agent to be killed");
  } finally {
    r.cleanup();
  }
});

test("resume: session/resume with the stored session id and a continue prompt; seq continues; the same gate applies", T, async () => {
  const r = rig({ scenario: "basic" });
  try {
    await r.driver.resume({ ...spec(r.host, r.dir.path), engineSessionId: "s-old", lastSeq: 7 } as never);
    const events = await collect(r.driver, "job-1");
    assert.equal(events[0]?.seq, 8);
    assert.equal(ev(events, "init")[0]?.engineSessionId, "s-old");
    const log = readLog(r.logFile);
    assert.equal(log.find((l) => l["event"] === "session_resume")?.["sessionId"], "s-old");
    assert.equal(log.some((l) => l["event"] === "session_new"), false);
    assert.equal(log.find((l) => l["event"] === "prompt")?.["text"], CONTINUE_PROMPT);
    assert.equal((events.at(-1) as Extract<JobEvent, { kind: "state" }>).state, "succeeded");
  } finally {
    r.cleanup();
  }
  const closed = rig({ verified: false });
  try {
    await assert.rejects(closed.driver.resume({ ...spec(closed.host, closed.dir.path), engineSessionId: "s-old" }), (e: unknown) => e instanceof DshRefusedError);
    assert.equal(closed.launches.length, 0);
  } finally {
    closed.cleanup();
  }
});

// ---- Windows: the real launch path for a .cmd file, with a fake .cmd standing in for dsh.cmd -------------------

test("Windows: a .cmd in a folder with a space is launched through cmd.exe and cancel kills the whole tree", { timeout: 60_000, skip: process.platform !== "win32" }, async () => {
  const r = rig({ scenario: "hang", scenarioOpts: { ignoreCancel: true } });
  try {
    const dir = join(r.dir.path, "with space");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir);
    const cmdPath = join(dir, "fake-dsh.cmd");
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${FAKE_AGENT}" %*\r\n`);
    const evidence = new MemoryEvidenceStore(goodEvidence({ dshPath: cmdPath }));
    const driver = new DshDriver({
      dshPath: cmdPath,
      verified: true,
      evidence,
      logger: r.logger,
      readVersion: async () => FAKE_VERSION,
      baseEnv: { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "", ComSpec: process.env["ComSpec"] ?? "cmd.exe" },
      extraEnv: { FAKE_ACP_SCENARIO: "hang", FAKE_ACP_OPTS: JSON.stringify({ ignoreCancel: true }), FAKE_ACP_LOG: r.logFile },
      cancelGraceMs: 300,
    });
    await driver.start(spec(r.host, r.dir.path));
    await waitFor(() => readLog(r.logFile).some((l) => l["event"] === "prompt"), 15_000, "the prompt");
    const pid = readLog(r.logFile).find((l) => l["event"] === "start")?.["pid"] as number;
    assert.ok(pidAlive(pid));
    await driver.cancel("job-1");
    await waitFor(() => !pidAlive(pid), 15_000, "the node child behind cmd.exe to be killed");
    assert.equal(FAKE_DSH_PATH.length > 0, true);
  } finally {
    r.cleanup();
  }
});
