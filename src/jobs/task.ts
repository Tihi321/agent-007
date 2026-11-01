/**
 * The durable Job task (S14.1, U45). A Pi Durable task `a7.job` with the phases
 *
 *   approve -> submit -> run -> collect -> done
 *
 * Every phase commits through `runtime.commit`. After a crash or a restart `resume()` reruns the phase of the last
 * checkpoint, and each phase is written so a rerun is safe:
 *
 *   approve  the first-ask time and the decision are task memos (first writer wins), so the deadline survives a restart and
 *            an answered card is never asked again. A restart expires the old card; the phase sends a new one.
 *   submit   asks the job runner first (`status`): a job it already has is attached to (and resumed if `interrupted`), never
 *            submitted a second time. `submit` is also idempotent on `jobId` at the runner.
 *   run      re-attaches with `status {jobId, sinceSeq}` from the last committed event, replays the missed events, re-asks any
 *            pending permission, then follows the live stream. The runner being offline makes it wait, and `/status` shows
 *            "job runner offline" (see `JobTracker`).
 *   collect  posts the final message once (a memo), closes the Flow ledger entry and stores the result.
 *
 * What the model gets from a job (`JobTaskResult.modelText`, `job_status`) is wrapped as untrusted content (S14.6); the user's
 * Telegram messages are plain text. A Flow job is never submitted without an approved number (D11).
 */
import type { Logger } from "../contracts.js";
import { defineDoc, defineTask } from "../pi/adapter.js";
import type { Context, RunningTask, TaskRuntime } from "../pi/adapter.js";
import { PermissionRelay, buildJobCard, rejectionText, waitForApproval } from "./approval.js";
import type {
  JobApprovalTransport,
  JobDone,
  JobEvent,
  JobRequest,
  JobRunnerClient,
  JobRunnerConnectionState,
  JobSnapshot,
  JobState,
  JobTemplateSummary,
  SubmitBody,
  TerminalJobState,
} from "./contracts.js";
import { isTerminalJobState } from "./contracts.js";
import { closeEntry, flowLedgerDoc, isCredits, openEntry, recordJobCharge, recordReported } from "./ledger.js";
import { ProgressAggregator, ProgressPoster, wrapJobText } from "./progress.js";

export const JOB_TASK_NAME = "a7.job";
export const DEFAULT_MAX_RESUMES = 2;

// ---- task data -------------------------------------------------------------------------------------

export interface JobTaskInput {
  jobId: string;
  /** The chat conversation (decimal string) the job reports to. */
  conversationId: string;
  request: JobRequest;
  template: JobTemplateSummary;
  /** Present for a Flow template: the credits the card asks the user to approve (D11). */
  flowEstimateCredits?: number;
  createdAt: number;
}

export type ApprovalProofCp = { userId: number; at: number };

export type JobCheckpoint =
  | { phase: "approve" }
  | { phase: "submit"; approval: ApprovalProofCp; approvedCredits?: number }
  | { phase: "run"; approval: ApprovalProofCp; approvedCredits?: number; lastSeq: number; resumes: number }
  | { phase: "collect"; approvedCredits?: number; done: JobDone }
  | { phase: "done"; result: JobTaskResult };

export interface JobTaskResult {
  jobId: string;
  state: TerminalJobState;
  /** For `rejected`: who decided (user, timeout, stop, restart-expired). */
  by?: string;
  exitCode?: number;
  durationMs?: number;
  costUsd?: number;
  flow?: { approved: number; charged: number; reported?: number };
  /** Summary, artifacts and error as ONE untrusted-content block (S14.6). The model only ever gets this form. */
  modelText: string;
}

type JobRuntime = TaskRuntime<JobTaskInput, JobCheckpoint, JobTaskResult, object>;
type JobRunning<P extends JobCheckpoint["phase"]> = RunningTask<JobTaskInput, Extract<JobCheckpoint, { phase: P }>, JobTaskResult>;

// ---- control document: cancel requests (durable) -------------------------------------------------------

export type JobControlDoc = { cancel: Record<string, number> };

