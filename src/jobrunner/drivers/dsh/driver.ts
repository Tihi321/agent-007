/**
 * `DshDriver` (S13): the `EngineDriver` for `engine: "dsh"` templates. It drives `dsh --profile acp` as an ACP client.
 *
 * Safety (U39, S13.2, S13.3):
 *   - Every start and resume goes through the gate (gate.ts): refused with `DshRefusedError` unless `dsh.verified` is true and
 *     the stored probe evidence proves ask-first and shell-off for this dsh path and version. No process starts when refused.
 *   - The client implements no `terminal/*`, `fs/*` or elicitation methods and advertises none (session.ts).
 *   - A permission request of kind `execute` (or a tool whose name looks like a shell) is rejected without asking anyone.
 *     Anything else goes to `host.policy`, and to the user only when the policy says `ask`. Only `allow_once` and
 *     `reject_once` options are ever selected; "always" options are dropped. On cancel every pending request is answered
 *     `cancelled`.
 *   - `DEEPSEEK_API_KEY` is in the child's environment only; every string that leaves the driver goes through the redactor.
 *   - One dsh job at a time (I18; the core also queues).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { isTerminalJobState } from "../../../jobs/contracts.js";
import type {
  EngineDriver,
  EngineResumeSpec,
  EngineStartSpec,
  JobEvent,
  JobRef,
  JobState,
  PermissionRequest,
} from "../../../jobs/contracts.js";
import { createRedactor, redactDeep } from "../../../logging/redact.js";
import type { Redactor } from "../../../logging/redact.js";
import { evaluateGate } from "./gate.js";
import type { GateVerdict } from "./gate.js";
import { ACP_ARGS, buildChildEnv, buildLaunch, readDshVersion, spawnDsh } from "./launch.js";
import type { DshChild } from "./launch.js";
import { capText, mapUpdate, messageChunkText } from "./mapping.js";
import type { EventBody } from "./mapping.js";
import { CANCELLED, allowOutcome, permissionKind, rejectOutcome, toJsonInput, toolNameOf } from "./permissions.js";
import { AcpConnection } from "./session.js";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from "./session.js";
import { DshRefusedError, DshStartError, DshUnsupportedError } from "./types.js";
import type { DshDriverOptions, DshMcpServer, LaunchFn } from "./types.js";

export const CONTINUE_PROMPT =
  "Continue the task from where you stopped. Do not repeat work that is already done. Report the final result when you are finished.";
const CLIENT_VERSION = "0.1.0";
const HANDSHAKE_TIMEOUT_MS = 60_000;
const KEEP_FINISHED_RUNS = 20;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

class Run {
  readonly events: JobEvent[] = [];
  seq: number;
  private waiters: Array<() => void> = [];
  terminal = false;
  child!: DshChild;
  conn!: AcpConnection;
  sessionId = "";
  readonly toolNames = new Map<string, string>();
  textBuf = "";
  collected = "";
  collectedTruncated = false;
  costUsd: number | undefined;
  /** Resolvers that answer a pending `request_permission` with `cancelled` (on cancel). */
  readonly pending = new Set<(r: RequestPermissionResponse) => void>();
  cancelRequested = false;
  timedOut = false;
  permissionDenials = 0;
  flushTimer: NodeJS.Timeout | undefined;
  deadline: NodeJS.Timeout | undefined;
  readonly startedAt: number;
  readonly finished: Promise<void>;
  private resolveFinished!: () => void;

  constructor(
    readonly jobId: string,
    readonly spec: EngineStartSpec,
    readonly ref: JobRef,
    startSeq: number,
    now: number,
  ) {
    this.seq = startSeq;
    this.startedAt = now;
    this.finished = new Promise<void>((r) => {
      this.resolveFinished = r;
    });
  }

  push(e: JobEvent): void {
    this.events.push(e);
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  waitForEvent(): Promise<void> {
    return new Promise<void>((r) => this.waiters.push(r));
  }

  markFinished(): void {
    this.terminal = true;
    this.resolveFinished();
  }
}

export class DshDriver implements EngineDriver {
  readonly engine = "dsh" as const;
  private readonly runs = new Map<string, Run>();
  private reserved: string | undefined;
  private versionCache: { at: number; value: string } | undefined;
  private readonly redact: Redactor;
  private readonly launchFor: LaunchFn;
  private readonly now: () => number;

