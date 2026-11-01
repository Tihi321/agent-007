/**
 * Shared helpers for the job runner core tests (S11). Not a test file. Everything lives under `.claude/temp/`.
 * The fake driver stands in for S12 (claude) and S13 (dsh): no real `claude`, `dsh` or hub script ever runs.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../../../src/contracts.js";
import type {
  EngineDriver,
  EngineResumeSpec,
  EngineStartSpec,
  JobDone,
  JobEngine,
  JobEvent,
  JsonObject,
  PermissionRequest,
  SubmitBody,
  TerminalJobState,
} from "../../../src/jobs/contracts.js";
import { createMemoryJobAudit } from "../../../src/jobrunner/audit.js";
import { HubRunner, createHubEngineDriver } from "../../../src/jobrunner/hub.js";
import type { HubDeps } from "../../../src/jobrunner/hub.js";
import { Journal } from "../../../src/jobrunner/journal.js";
import { parseJobRunnerConfig } from "../../../src/jobrunner/limits.js";
import type { EventBody, JobRunnerConfig } from "../../../src/jobrunner/limits.js";
import { JobKeyRegistry, JobManager } from "../../../src/jobrunner/manager.js";
import type { JobManagerOptions } from "../../../src/jobrunner/manager.js";
import { TemplateRegistry, loadTemplates } from "../../../src/jobrunner/templates.js";
import { createMemoryLogger } from "../../../src/logging/logger.js";
import { createRedactor } from "../../../src/logging/redact.js";

export const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..");
export const TEMP_BASE = join(ROOT, ".claude", "temp");

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(cond: () => boolean, timeoutMs = 4000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// ---- a fixture tree ---------------------------------------------------------------------------------

export interface Env {
  root: string;
  hub: string;
  pixotope: string;
  dataDir: string;
  configDir: string;
  templatesDir: string;
  config: JobRunnerConfig;
  /** Writes `<id>.json` into the templates folder. */
  writeTemplate(raw: Record<string, unknown>, file?: string): void;
  cleanup(): void;
}

