/**
 * S14.1: the durable Job task on the REAL Pi Harness over SQLite, with a fake job runner and a fake transport.
 * "Crash" = the Harness is closed while a phase is running (its abort signal fires and the phase stops without committing),
 * then a new Harness opens the same SQLite file and `resume()` reruns that phase. The runner keeps its own state, as the real
 * one keeps its journal. U45 (crash-resume of a task phase) is settled by these tests.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { JobApprovalCard, JobApprovalDecision } from "../../src/jobs/contracts.js";
import { FakeJobApprovalTransport } from "../helpers/fakeJobRunner.js";
import { jobControlDoc } from "../../src/jobs/task.js";
import type { JobTaskResult } from "../../src/jobs/task.js";
import { TPL_BOOK, TPL_FLOW, TPL_PLAIN, TPL_VN, jobInput } from "./helpers/fixtures.js";
import { FakeRunner } from "./helpers/fakeRunner.js";
import { ctx, openJobsRig, sleep, tempDir, until } from "./helpers/rig.js";

const JOB = "job-aaaaaaaaaaaa";

/** A transport whose approval card waits for `release()` (or for its abort signal, like a restart). */
class HoldTransport extends FakeJobApprovalTransport {
  hold = true;
  cardSignals: AbortSignal[] = [];
  private release: ((d: JobApprovalDecision) => void) | undefined;
  override async requestJobApproval(card: JobApprovalCard, signal: AbortSignal = new AbortController().signal): Promise<JobApprovalDecision> {
    if (!this.hold) return super.requestJobApproval(card);
    this.jobCards.push(card);
    this.cardSignals.push(signal);
    return new Promise<JobApprovalDecision>((resolve) => {
      this.release = resolve;
      signal.addEventListener("abort", () => resolve({ approved: false, by: "stop", at: Date.now() }), { once: true });
    });
  }
  answer(d: Partial<JobApprovalDecision> = {}): void {
    this.release?.({ approved: true, by: "user", userId: 4242, at: Date.now(), ...d });
  }
}

function resultOf(settled: unknown): JobTaskResult {
  const outcome = (settled as { state: { outcome: { status: string; result?: JobTaskResult } } }).state.outcome;
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  return outcome.result as JobTaskResult;
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = tempDir();
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("happy path: approve, submit, run (progress, a permission prompt), collect, done", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const client = runner.makeClient();
    const transport = new FakeJobApprovalTransport();
    transport.permissionAnswers = [{ answer: "allow_once" }];
    const rig = await openJobsRig({ dir, client, transport });
    try {
      const id = await rig.createJob(jobInput(TPL_PLAIN));
      await until(() => runner.jobs.has(JOB), 8000, "the runner to get the job");
      assert.equal(transport.jobCards.length, 1);
      const card = transport.jobCards[0]!;
      assert.equal(card.brief, "Make it about a lighthouse keeper who talks to gulls.");
      assert.equal(card.cwd, TPL_PLAIN.cwd);
      assert.equal(card.engine, "claude");
      assert.deepEqual(card.cloud, ["claude-subscription"]);
      const body = runner.submits[0]!;
      assert.equal(body.jobId, JOB);
      assert.equal(body.approval.userId, 1);
      assert.equal(body.flowBudgetCredits, undefined, "no Flow number for a plain job");

      runner.emit(JOB, { kind: "progress", message: "Composing the melody", fraction: 0.3 });
      runner.emit(JOB, { kind: "text", text: "Working on it" });
      runner.permission(JOB);
      await until(() => client.decisions.length === 1, 8000, "the permission answer");
      assert.equal(client.decisions[0]!.answer, "allow_once");
      assert.equal(transport.permissionRequests[0]!.tool, "Write");
      await until(() => transport.progress.some((p) => /Composing the melody/.test(p.text)), 8000, "a progress post");

      runner.finish(JOB, { summary: "Made loop.wav", artifacts: ["runs/loop.wav"], costUsd: 0.12 });
      const result = resultOf(await rig.wait(id));
      assert.equal(result.state, "succeeded");
      assert.match(result.modelText, /^<untrusted_content source="job:job-aaaaaaaaaaaa\/claude">/);
      assert.ok(result.modelText.includes("Made loop.wav") && result.modelText.includes("runs/loop.wav"));
      assert.equal(transport.finals.length, 1);
      assert.equal(transport.finals[0]!.done.summary, "Made loop.wav");
      assert.equal(runner.submitCount(JOB), 1);
      assert.equal(rig.jobs.tracker.get(JOB)?.phase, "done");
    } finally {
      await rig.close();
    }
  });
});