export const jobControlDoc = defineDoc<JobControlDoc>({
  kind: "a7.job.control",
  version: 1,
  scope: "session",
  initial: () => ({ cancel: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 25,
});

// ---- tracker (in memory, for /status and job_status while the runner is down) ---------------------------

export type TrackedPhase = "approve" | "submit" | "run" | "collect" | "done";

export interface TrackedJob {
  jobId: string;
  templateId: string;
  conversationId: string;
  phase: TrackedPhase;
  /** The runner's state once known, else a label of the agent's own wait. */
  state: JobState | "awaiting_approval" | "submitting" | "waiting_for_runner";
  eventCount: number;
  lastLine?: string;
  updatedAt: number;
}

export interface TrackerSummary {
  runnerOnline: boolean;
  awaitingApproval: number;
  queued: number;
  running: number;
  open: number;
  jobs: TrackedJob[];
}

/**
 * What the agent knows about its jobs right now. In memory only: every task rebuilds its row when its phase runs, so after a
 * restart the rows return as the tasks resume. `cancelSignal` lets `cancel_job` stop a job that waits for approval.
 */
export class JobTracker {
  runnerOnline = true;
  readonly #jobs = new Map<string, TrackedJob>();
  readonly #cancel = new Map<string, AbortController>();
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  watchClient(client: Pick<JobRunnerClient, "state" | "onStateChange">): () => void {
    this.runnerOnline = client.state === "online";
    return client.onStateChange((s: JobRunnerConnectionState) => {
      this.runnerOnline = s === "online";
      this.#emit();
    });
  }

  upsert(jobId: string, patch: Partial<Omit<TrackedJob, "jobId" | "updatedAt">> & Pick<TrackedJob, "templateId" | "conversationId">): TrackedJob {
    const prev = this.#jobs.get(jobId);
    const next: TrackedJob = {
      jobId,
      phase: "approve",
      state: "awaiting_approval",
      eventCount: 0,
      ...prev,
      ...patch,
      updatedAt: this.#now(),
    };
    this.#jobs.set(jobId, next);
    this.#emit();
    return next;
  }

  get(jobId: string): TrackedJob | undefined {
    return this.#jobs.get(jobId);
  }

  list(): TrackedJob[] {
    return [...this.#jobs.values()];
  }

  /** Jobs of one conversation that are not finished. */
  openFor(conversationId: string): TrackedJob[] {
    return this.list().filter((j) => j.conversationId === conversationId && j.phase !== "done");
  }

  finish(jobId: string): void {
    const j = this.#jobs.get(jobId);
    if (j) this.#jobs.set(jobId, { ...j, phase: "done", updatedAt: this.#now() });
    this.#emit();
  }

  cancelSignal(jobId: string): AbortSignal {
    let c = this.#cancel.get(jobId);
    if (!c) {
      c = new AbortController();
      this.#cancel.set(jobId, c);
    }
    return c.signal;
  }

  requestCancel(jobId: string): void {
    let c = this.#cancel.get(jobId);
    if (!c) {
      c = new AbortController();
      this.#cancel.set(jobId, c);
    }
    if (!c.signal.aborted) c.abort();
  }

  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  summary(): TrackerSummary {
    const jobs = this.list().filter((j) => j.phase !== "done");
    return {
      runnerOnline: this.runnerOnline,
      awaitingApproval: jobs.filter((j) => j.state === "awaiting_approval").length,
      queued: jobs.filter((j) => j.state === "queued").length,
      running: jobs.filter((j) => j.state === "running" || j.state === "cancelling").length,
      open: jobs.length,
      jobs,
    };
  }

  /** Lines for `/status` (S15.2). */
  statusLines(): string[] {
    const s = this.summary();
    const lines = [`Job runner: ${s.runnerOnline ? "online" : "job runner offline (jobs wait and continue when it is back)"}`];
    lines.push(`Jobs: ${s.running} running, ${s.queued} queued, ${s.awaitingApproval} awaiting approval`);
    return lines;
  }

  #emit(): void {
    for (const cb of [...this.#listeners]) {
      try {
        cb();
      } catch {
        /* a listener must not break a job */
      }
    }
  }
}

// ---- helpers -------------------------------------------------------------------------------------------

const isAbort = (e: unknown): boolean => e instanceof Error && (e.name === "IpcAbortError" || e.name === "AbortError");
const isOffline = (e: unknown): boolean => e instanceof Error && (e.name === "IpcOfflineError" || e.name === "IpcTimeoutError");
const remoteCode = (e: unknown): string | undefined => (e instanceof Error && e.name === "IpcRemoteError" ? String((e as { code?: unknown }).code) : undefined);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** One wake-up flag: a wake between two waits is not lost. */
class Waker {
  #woken = false;
  #resolve: (() => void) | undefined;
  wake(): void {
    this.#woken = true;
    this.#resolve?.();
  }
  /** Resolves true when woken, false on the timeout or an abort. */
  async wait(ms: number, signal: AbortSignal): Promise<boolean> {
    if (this.#woken) {
      this.#woken = false;
      return true;
    }
    if (signal.aborted) return false;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        this.#resolve = undefined;
        resolve();
      };
      const t = setTimeout(done, ms);
      this.#resolve = done;
      signal.addEventListener("abort", done, { once: true });
    });
    const woken = this.#woken;
    this.#woken = false;
    return woken;
  }
}

