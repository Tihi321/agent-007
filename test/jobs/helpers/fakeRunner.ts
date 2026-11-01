/**
 * A stateful fake job runner behind `FakeJobRunnerClient`s: it keeps jobs, events and pending permissions across "restarts"
 * of the agent (each rig makes a new client from the same runner), the way the real job runner keeps its journal. No process
 * is started and nothing is spent.
 */
import type {
  CallOptions,
  CancelBody,
  JobDone,
  JobEvent,
  JobSnapshot,
  JobState,
  PermissionDecision,
  PermissionRequest,
  StatusBody,
  StatusReply,
  SubmitBody,
  SubmitReply,
} from "../../../src/jobs/contracts.js";
import { isTerminalJobState } from "../../../src/jobs/contracts.js";
import { FakeJobRunnerClient } from "../../helpers/fakeJobRunner.js";
import type { EventBody } from "./fixtures.js";

interface FakeJob {
  snapshot: JobSnapshot;
  events: JobEvent[];
  body: SubmitBody;
}

export class CrashableClient extends FakeJobRunnerClient {
  /** Runs after the runner accepted a `submit` and before the agent hears the reply (a crash in the submit phase). */
  afterSubmit: (() => void) | undefined;
  /** Runs when a `status` call comes in. */
  onStatus: ((body: StatusBody) => void) | undefined;
  /** Runs when the agent's permission answer reaches the runner. */
  onAnswer: ((d: PermissionDecision) => void) | undefined;

  override async answerPermission(d: PermissionDecision): Promise<void> {
    await super.answerPermission(d);
    this.onAnswer?.(d);
  }

  override async submit(body: SubmitBody, opts: CallOptions = {}): Promise<SubmitReply> {
    const reply = await super.submit(body);
    const hook = this.afterSubmit;
    if (hook) {
      this.afterSubmit = undefined;
      hook();
      await new Promise<void>((_resolve, reject) => {
        const err = (): void => {
          const e = new Error("aborted");
          e.name = "IpcAbortError";
          reject(e);
        };
        if (opts.signal?.aborted) err();
        else opts.signal?.addEventListener("abort", err, { once: true });
      });
    }
    return reply;
  }

  override async status(body: StatusBody = {}): Promise<StatusReply> {
    this.onStatus?.(body);
    return super.status(body);
  }
}

export class FakeRunner {
  readonly jobs = new Map<string, FakeJob>();
  /** Every `submit` call the runner received, duplicates and resumes included. */
  readonly submits: SubmitBody[] = [];
  readonly cancels: CancelBody[] = [];
  readonly clients = new Set<CrashableClient>();
  /** Status calls fail with this remote error instead (for example `not_found`). */
  statusError: { code: string; message: string } | undefined;
  private clock = 1_000;

  makeClient(initial: "online" | "offline" = "online"): CrashableClient {
    const c = new CrashableClient(
      {
        submit: (b) => this.onSubmit(b),
        status: (b) => this.onStatus(b),
        cancel: (b) => this.onCancel(b),
      },
      initial,
    );
    c.onAnswer = (d) => this.clearPermission(d.jobId, d.requestId);
    this.clients.add(c);
    return c;
  }

  private onSubmit(body: SubmitBody): SubmitReply {
    this.submits.push(body);
    const existing = this.jobs.get(body.jobId);
    if (existing) {
      if (body.resume === true && existing.snapshot.state === "interrupted") {
        this.setState(body.jobId, "running", "resumed");
        return { jobId: body.jobId, state: "running", duplicate: false };
      }
      return { jobId: body.jobId, state: existing.snapshot.state, duplicate: true };
    }
    const snapshot: JobSnapshot = {
      jobId: body.jobId,
      templateId: body.request.templateId,
      engine: "claude",
      state: "queued",
      createdAt: this.clock++,
      lastSeq: 0,
      pendingPermissions: [],
    };
    this.jobs.set(body.jobId, { snapshot, events: [], body });
    this.setState(body.jobId, "running");
    this.emit(body.jobId, { kind: "init", engineSessionId: "sess-1", engineVersion: "fake 1.0" });
    return { jobId: body.jobId, state: "running", duplicate: false };
  }

