/**
 * Helpers for the S13 tests. The "dsh" is always `fakeAgent.js` (compiled next to this file), run with `process.execPath`.
 * No test starts the real `dsh` binary.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../../../src/contracts.js";
import { DshDriver } from "../../../src/jobrunner/drivers/dsh/driver.js";
import { MemoryEvidenceStore } from "../../../src/jobrunner/drivers/dsh/gate.js";
import type { DshDriverOptions, DshProbeEvidence, LaunchFn } from "../../../src/jobrunner/drivers/dsh/types.js";
import type {
  EngineHost,
  EngineStartSpec,
  JobEvent,
  JobRunnerPolicy,
  JobTemplate,
  PermissionDecision,
  PermissionRequest,
  PolicyVerdict,
} from "../../../src/jobs/contracts.js";

export const FAKE_AGENT = fileURLToPath(new URL("./fakeAgent.js", import.meta.url));
export const FAKE_DSH_PATH = process.platform === "win32" ? "C:\\fake\\dsh.cmd" : "/fake/dsh";
export const FAKE_VERSION = "dsh 0.0.0-test (nightly)";
export const SECRET_KEY = "sk-test-DEEPSEEK-0123456789abcdef";

export interface TempDir {
  path: string;
  cleanup(): void;
}

export function tempDir(prefix = "a7-dsh-"): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export interface LogEntry {
  level: string;
  event: string;
  fields: Record<string, unknown>;
}

export function memoryLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const mk = (level: string) => (event: string, fields?: object) => {
    entries.push({ level, event, fields: (fields ?? {}) as Record<string, unknown> });
  };
  return { entries, debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error") };
}

export function goodEvidence(over: Partial<DshProbeEvidence> = {}): DshProbeEvidence {
  return {
    schema: 1,
    probedAt: "2026-10-29T10:00:00.000Z",
    dshVersion: FAKE_VERSION,
    dshPath: FAKE_DSH_PATH,
    protocolVersion: 1,
    permissionRequestSeen: true,
    executeKindLabelled: true,
    rejected: true,
    executedAnyway: false,
    shell: { state: "always_ask", how: "observed" },
    processCheck: "pass",
    terminalRequests: 0,
    passed: true,
    reasons: [],
    ...over,
  };
}

export function readLog(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export async function waitFor(cond: () => boolean, ms = 10_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A host whose policy and user answers are scripted, recording what it was asked. */
export class TestHost implements EngineHost {
  readonly asked: PermissionRequest[] = [];
  readonly policyCalls: Array<{ tool: string; input: unknown }> = [];
  verdict: (tool: string) => PolicyVerdict | Promise<PolicyVerdict> = () => "ask";
  answer: (req: PermissionRequest) => Promise<PermissionDecision> = async (req) => ({ requestId: req.requestId, jobId: req.jobId, answer: "allow_once", by: "user", at: 0 });
  readonly policy: JobRunnerPolicy = {
    checkPermission: (_job, tool, input) => {
      this.policyCalls.push({ tool, input });
      return this.verdict(tool);
    },
  };
  askPermission(req: PermissionRequest): Promise<PermissionDecision> {
    this.asked.push(req);
    return this.answer(req);
  }
}

export function template(over: Partial<JobTemplate> = {}): JobTemplate {
  return {
    id: "dsh-demo",
    title: "Demo",
    description: "demo",
    engine: "dsh",
    cwd: tmpdir(),
    prompt: "do the thing: {{brief}}",
    params: { type: "object" },
    permissionMode: "default",
    allowedTools: [],
    disallowedTools: [],
    mcpServers: [],
    flow: { enabled: false },
    paidModels: false,
    autostart: [],
    timeoutMin: 5,
    ...over,
  };
}

export function spec(host: EngineHost, cwd: string, over: Partial<EngineStartSpec> = {}): EngineStartSpec {
  return { jobId: "job-1", template: template({ cwd }), params: {}, brief: "brief", prompt: "do the thing: brief", cwd, host, ...over };
}

export interface Rig {
  driver: DshDriver;
  host: TestHost;
  logger: ReturnType<typeof memoryLogger>;
  evidence: MemoryEvidenceStore;
  logFile: string;
  dir: TempDir;
  launches: string[][];
  cleanup(): void;
}

export interface RigOptions {
  scenario?: string;
  scenarioOpts?: Record<string, unknown>;
  verified?: boolean;
  evidence?: DshProbeEvidence | undefined;
  driver?: Partial<DshDriverOptions>;
}

/** A driver that launches the fake agent in place of `dsh --profile acp`. */
export function rig(o: RigOptions = {}): Rig {
  const dir = tempDir();
  const logFile = join(dir.path, "fake.log");
  const logger = memoryLogger();
  const evidence = new MemoryEvidenceStore("evidence" in o ? o.evidence : goodEvidence());
  const launches: string[][] = [];
  const launch: LaunchFn = (args) => {
    launches.push([...args]);
    return { file: process.execPath, args: [FAKE_AGENT] };
  };
  const host = new TestHost();
  const driver = new DshDriver({
    dshPath: FAKE_DSH_PATH,
    verified: o.verified ?? true,
    evidence,
    logger,
    deepseekApiKey: SECRET_KEY,
    launch,
    readVersion: async () => FAKE_VERSION,
    baseEnv: { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "", SOME_OTHER_SECRET: "must-not-reach-the-child" },
    extraEnv: { FAKE_ACP_SCENARIO: o.scenario ?? "basic", FAKE_ACP_OPTS: JSON.stringify(o.scenarioOpts ?? {}), FAKE_ACP_LOG: logFile },
    cancelGraceMs: 400,
    ...o.driver,
  });
  return { driver, host, logger, evidence, logFile, dir, launches, cleanup: () => dir.cleanup() };
}

export async function collect(driver: DshDriver, jobId: string): Promise<JobEvent[]> {
  const out: JobEvent[] = [];
  for await (const e of driver.events(jobId)) out.push(e);
  return out;
}

export function kinds(events: JobEvent[]): string[] {
  return events.map((e) => (e.kind === "state" ? `state:${e.state}` : e.kind));
}
