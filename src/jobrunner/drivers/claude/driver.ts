/**
 * The Claude Code engine driver (S12). Implements `EngineDriver` from src/jobs/contracts.ts.
 *
 *  start/resume  version check (+ guard S12.5), settings pre-flight (S12.1), a job token and mcp-config file (S12.3),
 *                the argv of argv.ts, then `claude` is spawned with cwd = the job's validated cwd, the main user's env
 *                minus `ANTHROPIC_*`, and the prompt on stdin. `start` resolves once the process has spawned.
 *  events        `JobEvent`s with `seq` from 1, gapless per driver instance: state running, then the parsed stream, then
 *                `result` and a terminal `state` (succeeded, failed or cancelled). The stream ends after that.
 *  cancel        tree kill, then the terminal `state: cancelled`.
 *
 * Refusals (`start` rejects, nothing is spawned): `ClaudePreflightError`, `ClaudeVersionHeldError`, `ClaudeArgvError`.
 * The core (S11) should record such a job as failed or rejected with the error message.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "../../../contracts.js";
import type { EngineDriver, EngineResumeSpec, EngineStartSpec, JobEvent, JobRef, JobState } from "../../../jobs/contracts.js";
import { buildClaudeArgs, buildClaudeEnv, DEFAULT_FLOW_SERVER_ID } from "./argv.js";
import { PermissionBroker } from "./permissionBroker.js";
import { claudePreflight } from "./preflight.js";
import type { PreflightOptions } from "./preflight.js";
import { StreamJsonParser, runParserSmoke } from "./parser.js";
import type { EventBody, ParserFixture } from "./parser.js";
import { EventChannel, killProcessTree, mcpConfigPathFor, writeMcpConfig } from "./process.js";
import type { McpConfigFile } from "./process.js";
import { ClaudeVersionGuard, ClaudeVersionHeldError } from "./versionGuard.js";

export class ClaudePreflightError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`settings pre-flight refused the job: ${reasons.join("; ")}`);
    this.name = "ClaudePreflightError";
    this.reasons = reasons;
  }
}

export const DEFAULT_RESUME_PROMPT = "Continue the task from where you stopped and finish it. Keep to the original instructions.";
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ClaudeDriverOptions {
  /** Executable to run. Must be a real executable (`claude.exe`) or `process.execPath` with `prefixArgs`; never a shell. Default `claude`. */
  command?: string;
  /** Arguments before the Claude flags (tests: the fake script). */
  prefixArgs?: readonly string[];
  /** The job runner's main-user-only data folder (job-scoped mcp-config files go under `jobs/`). */
  dataDir: string;
  /** The job runner's IPC port (`A7_JOB_PORT`). */
  ipcPort: number;
  broker: PermissionBroker;
  /** UI-2 paths plus `C:\ProgramData\agent-007\` and the agent's data root. One Read/Edit/Write deny rule each. */
  denyPaths: readonly string[] | (() => readonly string[]);
  /** Base env (default `process.env`). `ANTHROPIC_*` is removed. */
  env?: NodeJS.ProcessEnv;
  /** `node` and the helper script. Defaults: `process.execPath` and `dist/.../permissionMcp.js` next to this module. */
  helperCommand?: string;
  helperArgs?: readonly string[];
  flowServerId?: string;
  preflight?: Omit<PreflightOptions, "cwd">;
  /** S12.5. Absent means no guard. */
  guard?: ClaudeVersionGuard;
  /** Recorded stream-json fixtures for the guard's parser smoke. Required when `guard` is set. */
  parserFixtures?: readonly ParserFixture[];
  /** Templates that may run while the version is held (the harmless probe). A success approves the version. */
  probeTemplateIds?: readonly string[];
  resumePrompt?: string;
  /** Seconds the permission card waits (the core enforces it). */
  permissionTimeoutSec?: number;
  /** Overrides `template.timeoutMin` (tests). */
  timeoutMsOverride?: number;
  killTree?: (pid: number) => Promise<void>;
  now?: () => number;
  logger?: Logger;
}

interface RunningJob {
  jobId: string;
  child: ChildProcess;
  channel: EventChannel<JobEvent>;
  seq: number;
  parser: StreamJsonParser;
  decoder: StringDecoder;
  stderrTail: string;
  cancelRequested: boolean;
  timedOut: boolean;
  finalized: boolean;
  mcp: McpConfigFile | undefined;
  timer: NodeJS.Timeout | undefined;
  version: string;
  isProbe: boolean;
  finished: Promise<void>;
  markFinished: () => void;
  templateId: string;
}

export class ClaudeDriver implements EngineDriver {
  readonly engine = "claude" as const;
  private readonly running = new Map<string, RunningJob>();
  private readonly channels = new Map<string, EventChannel<JobEvent>>();
  private readonly command: string;
  private readonly prefixArgs: readonly string[];
  private readonly now: () => number;

