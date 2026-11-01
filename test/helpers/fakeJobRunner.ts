/**
 * Shared fakes for the Phase 2 slices (S9). S10 (hub_start), S14 (Job task, tools, Telegram cards) and S15 test against
 * these instead of a real job runner: `FakeJobRunnerClient` implements `JobRunnerClient`, `FakeJobApprovalTransport`
 * implements `JobApprovalTransport`. Not a test file.
 */
import type {
  CallOptions,
  CancelBody,
  CancelReply,
  FlowEstimateBody,
  FlowEstimateReply,
  HubStartBody,
  HubStartCard,
  HubStartReply,
  HubStatusReply,
  JobApprovalCard,
  JobApprovalDecision,
  JobApprovalTransport,
  JobDone,
  JobEvent,
  JobProgressUpdate,
  JobRunnerClient,
  JobRunnerConnectionState,
  ListTemplatesReply,
  PermissionDecision,
  PermissionRequest,
  StatusBody,
  StatusReply,
  SubmitBody,
  SubmitReply,
  Unsubscribe,
} from "../../src/jobs/contracts.js";

export interface FakeCall {
  method: string;
  arg: unknown;
}

export interface FakeJobRunnerHandlers {
  submit?: (body: SubmitBody) => SubmitReply | Promise<SubmitReply>;
  cancel?: (body: CancelBody) => CancelReply | Promise<CancelReply>;
  status?: (body: StatusBody) => StatusReply | Promise<StatusReply>;
  listTemplates?: () => ListTemplatesReply | Promise<ListTemplatesReply>;
  hubStatus?: () => HubStatusReply | Promise<HubStatusReply>;
  hubStart?: (body: HubStartBody) => HubStartReply | Promise<HubStartReply>;
  flowEstimate?: (body: FlowEstimateBody) => FlowEstimateReply | Promise<FlowEstimateReply>;
}

export const EMPTY_STATUS: StatusReply = {
  runner: { version: "fake", startedAt: 0, now: 0 },
  engines: {},
  jobs: [],
  daily: { jobs: 0, jobCap: 100, credits: 0, creditCap: 1000 },
};

/** Offline calls reject like the real client does (`IpcOfflineError`'s name), so callers can be tested against it. */
class FakeOfflineError extends Error {
  constructor() {
    super("the job runner is offline");
    this.name = "IpcOfflineError";
  }
}

export class FakeJobRunnerClient implements JobRunnerClient {
  state: JobRunnerConnectionState;
  readonly calls: FakeCall[] = [];
  readonly decisions: PermissionDecision[] = [];
  private readonly events = new Set<(e: JobEvent) => void>();
  private readonly perms = new Set<(r: PermissionRequest) => void>();
  private readonly dones = new Set<(d: JobDone) => void>();
  private readonly states = new Set<(s: JobRunnerConnectionState) => void>();

  constructor(public handlers: FakeJobRunnerHandlers = {}, initial: JobRunnerConnectionState = "online") {
    this.state = initial;
  }

  start(): void {}
  async close(): Promise<void> {
    this.setState("offline");
  }

  setState(s: JobRunnerConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    for (const cb of [...this.states]) cb(s);
  }
  emitEvent(e: JobEvent): void {
    for (const cb of [...this.events]) cb(e);
  }
  emitPermission(r: PermissionRequest): void {
    for (const cb of [...this.perms]) cb(r);
  }
  emitDone(d: JobDone): void {
    for (const cb of [...this.dones]) cb(d);
  }

  async waitOnline(opts: CallOptions = {}): Promise<void> {
    if (this.state === "online") return;
    await new Promise<void>((resolve, reject) => {
      const off = this.onStateChange((s) => {
        if (s === "online") {
          off();
          resolve();
        }
      });
      opts.signal?.addEventListener("abort", () => {
        off();
        reject(new Error("aborted"));
      });
    });
  }

  private async run<T>(method: string, arg: unknown, handler: (() => T | Promise<T>) | undefined, fallback: T): Promise<T> {
    this.calls.push({ method, arg });
    if (this.state !== "online") throw new FakeOfflineError();
    return handler ? await handler() : fallback;
  }