test("a rejected job is never submitted; a timeout is a rejection too", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const transport = new FakeJobApprovalTransport();
    transport.approvals = [{ approved: false, by: "user" }];
    const rig = await openJobsRig({ dir, client: runner.makeClient(), transport });
    try {
      const id = await rig.createJob(jobInput(TPL_PLAIN));
      const result = resultOf(await rig.wait(id));
      assert.equal(result.state, "rejected");
      assert.equal(result.by, "user");
      assert.equal(runner.submits.length, 0);
      assert.equal(transport.finals.length, 0, "no job ran, so no final message");
    } finally {
      await rig.close();
    }
  });
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const transport = new HoldTransport();
    const rig = await openJobsRig({ dir, client: runner.makeClient(), transport, overrides: { approvalTimeoutSec: 0.15 } });
    try {
      const id = await rig.createJob(jobInput(TPL_PLAIN));
      const result = resultOf(await rig.wait(id));
      assert.equal(result.state, "rejected");
      assert.equal(result.by, "timeout");
      assert.equal(runner.submits.length, 0);
    } finally {
      await rig.close();
    }
  });
});

test("a transport answer that is not an explicit user approval is a rejection", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const transport = new FakeJobApprovalTransport();
    transport.approvals = [{ approved: true, by: "timeout" }];
    const rig = await openJobsRig({ dir, client: runner.makeClient(), transport });
    try {
      const result = resultOf(await rig.wait(await rig.createJob(jobInput(TPL_PLAIN))));
      assert.equal(result.state, "rejected");
      assert.equal(runner.submits.length, 0);
    } finally {
      await rig.close();
    }
  });
});

test("crash in the approve phase: the deadline is kept, the old card is gone, a new card is asked, and the job is submitted once", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const t1 = new HoldTransport();
    const rig1 = await openJobsRig({ dir, client: runner.makeClient(), transport: t1 });
    const id = await rig1.createJob(jobInput(TPL_PLAIN));
    await until(() => t1.jobCards.length === 1, 8000, "the first card");
    const firstDeadline = t1.jobCards[0]!.deadline;
    await rig1.close(); // the "crash": the card's signal aborts, the phase stops without a decision
    assert.ok(t1.cardSignals[0]!.aborted, "the old card was cancelled");
    assert.equal(runner.submits.length, 0);

    const t2 = new HoldTransport();
    t2.hold = false;
    const rig2 = await openJobsRig({ dir, client: runner.makeClient(), transport: t2 });
    try {
      await until(() => runner.jobs.has(JOB), 8000, "the job after the restart");
      assert.equal(t2.jobCards.length, 1, "a new card was asked after the restart");
      assert.equal(t2.jobCards[0]!.deadline, firstDeadline, "the deadline did not move");
      runner.finish(JOB, { summary: "ok" });
      assert.equal(resultOf(await rig2.wait(id)).state, "succeeded");
      assert.equal(runner.submitCount(JOB), 1);
    } finally {
      await rig2.close();
    }
  });
});

test("an approval that expired while the agent was down is rejected as restart-expired, not asked again", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const t1 = new HoldTransport();
    const rig1 = await openJobsRig({ dir, client: runner.makeClient(), transport: t1, overrides: { approvalTimeoutSec: 0.4 } });
    const id = await rig1.createJob(jobInput(TPL_PLAIN));
    await until(() => t1.jobCards.length === 1, 8000, "the card");
    await rig1.close();
    await sleep(600);
    const t2 = new FakeJobApprovalTransport();
    const rig2 = await openJobsRig({ dir, client: runner.makeClient(), transport: t2, overrides: { approvalTimeoutSec: 0.4 } });
    try {
      const result = resultOf(await rig2.wait(id));
      assert.equal(result.state, "rejected");
      assert.equal(result.by, "restart-expired");
      assert.equal(t2.jobCards.length, 0, "no new card for an expired approval");
      assert.equal(runner.submits.length, 0);
    } finally {
      await rig2.close();
    }
  });
});

