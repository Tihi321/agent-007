/** S11.4 done-check: journal replay after a simulated crash, audit line shapes and redaction. */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createJobAuditLog, jobAuditFileName, missingJobAuditFields, sha256Hex } from "../../../src/jobrunner/audit.js";
import { JOB_ID_PATTERN, Journal } from "../../../src/jobrunner/journal.js";
import type { JournalEntry } from "../../../src/jobrunner/journal.js";
import type { JobDone, JobState } from "../../../src/jobs/contracts.js";
import { createRedactor } from "../../../src/logging/redact.js";
import { makeEnv } from "./helpers.js";

function jobEntry(jobId: string, at = 1000): JournalEntry {
  return { t: "job", at, jobId, templateId: "list-runs", engine: "claude", request: { templateId: "list-runs", params: { topic: "cats" }, brief: "hi" }, approval: { userId: 42, at: 1 }, cwd: "C:\\hub", flowBudgetCredits: 50 };
}
function stateEv(jobId: string, seq: number, state: JobState, ts = 2000): JournalEntry {
  return { t: "event", at: ts, jobId, event: { jobId, seq, ts, kind: "state", state } };
}

test("replay rebuilds a job: states, pid, session id, version, flow charged, events and the final JobDone", () => {
  const env = makeEnv();
  try {
    const j = new Journal({ dir: join(env.dataDir, "journal") });
    j.append(jobEntry("job-1"));
    j.append(stateEv("job-1", 1, "queued", 1001));
    j.append(stateEv("job-1", 2, "running", 1002));
    j.append({ t: "version", at: 1003, jobId: "job-1", engineVersion: "claude 2.1.0" });
    j.append({ t: "pid", at: 1004, jobId: "job-1", pid: 4321 });
    j.append({ t: "event", at: 1005, jobId: "job-1", event: { jobId: "job-1", seq: 3, ts: 1005, kind: "init", engineSessionId: "sess-9", engineVersion: "2.1.0" } });
    j.append({ t: "flow", at: 1006, jobId: "job-1", charged: 30 });
    j.append({ t: "resume", at: 1007, jobId: "job-1", count: 1 });
    const done: JobDone = { jobId: "job-1", state: "succeeded", summary: "ok", artifacts: [], durationMs: 9 };
    j.append(stateEv("job-1", 4, "succeeded", 1008));
    j.append({ t: "done", at: 1009, jobId: "job-1", done });

    // a "crash": a brand-new Journal over the same folder
    const { records, corruptLines } = new Journal({ dir: join(env.dataDir, "journal") }).replay();
    assert.equal(corruptLines, 0);
    const r = records.get("job-1");
    assert.ok(r);
    assert.equal(r.state, "succeeded");
    assert.equal(r.createdAt, 1000);
    assert.equal(r.startedAt, 1002);
    assert.equal(r.finishedAt, 1008);
    assert.equal(r.pid, 4321);
    assert.equal(r.engineSessionId, "sess-9");
    assert.equal(r.engineVersion, "2.1.0", "the last version seen wins");
    assert.equal(r.flowCharged, 30);
    assert.equal(r.resumeCount, 1);
    assert.equal(r.lastSeq, 4);
    assert.equal(r.events.length, 4);
    assert.deepEqual(r.done, done);
    assert.equal(r.request.brief, "hi");
    assert.equal(r.flowBudgetCredits, 50);
  } finally {
    env.cleanup();
  }
});

test("replay tolerates a torn last line and unreadable lines, and counts them", () => {
  const env = makeEnv();
  try {
    const dir = join(env.dataDir, "journal");
    const j = new Journal({ dir });
    j.append(jobEntry("job-2"));
    j.append(stateEv("job-2", 1, "running"));
    appendFileSync(join(dir, "job-2.jsonl"), 'not json at all\n{"t":"event","at":3,"jobId":"job-2","ev'); // torn write
    const { records, corruptLines } = new Journal({ dir }).replay();
    assert.equal(corruptLines, 2);
    assert.equal(records.get("job-2")?.state, "running");
    // files with unsafe names and files with no `job` line are ignored
    writeFileSync(join(dir, "..evil.jsonl"), "x");
    writeFileSync(join(dir, "orphan.jsonl"), JSON.stringify(stateEv("orphan", 1, "running")) + "\n");
    assert.equal(new Journal({ dir }).replay().records.has("orphan"), false);
  } finally {
    env.cleanup();
  }
});

