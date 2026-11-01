/**
 * The job manager: the core that sits between the IPC handler (server.ts) and the engine drivers (S12 claude, S13 dsh,
 * and the built-in `hub` driver). It is the only place that turns a signed `submit` into a running job.
 *
 * DRIVER CONTRACT (what S12 and S13 build against; the types are `EngineDriver`, `EngineStartSpec`, `EngineHost` in
 * src/jobs/contracts.ts):
 *   - `version()` is called once per job, before `start`/`resume`; the string is journaled and shown in `status`.
 *   - `start(spec)` / `resume(spec)` begin the job; `events(jobId)` is then iterated until it ends.
 *   - The CORE owns `seq` and `ts`: it renumbers every event from 1, gapless, and ignores the driver's own `seq`/`ts`.
 *   - A driver's `state` event with a TERMINAL state (`succeeded`, `failed`, `cancelled`) ends the job; other `state`
 *     events are ignored (the core emits `running`, `cancelling`, `interrupted`). The core emits the final events itself,
 *     in the order the contract promises: the driver's `result` (or one it makes up), then the terminal `state`.
 *   - The driver's own `flow_call` events are dropped: the core emits them when the policy decides on a Flow tool call.
 *   - When the stream ends with no terminal `state` event, the job is `failed`.
 *   - `cancel(jobId)` should stop the child (tree kill). The core waits `limits.cancelGraceSec`, then kills the reported
 *     child PID's tree itself and finishes the job regardless of the driver.
 *   - Optional, discovered at run time: the `host` passed in the spec is a `CoreEngineHost`: `reportChildPid(pid)` (so the
 *     journal records the child and the grace kill can reach it) and `channel` (the per-job token and the loopback port
 *     for the permission helper, I28). A driver that does not know them works without them.
 *   - For a tool use that needs the user, the driver asks `host.policy` first and, on `ask`, calls `host.askPermission`.
 *     The helper path (Claude's `--permission-prompt-tool`) needs none of that: the core applies the policy itself.
 */
import { randomBytes } from "node:crypto";
import type { Logger } from "../contracts.js";
import { IpcKey } from "../ipc/hmac.js";
import { IpcHandlerError } from "../ipc/server.js";
import type {
  CancelBody,
  CancelReply,
  EngineDriver,
  EngineHost,
  EngineStatus,
  FlowEstimateBody,
  FlowEstimateReply,
  HubStartBody,
  HubStartReply,
  HubStatusReply,
  JobDone,
  JobEngine,
  JobEvent,
  JobRef,
  JobSnapshot,
  JobState,
  JobTemplate,
  JobRunnerPolicy,
  ListTemplatesReply,
  PermissionDecider,
  PermissionDecision,
  PermissionHelperReply,
  PermissionHelperRequest,
  PermissionRequest,
  StatusBody,
  StatusReply,
  SubmitBody,
  SubmitReply,
  TerminalJobState,
} from "../jobs/contracts.js";
import { JOB_ENGINES, isTerminalJobState } from "../jobs/contracts.js";
import { redactDeep } from "../logging/redact.js";
import type { Redactor } from "../logging/redact.js";
import { sha256Hex } from "./audit.js";
import type { JobAuditLog } from "./audit.js";
import { checkCwd } from "./cwd.js";
import { FlowEstimateRefused, runVideoPlanEstimate } from "./flowEstimate.js";
import type { CwdCheck } from "./cwd.js";
import { SCRIPTORIUM, HubError } from "./hub.js";
import type { HubRunner } from "./hub.js";
import { Journal, applyEntry, newRecord } from "./journal.js";
import type { JobRecord, JournalEntry } from "./journal.js";
import { Limits } from "./limits.js";
import type { EventBody, JobRunnerConfig, OutputBudget } from "./limits.js";
import { CorePolicy, kindOfTool } from "./policy.js";
import { isProcessAlive, killProcessTree } from "./proc.js";
import { TemplateRegistry, renderPrompt, templateEnabledByDefault, validateParams } from "./templates.js";

// ---- what the core hands to drivers, beyond contracts.ts (all optional for a driver) ------------------

/** The per-job channel for the permission helper (I28): the loopback port and the token that signs its requests. */
export interface JobChannel {
  host: "127.0.0.1";
  port: number;
  jobId: string;
  /** base64url, 32 bytes. Written only into the job-scoped mcp-config file; never logged. */
  token: string;
}

export interface CoreEngineHost extends EngineHost {
  readonly jobId: string;
  /** Tell the core the child's PID (journaled; used by the grace kill after a cancel). */
  reportChildPid(pid: number): void;
  /** Absent for engines without a helper (hub). */
  readonly channel: JobChannel | undefined;
}

/** The per-job keys the IPC server accepts for `permission_request` (I28). */
export class JobKeyRegistry {
  private readonly keys = new Map<string, IpcKey>();
  add(jobId: string, key: IpcKey): void {
    this.keys.set(jobId, key);
  }
  remove(jobId: string): void {
    this.keys.delete(jobId);
  }
  get(jobId: string): IpcKey | undefined {
    return this.keys.get(jobId);
  }
  get size(): number {
    return this.keys.size;
  }
}

/** Where the manager pushes things for the agent (the server broadcasts them to the `main` connections). */
export interface JobNotifier {
  event(e: JobEvent): void;
  permission(r: PermissionRequest): void;
  done(d: JobDone): void;
}