test("crash in the submit phase after the runner accepted the job: the rerun attaches and does not submit again", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const transport = new FakeJobApprovalTransport();
    const c1 = runner.makeClient();
    let rig1!: Awaited<ReturnType<typeof openJobsRig>>;
    c1.afterSubmit = () => void rig1.close();
    rig1 = await openJobsRig({ dir, client: c1, transport });
    const id = await rig1.createJob(jobInput(TPL_PLAIN));
    await until(() => runner.submits.length === 1, 8000, "the first submit");
    await sleep(100);
    assert.equal(runner.submitCount(JOB), 1);

    const rig2 = await openJobsRig({ dir, client: runner.makeClient(), transport });
    try {
      await until(() => rig2.jobs.tracker.get(JOB)?.phase === "run", 8000, "the run phase after the restart");
      runner.finish(JOB, { summary: "finished after the crash" });
      const result = resultOf(await rig2.wait(id));
      assert.equal(result.state, "succeeded");
      assert.equal(runner.submitCount(JOB), 1, "no duplicate submit");
      assert.equal(transport.jobCards.length, 1, "no second approval card either: the decision was durable");
    } finally {
      await rig2.close();
    }
  });
});

test("crash in the run phase: the rerun replays the missed events, asks the pending permission again, and finishes", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const transport = new FakeJobApprovalTransport();
    const c1 = runner.makeClient();
    const rig1 = await openJobsRig({ dir, client: c1, transport });
    const id = await rig1.createJob(jobInput(TPL_PLAIN));
    await until(() => runner.jobs.has(JOB), 8000, "the job");
    await until(() => rig1.jobs.tracker.get(JOB)?.phase === "run", 8000, "the run phase");
    runner.emit(JOB, { kind: "progress", message: "step one" });
    await until(() => (rig1.jobs.tracker.get(JOB)?.eventCount ?? 0) >= 3, 8000, "events seen");
    await rig1.close(); // crash while the job runs
    // while the agent is down the job goes on, asks for a permission and writes more events
    runner.emit(JOB, { kind: "progress", message: "step two (while the agent was down)" });
    runner.permission(JOB, { requestId: "perm-down" });
    runner.emit(JOB, { kind: "text", text: "more text" });

    transport.permissionAnswers = [{ answer: "allow_once" }];
    const c2 = runner.makeClient();
    const rig2 = await openJobsRig({ dir, client: c2, transport });
    try {
      await until(() => c2.decisions.length === 1, 8000, "the pending permission to be asked again");
      assert.equal(c2.decisions[0]!.requestId, "perm-down");
      await until(() => transport.progress.some((p) => /step two/.test(p.text)), 8000, "the missed event to show in progress");
      runner.finish(JOB, { summary: "done after the crash" });
      const result = resultOf(await rig2.wait(id));
      assert.equal(result.state, "succeeded");
      assert.equal(runner.submitCount(JOB), 1, "attached, not submitted again");
      assert.equal(transport.finals.length, 1);
    } finally {
      await rig2.close();
    }
  });
});

test("crash in the done phase: the result is settled again (at least once) but the final message is posted once", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const transport = new FakeJobApprovalTransport();
    let settled = 0;
    let rig1!: Awaited<ReturnType<typeof openJobsRig>>;
    rig1 = await openJobsRig({
      dir,
      client: runner.makeClient(),
      transport,
      overrides: {
        onSettled: async () => {
          settled++;
          if (settled === 1) {
            void rig1.close(); // the crash: the terminal commit that follows is refused
            await sleep(80);
          }
        },
      },
    });
    const id = await rig1.createJob(jobInput(TPL_PLAIN));
    await until(() => runner.jobs.has(JOB), 8000, "the job");
    runner.finish(JOB, { summary: "x" });
    await until(() => settled === 1, 8000, "the first onSettled");
    await sleep(200);
    assert.equal(transport.finals.length, 1);

    const rig2 = await openJobsRig({ dir, client: runner.makeClient(), transport, overrides: { onSettled: async () => void settled++ } });
    try {
      const result = resultOf(await rig2.wait(id));
      assert.equal(result.state, "succeeded");
      assert.equal(settled, 2, "settled again after the restart: at least once, never lost");
      assert.equal(transport.finals.length, 1, "the final message was not posted twice");
      assert.equal(runner.submitCount(JOB), 1);
    } finally {
      await rig2.close();
    }
  });
});