export function makeEnv(configOverrides: Record<string, unknown> = {}): Env {
  mkdirSync(TEMP_BASE, { recursive: true });
  const root = mkdtempSync(join(TEMP_BASE, "jr-core-"));
  const hub = join(root, "creative-hub");
  const pixotope = join(root, "Pixotope");
  const dataDir = join(root, "data");
  const configDir = join(root, "ProgramData", "jobrunner");
  const templatesDir = join(configDir, "templates");
  for (const d of [hub, pixotope, dataDir, templatesDir]) mkdirSync(d, { recursive: true });
  const config = parseJobRunnerConfig({
    ipcPort: 47007,
    paths: { dataDir, configDir, templatesDir },
    cwdAllowlist: [hub],
    denyPaths: [pixotope],
    limits: { dailyJobCap: 20, dailyCreditCap: 500, cancelGraceSec: 1, ...((configOverrides["limits"] as object | undefined) ?? {}) },
    engines: { claude: { enabled: true }, dsh: { enabled: true, verified: true }, hub: { enabled: true } },
    hub: { dir: hub, services: ["vibetts", "comfy", "scriptorium"], pwsh: "pwsh-fake" },
    ...Object.fromEntries(Object.entries(configOverrides).filter(([k]) => k !== "limits")),
  });
  return {
    root,
    hub,
    pixotope,
    dataDir,
    configDir,
    templatesDir,
    config,
    writeTemplate(raw, file) {
      writeFileSync(join(templatesDir, file ?? `${String(raw["id"])}.json`), JSON.stringify(raw, null, 2));
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A valid claude template (raw JSON) rooted at the fixture hub. */
export function claudeTemplate(env: Pick<Env, "hub">, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "list-runs",
    title: "List runs",
    description: "Lists the files in runs/ (read-only).",
    engine: "claude",
    cwd: env.hub,
    prompt: "List the files in runs/.\n{{brief}}\nTopic: {{params.topic}}",
    params: { type: "object", properties: { topic: { type: "string", maxLength: 40, pattern: "^[a-z ]+$" } }, required: ["topic"] },
    permissionMode: "default",
    allowedTools: ["Read", "Glob", "Grep"],
    disallowedTools: ["Bash", "PowerShell"],
    mcpServers: [],
    flow: { enabled: false },
    paidModels: false,
    autostart: [],
    timeoutMin: 10,
    ...over,
  };
}

export function flowTemplate(env: Pick<Env, "hub">, over: Record<string, unknown> = {}): Record<string, unknown> {
  return claudeTemplate(env, { id: "video-clip", title: "Video clip", flow: { enabled: true, estimate: 40, maxCredits: 100 }, mcpServers: ["flow-music-mcp"], ...over });
}

// ---- the fake driver --------------------------------------------------------------------------------

class Queue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const v = this.items.shift();
        if (v !== undefined) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export class FakeJob {
  readonly queue = new Queue<JobEvent>();
  private n = 0;
  ended = false;
  constructor(
    readonly spec: EngineStartSpec | EngineResumeSpec,
    readonly resumed: boolean,
  ) {}
  /** Pushes an event. The driver's own seq and ts are deliberately wrong: the core renumbers them. */
  emit(body: EventBody): void {
    if (this.ended) return;
    this.queue.push({ ...body, jobId: this.spec.jobId, seq: 1000 + ++this.n, ts: 1 } as JobEvent);
  }
  text(text: string): void {
    this.emit({ kind: "text", text });
  }
  /** `result`, a terminal `state`, and the end of the stream. */
  finish(state: TerminalJobState = "succeeded", text = "done", detail?: string): void {
    if (this.ended) return;
    this.emit({ kind: "result", text });
    this.emit({ kind: "state", state, ...(detail !== undefined ? { detail } : {}) });
    this.ended = true;
    this.queue.close();
  }
  /** Ends the stream with no terminal state at all. */
  endSilently(): void {
    this.ended = true;
    this.queue.close();
  }
  get host(): EngineStartSpec["host"] {
    return this.spec.host;
  }
}

export class FakeDriver implements EngineDriver {
  versionText = "fake 1.0";
  versionError: Error | undefined;
  jobs = new Map<string, FakeJob>();
  starts: EngineStartSpec[] = [];
  resumes: EngineResumeSpec[] = [];
  cancels: string[] = [];
  /** Called when a job starts. Default: the job stays running until the test finishes it. */
  onStart: ((job: FakeJob) => void | Promise<void>) | undefined;
  /** Called on cancel. Default: the job ends as `cancelled`. Set to a no-op to model a driver that hangs. */
  onCancel: ((job: FakeJob) => void | Promise<void>) | undefined = (job) => job.finish("cancelled", "cancelled");

  constructor(readonly engine: JobEngine = "claude") {}

  version(): Promise<string> {
    return this.versionError ? Promise.reject(this.versionError) : Promise.resolve(this.versionText);
  }
  async start(spec: EngineStartSpec): Promise<void> {
    this.starts.push(spec);
    const job = new FakeJob(spec, false);
    this.jobs.set(spec.jobId, job);
    await this.onStart?.(job);
  }
  async resume(spec: EngineResumeSpec): Promise<void> {
    this.resumes.push(spec);
    const job = new FakeJob(spec, true);
    this.jobs.set(spec.jobId, job);
    await this.onStart?.(job);
  }
  events(jobId: string): AsyncIterable<JobEvent> {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error("unknown job");
    return j.queue;
  }
  async cancel(jobId: string): Promise<void> {
    this.cancels.push(jobId);
    const j = this.jobs.get(jobId);
    if (j) await this.onCancel?.(j);
  }
  job(jobId: string): FakeJob {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`no fake job ${jobId}`);
    return j;
  }
}

// ---- a manager without a server -------------------------------------------------------------------

export interface Rig {
  env: Env;
  manager: JobManager;
  journal: Journal;
  audit: ReturnType<typeof createMemoryJobAudit>;
  logger: ReturnType<typeof createMemoryLogger>;
  jobKeys: JobKeyRegistry;
  events: JobEvent[];
  dones: JobDone[];
  permissions: PermissionRequest[];
  drivers: { claude: FakeDriver; dsh: FakeDriver };
  hubCalls: { exe: string; args: string[] }[];
  hub: HubRunner;
  registry: TemplateRegistry;
  /** Replaces the manager with a fresh one over the same journal (a restart). */
  restart(): Rig;
  now: { value: number };
}

export interface RigOptions {
  env?: Env;
  templates?: Record<string, unknown>[];
  drivers?: Partial<Record<JobEngine, EngineDriver>>;
  hubDeps?: HubDeps;
  overrides?: Partial<JobManagerOptions>;
  now?: { value: number };
  registry?: TemplateRegistry;
}

export function makeRig(opts: RigOptions = {}): Rig {
  const env = opts.env ?? makeEnv();
  for (const t of opts.templates ?? [claudeTemplate(env)]) env.writeTemplate(t);
  const logger = createMemoryLogger();
  const redact = createRedactor(["SECRET-VALUE-1234"]);
  const journal = new Journal({ dir: join(env.dataDir, "journal"), redact });
  const audit = createMemoryJobAudit();
  const hubCalls: { exe: string; args: string[] }[] = [];
  const hub = new HubRunner(env.config.hub, {
    logger: logger as Logger,
    exec: (exe, args) => {
      hubCalls.push({ exe, args: [...args] });
      return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false });
    },
    probe: () => Promise.resolve(false),
    ...(opts.hubDeps ?? {}),
  });
  const registry = opts.registry ?? loadTemplates(env.templatesDir, { flowServerId: env.config.flow.serverId, hubServices: hub.services() });
  const drivers = { claude: new FakeDriver("claude"), dsh: new FakeDriver("dsh") };
  const jobKeys = new JobKeyRegistry();
  const now = opts.now ?? { value: Date.now() };
  const events: JobEvent[] = [];
  const dones: JobDone[] = [];
  const permissions: PermissionRequest[] = [];
  const manager = new JobManager({
    config: env.config,
    templates: () => registry,
    journal,
    audit,
    hub,
    drivers: { claude: drivers.claude, dsh: drivers.dsh, hub: createHubEngineDriver(hub), ...(opts.drivers ?? {}) },
    logger: logger as Logger,
    redact,
    jobKeys,
    channelPort: () => 47007,
    now: () => now.value,
    ...(opts.overrides ?? {}),
  });
  manager.setNotifier({ event: (e) => void events.push(e), permission: (r) => void permissions.push(r), done: (d) => void dones.push(d) });
  const rig: Rig = {
    env,
    manager,
    journal,
    audit,
    logger,
    jobKeys,
    events,
    dones,
    permissions,
    drivers,
    hubCalls,
    hub,
    registry,
    now,
    restart: () => makeRig({ ...opts, env, templates: [], now, registry }),
  };
  return rig;
}

export function submitBody(jobId: string, over: Partial<SubmitBody> & { params?: JsonObject; brief?: string; templateId?: string } = {}): SubmitBody {
  return {
    jobId,
    request: { templateId: over.templateId ?? "list-runs", params: over.params ?? { topic: "cats" }, brief: over.brief ?? "make it nice" },
    approval: over.approval ?? { userId: 42, at: 1 },
    ...(over.flowBudgetCredits !== undefined ? { flowBudgetCredits: over.flowBudgetCredits } : {}),
    ...(over.resume !== undefined ? { resume: over.resume } : {}),
  };
}