export interface JobManagerOptions {
  config: JobRunnerConfig;
  templates: () => TemplateRegistry;
  journal: Journal;
  audit: JobAuditLog;
  hub: HubRunner;
  drivers: Partial<Record<JobEngine, EngineDriver>>;
  logger: Logger;
  redact: Redactor;
  jobKeys: JobKeyRegistry;
  /** The IPC port the helper connects to. */
  channelPort: () => number;
  now?: () => number;
  /** Test seams. */
  checkCwd?: (cwd: string) => CwdCheck;
  /** The deny paths read at each job start (S18.3): the job runner's own list plus `security.json` `folders.deny`. A throw fails closed. */
  denyPaths?: () => readonly string[];
  killTree?: (pid: number) => Promise<boolean>;
  /** Runs the read-only Flow estimator (S14.4); default: `scripts/video-plan.mjs estimate` in the template's cwd. */
  runFlowEstimate?: (cwd: string, runDir: unknown) => Promise<FlowEstimateReply>;
  isAlive?: (pid: number) => boolean;
  runnerVersion?: string;
  retentionDays?: number;
}

interface PendingPermission {
  req: PermissionRequest;
  resolve: (d: PermissionDecision) => void;
  timer: NodeJS.Timeout;
}

interface Active {
  rec: JobRecord;
  template: JobTemplate;
  driver: EngineDriver;
  cwd: string;
  resume: boolean;
  budget: OutputBudget;
  pending: Map<string, PendingPermission>;
  forced: Promise<void>;
  forceStop: () => void;
  timer: NodeJS.Timeout | undefined;
  graceTimer: NodeJS.Timeout | undefined;
  cancelRequested: { reason: string; by: string } | undefined;
  timedOut: boolean;
  outputExceeded: boolean;
  shuttingDown: boolean;
  finished: boolean;
  driverTerminal: { state: TerminalJobState; detail?: string } | undefined;
  result: Extract<EventBody, { kind: "result" }> | undefined;
  done: Promise<void>;
}

const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const FORCED: unique symbol = Symbol("forced");

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stripEvent(e: JobEvent): EventBody {
  const { jobId: _j, seq: _s, ts: _t, ...body } = e;
  void _j;
  void _s;
  void _t;
  return body as EventBody;
}

export class JobManager {
  readonly policy: JobRunnerPolicy;
  readonly limits: Limits;
  private readonly now: () => number;
  private readonly records = new Map<string, JobRecord>();
  private readonly active = new Map<string, Active>();
  private readonly queues: Record<JobEngine, string[]> = { claude: [], dsh: [], hub: [] };
  private readonly versions: Partial<Record<JobEngine, string>> = {};
  private notifier: JobNotifier | undefined;
  private stopping = false;
  private readonly startedAt: number;
  private readonly cwdCheck: (cwd: string) => CwdCheck;
  private readonly killTree: (pid: number) => Promise<boolean>;
  private readonly isAlive: (pid: number) => boolean;

  constructor(private readonly o: JobManagerOptions) {
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
    this.limits = new Limits(o.config, this.now);
    this.cwdCheck =
      o.checkCwd ??
      ((cwd) => {
        let deny: readonly string[];
        try {
          deny = (o.denyPaths ?? (() => o.config.denyPaths))();
        } catch (e) {
          // Fail closed: if the deny list cannot be read or is invalid, no new job starts.
          return { ok: false, reason: `the deny paths could not be read (${errMsg(e)}); new jobs are refused until security.json is fixed` };
        }
        return checkCwd(cwd, { allowlist: o.config.cwdAllowlist, denyPaths: deny });
      });
    this.killTree = o.killTree ?? killProcessTree;
    this.isAlive = o.isAlive ?? isProcessAlive;
    this.policy = new CorePolicy({
      flowServerId: o.config.flow.serverId,
      getJob: (jobId) => {
        const a = this.active.get(jobId);
        if (!a || a.finished) return undefined;
        return { flowEnabled: a.template.flow.enabled, flowBudget: a.rec.flowBudgetCredits, flowCharged: a.rec.flowCharged };
      },
      chargeFlow: (jobId, credits) => {
        const a = this.active.get(jobId);
        if (!a) return 0;
        const total = a.rec.flowCharged + credits;
        this.record(a.rec, { t: "flow", at: this.now(), jobId, charged: total });
        return total;
      },
      onFlowCall: (jobId, info) => {
        const a = this.active.get(jobId);
        if (!a) return;
        this.emit(a.rec, { kind: "flow_call", ...info });
        this.auditSafe({ event: "flow_call", ts: this.iso(), jobId, ...info });
      },
    });
  }

  setNotifier(n: JobNotifier): void {
    this.notifier = n;
  }

  // ---- startup and shutdown ---------------------------------------------------------------------