  constructor(private readonly opts: DshDriverOptions) {
    this.redact = createRedactor([opts.deepseekApiKey]);
    this.launchFor = opts.launch ?? ((args) => buildLaunch(opts.dshPath, args));
    this.now = opts.now ?? Date.now;
  }

  // ---- version and gate ------------------------------------------------------------------------------------------

  async version(): Promise<string> {
    const ttl = this.opts.versionTtlMs ?? 30_000;
    const c = this.versionCache;
    if (c && this.now() - c.at < ttl) return c.value;
    const read = this.opts.readVersion ?? (() => readDshVersion(this.launchFor(["--version"]), { cwd: tmpdir(), env: this.childEnv() }));
    const value = await read();
    this.versionCache = { at: this.now(), value };
    return value;
  }

  /** The U39 gate and the S13.4 version guard in one answer. Also what the core asks to show `dsh` templates as enabled. */
  async gate(): Promise<GateVerdict> {
    let currentVersion = "";
    try {
      currentVersion = await this.version();
    } catch (e) {
      return { allowed: false, reasons: [`could not read the dsh version: ${this.redact(e instanceof Error ? e.message : String(e))}`] };
    }
    const evidence = await this.opts.evidence.read().catch(() => undefined);
    return evaluateGate({ configVerified: this.opts.verified, evidence, currentVersion, currentPath: this.opts.dshPath });
  }

  private childEnv(): NodeJS.ProcessEnv {
    return buildChildEnv(this.opts.baseEnv ?? process.env, this.opts.deepseekApiKey, this.opts.extraEnv);
  }

  // ---- EngineDriver ----------------------------------------------------------------------------------------------

  async start(spec: EngineStartSpec): Promise<void> {
    await this.launchJob(spec, undefined);
  }

  async resume(spec: EngineResumeSpec): Promise<void> {
    await this.launchJob(spec, spec.engineSessionId);
  }

  async *events(jobId: string): AsyncIterable<JobEvent> {
    const run = this.runs.get(jobId);
    if (!run) return;
    let i = 0;
    for (;;) {
      while (i < run.events.length) {
        const e = run.events[i++] as JobEvent;
        yield e;
        if (e.kind === "state" && isTerminalJobState(e.state)) return;
      }
      await run.waitForEvent();
    }
  }

  async cancel(jobId: string): Promise<void> {
    const run = this.runs.get(jobId);
    if (!run || run.terminal) return;
    await this.cancelRun(run);
    await run.finished;
  }

  // ---- start / resume --------------------------------------------------------------------------------------------

  private async launchJob(spec: EngineStartSpec, resumeSessionId: string | undefined): Promise<void> {
    const jobId = spec.jobId;
    if (this.reserved !== undefined || [...this.runs.values()].some((r) => !r.terminal)) {
      throw new DshRefusedError("dsh_busy", ["another DeepSeek job is running (one at a time)"]);
    }
    this.reserved = jobId;
    let child: DshChild | undefined;
    let conn: AcpConnection | undefined;
    try {
      if (spec.template.engine !== "dsh") throw new DshRefusedError("dsh_bad_spec", [`template engine is "${spec.template.engine}", not dsh`]);
      if (!isAbsolute(spec.cwd)) throw new DshRefusedError("dsh_bad_spec", ["cwd must be an absolute path"]);
      const servers = this.mcpServersFor(spec);

      const verdict = await this.gate();
      if (!verdict.allowed) {
        this.opts.logger.warn("dsh.job.refused", { jobId, reasons: verdict.reasons });
        throw new DshRefusedError("dsh_unverified", verdict.reasons);
      }
      const version = await this.version();

      const startSeq = Math.max(0, Math.floor((spec as { lastSeq?: number }).lastSeq ?? 0));
      const ref: JobRef = { jobId, templateId: spec.template.id, engine: "dsh" };
      if (spec.flowBudgetCredits !== undefined) ref.flowBudgetCredits = spec.flowBudgetCredits;
      const run = new Run(jobId, spec, ref, startSeq, this.now());

      child = spawnDsh(this.launchFor(ACP_ARGS), { cwd: spec.cwd, env: this.childEnv() });
      conn = AcpConnection.open(child, {
        onUpdate: (u) => this.onUpdate(run, u),
        onPermission: (r) => this.onPermission(run, r),
        onRefused: (m) => this.opts.logger.warn("dsh.request.refused", { jobId, method: m }),
      });
      run.child = child;
      run.conn = conn;

      const sessionId = await this.handshake(run, conn, resumeSessionId, servers);
      run.sessionId = sessionId;

      this.runs.set(jobId, run);
      this.pruneRuns();
      this.emit(run, { kind: "state", state: "running" });
      this.emit(run, { kind: "init", engineSessionId: sessionId, engineVersion: version });
      const minutes = Math.max(1, spec.template.timeoutMin);
      run.deadline = setTimeout(() => {
        run.timedOut = true;
        void this.cancelRun(run);
      }, minutes * 60_000);
      run.deadline.unref();
      this.opts.logger.info("dsh.job.started", { jobId, resumed: resumeSessionId !== undefined, version });
      void this.runPrompt(run, resumeSessionId !== undefined ? CONTINUE_PROMPT : spec.prompt);
    } catch (e) {
      conn?.close();
      if (child) await child.killTree();
      if (e instanceof DshRefusedError || e instanceof DshStartError || e instanceof DshUnsupportedError) throw e;
      throw new DshStartError(this.redact(e instanceof Error ? e.message : String(e)));
    } finally {
      this.reserved = undefined;
    }
  }