  constructor(private readonly opts: ClaudeDriverOptions) {
    this.command = opts.command ?? "claude";
    this.prefixArgs = opts.prefixArgs ?? [];
    this.now = opts.now ?? Date.now;
    if (opts.guard && (!opts.parserFixtures || opts.parserFixtures.length === 0)) throw new Error("a version guard needs parserFixtures");
  }

  /** `claude --version`, trimmed (S12.1: recorded for every job). */
  version(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...this.prefixArgs, "--version"], { env: buildClaudeEnv(this.opts.env ?? process.env), windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      const t = setTimeout(() => {
        child.kill();
        reject(new Error("claude --version timed out"));
      }, 15_000);
      child.stdout.on("data", (c: Buffer) => {
        if (out.length < 1024) out += c.toString("utf8");
      });
      child.once("error", (e) => {
        clearTimeout(t);
        reject(new Error(`claude --version failed: ${(e as NodeJS.ErrnoException).code ?? "error"}`));
      });
      child.once("close", (code) => {
        clearTimeout(t);
        const line = out.split(/\r?\n/)[0]?.trim() ?? "";
        if (code !== 0 || line === "") reject(new Error("claude --version gave no version"));
        else resolve(line);
      });
    });
  }

  start(spec: EngineStartSpec): Promise<void> {
    return this.launch(spec, undefined);
  }

  resume(spec: EngineResumeSpec): Promise<void> {
    return this.launch(spec, spec.engineSessionId);
  }

  events(jobId: string): AsyncIterable<JobEvent> {
    const ch = this.channels.get(jobId);
    if (!ch) return (async function* () {})();
    const self = this;
    return (async function* () {
      try {
        yield* ch.iterate();
      } finally {
        if (self.channels.get(jobId) === ch) self.channels.delete(jobId);
      }
    })();
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.running.get(jobId);
    if (!job) return;
    job.cancelRequested = true;
    await this.kill(job);
    await Promise.race([job.finished, new Promise<void>((r) => setTimeout(r, 10_000).unref())]);
  }

  /** Number of jobs with a live process (for the core's one-Claude-job limit and for shutdown). */
  get runningCount(): number {
    return this.running.size;
  }

  // ---- launch ----------------------------------------------------------------------------------

  private async launch(spec: EngineStartSpec, resumeSessionId: string | undefined): Promise<void> {
    const { jobId, template } = spec;
    if (!JOB_ID.test(jobId)) throw new Error("job id has unexpected characters");
    if (template.engine !== "claude") throw new Error(`template ${template.id} is not a claude template`);
    if (this.running.has(jobId)) throw new Error(`job ${jobId} is already running`);

    // Validate everything that needs no process first: a refused job creates no token and no file.
    const argvOpts: Parameters<typeof buildClaudeArgs>[0] = {
      template,
      mcpConfigPath: mcpConfigPathFor(this.opts.dataDir, jobId),
      denyPaths: typeof this.opts.denyPaths === "function" ? this.opts.denyPaths() : this.opts.denyPaths,
      flowServerId: this.opts.flowServerId ?? DEFAULT_FLOW_SERVER_ID,
    };
    if (resumeSessionId !== undefined) argvOpts.resumeSessionId = resumeSessionId;
    const { args } = buildClaudeArgs(argvOpts);

    const version = await this.version();
    const isProbe = (this.opts.probeTemplateIds ?? []).includes(template.id);
    this.checkGuard(version, isProbe);

    const pre = await claudePreflight({ ...this.opts.preflight, cwd: spec.cwd });
    if (!pre.ok) throw new ClaudePreflightError(pre.reasons);
    for (const w of pre.warnings) this.opts.logger?.warn("claude.preflight_warning", { jobId, warning: w });

    let mcp: McpConfigFile | undefined;
    let registered = false;
    try {
      const helperCommand = this.opts.helperCommand ?? process.execPath;
      const helperArgs = this.opts.helperArgs ?? [fileURLToPath(new URL("../../permissionMcp.js", import.meta.url))];
      const ref: JobRef = { jobId, templateId: template.id, engine: "claude" };
      if (spec.flowBudgetCredits !== undefined) ref.flowBudgetCredits = spec.flowBudgetCredits;
      const token = this.opts.broker.register({ jobId, ref, cwd: spec.cwd, host: spec.host, timeoutSec: this.opts.permissionTimeoutSec ?? 1800 });
      registered = true;
      mcp = await writeMcpConfig({ dataDir: this.opts.dataDir, jobId, helperCommand, helperArgs, token, port: this.opts.ipcPort });

      const child = spawn(this.command, [...this.prefixArgs, ...args], {
        cwd: spec.cwd,
        env: buildClaudeEnv(this.opts.env ?? process.env),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        shell: false,
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", (e) => reject(new Error(`could not start claude: ${(e as NodeJS.ErrnoException).code ?? "error"}`)));
      });

      let markFinished!: () => void;
      const finished = new Promise<void>((r) => (markFinished = r));
      const channel = new EventChannel<JobEvent>();
      const job: RunningJob = {
        jobId,
        child,
        channel,
        seq: 0,
        parser: new StreamJsonParser(),
        decoder: new StringDecoder("utf8"),
        stderrTail: "",
        cancelRequested: false,
        timedOut: false,
        finalized: false,
        mcp,
        timer: undefined,
        version,
        isProbe,
        finished,
        markFinished,
        templateId: template.id,
      };
      this.running.set(jobId, job);
      this.channels.set(jobId, channel);
      this.emit(job, { kind: "state", state: "running" });
      this.attach(job);

      const timeoutMs = this.opts.timeoutMsOverride ?? Math.max(1, template.timeoutMin) * 60_000;
      job.timer = setTimeout(() => {
        job.timedOut = true;
        void this.kill(job);
      }, timeoutMs);
      job.timer.unref();

      child.stdin.on("error", () => undefined);
      child.stdin.end(resumeSessionId !== undefined ? (this.opts.resumePrompt ?? DEFAULT_RESUME_PROMPT) : spec.prompt, "utf8");
    } catch (e) {
      if (registered) this.opts.broker.unregister(jobId);
      await mcp?.remove().catch(() => undefined);
      throw e;
    }
  }

  private checkGuard(version: string, isProbe: boolean): void {
    const guard = this.opts.guard;
    if (!guard) return;
    let c = guard.check(version);
    if (c.missing.includes("parser_smoke")) {
      const smoke = runParserSmoke(this.opts.parserFixtures ?? []);
      guard.recordParserSmoke(version, smoke.ok);
      if (!smoke.ok) this.opts.logger?.error("claude.parser_smoke_failed", { version, failures: smoke.failures });
      c = guard.check(version);
    }
    if (c.held && !(isProbe && !c.missing.includes("parser_smoke"))) throw new ClaudeVersionHeldError(version, c.missing);
  }

  private attach(job: RunningJob): void {
    const { child } = job;
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const body of job.parser.push(job.decoder.write(chunk))) this.emitParsed(job, body);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      job.stderrTail = (job.stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    child.once("error", () => void this.finalize(job, null));
    child.once("close", (code) => void this.finalize(job, code));
  }

  private emitParsed(job: RunningJob, body: EventBody): void {
    if (body.kind === "init" && body.engineVersion === undefined) body = { ...body, engineVersion: job.version };
    this.emit(job, body);
  }

  private emit(job: RunningJob, body: EventBody): void {
    const ev = { jobId: job.jobId, seq: ++job.seq, ts: this.now(), ...body } as JobEvent;
    job.channel.push(ev);
  }

  private async kill(job: RunningJob): Promise<void> {
    const pid = job.child.pid;
    if (pid === undefined || job.finalized) return;
    try {
      await (this.opts.killTree ?? killProcessTree)(pid);
    } catch (e) {
      this.opts.logger?.error("claude.kill_failed", { jobId: job.jobId, error: e instanceof Error ? e.message : "error" });
    }
  }

  private async finalize(job: RunningJob, exitCode: number | null): Promise<void> {
    if (job.finalized) return;
    job.finalized = true;
    if (job.timer) clearTimeout(job.timer);
    for (const body of [...job.parser.push(job.decoder.end()), ...job.parser.flush()]) this.emitParsed(job, body);

    const r = job.parser.result;
    let state: JobState;
    let detail: string | undefined;
    if (job.cancelRequested) {
      state = "cancelled";
    } else if (job.timedOut) {
      state = "failed";
      detail = "timed out";
    } else if (r && !r.isError && exitCode === 0) {
      state = "succeeded";
    } else {
      state = "failed";
      detail = r ? `Claude Code ended with ${r.subtype}${exitCode === 0 ? "" : `, exit ${String(exitCode)}`}` : `exit ${String(exitCode)}${job.stderrTail.trim() ? `: ${job.stderrTail.trim().slice(-300)}` : ""}`;
    }
    // Cleanup first, so that when a consumer sees the terminal event the token and the mcp-config file are already gone.
    this.running.delete(job.jobId);
    this.opts.broker.unregister(job.jobId);
    await job.mcp?.remove().catch((e: unknown) => this.opts.logger?.error("claude.mcp_config_remove_failed", { jobId: job.jobId, error: e instanceof Error ? e.message : "error" }));
    if (job.isProbe && state === "succeeded" && this.opts.guard) this.opts.guard.recordLiveJob(job.version, true);

    if (!r) {
      const text = state === "cancelled" ? "Cancelled before Claude Code reported a result." : `Claude Code produced no result (${detail ?? "unknown"}).`;
      this.emit(job, { kind: "result", text, permissionDenials: 0 });
    }
    this.emit(job, detail !== undefined ? { kind: "state", state, detail } : { kind: "state", state });
    job.channel.close();
    job.markFinished();
  }
}