/** Appended to the brief the runner gets: the budget the user approved, so no repo default (150 per production) applies. */
export function budgetLine(credits: number): string {
  return `[agent-007] The agreed Flow budget for this job is ${credits} credits. Put max_credits on every Flow call and never let the total go above ${credits}.`;
}

export function briefForRunner(input: JobTaskInput, approvedCredits: number | undefined): string {
  return approvedCredits !== undefined ? `${input.request.brief}\n\n${budgetLine(approvedCredits)}` : input.request.brief;
}

function submitBody(input: JobTaskInput, approval: ApprovalProofCp, approvedCredits: number | undefined, resume: boolean): SubmitBody {
  return {
    jobId: input.jobId,
    request: { templateId: input.request.templateId, params: input.request.params, brief: briefForRunner(input, approvedCredits) },
    approval,
    ...(approvedCredits !== undefined ? { flowBudgetCredits: approvedCredits } : {}),
    ...(resume ? { resume: true } : {}),
  };
}

/** The wrapped text the model gets for a finished job: summary, artifacts and error in one untrusted block. */
export function modelTextFor(input: Pick<JobTaskInput, "jobId"> & { engine: string }, done: JobDone): string {
  const parts = [`state: ${done.state}`];
  if (done.summary.trim() !== "") parts.push(`summary: ${done.summary}`);
  if (done.artifacts.length > 0) parts.push(`artifacts:\n${done.artifacts.map((a) => `- ${a}`).join("\n")}`);
  if (done.error) parts.push(`error: ${done.error}`);
  return wrapJobText(input.jobId, input.engine, parts.join("\n"));
}

function syntheticDone(input: JobTaskInput, state: TerminalJobState, error: string, startedAt: number, now: number): JobDone {
  return { jobId: input.jobId, state, summary: "", artifacts: [], durationMs: Math.max(0, now - startedAt), error };
}

// ---- the task -------------------------------------------------------------------------------------------

export interface SettledJob {
  jobId: string;
  conversationId: string;
  templateId: string;
  result: JobTaskResult;
}

export interface JobTaskDeps {
  client: JobRunnerClient;
  transport: JobApprovalTransport;
  tracker?: JobTracker | undefined;
  logger?: Logger | undefined;
  /** `config.jobs.approvalTimeoutSec` (UI-12). */
  approvalTimeoutSec: number;
  /** `config.jobs.progressIntervalSec * 1000`: the minimum gap between two progress posts. */
  progressIntervalMs: number;
  /** How often the run phase reconciles with `status` when no event arrives. Default 15 s. */
  pollMs?: number | undefined;
  /** Wait after a transient failure (Telegram or the runner down). Default 2 s. */
  retryDelayMs?: number | undefined;
  /** How often an `interrupted` job is resumed before it is failed. Default 2. */
  maxResumes?: number | undefined;
  /** Called once a job reached a result, before the task becomes terminal (so a crash repeats it, never loses it). */
  onSettled?: ((job: SettledJob) => void | Promise<void>) | undefined;
}