test("a job id must be safe for a file name", () => {
  const env = makeEnv();
  try {
    const j = new Journal({ dir: join(env.dataDir, "journal") });
    for (const bad of ["../x", "a/b", "a\\b", "", "x".repeat(65), ".hidden", "a b"]) {
      assert.equal(JOB_ID_PATTERN.test(bad), false);
      assert.throws(() => j.append(jobEntry(bad)));
    }
  } finally {
    env.cleanup();
  }
});

test("the journal redacts secrets in events but stores the request as sent", () => {
  const env = makeEnv();
  try {
    const dir = join(env.dataDir, "journal");
    const j = new Journal({ dir, redact: createRedactor(["SUPER-SECRET-KEY"]) });
    j.append(jobEntry("job-3"));
    j.append({ t: "event", at: 5, jobId: "job-3", event: { jobId: "job-3", seq: 1, ts: 5, kind: "text", text: "the key is SUPER-SECRET-KEY ok" } });
    const raw = readFileSync(join(dir, "job-3.jsonl"), "utf8");
    assert.ok(!raw.includes("SUPER-SECRET-KEY"));
    assert.ok(raw.includes("[REDACTED]"));
  } finally {
    env.cleanup();
  }
});

test("prune removes only old terminal jobs", () => {
  const env = makeEnv();
  try {
    const j = new Journal({ dir: join(env.dataDir, "journal") });
    const day = 86_400_000;
    j.append(jobEntry("old", 0));
    j.append(stateEv("old", 1, "succeeded", 1000));
    j.append(jobEntry("fresh", 0));
    j.append(stateEv("fresh", 1, "succeeded", 40 * day));
    j.append(jobEntry("live", 0));
    j.append(stateEv("live", 1, "running", 1000));
    const { records } = j.replay();
    assert.deepEqual(j.prune(records.values(), 41 * day, 30), ["old"]);
    assert.deepEqual([...j.replay().records.keys()].sort(), ["fresh", "live"]);
  } finally {
    env.cleanup();
  }
});

test("audit: every event has its required fields, lines are monthly JSONL, redacted, and the brief is never stored", () => {
  const env = makeEnv();
  try {
    const dir = join(env.dataDir, "audit");
    const when = new Date(Date.UTC(2026, 9, 29, 12));
    const log = createJobAuditLog({ dir, redact: createRedactor(["SUPER-SECRET-KEY"]), now: () => when });
    const ts = when.toISOString();
    log.write({ event: "submitted", ts, jobId: "j", templateId: "t", engine: "claude", cwd: "C:\\hub", params: { a: "SUPER-SECRET-KEY" }, briefChars: 5, briefSha256: sha256Hex("hello"), approvalUserId: 42, approvedAt: 1, flowBudgetCredits: 10 });
    log.write({ event: "started", ts, jobId: "j", engine: "claude", engineVersion: "2.1", resumed: false });
    log.write({ event: "permission_asked", ts, jobId: "j", requestId: "r1", tool: "Read", kind: "read", inputSha256: sha256Hex("{}") });
    log.write({ event: "permission_decided", ts, jobId: "j", requestId: "r1", answer: "allow_once", by: "user", userId: 42 });
    log.write({ event: "flow_call", ts, jobId: "j", tool: "mcp__flow-music-mcp__gen", maxCredits: 10, allowed: true, chargedTotal: 10, remaining: 0 });
    log.write({ event: "cancelled", ts, jobId: "j", reason: "x", by: "agent" });
    log.write({ event: "finished", ts, jobId: "j", state: "cancelled", durationMs: 5, exitCode: 1 });
    const file = join(dir, "jobs-202610.jsonl");
    assert.equal(jobAuditFileName(when), "jobs-202610.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(lines.map((l) => l["event"]), ["submitted", "started", "permission_asked", "permission_decided", "flow_call", "cancelled", "finished"]);
    assert.equal(lines[0]?.["briefSha256"], sha256Hex("hello"));
    assert.equal("brief" in (lines[0] ?? {}), false);
    assert.ok(!readFileSync(file, "utf8").includes("SUPER-SECRET-KEY"));
    assert.deepEqual(lines[6], { event: "finished", ts, jobId: "j", state: "cancelled", durationMs: 5, exitCode: 1 });
    // a missing required field throws and writes nothing
    assert.throws(() => log.write({ event: "finished", ts, jobId: "j", state: "failed" } as never), /missing: durationMs/);
    assert.deepEqual(missingJobAuditFields({ event: "cancelled", ts, jobId: "j" } as never), ["reason", "by"]);
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 7);
    mkdirSync(dir, { recursive: true });
  } finally {
    env.cleanup();
  }
});