test("crash at the start of the collect phase: the job still completes after the restart (the final message is at least once, at most twice)", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const transport = new FakeJobApprovalTransport();
    const rig1 = await openJobsRig({ dir, client: runner.makeClient(), transport });
    let crashed = false;
    rig1.jobs.tracker.onChange(() => {
      if (!crashed && rig1.jobs.tracker.get(JOB)?.phase === "collect") {
        crashed = true;
        void rig1.close();
      }
    });
    const id = await rig1.createJob(jobInput(TPL_FLOW, { flowEstimateCredits: 40 }));
    await until(() => runner.jobs.has(JOB), 8000, "the job");
    runner.finish(JOB, { summary: "collect me", flow: { approved: 40, charged: 12, reported: 9 } });
    await until(() => crashed, 8000, "the crash at collect");
    await sleep(150);

    const rig2 = await openJobsRig({ dir, client: runner.makeClient(), transport });
    try {
      const result = resultOf(await rig2.wait(id));
      assert.equal(result.state, "succeeded");
      assert.ok(transport.finals.length >= 1 && transport.finals.length <= 2, `final posts: ${transport.finals.length}`);
      assert.equal(runner.submitCount(JOB), 1);
      const ledger = await rig2.ledger();
      assert.equal(ledger.entries[JOB]?.open, false, "the ledger entry was closed after the restart");
      assert.equal(ledger.entries[JOB]?.reported, 9);
    } finally {
      await rig2.close();
    }
  });
});

test("the runner being offline: the job waits in submit, /status says so, and it goes on when the runner is back", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const client = runner.makeClient("offline");
    const transport = new FakeJobApprovalTransport();
    const rig = await openJobsRig({ dir, client, transport });
    try {
      const id = await rig.createJob(jobInput(TPL_PLAIN));
      await until(() => rig.jobs.tracker.get(JOB)?.state === "waiting_for_runner", 8000, "the wait state");
      assert.equal(runner.submits.length, 0);
      const lines = rig.jobs.statusLines();
      assert.ok(lines.some((l) => /job runner offline/.test(l)), lines.join(" | "));
      client.setState("online");
      await until(() => runner.jobs.has(JOB), 8000, "the submit after the reconnect");
      assert.ok(rig.jobs.statusLines().some((l) => /Job runner: online/.test(l)));
      runner.finish(JOB, { summary: "ok" });
      assert.equal(resultOf(await rig.wait(id)).state, "succeeded");
      assert.equal(runner.submitCount(JOB), 1);
    } finally {
      await rig.close();
    }
  });
});

test("the runner going offline while the job runs: the job waits, then replays what it missed", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const client = runner.makeClient();
    const transport = new FakeJobApprovalTransport();
    const rig = await openJobsRig({ dir, client, transport });
    try {
      const id = await rig.createJob(jobInput(TPL_PLAIN));
      await until(() => rig.jobs.tracker.get(JOB)?.phase === "run", 8000, "run phase");
      client.setState("offline");
      await until(() => rig.jobs.tracker.get(JOB)?.state === "waiting_for_runner", 8000, "the wait");
      runner.emit(JOB, { kind: "progress", message: "made while offline" });
      runner.finish(JOB, { summary: "finished while offline" });
      client.setState("online");
      const result = resultOf(await rig.wait(id));
      assert.equal(result.state, "succeeded");
      assert.ok(result.modelText.includes("finished while offline"));
      assert.equal(runner.submitCount(JOB), 1);
    } finally {
      await rig.close();
    }
  });
});