  private onStatus(body: StatusBody): StatusReply {
    if (this.statusError) {
      const e = new Error(this.statusError.message);
      e.name = "IpcRemoteError";
      (e as { code?: string }).code = this.statusError.code;
      throw e;
    }
    const jobs = [...this.jobs.values()].filter((j) => body.jobId === undefined || j.snapshot.jobId === body.jobId);
    return {
      runner: { version: "fake", startedAt: 0, now: this.clock },
      engines: {},
      jobs: jobs.map((j) => ({ ...j.snapshot, lastSeq: j.events.length, pendingPermissions: [...j.snapshot.pendingPermissions] })),
      ...(body.jobId !== undefined && body.sinceSeq !== undefined ? { events: this.jobs.get(body.jobId)?.events.filter((e) => e.seq > (body.sinceSeq ?? 0)) ?? [] } : {}),
      daily: { jobs: 0, jobCap: 100, credits: 0, creditCap: 1000 },
    };
  }

  private onCancel(body: CancelBody): { jobId: string; state: JobState } {
    this.cancels.push(body);
    const j = this.jobs.get(body.jobId);
    if (!j) return { jobId: body.jobId, state: "cancelled" };
    if (!isTerminalJobState(j.snapshot.state)) this.finish(body.jobId, { state: "cancelled", summary: "Cancelled." });
    return { jobId: body.jobId, state: j.snapshot.state };
  }

  /** The runner's own event stream: appended to the journal and pushed to every connected client. */
  emit(jobId: string, body: EventBody): JobEvent {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`no such job ${jobId}`);
    const event = { jobId, seq: j.events.length + 1, ts: this.clock++, ...body } as JobEvent;
    j.events.push(event);
    j.snapshot.lastSeq = event.seq;
    for (const c of this.clients) c.emitEvent(event);
    return event;
  }

  setState(jobId: string, state: JobState, detail?: string): void {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`no such job ${jobId}`);
    j.snapshot.state = state;
    if (state === "running" && j.snapshot.startedAt === undefined) j.snapshot.startedAt = this.clock++;
    this.emit(jobId, { kind: "state", state, ...(detail ? { detail } : {}) });
  }

  /** The runner marks running jobs `interrupted` after its own restart. */
  interrupt(jobId: string): void {
    this.setState(jobId, "interrupted", "job runner restarted");
  }

  permission(jobId: string, over: Partial<PermissionRequest> = {}): PermissionRequest {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`no such job ${jobId}`);
    const req: PermissionRequest = {
      requestId: over.requestId ?? `perm-${j.snapshot.pendingPermissions.length + 1}`,
      jobId,
      engine: "claude",
      tool: "Write",
      input: { file_path: "runs/out.txt" },
      cwd: "C:\\projects\\Personal\\creative-hub",
      kind: "edit",
      requestedAt: Date.now(),
      timeoutSec: 600,
      ...over,
    };
    j.snapshot.pendingPermissions.push(req);
    for (const c of this.clients) c.emitPermission(req);
    return req;
  }

  /** The agent's answer reached the runner: the request is no longer pending. */
  clearPermission(jobId: string, requestId: string): void {
    const j = this.jobs.get(jobId);
    if (j) j.snapshot.pendingPermissions = j.snapshot.pendingPermissions.filter((p) => p.requestId !== requestId);
  }

  finish(jobId: string, over: Partial<JobDone> = {}): JobDone {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`no such job ${jobId}`);
    const done: JobDone = { jobId, state: "succeeded", summary: "All done.", artifacts: [], durationMs: 1234, ...over };
    this.emit(jobId, { kind: "result", text: done.summary });
    j.snapshot.finishedAt = this.clock++;
    j.snapshot.done = done;
    this.setState(jobId, done.state);
    for (const c of this.clients) c.emitDone(done);
    return done;
  }

  /** Replays submits a crashed process had accepted (a real runner keeps its journal on disk). */
  restoreSubmits(bodies: readonly SubmitBody[]): void {
    for (const b of bodies) this.onSubmit(b);
  }

  /** Submits that started the job (not resumes). */
  submitCount(jobId: string): number {
    return this.submits.filter((s) => s.jobId === jobId && s.resume !== true).length;
  }
}