  private mcpServersFor(spec: EngineStartSpec): DshMcpServer[] {
    const ids = spec.template.mcpServers;
    if (ids.length === 0) return [];
    const resolve = this.opts.resolveMcpServers;
    if (!resolve) throw new DshRefusedError("dsh_bad_spec", ["the template names MCP servers but no resolver is configured"]);
    const servers = resolve(ids);
    if (servers.length !== ids.length) throw new DshRefusedError("dsh_bad_spec", ["an MCP server of the template is unknown"]);
    for (const s of servers) {
      let host = "";
      try {
        host = new URL(s.url).hostname;
      } catch {
        /* falls through */
      }
      if (!LOOPBACK_HOSTS.has(host)) throw new DshRefusedError("dsh_bad_spec", [`MCP server "${s.name}" is not on loopback`]);
    }
    return servers;
  }

  /** initialize, then session/new or session/resume, then the forced mode. Returns the session id. */
  private async handshake(run: Run, conn: AcpConnection, resumeSessionId: string | undefined, servers: DshMcpServer[]): Promise<string> {
    const cwd = run.spec.cwd;
    const work = (async () => {
      const init = await conn.initialize(CLIENT_VERSION);
      if (init.protocolVersion !== 1) throw new DshStartError(`dsh speaks ACP v${init.protocolVersion}; this driver speaks v1`);
      let sessionId: string;
      let modes: { availableModes: Array<{ id: string }> } | null | undefined;
      if (resumeSessionId !== undefined) {
        if (!init.agentCapabilities?.sessionCapabilities?.resume) throw new DshUnsupportedError("this dsh build does not support session/resume");
        const r = await conn.resumeSession(resumeSessionId, cwd, servers);
        sessionId = resumeSessionId;
        modes = r.modes;
      } else {
        const n = await conn.newSession(cwd, servers);
        sessionId = n.sessionId;
        modes = n.modes;
      }
      const modeId = this.opts.askFirstModeId;
      if (modeId !== undefined) {
        if (!modes?.availableModes.some((m) => m.id === modeId)) throw new DshStartError(`dsh does not offer the ask-first mode "${modeId}"`);
        await conn.setMode(sessionId, modeId);
      }
      return sessionId;
    })();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DshStartError("dsh did not finish the ACP handshake in time")), HANDSHAKE_TIMEOUT_MS);
      timer.unref();
    });
    // The child exiting during the handshake rejects the pending request via the closed stream; surface its stderr in the log.
    try {
      return await Promise.race([work, timeout]);
    } catch (e) {
      const tail = this.redact(run.child.stderrTail().slice(-300));
      this.opts.logger.warn("dsh.handshake.failed", { jobId: run.jobId, stderrTail: tail });
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      work.catch(() => {});
    }
  }

  // ---- events ----------------------------------------------------------------------------------------------------

  private emit(run: Run, body: EventBody): void {
    const e = { ...body, jobId: run.jobId, seq: ++run.seq, ts: this.now() } as JobEvent;
    run.push(e);
  }

  private emitText(run: Run, text: string): void {
    const safe = this.redact(text);
    this.emit(run, { kind: "text", text: safe });
  }

  private flushText(run: Run): void {
    if (run.flushTimer) {
      clearTimeout(run.flushTimer);
      run.flushTimer = undefined;
    }
    if (run.textBuf === "") return;
    const t = run.textBuf;
    run.textBuf = "";
    this.emitText(run, t);
  }

  private onUpdate(run: Run, update: SessionUpdate): void {
    if (run.terminal) return;
    const chunk = messageChunkText(update);
    if (chunk !== undefined) {
      run.textBuf += chunk;
      this.collect(run, chunk);
      if (run.textBuf.length >= (this.opts.textFlushChars ?? 1500)) this.flushText(run);
      else if (!run.flushTimer) {
        run.flushTimer = setTimeout(() => {
          run.flushTimer = undefined;
          this.flushText(run);
        }, 2000);
        run.flushTimer.unref();
      }
      return;
    }
    const mapped = mapUpdate(update, run.toolNames);
    if (mapped.costUsd !== undefined) run.costUsd = mapped.costUsd;
    if (mapped.events.length > 0) this.flushText(run);
    for (const ev of mapped.events) this.emit(run, redactDeep(ev, this.redact));
  }

  private collect(run: Run, chunk: string): void {
    const max = this.opts.maxResultChars ?? 20_000;
    run.collected += chunk;
    if (run.collected.length > max * 2) {
      run.collected = run.collected.slice(-max);
      run.collectedTruncated = true;
    }
  }

  // ---- permissions -----------------------------------------------------------------------------------------------

  private async onPermission(run: Run, req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (run.terminal || run.cancelRequested) return CANCELLED;
    const tool = toolNameOf(req.toolCall);
    const kind = permissionKind(req.toolCall.kind, tool);
    const input = redactDeep(toJsonInput(req.toolCall.rawInput), this.redact);

    if (kind === "execute") {
      run.permissionDenials += 1;
      this.opts.logger.warn("dsh.permission.execute_rejected", { jobId: run.jobId, tool });
      return rejectOutcome(req.options);
    }

    let verdict: "allow" | "deny" | "ask";
    try {
      verdict = await run.spec.host.policy.checkPermission(run.ref, tool, input);
    } catch (e) {
      this.opts.logger.warn("dsh.permission.policy_error", { jobId: run.jobId, error: this.redact(e instanceof Error ? e.message : String(e)) });
      verdict = "deny";
    }
    if (verdict === "deny") {
      run.permissionDenials += 1;
      return rejectOutcome(req.options);
    }
    if (verdict === "allow") return allowOutcome(req.options);

    const title = (req.toolCall.title ?? "").trim();
    const card: PermissionRequest = {
      requestId: randomUUID(),
      jobId: run.jobId,
      engine: "dsh",
      tool: this.redact(tool),
      input,
      cwd: run.spec.cwd,
      kind,
      summary: this.redact(capText(title !== "" ? `${tool}: ${title}` : tool, 200)),
      requestedAt: this.now(),
      timeoutSec: this.opts.approvalTimeoutSec ?? 1800,
    };
    const answered = run.spec.host.askPermission(card).then(
      (d) => ({ out: d.answer === "allow_once" ? allowOutcome(req.options) : rejectOutcome(req.options), denied: d.answer !== "allow_once" }),
      () => ({ out: rejectOutcome(req.options), denied: true }),
    );
    let release: (r: RequestPermissionResponse) => void = () => {};
    const cancelled = new Promise<{ out: RequestPermissionResponse; denied: boolean }>((resolve) => {
      release = (r) => resolve({ out: r, denied: false });
      run.pending.add(release);
    });
    try {
      const res = await Promise.race([answered, cancelled]);
      if (res.denied) run.permissionDenials += 1;
      return res.out;
    } finally {
      run.pending.delete(release);
    }
  }

  // ---- the prompt turn and its end -------------------------------------------------------------------------------

  private async runPrompt(run: Run, text: string): Promise<void> {
    let stop: string | undefined;
    let failure: string | undefined;
    try {
      const resp = await run.conn.prompt(run.sessionId, text);
      stop = resp.stopReason;
    } catch (e) {
      // The stream usually closes a moment before the process is reaped: give it a second to report its exit code.
      const code = await Promise.race([run.child.exited, new Promise<undefined>((r) => setTimeout(() => r(undefined), 1000).unref())]);
      failure = `${e instanceof Error ? e.message : String(e)}${code !== undefined ? ` (dsh exited with code ${code})` : ""}`;
    }
    this.flushText(run);
    await this.shutdown(run);

    let state: JobState;
    let detail: string | undefined;
    if (run.timedOut) {
      state = "failed";
      detail = `timed out after ${Math.max(1, run.spec.template.timeoutMin)} min`;
    } else if (run.cancelRequested) {
      state = "cancelled";
    } else if (failure !== undefined) {
      state = "failed";
      detail = `dsh connection lost: ${capText(failure, 300)}`;
      this.opts.logger.warn("dsh.job.connection_lost", { jobId: run.jobId, stderrTail: this.redact(run.child.stderrTail().slice(-300)) });
    } else if (stop === "end_turn") {
      state = "succeeded";
    } else if (stop === "cancelled") {
      state = "cancelled";
    } else {
      state = "failed";
      detail = `dsh stopped: ${stop ?? "unknown"}`;
    }
    this.finish(run, state, detail);
  }

  private finish(run: Run, state: JobState, detail?: string): void {
    if (run.terminal) return;
    if (run.deadline) clearTimeout(run.deadline);
    if (run.flushTimer) clearTimeout(run.flushTimer);
    const max = this.opts.maxResultChars ?? 20_000;
    let text = run.collected.trim();
    if (text.length > max || run.collectedTruncated) text = `...${text.slice(-max)}`;
    if (text === "") text = detail !== undefined ? detail : state === "succeeded" ? "(dsh returned no text)" : state;
    const result: EventBody = { kind: "result", text: this.redact(text), durationMs: this.now() - run.startedAt };
    if (run.costUsd !== undefined) result.costUsd = run.costUsd;
    if (run.permissionDenials > 0) result.permissionDenials = run.permissionDenials;
    this.emit(run, result);
    this.emit(run, { kind: "state", state, ...(detail !== undefined ? { detail: this.redact(detail) } : {}) });
    run.markFinished();
    this.opts.logger.info("dsh.job.finished", { jobId: run.jobId, state });
  }

  /** Close the connection, give the child a moment to exit on its own, then tree-kill whatever is left. */
  private async shutdown(run: Run): Promise<void> {
    run.conn.close();
    try {
      run.child.stdin.end();
    } catch {
      /* already closed */
    }
    if (!run.child.hasExited()) {
      await Promise.race([run.child.exited, new Promise<void>((r) => setTimeout(r, 1500).unref())]);
    }
    if (!run.child.hasExited()) await run.child.killTree();
  }

  // ---- cancel (S13.4) --------------------------------------------------------------------------------------------

  /** `session/cancel`, every pending permission answered `cancelled`, then a tree kill after the grace period. */
  private async cancelRun(run: Run): Promise<void> {
    if (run.terminal) return;
    const first = !run.cancelRequested;
    run.cancelRequested = true;
    if (first) this.emit(run, { kind: "state", state: "cancelling" });
    for (const release of [...run.pending]) release(CANCELLED);
    run.pending.clear();
    if (!first) return;
    try {
      await run.conn.cancel(run.sessionId);
    } catch {
      /* the connection is already gone: the kill below ends it */
    }
    const grace = this.opts.cancelGraceMs ?? 5000;
    const timer = setTimeout(() => {
      this.opts.logger.warn("dsh.job.cancel_kill", { jobId: run.jobId });
      void run.child.killTree().then(() => {
        // The kill closes the stream and the prompt settles; this is the safety net if it somehow does not.
        setTimeout(() => this.finish(run, run.timedOut ? "failed" : "cancelled", run.timedOut ? "timed out" : undefined), 2000).unref();
      });
    }, grace);
    timer.unref();
    void run.finished.then(() => clearTimeout(timer));
  }

  private pruneRuns(): void {
    const finished = [...this.runs.values()].filter((r) => r.terminal);
    for (const r of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED_RUNS))) this.runs.delete(r.jobId);
  }
}