  /**
   * Replays the journal. Jobs that were `running` become `interrupted` (the agent decides whether to resume, S14.1); a job
   * that was `cancelling` is finished as `cancelled`; `queued` jobs go back into their queue and start when a slot is free.
   * An old child PID is only recorded and reported, never killed: after a restart the PID may belong to another process.
   */
  recover(): void {
    const { records, corruptLines } = this.o.journal.replay();
    if (corruptLines > 0) this.o.logger.warn("jobrunner.journal_corrupt_lines", { count: corruptLines });
    const keep = this.o.journal.prune(records.values(), this.now(), this.o.retentionDays ?? 30);
    for (const id of keep) records.delete(id);
    for (const rec of [...records.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      this.records.set(rec.jobId, rec);
      if (isTerminalJobState(rec.state)) continue;
      if (rec.state === "queued") {
        this.queues[rec.engine].push(rec.jobId);
      } else if (rec.state === "cancelling") {
        this.finishWithoutRun(rec, "cancelled", "the job runner restarted while the job was being cancelled");
      } else if (rec.state === "running") {
        const orphan = rec.pid !== undefined && this.isAlive(rec.pid);
        if (orphan) this.o.logger.warn("jobrunner.orphan_possible", { jobId: rec.jobId, pid: rec.pid });
        this.emit(rec, { kind: "state", state: "interrupted", detail: "the job runner restarted" });
        this.auditSafe({ event: "interrupted", ts: this.iso(), jobId: rec.jobId, reason: "the job runner restarted", ...(rec.pid !== undefined ? { pid: rec.pid } : {}) });
      }
    }
    this.pump();
  }

  /** Stops every running job (they become `interrupted`, resumable) and keeps the queue in the journal. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const acts = [...this.active.values()];
    for (const a of acts) {
      a.shuttingDown = true;
      try {
        await a.driver.cancel(a.rec.jobId);
      } catch {
        /* the tree kill below is the backstop */
      }
      if (a.rec.pid !== undefined) await this.killTree(a.rec.pid).catch(() => false);
      a.forceStop();
    }
    await Promise.race([Promise.all(acts.map((a) => a.done)), new Promise((r) => setTimeout(r, 5000).unref())]);
  }

  /** Resolves when no job is running (tests). Queued jobs that start meanwhile are waited for too. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()].map((a) => a.done));
  }

  // ---- the IPC operations -------------------------------------------------------------------------

  listTemplates(): ListTemplatesReply {
    const reg = this.o.templates();
    return { templates: reg.all().map((t) => reg.summary(t, this.templateEnabled(t))) };
  }

  async submit(body: SubmitBody): Promise<SubmitReply> {
    const existing = this.records.get(body.jobId);
    if (existing) return this.submitExisting(existing, body);
    if (body.resume === true) throw new IpcHandlerError("not_found", "there is no such job to resume");

    const req = body.request;
    const refuse = (code: ConstructorParameters<typeof IpcHandlerError>[0], reason: string): never => {
      this.auditSafe({ event: "rejected", ts: this.iso(), jobId: body.jobId, templateId: req.templateId, code, reason });
      throw new IpcHandlerError(code, reason);
    };
    const tpl = this.o.templates().get(req.templateId);
    if (!tpl) return refuse("unknown_template", `unknown template "${req.templateId}"`);
    if (!this.templateEnabled(tpl)) return refuse("engine_disabled", `the template "${tpl.id}" is disabled (${this.disabledWhy(tpl)})`);
    if (tpl.engine === "hub" && tpl.hubService === SCRIPTORIUM) return refuse("forbidden", "scriptorium can only be started with hub_start and its own approval");
    const params = validateParams(tpl.params, req.params);
    if (!params.ok) return refuse("invalid_params", params.errors.join("; "));
    let prompt: string;
    try {
      prompt = renderPrompt(tpl, params.value, req.brief);
    } catch (e) {
      return refuse("invalid_params", errMsg(e));
    }
    void prompt;
    const cwd = this.cwdCheck(tpl.cwd);
    if (!cwd.ok) return refuse("cwd_refused", cwd.reason);
    const limit = this.limits.checkSubmit({ template: tpl, flowBudgetCredits: body.flowBudgetCredits, usage: this.limits.usageToday(this.records.values()) });
    if (!limit.ok) return refuse(limit.code as "limit_exceeded" | "bad_request", limit.message);

    // audit first (fail closed): no audit line, no job
    try {
      this.o.audit.write({
        event: "submitted",
        ts: this.iso(),
        jobId: body.jobId,
        templateId: tpl.id,
        engine: tpl.engine,
        cwd: cwd.cwd,
        params: params.value,
        briefChars: req.brief.length,
        briefSha256: sha256Hex(req.brief),
        approvalUserId: body.approval.userId,
        approvedAt: body.approval.at,
        ...(body.flowBudgetCredits !== undefined ? { flowBudgetCredits: body.flowBudgetCredits } : {}),
      });
    } catch (e) {
      this.o.logger.error("jobrunner.audit_failed", { error: errMsg(e) });
      throw new IpcHandlerError("internal", "the audit log could not be written, so the job was not accepted");
    }
    const entry: Extract<JournalEntry, { t: "job" }> = {
      t: "job",
      at: this.now(),
      jobId: body.jobId,
      templateId: tpl.id,
      engine: tpl.engine,
      request: { templateId: req.templateId, params: params.value, brief: req.brief },
      approval: body.approval,
      cwd: cwd.cwd,
      ...(body.flowBudgetCredits !== undefined && body.flowBudgetCredits > 0 ? { flowBudgetCredits: body.flowBudgetCredits } : {}),
    };
    try {
      this.o.journal.append(entry);
    } catch (e) {
      this.o.logger.error("jobrunner.journal_failed", { error: errMsg(e) });
      throw new IpcHandlerError("internal", "the journal could not be written, so the job was not accepted");
    }
    const rec = newRecord(entry);
    this.records.set(rec.jobId, rec);
    this.emit(rec, { kind: "state", state: "queued" });
    this.queues[rec.engine].push(rec.jobId);
    this.pump();
    return this.replyFor(rec, false);
  }

  private submitExisting(rec: JobRecord, body: SubmitBody): SubmitReply {
    if (body.resume !== true || rec.state !== "interrupted") return this.replyFor(rec, true);
    const refuse = (code: ConstructorParameters<typeof IpcHandlerError>[0], reason: string): never => {
      this.auditSafe({ event: "rejected", ts: this.iso(), jobId: rec.jobId, templateId: rec.templateId, code, reason });
      throw new IpcHandlerError(code, reason);
    };
    const tpl = this.o.templates().get(rec.templateId);
    if (!tpl) return refuse("unknown_template", `the template "${rec.templateId}" no longer exists`);
    if (!this.templateEnabled(tpl)) return refuse("engine_disabled", `the template "${tpl.id}" is disabled (${this.disabledWhy(tpl)})`);
    if (rec.engineSessionId === undefined) return refuse("unsupported", "no engine session was recorded for this job, so it cannot be resumed");
    const cwd = this.cwdCheck(tpl.cwd);
    if (!cwd.ok) return refuse("cwd_refused", cwd.reason);
    try {
      this.o.audit.write({ event: "resumed", ts: this.iso(), jobId: rec.jobId, approvalUserId: body.approval.userId });
    } catch (e) {
      this.o.logger.error("jobrunner.audit_failed", { error: errMsg(e) });
      throw new IpcHandlerError("internal", "the audit log could not be written, so the job was not resumed");
    }
    this.record(rec, { t: "resume", at: this.now(), jobId: rec.jobId, count: rec.resumeCount + 1 });
    this.resumeIds.add(rec.jobId);
    this.emit(rec, { kind: "state", state: "queued", detail: "resume" });
    this.queues[rec.engine].push(rec.jobId);
    this.pump();
    return this.replyFor(rec, false);
  }
  private readonly resumeIds = new Set<string>();

  cancel(body: CancelBody): CancelReply {
    const rec = this.records.get(body.jobId);
    if (!rec) throw new IpcHandlerError("not_found", "there is no such job");
    if (isTerminalJobState(rec.state)) return { jobId: rec.jobId, state: rec.state };
    const reason = body.reason?.slice(0, 200) || "cancelled by the agent";
    const act = this.active.get(rec.jobId);
    if (act) {
      this.requestCancel(act, reason, "agent");
      return { jobId: rec.jobId, state: rec.state };
    }
    // queued or interrupted: nothing runs, so it ends here
    this.queues[rec.engine] = this.queues[rec.engine].filter((id) => id !== rec.jobId);
    this.auditSafe({ event: "cancelled", ts: this.iso(), jobId: rec.jobId, reason, by: "agent" });
    this.finishWithoutRun(rec, "cancelled", reason);
    return { jobId: rec.jobId, state: rec.state };
  }

  status(body: StatusBody): StatusReply {
    const usage = this.limits.usageToday(this.records.values());
    const engines: StatusReply["engines"] = {};
    for (const e of JOB_ENGINES) engines[e] = this.engineStatus(e);
    const base = {
      runner: { version: this.o.runnerVersion ?? "0.1.0", startedAt: this.startedAt, now: this.now() },
      engines,
      daily: { jobs: usage.jobs, jobCap: this.o.config.limits.dailyJobCap, credits: usage.credits, creditCap: this.o.config.limits.dailyCreditCap },
    };
    if (body.jobId !== undefined) {
      const rec = this.records.get(body.jobId);
      if (!rec) throw new IpcHandlerError("not_found", "there is no such job");
      const reply: StatusReply = { ...base, jobs: [this.snapshot(rec)] };
      if (body.sinceSeq !== undefined) reply.events = this.eventsSince(rec, body.sinceSeq);
      return reply;
    }
    const weekAgo = this.now() - 7 * 86_400_000;
    const jobs = [...this.records.values()]
      .filter((r) => !isTerminalJobState(r.state) || (r.finishedAt ?? r.createdAt) >= weekAgo)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 200)
      .map((r) => this.snapshot(r));
    return { ...base, jobs };
  }

  /** At most ~900 KB of events per reply (an IPC line is limited to 1 MiB); the agent asks again with a later `sinceSeq`. */
  private eventsSince(rec: JobRecord, sinceSeq: number): JobEvent[] {
    const out: JobEvent[] = [];
    let bytes = 0;
    for (const e of rec.events) {
      if (e.seq <= sinceSeq) continue;
      bytes += Buffer.byteLength(JSON.stringify(e), "utf8");
      if (bytes > 900_000 && out.length > 0) break;
      out.push(e);
    }
    return out;
  }

  hubStatus(): Promise<HubStatusReply> {
    return this.o.hub.status();
  }

  async hubStart(body: HubStartBody): Promise<HubStartReply> {
    const scriptorium = body.service === SCRIPTORIUM;
    const base = { service: body.service, approvalUserId: body.approval.userId, scriptorium };
    if (!this.o.config.engines.hub.enabled) {
      this.auditSafe({ event: "hub_start", ts: this.iso(), ...base, outcome: "refused", detail: "hub is disabled" });
      throw new IpcHandlerError("engine_disabled", "hub_start is disabled in jobrunner.json");
    }
    try {
      this.o.audit.write({ event: "hub_start", ts: this.iso(), ...base, outcome: "requested" });
    } catch (e) {
      this.o.logger.error("jobrunner.audit_failed", { error: errMsg(e) });
      throw new IpcHandlerError("internal", "the audit log could not be written, so nothing was started");
    }
    try {
      const r = await this.o.hub.start(body.service, { scriptoriumApproved: body.scriptoriumApproved });
      this.auditSafe({ event: "hub_start", ts: this.iso(), ...base, outcome: r.alreadyUp ? "already_up" : r.started ? "started" : "failed", detail: r.message });
      return r;
    } catch (e) {
      if (e instanceof HubError) {
        this.auditSafe({ event: "hub_start", ts: this.iso(), ...base, outcome: "refused", detail: e.message });
        throw new IpcHandlerError(e.code, e.message);
      }
      this.o.logger.error("jobrunner.hub_start_failed", { error: errMsg(e) });
      this.auditSafe({ event: "hub_start", ts: this.iso(), ...base, outcome: "failed", detail: errMsg(e) });
      throw new IpcHandlerError("internal", "the hub command failed");
    }
  }

  /**
   * The live Flow estimate (S14.4): read only. Only a template with `flow.estimator: "video-plan"` and a cwd the allowlist
   * accepts; it runs a fixed script with a validated run folder (`flowEstimate.ts`) and starts no job, spends no credit.
   */
  async flowEstimate(body: FlowEstimateBody): Promise<FlowEstimateReply> {
    const tpl = this.o.templates().get(body.templateId);
    if (!tpl) throw new IpcHandlerError("unknown_template", `unknown template "${body.templateId}"`);
    if (!this.templateEnabled(tpl)) throw new IpcHandlerError("engine_disabled", `the template "${tpl.id}" is disabled (${this.disabledWhy(tpl)})`);
    if (!tpl.flow.enabled || tpl.flow.estimator !== "video-plan") throw new IpcHandlerError("unsupported", `the template "${tpl.id}" has no video-plan estimator`);
    const params = validateParams(tpl.params, body.params);
    if (!params.ok) throw new IpcHandlerError("invalid_params", params.errors.join("; "));
    const cwd = this.cwdCheck(tpl.cwd);
    if (!cwd.ok) throw new IpcHandlerError("cwd_refused", cwd.reason);
    try {
      const r = await (this.o.runFlowEstimate ?? runVideoPlanEstimate)(cwd.cwd, params.value["runDir"]);
      this.o.logger.info("jobrunner.flow_estimate", { templateId: tpl.id, runDir: r.runDir, credits: r.credits });
      return r;
    } catch (e) {
      if (e instanceof FlowEstimateRefused) throw new IpcHandlerError(e.code, e.message);
      this.o.logger.error("jobrunner.flow_estimate_failed", { error: errMsg(e) });
      throw new IpcHandlerError("internal", "the Flow estimate could not be run");
    }
  }

  // ---- permissions ----------------------------------------------------------------------------------

  /** The agent's `permission_decision` (no reply). A decision for an unknown job or request is ignored with a warning. */
  decidePermission(d: PermissionDecision): void {
    const act = this.active.get(d.jobId);
    const pending = act?.pending.get(d.requestId);
    if (!act || !pending) {
      this.o.logger.warn("jobrunner.permission_decision_ignored", { jobId: d.jobId, requestId: d.requestId });
      return;
    }
    const by: PermissionDecider = (["user", "timeout", "cancel", "stop", "restart", "policy"] as const).includes(d.by) ? d.by : "user";
    this.settlePermission(act, pending, { requestId: d.requestId, jobId: d.jobId, answer: d.answer === "allow_once" ? "allow_once" : "deny", by, at: this.now(), ...(d.userId !== undefined ? { userId: d.userId } : {}), ...(d.message !== undefined ? { message: String(d.message).slice(0, 200) } : {}) });
  }

  /** The permission helper's request (S12.3), already authenticated with the per-job token of `principalJobId`. */
  async handleHelperPermission(req: PermissionHelperRequest, principalJobId: string): Promise<PermissionHelperReply> {
    if (req.jobId !== principalJobId) throw new IpcHandlerError("forbidden", "the token belongs to another job");
    const act = this.active.get(req.jobId);
    if (!act || act.finished) throw new IpcHandlerError("forbidden", "the job is not running");
    if (typeof req.tool !== "string" || req.tool === "" || req.tool.length > 300) throw new IpcHandlerError("bad_request", "tool is required");
    if (typeof req.requestId !== "string" || !REQUEST_ID.test(req.requestId)) throw new IpcHandlerError("bad_request", "requestId is required");
    const ref = this.jobRef(act);
    const verdict = await this.policy.checkPermission(ref, req.tool, req.input);
    if (verdict === "deny") return { decision: "deny", message: "denied by the job runner's own rules" };
    if (verdict === "allow") return { decision: "allow_once" };
    const kind = kindOfTool(req.tool, this.o.config.flow.serverId);
    const d = await this.askPermission(act, {
      requestId: req.requestId,
      jobId: act.rec.jobId,
      engine: act.rec.engine,
      tool: req.tool,
      input: req.input,
      cwd: act.cwd,
      kind,
      summary: this.summarize(req.tool, req.input),
      requestedAt: this.now(),
      timeoutSec: this.o.config.limits.permissionTimeoutSec,
    });
    return d.message !== undefined ? { decision: d.answer, message: d.message } : { decision: d.answer };
  }

  private askPermission(act: Active, req: PermissionRequest): Promise<PermissionDecision> {
    const deny = (by: PermissionDecider, message: string): PermissionDecision => ({ requestId: req.requestId, jobId: act.rec.jobId, answer: "deny", by, at: this.now(), message });
    if (act.finished || act.cancelRequested || act.shuttingDown) return Promise.resolve(deny("cancel", "the job is ending"));
    const full: PermissionRequest = {
      ...req,
      jobId: act.rec.jobId,
      engine: act.rec.engine,
      cwd: act.cwd,
      requestedAt: this.now(),
      timeoutSec: this.o.config.limits.permissionTimeoutSec,
    };
    // defence in depth: whatever a driver asks, a shell is never offered to the user
    if (full.kind === "execute") {
      this.auditSafe({ event: "permission_asked", ts: this.iso(), jobId: full.jobId, requestId: full.requestId, tool: full.tool, kind: full.kind, inputSha256: sha256Hex(JSON.stringify(full.input) ?? "") });
      const d = deny("policy", "shell commands are not allowed in a job");
      this.auditSafe({ event: "permission_decided", ts: this.iso(), jobId: full.jobId, requestId: full.requestId, answer: "deny", by: "policy" });
      return Promise.resolve(d);
    }
    if (!REQUEST_ID.test(full.requestId) || act.pending.has(full.requestId)) return Promise.resolve(deny("policy", "duplicate or invalid request id"));
    try {
      this.o.audit.write({ event: "permission_asked", ts: this.iso(), jobId: full.jobId, requestId: full.requestId, tool: full.tool, kind: full.kind, inputSha256: sha256Hex(JSON.stringify(full.input) ?? ""), ...(full.summary !== undefined ? { summary: full.summary } : {}) });
    } catch (e) {
      this.o.logger.error("jobrunner.audit_failed", { error: errMsg(e) });
      return Promise.resolve(deny("policy", "the audit log could not be written"));
    }
    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        const p = act.pending.get(full.requestId);
        if (p) this.settlePermission(act, p, deny("timeout", "no answer in time"));
      }, full.timeoutSec * 1000);
      timer.unref();
      act.pending.set(full.requestId, { req: full, resolve, timer });
      try {
        this.notifier?.permission(full);
      } catch (e) {
        this.o.logger.warn("jobrunner.notify_failed", { error: errMsg(e) });
      }
    });
  }

  private settlePermission(act: Active, p: PendingPermission, d: PermissionDecision): void {
    if (act.pending.get(p.req.requestId) !== p) return;
    act.pending.delete(p.req.requestId);
    clearTimeout(p.timer);
    this.auditSafe({ event: "permission_decided", ts: this.iso(), jobId: act.rec.jobId, requestId: p.req.requestId, answer: d.answer, by: d.by, ...(d.userId !== undefined ? { userId: d.userId } : {}) });
    p.resolve(d);
  }

  private summarize(tool: string, input: unknown): string {
    let text = "";
    try {
      text = JSON.stringify(input) ?? "";
    } catch {
      text = "";
    }
    return this.o.redact(`${tool} ${text}`.slice(0, 300));
  }

  // ---- queue and run -----------------------------------------------------------------------------

  private runningCount(engine: JobEngine): number {
    let n = 0;
    for (const a of this.active.values()) if (a.rec.engine === engine) n++;
    return n;
  }

  private pump(): void {
    if (this.stopping) return;
    for (const engine of JOB_ENGINES) {
      const q = this.queues[engine];
      while (q.length > 0 && this.runningCount(engine) < this.limits.maxConcurrent(engine)) {
        const id = q.shift();
        const rec = id === undefined ? undefined : this.records.get(id);
        if (!rec || rec.state !== "queued") continue;
        this.launch(rec);
      }
    }
  }

  private launch(rec: JobRecord): void {
    const template = this.o.templates().get(rec.templateId);
    const driver = this.o.drivers[rec.engine];
    if (!template) return this.finishWithoutRun(rec, "failed", `the template "${rec.templateId}" no longer exists`);
    if (!driver) return this.finishWithoutRun(rec, "failed", `no driver is installed for the ${rec.engine} engine`);
    const cwd = this.cwdCheck(template.cwd);
    if (!cwd.ok) return this.finishWithoutRun(rec, "failed", `the cwd was refused: ${cwd.reason}`);

    let forceStop: () => void = () => undefined;
    const forced = new Promise<void>((r) => (forceStop = r));
    const resume = this.resumeIds.delete(rec.jobId);
    const act: Active = {
      rec,
      template,
      driver,
      cwd: cwd.cwd,
      resume,
      budget: this.limits.newOutputBudget(),
      pending: new Map(),
      forced,
      forceStop,
      timer: undefined,
      graceTimer: undefined,
      cancelRequested: undefined,
      timedOut: false,
      outputExceeded: false,
      shuttingDown: false,
      finished: false,
      driverTerminal: undefined,
      result: undefined,
      done: Promise.resolve(),
    };
    this.active.set(rec.jobId, act);
    this.emit(rec, { kind: "state", state: "running", ...(resume ? { detail: "resumed" } : {}) });
    const timeoutMs = this.limits.timeoutMs(template);
    act.timer = setTimeout(() => {
      act.timedOut = true;
      this.requestCancel(act, `timed out after ${Math.round(timeoutMs / 60000)} min`, "timeout");
    }, timeoutMs);
    act.timer.unref();
    act.done = this.run(act);
  }

  private async run(act: Active): Promise<void> {
    const { rec, driver } = act;
    let failure: string | undefined;
    try {
      let version: string;
      try {
        version = await driver.version();
      } catch (e) {
        throw new Error(`cannot read the ${rec.engine} version: ${errMsg(e)}`);
      }
      this.versions[rec.engine] = version;
      this.record(rec, { t: "version", at: this.now(), jobId: rec.jobId, engineVersion: version });
      this.auditSafe({ event: "started", ts: this.iso(), jobId: rec.jobId, engine: rec.engine, engineVersion: version, resumed: act.resume });

      let channel: JobChannel | undefined;
      if (rec.engine !== "hub") {
        const token = randomBytes(32).toString("base64url");
        this.o.jobKeys.add(rec.jobId, IpcKey.fromBase64Url(token));
        channel = { host: "127.0.0.1", port: this.o.channelPort(), jobId: rec.jobId, token };
      }
      const host: CoreEngineHost = {
        policy: this.policy,
        jobId: rec.jobId,
        channel,
        askPermission: (req) => this.askPermission(act, req),
        reportChildPid: (pid) => {
          if (Number.isInteger(pid) && pid > 0) this.record(rec, { t: "pid", at: this.now(), jobId: rec.jobId, pid });
        },
      };
      const spec = {
        jobId: rec.jobId,
        template: act.template,
        params: rec.request.params,
        brief: rec.request.brief,
        prompt: renderPrompt(act.template, rec.request.params, rec.request.brief),
        cwd: act.cwd,
        ...(rec.flowBudgetCredits !== undefined ? { flowBudgetCredits: rec.flowBudgetCredits } : {}),
        host: host as EngineHost,
      };
      if (!act.cancelRequested && !act.shuttingDown) {
        const startP = act.resume && rec.engineSessionId !== undefined ? driver.resume({ ...spec, engineSessionId: rec.engineSessionId }) : driver.start(spec);
        startP.catch(() => undefined);
        const r = await Promise.race([startP.then(() => undefined), act.forced.then((): typeof FORCED => FORCED)]);
        if (r !== FORCED) await this.consume(act);
      }
    } catch (e) {
      failure = errMsg(e);
    }
    this.finish(act, failure);
  }

  private async consume(act: Active): Promise<void> {
    const it = act.driver.events(act.rec.jobId)[Symbol.asyncIterator]();
    for (;;) {
      const next = await Promise.race([it.next(), act.forced.then((): typeof FORCED => FORCED)]);
      if (next === FORCED) {
        void Promise.resolve(it.return?.()).catch(() => undefined);
        return;
      }
      if (next.done) return;
      this.onDriverEvent(act, next.value);
    }
  }

  private onDriverEvent(act: Active, e: JobEvent): void {
    if (act.driverTerminal || act.finished) return; // nothing after the terminal state counts
    switch (e.kind) {
      case "state":
        if (isTerminalJobState(e.state)) act.driverTerminal = { state: e.state, ...(e.detail !== undefined ? { detail: e.detail } : {}) };
        return;
      case "flow_call":
        return;
      default: {
        const admitted = act.budget.admit(stripEvent(e));
        if (admitted.event?.kind === "result") {
          act.result = admitted.event;
          return;
        }
        if (admitted.event) this.emit(act.rec, admitted.event);
        if (admitted.exceeded && !act.outputExceeded) {
          act.outputExceeded = true;
          this.requestCancel(act, "the output cap was reached", "output_cap");
        }
      }
    }
  }

  private requestCancel(act: Active, reason: string, by: string): void {
    if (act.cancelRequested || act.finished) return;
    act.cancelRequested = { reason, by };
    this.auditSafe({ event: "cancelled", ts: this.iso(), jobId: act.rec.jobId, reason, by });
    if (act.rec.state === "running") this.emit(act.rec, { kind: "state", state: "cancelling", detail: reason });
    for (const p of [...act.pending.values()]) this.settlePermission(act, p, { requestId: p.req.requestId, jobId: act.rec.jobId, answer: "deny", by: "cancel", at: this.now(), message: "the job is being cancelled" });
    void Promise.resolve()
      .then(() => act.driver.cancel(act.rec.jobId))
      .catch((e: unknown) => this.o.logger.warn("jobrunner.driver_cancel_failed", { jobId: act.rec.jobId, error: errMsg(e) }));
    act.graceTimer = setTimeout(() => {
      const pid = act.rec.pid;
      void (pid !== undefined ? this.killTree(pid) : Promise.resolve(false))
        .catch(() => false)
        .then(() => act.forceStop());
    }, this.o.config.limits.cancelGraceSec * 1000);
    act.graceTimer.unref();
  }

  private outcome(act: Active, failure: string | undefined): { state: TerminalJobState; detail?: string } {
    const d = act.driverTerminal;
    if (d?.state === "succeeded") return d;
    if (act.outputExceeded) return { state: "failed", detail: `the output cap was reached (${act.budget.bytes} bytes kept)` };
    if (act.timedOut) return { state: "failed", detail: act.cancelRequested?.reason ?? "timed out" };
    if (act.cancelRequested) return { state: "cancelled", detail: act.cancelRequested.reason };
    if (failure !== undefined) return { state: "failed", detail: failure };
    if (d) return d;
    return { state: "failed", detail: "the engine ended without a final state" };
  }

  private finish(act: Active, failure: string | undefined): void {
    if (act.finished) return;
    act.finished = true;
    if (act.timer) clearTimeout(act.timer);
    if (act.graceTimer) clearTimeout(act.graceTimer);
    const rec = act.rec;
    this.o.jobKeys.remove(rec.jobId);
    for (const p of [...act.pending.values()]) {
      act.pending.delete(p.req.requestId);
      clearTimeout(p.timer);
      p.resolve({ requestId: p.req.requestId, jobId: rec.jobId, answer: "deny", by: "cancel", at: this.now(), message: "the job ended" });
    }
    try {
      if (act.shuttingDown) {
        this.emit(rec, { kind: "state", state: "interrupted", detail: "the job runner is stopping" });
        this.auditSafe({ event: "interrupted", ts: this.iso(), jobId: rec.jobId, reason: "the job runner is stopping", ...(rec.pid !== undefined ? { pid: rec.pid } : {}) });
        return;
      }
      const out = this.outcome(act, failure);
      this.complete(rec, out.state, out.detail, act.result);
    } finally {
      this.active.delete(rec.jobId);
      this.pump();
    }
  }

  /** Ends a job that is not running (queued, interrupted, or cancelling at a restart). */
  private finishWithoutRun(rec: JobRecord, state: TerminalJobState, detail: string): void {
    this.complete(rec, state, detail, undefined);
    this.queues[rec.engine] = this.queues[rec.engine].filter((id) => id !== rec.jobId);
  }

  /** The last events (`result`, then the terminal `state`), the `JobDone`, the audit line and the push to the agent. */
  private complete(rec: JobRecord, state: TerminalJobState, detail: string | undefined, result: Extract<EventBody, { kind: "result" }> | undefined): void {
    const res: Extract<EventBody, { kind: "result" }> = result ?? { kind: "result", text: detail ?? state };
    this.emit(rec, res);
    this.emit(rec, { kind: "state", state, ...(detail !== undefined ? { detail } : {}) });
    const done: JobDone = {
      jobId: rec.jobId,
      state,
      summary: res.text.slice(0, 2000),
      artifacts: [],
      durationMs: Math.max(0, (rec.finishedAt ?? this.now()) - (rec.startedAt ?? rec.createdAt)),
    };
    if (res.costUsd !== undefined) done.costUsd = res.costUsd;
    if (rec.engineVersion !== undefined) done.engineVersion = rec.engineVersion;
    if (state === "failed" && detail !== undefined) done.error = detail;
    if (rec.flowBudgetCredits !== undefined) done.flow = { approved: rec.flowBudgetCredits, charged: rec.flowCharged };
    try {
      this.record(rec, { t: "done", at: this.now(), jobId: rec.jobId, done });
    } catch (e) {
      this.o.logger.error("jobrunner.journal_failed", { error: errMsg(e) });
      rec.done = done;
    }
    this.auditSafe({ event: "finished", ts: this.iso(), jobId: rec.jobId, state, durationMs: done.durationMs, ...(done.costUsd !== undefined ? { costUsd: done.costUsd } : {}), ...(done.error !== undefined ? { error: done.error } : {}) });
    try {
      this.notifier?.done(done);
    } catch (e) {
      this.o.logger.warn("jobrunner.notify_failed", { error: errMsg(e) });
    }
  }

  // ---- small helpers ---------------------------------------------------------------------------------

  private record(rec: JobRecord, entry: JournalEntry): void {
    this.o.journal.append(entry);
    applyEntry(rec, entry);
  }

  /** Assigns `seq` and `ts`, journals the event, keeps it for `status`, and pushes it to the agent. */
  private emit(rec: JobRecord, body: EventBody): JobEvent {
    const raw = { ...body, jobId: rec.jobId, seq: rec.lastSeq + 1, ts: this.now() } as JobEvent;
    const ev = redactDeep(raw, this.o.redact);
    this.record(rec, { t: "event", at: ev.ts, jobId: rec.jobId, event: ev });
    try {
      this.notifier?.event(ev);
    } catch (e) {
      this.o.logger.warn("jobrunner.notify_failed", { error: errMsg(e) });
    }
    return ev;
  }

  private auditSafe(event: Parameters<JobAuditLog["write"]>[0]): void {
    try {
      this.o.audit.write(event);
    } catch (e) {
      this.o.logger.error("jobrunner.audit_failed", { event: event.event, error: errMsg(e) });
    }
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private jobRef(act: Active): JobRef {
    return {
      jobId: act.rec.jobId,
      templateId: act.rec.templateId,
      engine: act.rec.engine,
      ...(act.rec.flowBudgetCredits !== undefined ? { flowBudgetCredits: act.rec.flowBudgetCredits } : {}),
      flowChargedCredits: act.rec.flowCharged,
    };
  }

  private engineEnabled(engine: JobEngine): boolean {
    const c = this.o.config.engines[engine];
    if (!c.enabled || this.o.drivers[engine] === undefined) return false;
    return engine !== "dsh" || c.verified === true;
  }

  private templateEnabled(t: JobTemplate): boolean {
    return templateEnabledByDefault(t) && this.engineEnabled(t.engine);
  }

  private disabledWhy(t: JobTemplate): string {
    if (!templateEnabledByDefault(t)) return "the template is not enabled";
    const c = this.o.config.engines[t.engine];
    if (!c.enabled) return `the ${t.engine} engine is off in jobrunner.json`;
    if (this.o.drivers[t.engine] === undefined) return `no driver is installed for the ${t.engine} engine`;
    return "dsh.verified is false: dsh has not passed the ask-first probe";
  }

  private engineStatus(engine: JobEngine): EngineStatus {
    const s: EngineStatus = { enabled: this.engineEnabled(engine), running: this.runningCount(engine), queued: this.queues[engine].length };
    const v = this.versions[engine];
    if (v !== undefined) s.version = v;
    return s;
  }

  private replyFor(rec: JobRecord, duplicate: boolean): SubmitReply {
    const reply: SubmitReply = { jobId: rec.jobId, state: rec.state, duplicate };
    if (rec.state === "queued") {
      const idx = this.queues[rec.engine].indexOf(rec.jobId);
      if (idx >= 0) reply.queuePosition = idx + 1;
    }
    return reply;
  }

  private snapshot(rec: JobRecord): JobSnapshot {
    const act = this.active.get(rec.jobId);
    const snap: JobSnapshot = {
      jobId: rec.jobId,
      templateId: rec.templateId,
      engine: rec.engine,
      state: rec.state as JobState,
      createdAt: rec.createdAt,
      lastSeq: rec.lastSeq,
      pendingPermissions: act ? [...act.pending.values()].map((p) => p.req) : [],
    };
    if (rec.startedAt !== undefined) snap.startedAt = rec.startedAt;
    if (rec.finishedAt !== undefined) snap.finishedAt = rec.finishedAt;
    if (rec.engineSessionId !== undefined) snap.engineSessionId = rec.engineSessionId;
    if (rec.engineVersion !== undefined) snap.engineVersion = rec.engineVersion;
    if (rec.flowBudgetCredits !== undefined) snap.flow = { approved: rec.flowBudgetCredits, charged: rec.flowCharged };
    if (rec.done) snap.done = rec.done;
    return snap;
  }
}