  submit(body: SubmitBody): Promise<SubmitReply> {
    return this.run("submit", body, this.handlers.submit ? () => this.handlers.submit!(body) : undefined, { jobId: body.jobId, state: "queued", duplicate: false });
  }
  cancel(body: CancelBody): Promise<CancelReply> {
    return this.run("cancel", body, this.handlers.cancel ? () => this.handlers.cancel!(body) : undefined, { jobId: body.jobId, state: "cancelled" });
  }
  status(body: StatusBody = {}): Promise<StatusReply> {
    return this.run("status", body, this.handlers.status ? () => this.handlers.status!(body) : undefined, EMPTY_STATUS);
  }
  listTemplates(): Promise<ListTemplatesReply> {
    return this.run("listTemplates", undefined, this.handlers.listTemplates, { templates: [] });
  }
  hubStatus(): Promise<HubStatusReply> {
    return this.run("hubStatus", undefined, this.handlers.hubStatus, { services: [] });
  }
  hubStart(body: HubStartBody): Promise<HubStartReply> {
    return this.run("hubStart", body, this.handlers.hubStart ? () => this.handlers.hubStart!(body) : undefined, { service: body.service, started: true, message: "started" });
  }
  flowEstimate(body: FlowEstimateBody): Promise<FlowEstimateReply> {
    return this.run("flowEstimate", body, this.handlers.flowEstimate ? () => this.handlers.flowEstimate!(body) : undefined, { credits: 23, videoCredits: 18, reserve: 5, runDir: "runs/x/video" });
  }
  async answerPermission(decision: PermissionDecision): Promise<void> {
    this.calls.push({ method: "answerPermission", arg: decision });
    if (this.state !== "online") throw new FakeOfflineError();
    this.decisions.push(decision);
  }

  onJobEvent(cb: (e: JobEvent) => void): Unsubscribe {
    this.events.add(cb);
    return () => this.events.delete(cb);
  }
  onPermissionRequest(cb: (r: PermissionRequest) => void): Unsubscribe {
    this.perms.add(cb);
    return () => this.perms.delete(cb);
  }
  onJobDone(cb: (d: JobDone) => void): Unsubscribe {
    this.dones.add(cb);
    return () => this.dones.delete(cb);
  }
  onStateChange(cb: (s: JobRunnerConnectionState) => void): Unsubscribe {
    this.states.add(cb);
    return () => this.states.delete(cb);
  }
}

/** Records every card; answers from a queue (default: the user approves at once). */
export class FakeJobApprovalTransport implements JobApprovalTransport {
  readonly jobCards: JobApprovalCard[] = [];
  readonly hubCards: HubStartCard[] = [];
  readonly permissionRequests: PermissionRequest[] = [];
  readonly progress: JobProgressUpdate[] = [];
  readonly finals: { done: JobDone; conversationId: string }[] = [];
  /** Answers consumed in order by `requestJobApproval` and `requestHubStartApproval`. */
  approvals: Partial<JobApprovalDecision>[] = [];
  /** Answers consumed in order by `requestPermission`. */
  permissionAnswers: Partial<PermissionDecision>[] = [];

  private nextApproval(): JobApprovalDecision {
    const p = this.approvals.shift() ?? {};
    return { approved: true, by: "user", userId: 1, at: Date.now(), ...p };
  }

  async requestJobApproval(card: JobApprovalCard): Promise<JobApprovalDecision> {
    this.jobCards.push(card);
    return this.nextApproval();
  }
  async requestHubStartApproval(card: HubStartCard): Promise<JobApprovalDecision> {
    this.hubCards.push(card);
    return this.nextApproval();
  }
  async requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    this.permissionRequests.push(req);
    const p = this.permissionAnswers.shift() ?? {};
    return { requestId: req.requestId, jobId: req.jobId, answer: "deny", by: "user", userId: 1, at: Date.now(), ...p };
  }
  async postProgress(update: JobProgressUpdate): Promise<void> {
    this.progress.push(update);
  }
  async postFinal(done: JobDone, conversationId: string): Promise<void> {
    this.finals.push({ done, conversationId });
  }
}