test("an interrupted job (the runner restarted) is resumed, up to maxResumes, then failed", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const transport = new FakeJobApprovalTransport();
    const rig = await openJobsRig({ dir, client: runner.makeClient(), transport, overrides: { maxResumes: 1 } });
    try {
      const id = await rig.createJob(jobInput(TPL_PLAIN));
      await until(() => rig.jobs.tracker.get(JOB)?.phase === "run", 8000, "run phase");
      runner.interrupt(JOB);
      await until(() => runner.submits.some((s) => s.resume === true), 8000, "the resume");
      assert.equal(runner.submits.filter((s) => s.resume === true).length, 1);
      assert.equal(runner.submitCount(JOB), 1, "the job itself was submitted once");
      runner.interrupt(JOB); // a second restart: over the limit
      const result = resultOf(await rig.wait(id));
      assert.equal(result.state, "failed");
      assert.match(result.modelText, /interrupted/);
      assert.equal(runner.submits.filter((s) => s.resume === true).length, 1, "not resumed a second time");
    } finally {
      await rig.close();
    }
  });
});

test("cancel while waiting for approval: the card is cancelled and the runner is never contacted", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const transport = new HoldTransport();
    const rig = await openJobsRig({ dir, client: runner.makeClient(), transport });
    try {
      const id = await rig.createJob(jobInput(TPL_PLAIN));
      await until(() => transport.jobCards.length === 1, 8000, "the card");
      await rig.root.commit(async (tx) => {
        (await tx.doc(jobControlDoc)).cancel[JOB] = Date.now();
      }, ctx);
      rig.jobs.tracker.requestCancel(JOB);
      const result = resultOf(await rig.wait(id));
      assert.equal(result.state, "cancelled");
      assert.ok(transport.cardSignals[0]!.aborted);
      assert.equal(runner.submits.length, 0);
      assert.equal(runner.cancels.length, 0);
      assert.equal(transport.finals.length, 1);
    } finally {
      await rig.close();
    }
  });
});

test("cancel while running: the runner is told to cancel and the job ends cancelled", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const transport = new FakeJobApprovalTransport();
    const rig = await openJobsRig({ dir, client: runner.makeClient(), transport });
    try {
      const id = await rig.createJob(jobInput(TPL_PLAIN));
      await until(() => rig.jobs.tracker.get(JOB)?.phase === "run", 8000, "run phase");
      await rig.root.commit(async (tx) => {
        (await tx.doc(jobControlDoc)).cancel[JOB] = Date.now();
      }, ctx);
      rig.jobs.tracker.requestCancel(JOB);
      const result = resultOf(await rig.wait(id));
      assert.equal(result.state, "cancelled");
      assert.equal(runner.cancels.length >= 1, true);
      assert.equal(transport.finals[0]!.done.state, "cancelled");
    } finally {
      await rig.close();
    }
  });
});

test("the runner refusing the job fails it with the reason (no retry loop)", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const client = runner.makeClient();
    client.handlers.submit = () => {
      const e = new Error("daily job cap reached");
      e.name = "IpcRemoteError";
      (e as { code?: string }).code = "limit_exceeded";
      throw e;
    };
    const transport = new FakeJobApprovalTransport();
    const rig = await openJobsRig({ dir, client, transport });
    try {
      const result = resultOf(await rig.wait(await rig.createJob(jobInput(TPL_PLAIN))));
      assert.equal(result.state, "failed");
      assert.match(result.modelText, /limit_exceeded/);
      assert.equal(transport.finals.length, 1);
      assert.equal(client.calls.filter((c) => c.method === "submit").length, 1);
    } finally {
      await rig.close();
    }
  });
});

test("a job the runner does not know in the run phase is failed, not resubmitted", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const transport = new FakeJobApprovalTransport();
    const rig = await openJobsRig({ dir, client: runner.makeClient(), transport });
    try {
      const id = await rig.createJob(jobInput(TPL_PLAIN));
      await until(() => rig.jobs.tracker.get(JOB)?.phase === "run", 8000, "run phase");
      runner.jobs.delete(JOB); // the runner lost its journal
      const result = resultOf(await rig.wait(id));
      assert.equal(result.state, "failed");
      assert.equal(runner.submitCount(JOB), 1);
    } finally {
      await rig.close();
    }
  });
});

