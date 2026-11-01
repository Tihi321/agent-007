/**
 * U45: HARD crash-resume of a task phase. A child process runs the real Harness on SQLite and kills itself with
 * `process.exit(9)` at a chosen point (no close, no cleanup). The parent opens the same SQLite file, resumes, and checks that
 * the job is attached to, not submitted twice, and the approval is not asked again. The fake runner's journal is replayed
 * from what the child wrote, as a real job runner keeps its journal on disk.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SubmitBody } from "../../src/jobs/contracts.js";
import { FakeJobApprovalTransport } from "../helpers/fakeJobRunner.js";
import { FakeRunner } from "./helpers/fakeRunner.js";
import { openJobsRig, tempDir, until } from "./helpers/rig.js";

const CHILD = resolve(fileURLToPath(import.meta.url), "..", "helpers", "crashChild.js");
const JOB = "job-aaaaaaaaaaaa";

async function crashAt(mode: "submit" | "run", dir: string, stateFile: string): Promise<void> {
  const child = spawn(process.execPath, [CHILD, dir, stateFile, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
  const code = await new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
  assert.equal(code, 9, `the child crashed on purpose (exit 9), stderr: ${err.slice(0, 300)}`);
}

for (const mode of ["submit", "run"] as const) {
  test(`hard crash in the ${mode} phase: after the restart the job is attached to, never submitted again`, async () => {
    const dir = tempDir();
    const stateFile = join(dir, "runner-journal.jsonl");
    try {
      await crashAt(mode, dir, stateFile);
      const bodies = readFileSync(stateFile, "utf8").trim().split("\n").flatMap((l) => JSON.parse(l) as SubmitBody[]);
      assert.equal(bodies.length, 1, "the runner had accepted exactly one submit before the crash");

      const runner = new FakeRunner();
      runner.restoreSubmits(bodies);
      assert.equal(runner.submitCount(JOB), 1);
      const transport = new FakeJobApprovalTransport();
      const rig = await openJobsRig({ dir, client: runner.makeClient(), transport });
      try {
        // The task resumes by itself (harness.resume() in the rig): find it through the tracker, not by creating it again.
        await until(() => rig.jobs.tracker.get(JOB)?.phase === "run", 10_000, "the run phase after the hard crash");
        runner.emit(JOB, { kind: "progress", message: "after the crash" });
        runner.finish(JOB, { summary: "survived a hard crash" });
        await until(() => rig.jobs.tracker.get(JOB)?.phase === "done", 10_000, "the job to finish");
        assert.equal(runner.submitCount(JOB), 1, "no duplicate submit");
        assert.equal(runner.submits.length, 1, "no resume either");
        assert.equal(transport.jobCards.length, 0, "the decision was durable: the user is not asked again");
        assert.equal(transport.finals.length, 1);
        assert.ok(transport.finals[0]!.done.summary.includes("survived a hard crash"));
      } finally {
        await rig.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