export type JobTask = ReturnType<typeof createJobTask>;

export function createJobTask(deps: JobTaskDeps) {
  const tracker = deps.tracker ?? new JobTracker();
  tracker.watchClient(deps.client);
  const pollMs = deps.pollMs ?? 15_000;
  const retryDelayMs = deps.retryDelayMs ?? 2_000;
  const maxResumes = deps.maxResumes ?? DEFAULT_MAX_RESUMES;
  const log = deps.logger;

  const track = (input: JobTaskInput, patch: Partial<Omit<TrackedJob, "jobId" | "updatedAt" | "templateId" | "conversationId">>): void => {
    tracker.upsert(input.jobId, { templateId: input.template.id, conversationId: input.conversationId, ...patch });
  };

  const cancelRequested = async (rt: JobRuntime, jobId: string, ctx: Context): Promise<boolean> =>
    tracker.cancelSignal(jobId).aborted || (await rt.snapshot(jobControlDoc, ctx))?.cancel[jobId] !== undefined;

  /** Moves to `collect` with a synthetic result (an early failure or a cancel before the job ran). */
  const toCollect = async (task: { input: JobTaskInput; state: { checkpoint: JobCheckpoint } }, rt: JobRuntime, ctx: Context, state: TerminalJobState, error: string, approvedCredits?: number): Promise<void> => {
    const done = syntheticDone(task.input, state, error, task.input.createdAt, rt.now());
    await rt.commit(() => ({ status: "running", checkpoint: { phase: "collect", ...(approvedCredits !== undefined ? { approvedCredits } : {}), done } }), ctx);
  };

  const toRejected = async (input: JobTaskInput, rt: JobRuntime, ctx: Context, by: string): Promise<void> => {
    const result: JobTaskResult = { jobId: input.jobId, state: "rejected", by, modelText: rejectionText(by as never) };
    await rt.commit(() => ({ status: "running", checkpoint: { phase: "done", result } }), ctx);
  };

  // ---- approve ----------------------------------------------------------------------------------------

  const approve = async (task: JobRunning<"approve">, rt: JobRuntime, ctx: Context): Promise<void> => {
    const input = task.input;
    track(input, { phase: "approve", state: "awaiting_approval" });
    if (await cancelRequested(rt, input.jobId, ctx)) return toCollect(task, rt, ctx, "cancelled", "Cancelled before it was approved.");

    type Stored = { approved: boolean; by: string; userId: number | null; at: number; approvedCredits: number | null };
    let stored = await rt.memo<Stored>("decision", ctx);
    if (stored === undefined) {
      const rerun = (await rt.memo<{ askedAt: number }>("asked", ctx)) !== undefined;
      const asked = await rt.memo("asked", { askedAt: rt.now() }, ctx);
      const card = buildJobCard({
        jobId: input.jobId,
        conversationId: input.conversationId,
        template: input.template,
        params: input.request.params,
        brief: input.request.brief,
        flowEstimateCredits: input.flowEstimateCredits,
        askedAt: asked.askedAt,
        timeoutSec: deps.approvalTimeoutSec,
      });
      let candidate: Stored;
      if (rt.now() >= card.deadline) {
        candidate = { approved: false, by: rerun ? "restart-expired" : "timeout", userId: null, at: rt.now(), approvedCredits: null };
      } else {
        const outcome = await waitForApproval({ transport: deps.transport, card, signal: rt.signal, cancel: tracker.cancelSignal(input.jobId), now: () => rt.now(), retryDelayMs, logger: log });
        if (outcome.type === "closing") return; // a restart: the next invocation asks again with a new card
        if (outcome.type === "cancelled") return toCollect(task, rt, ctx, "cancelled", "Cancelled before it was approved.");
        const d = outcome.decision;
        candidate = { approved: d.approved, by: d.by, userId: d.userId ?? null, at: d.at, approvedCredits: d.approvedCredits ?? null };
      }
      stored = await rt.memo("decision", candidate, ctx); // first writer wins
    }
    if (!stored.approved) {
      log?.info("jobs.not_approved", { jobId: input.jobId, by: stored.by });
      return toRejected(input, rt, ctx, stored.by);
    }

    // D11: a Flow job runs only on the number the user approved; with none it is never submitted.
    let approvedCredits: number | undefined;
    if (input.template.flow.enabled) {
      const estimate = input.flowEstimateCredits;
      const said = stored.approvedCredits ?? estimate;
      approvedCredits = isCredits(said) && isCredits(estimate) ? Math.min(said, estimate) : undefined;
      if (approvedCredits === undefined) return toCollect(task, rt, ctx, "failed", "A Flow job needs an approved number of credits. No credits were approved, so the job was not submitted.");
    }
    const userId = stored.userId ?? 0;
    const approval: ApprovalProofCp = { userId, at: stored.at };
    await rt.commit(async (tx) => {
      if (approvedCredits !== undefined) {
        openEntry(await tx.doc(flowLedgerDoc), { jobId: input.jobId, conversationId: input.conversationId, templateId: input.template.id, approved: approvedCredits, userId, at: rt.now() });
      }
      return { status: "running", checkpoint: { phase: "submit", approval, ...(approvedCredits !== undefined ? { approvedCredits } : {}) } };
    }, ctx);
  };

  // ---- submit ------------------------------------------------------------------------------------------

  const submit = async (task: JobRunning<"submit">, rt: JobRuntime, ctx: Context): Promise<void> => {
    const input = task.input;
    const cp = task.state.checkpoint;
    const signal = rt.signal;
    track(input, { phase: "submit", state: "submitting" });
    if (input.template.flow.enabled && !isCredits(cp.approvedCredits)) {
      return toCollect(task, rt, ctx, "failed", "A Flow job needs an approved number of credits. None is recorded, so the job was not submitted.");
    }
    if (await cancelRequested(rt, input.jobId, ctx)) return toCollect(task, rt, ctx, "cancelled", "Cancelled before it was submitted.", cp.approvedCredits);

    let failures = 0;
    for (;;) {
      if (signal.aborted) return;
      if (deps.client.state !== "online") {
        track(input, { state: "waiting_for_runner" });
        try {
          await deps.client.waitOnline({ signal });
        } catch {
          if (signal.aborted) return;
        }
        continue;
      }
      try {
        // Re-attach instead of submitting again: a job the runner already has is never submitted twice.
        // The real runner answers `status {jobId}` for an unknown job with the error `not_found` (the S14 fake returned an empty
        // list); both mean "not there yet" (S15 integration fix).
        let existing: JobSnapshot | undefined;
        try {
          const status = await deps.client.status({ jobId: input.jobId }, { signal });
          existing = status.jobs.find((j) => j.jobId === input.jobId);
        } catch (e) {
          if (remoteCode(e) !== "not_found") throw e;
        }
        if (existing === undefined) {
          const reply = await deps.client.submit(submitBody(input, cp.approval, cp.approvedCredits, false), { signal });
          log?.info("jobs.submitted", { jobId: input.jobId, state: reply.state, duplicate: reply.duplicate });
          if (reply.state === "rejected") return toCollect(task, rt, ctx, "failed", "The job runner rejected the job.", cp.approvedCredits);
        } else if (existing.state === "interrupted") {
          await deps.client.submit(submitBody(input, cp.approval, cp.approvedCredits, true), { signal });
          log?.info("jobs.resumed_at_submit", { jobId: input.jobId });
        }
        break;
      } catch (e) {
        if (signal.aborted || isAbort(e)) return;
        const code = remoteCode(e);
        if (code !== undefined && code !== "busy" && code !== "internal") {
          return toCollect(task, rt, ctx, "failed", `The job runner refused the job (${code}): ${errText(e)}`, cp.approvedCredits);
        }
        if (!isOffline(e) && ++failures >= 5) return toCollect(task, rt, ctx, "failed", `The job runner could not take the job: ${errText(e)}`, cp.approvedCredits);
        await sleep(retryDelayMs, signal);
      }
    }
    await rt.commit(() => ({ status: "running", checkpoint: { phase: "run", approval: cp.approval, ...(cp.approvedCredits !== undefined ? { approvedCredits: cp.approvedCredits } : {}), lastSeq: 0, resumes: 0 } }), ctx);
  };

  // ---- run ----------------------------------------------------------------------------------------------

  const run = async (task: JobRunning<"run">, rt: JobRuntime, ctx: Context): Promise<void> => {
    const input = task.input;
    const cp = task.state.checkpoint;
    const signal = rt.signal;
    const client = deps.client;
    const jobId = input.jobId;
    const engine = input.template.engine;
    const agg = new ProgressAggregator({ jobId, title: input.template.title || input.template.id });
    agg.lastSeq = cp.lastSeq;
    const poster = new ProgressPoster({ post: (u) => deps.transport.postProgress(u), intervalMs: deps.progressIntervalMs, logger: log, now: () => rt.now() });
    const relay = new PermissionRelay({ client, transport: deps.transport, conversationId: input.conversationId, logger: log, now: () => rt.now() });
    const waker = new Waker();
    const inbox: JobEvent[] = [];
    let doneMsg: JobDone | undefined;
    let needReconcile = true;
    let cancelSent = false;
    let resumes = cp.resumes;
    let committedSeq = cp.lastSeq;
    let pendingCharge: number | undefined;
    let resultText: string | undefined;
    let startedAt = input.createdAt;
    track(input, { phase: "run", state: "running", eventCount: agg.eventCount });

    const offs = [
      client.onJobEvent((e) => {
        if (e.jobId !== jobId) return;
        inbox.push(e);
        waker.wake();
      }),
      client.onPermissionRequest((r) => {
        if (r.jobId === jobId) relay.handle(r);
      }),
      client.onJobDone((d) => {
        if (d.jobId !== jobId) return;
        doneMsg = d;
        needReconcile = true;
        waker.wake();
      }),
      client.onStateChange(() => {
        needReconcile = true;
        waker.wake();
      }),
    ];

    let committedResumes = cp.resumes;
    const commitProgress = async (force = false): Promise<void> => {
      if (!force && agg.lastSeq === committedSeq && pendingCharge === undefined && resumes === committedResumes) return;
      const seq = agg.lastSeq;
      const charge = pendingCharge;
      try {
        await rt.commit(async (tx, current) => {
          if (charge !== undefined) recordJobCharge(await tx.doc(flowLedgerDoc), jobId, charge);
          const c = current.state.checkpoint as Extract<JobCheckpoint, { phase: "run" }>;
          return { status: "running", checkpoint: { ...c, lastSeq: seq, resumes } };
        }, ctx);
        committedSeq = seq;
        committedResumes = resumes;
        if (pendingCharge === charge) pendingCharge = undefined;
      } catch (e) {
        if (!signal.aborted) log?.warn("jobs.commit_progress_failed", { jobId, error: errText(e) });
        else throw e;
      }
    };

    const handleEvent = (e: JobEvent): void => {
      if (e.seq <= agg.lastSeq) return;
      if (e.seq > agg.lastSeq + 1) {
        needReconcile = true; // a gap: status will return the events in order
        return;
      }
      agg.apply(e);
      if (e.kind === "state") {
        if (isTerminalJobState(e.state)) needReconcile = true; // fetch the final snapshot: it carries `done`
      } else if (e.kind === "init") {
        startedAt = e.ts;
      } else if (e.kind === "flow_call" && e.allowed) {
        pendingCharge = Math.max(pendingCharge ?? 0, e.chargedTotal);
      } else if (e.kind === "result") {
        resultText = e.text;
      }
      track(input, { phase: "run", state: agg.state, eventCount: agg.eventCount, lastLine: agg.text().split("\n").at(-1) ?? "" });
      poster.offer(agg.update(input.conversationId));
    };

    const finish = async (done: JobDone): Promise<void> => {
      await commitProgress().catch(() => undefined);
      relay.cancelAll("cancel");
      poster.offer(agg.update(input.conversationId));
      await poster.flush();
      await rt.commit(() => ({ status: "running", checkpoint: { phase: "collect", ...(cp.approvedCredits !== undefined ? { approvedCredits: cp.approvedCredits } : {}), done } }), ctx);
    };

    const fail = (error: string): Promise<void> => finish(syntheticDone(input, "failed", error, startedAt, rt.now()));

    try {
      let consecutiveErrors = 0;
      while (!signal.aborted) {
        if (client.state !== "online") {
          track(input, { state: "waiting_for_runner" });
          try {
            await client.waitOnline({ signal });
          } catch {
            if (signal.aborted) return;
          }
          needReconcile = true;
          continue;
        }

        if (!cancelSent && (await cancelRequested(rt, jobId, ctx))) {
          try {
            await client.cancel({ jobId, reason: "cancelled by the user" }, { signal });
            cancelSent = true;
            relay.cancelAll("cancel");
          } catch (e) {
            if (signal.aborted) return;
            if (!isOffline(e)) cancelSent = true; // the runner refused or does not know it; do not loop
            log?.warn("jobs.cancel_failed", { jobId, error: errText(e) });
          }
        }

        for (const e of inbox.splice(0, inbox.length).sort((a, b) => a.seq - b.seq)) handleEvent(e);
        if (pendingCharge !== undefined || agg.lastSeq - committedSeq >= 20) await commitProgress();

        if (needReconcile) {
          needReconcile = false;
          let snap;
          try {
            snap = await client.status({ jobId, sinceSeq: agg.lastSeq }, { signal });
            consecutiveErrors = 0;
          } catch (e) {
            if (signal.aborted || isAbort(e)) return;
            if (remoteCode(e) === "not_found") return fail("The job runner has no record of this job (it may have lost its journal).");
            if (!isOffline(e) && ++consecutiveErrors >= 5) return fail(`The job runner status call keeps failing: ${errText(e)}`);
            needReconcile = true;
            await sleep(retryDelayMs, signal);
            continue;
          }
          const job = snap.jobs.find((j) => j.jobId === jobId);
          if (job === undefined) return fail("The job runner has no record of this job (it may have lost its journal).");
          if (job.startedAt !== undefined) startedAt = job.startedAt;
          for (const e of [...(snap.events ?? [])].sort((a, b) => a.seq - b.seq)) handleEvent(e);
          for (const p of job.pendingPermissions) relay.handle(p);

          if (isTerminalJobState(job.state)) {
            const done =
              job.done ??
              doneMsg ??
              ({
                jobId,
                state: job.state,
                summary: resultText ?? "",
                artifacts: [],
                durationMs: job.finishedAt !== undefined && job.startedAt !== undefined ? job.finishedAt - job.startedAt : 0,
              } satisfies JobDone);
            return finish(done);
          }
          if (job.state === "interrupted") {
            if (resumes >= maxResumes) return fail(`The job was interrupted ${resumes + 1} times (job runner restarts) and was not resumed again.`);
            try {
              await client.submit(submitBody(input, cp.approval, cp.approvedCredits, true), { signal });
              resumes++;
              log?.info("jobs.resumed", { jobId, resumes });
              poster.offer({ ...agg.update(input.conversationId), text: `${agg.text()}\nResumed after an interruption (${resumes}/${maxResumes}).` });
              await commitProgress(true);
              // the runner emits a state event when the job runs again; that wakes the loop (a quiet poll reconciles)
            } catch (e) {
              if (signal.aborted || isAbort(e)) return;
              if (remoteCode(e) !== undefined && remoteCode(e) !== "busy") return fail(`The job could not be resumed (${remoteCode(e)}): ${errText(e)}`);
              needReconcile = true;
              await sleep(retryDelayMs, signal);
            }
            continue;
          }
          track(input, { state: job.state });
        }

        if (inbox.length === 0 && !needReconcile) {
          // Events wake the loop (a gap, a state change or a done message sets needReconcile); a quiet poll reconciles.
          const woken = await waker.wait(pollMs, signal);
          if (!woken && !signal.aborted) needReconcile = true;
        }
      }
    } finally {
      for (const off of offs) off();
      relay.dispose();
      poster.dispose();
    }
  };

  // ---- collect -------------------------------------------------------------------------------------------

  const collect = async (task: JobRunning<"collect">, rt: JobRuntime, ctx: Context): Promise<void> => {
    const input = task.input;
    const done = task.state.checkpoint.done;
    track(input, { phase: "collect", state: done.state });
    const ledger = (await rt.snapshot(flowLedgerDoc, ctx))?.entries[input.jobId];
    const reported = done.flow?.reported ?? ledger?.reported ?? undefined;
    const flow = ledger
      ? { approved: ledger.approved, charged: Math.max(ledger.jobCharged + ledger.directCharged, done.flow?.charged ?? 0), ...(reported !== undefined ? { reported } : {}) }
      : undefined;
    if ((await rt.memo<boolean>("final_posted", ctx)) !== true) {
      // The user's final message is plain text and shows approved, charged and reported Flow credits (S14.4). A failed post
      // is logged; it never stops the job from being recorded.
      try {
        await deps.transport.postFinal(flow ? { ...done, flow } : done, input.conversationId);
      } catch (e) {
        log?.warn("jobs.final_post_failed", { jobId: input.jobId, error: errText(e) });
      }
      await rt.memo("final_posted", true, ctx);
    }
    const result: JobTaskResult = {
      jobId: input.jobId,
      state: done.state,
      ...(done.exitCode !== undefined ? { exitCode: done.exitCode } : {}),
      durationMs: done.durationMs,
      ...(done.costUsd !== undefined ? { costUsd: done.costUsd } : {}),
      ...(flow ? { flow } : {}),
      modelText: modelTextFor({ jobId: input.jobId, engine: input.template.engine }, done),
    };
    await rt.commit(async (tx) => {
      if (ledger) {
        const doc = await tx.doc(flowLedgerDoc);
        if (reported !== undefined) recordReported(doc, input.jobId, reported);
        if (done.flow) recordJobCharge(doc, input.jobId, done.flow.charged);
        closeEntry(doc, input.jobId);
      }
      return { status: "running", checkpoint: { phase: "done", result } };
    }, ctx);
  };

  // ---- done ----------------------------------------------------------------------------------------------

  const done = async (task: JobRunning<"done">, rt: JobRuntime, ctx: Context): Promise<void> => {
    const input = task.input;
    const result = task.state.checkpoint.result;
    try {
      await deps.onSettled?.({ jobId: input.jobId, conversationId: input.conversationId, templateId: input.template.id, result });
    } catch (e) {
      log?.warn("jobs.on_settled_failed", { jobId: input.jobId, error: errText(e) });
    }
    tracker.finish(input.jobId);
    await rt.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), ctx);
  };

  return defineTask<JobTaskInput, JobCheckpoint, JobTaskResult>({
    name: JOB_TASK_NAME,
    version: 1,
    initial: () => ({ phase: "approve" }),
    phases: { approve, submit, run, collect, done },
    abort: async (task, rt, ctx) => {
      const input = task.input;
      const phase = task.state.checkpoint.phase;
      if (phase === "run" || phase === "submit") {
        try {
          await deps.client.cancel({ jobId: input.jobId, reason: "the agent task was aborted" }, { timeoutMs: 5_000 });
        } catch {
          /* best effort: the runner may be offline */
        }
      }
      tracker.finish(input.jobId);
      await rt.commit(async (tx) => {
        const doc = await tx.doc(flowLedgerDoc);
        closeEntry(doc, input.jobId);
        return { status: "terminal", outcome: { status: "aborted", reason: "aborted" } };
      }, ctx);
    },
  });
}