test("Flow job: the approved number is kept in the ledger, passed to the runner and shown in the result", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const transport = new FakeJobApprovalTransport();
    const rig = await openJobsRig({ dir, client: runner.makeClient(), transport });
    try {
      const id = await rig.createJob(jobInput(TPL_FLOW, { flowEstimateCredits: 40 }));
      await until(() => runner.jobs.has(JOB), 8000, "the runner to get the job");
      assert.equal(transport.jobCards[0]!.flowEstimateCredits, 40);
      assert.deepEqual(transport.jobCards[0]!.cloud, ["claude-subscription", "google-flow"]);
      const body = runner.submits[0]!;
      assert.equal(body.flowBudgetCredits, 40);
      assert.match(body.request.brief, /The agreed Flow budget for this job is 40 credits/);
      assert.ok(body.request.brief.startsWith("Make it about a lighthouse keeper"));
      let ledger = await rig.ledger();
      assert.equal(ledger.entries[JOB]?.approved, 40);
      assert.equal(ledger.entries[JOB]?.open, true);

      runner.emit(JOB, { kind: "flow_call", tool: "mcp__flow-music-mcp__generate_clip", maxCredits: 10, allowed: true, chargedTotal: 10, remaining: 30 });
      runner.emit(JOB, { kind: "flow_call", tool: "mcp__flow-music-mcp__generate_clip", maxCredits: 25, allowed: true, chargedTotal: 35, remaining: 5 });
      runner.emit(JOB, { kind: "flow_call", tool: "mcp__flow-music-mcp__generate_clip", maxCredits: 20, allowed: false, chargedTotal: 35, remaining: 5 });
      await until(async () => (await rig.ledger()).entries[JOB]?.jobCharged === 35, 8000, "the ledger to follow the flow_call events");
      runner.finish(JOB, { summary: "video done", flow: { approved: 40, charged: 35, reported: 28 } });
      const result = resultOf(await rig.wait(id));
      assert.deepEqual(result.flow, { approved: 40, charged: 35, reported: 28 });
      ledger = await rig.ledger();
      assert.equal(ledger.entries[JOB]?.open, false, "the entry is closed when the job ends");
      assert.equal(ledger.entries[JOB]?.reported, 28);
      assert.deepEqual(transport.finals[0]!.done.flow, { approved: 40, charged: 35, reported: 28 });
    } finally {
      await rig.close();
    }
  });
});

test("Flow job with no approved number is never submitted", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const transport = new FakeJobApprovalTransport();
    const rig = await openJobsRig({ dir, client: runner.makeClient(), transport });
    try {
      // no estimate in the input: nothing the user could have approved
      const result = resultOf(await rig.wait(await rig.createJob(jobInput(TPL_FLOW))));
      assert.equal(result.state, "failed");
      assert.match(result.modelText, /approved number/);
      assert.equal(runner.submits.length, 0);
      assert.deepEqual((await rig.ledger()).entries, {});
    } finally {
      await rig.close();
    }
  });
});

test("Flow job: the user approving fewer credits than the estimate lowers the budget; never raises it", async () => {
  for (const [said, expected] of [[25, 25], [90, 40]] as const) {
    const dir = tempDir();
    const runner = new FakeRunner();
    const transport = new FakeJobApprovalTransport();
    transport.approvals = [{ approvedCredits: said }];
    const rig = await openJobsRig({ dir, client: runner.makeClient(), transport });
    try {
      const id = await rig.createJob(jobInput(TPL_FLOW, { flowEstimateCredits: 40 }));
      await until(() => runner.jobs.has(JOB), 8000, "submit");
      assert.equal(runner.submits[0]!.flowBudgetCredits, expected);
      assert.equal((await rig.ledger()).entries[JOB]?.approved, expected);
      runner.finish(JOB);
      await rig.wait(id);
    } finally {
      await rig.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("paid-model and autostart templates reach the card as flags", async () => {
  await withDir(async (dir) => {
    const runner = new FakeRunner();
    const transport = new FakeJobApprovalTransport();
    transport.approvals = [{ approved: false }, { approved: false }];
    const rig = await openJobsRig({ dir, client: runner.makeClient(), transport });
    try {
      await rig.wait(await rig.createJob(jobInput(TPL_BOOK, { jobId: "job-bbbbbbbbbbbb" })));
      await rig.wait(await rig.createJob(jobInput(TPL_VN, { jobId: "job-cccccccccccc" })));
      assert.equal(transport.jobCards[0]!.paidModels, true);
      assert.deepEqual(transport.jobCards[1]!.autostart, ["pixel-studio", "chiptune-studio", "comfyui"]);
    } finally {
      await rig.close();
    }
  });
});
