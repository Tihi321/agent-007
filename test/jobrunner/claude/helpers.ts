/** Shared helpers for the Claude driver tests. Not a test file. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EngineHost,
  EngineStartSpec,
  JobEvent,
  JobRef,
  JobRunnerPolicy,
  JobTemplate,
  PermissionDecision,
  PermissionRequest,
  PolicyVerdict,
} from "../../../src/jobs/contracts.js";
import { ClaudeDriver } from "../../../src/jobrunner/drivers/claude/driver.js";
import type { ClaudeDriverOptions } from "../../../src/jobrunner/drivers/claude/driver.js";
import { PermissionBroker } from "../../../src/jobrunner/drivers/claude/permissionBroker.js";

export const FAKE_CLAUDE = fileURLToPath(new URL("./fakeClaude.js", import.meta.url));
/** dist/test/jobrunner/claude -> dist/src/jobrunner/permissionMcp.js */
export const HELPER_JS = fileURLToPath(new URL("../../../src/jobrunner/permissionMcp.js", import.meta.url));

export const DENY_PATHS = ["C:\\Pixotope", "D:\\Work\\Repos\\", "C:\\ProgramData\\agent-007", "C:\\Users\\agent\\AppData\\Local\\agent-007"];

export function tempDir(prefix = "a7-claude-"): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function makeTemplate(over: Partial<JobTemplate> = {}): JobTemplate {
  return {
    id: "list-runs",
    title: "List runs",
    description: "Lists the files in runs/",
    engine: "claude",
    cwd: "C:\\projects\\Personal\\creative-hub",
    prompt: "List the files in runs/.\n<brief>{{brief}}</brief>",
    params: { type: "object" },
    permissionMode: "default",
    allowedTools: ["Read", "Glob", "Grep"],
    disallowedTools: ["WebFetch"],
    mcpServers: [],
    flow: { enabled: false },
    paidModels: false,
    autostart: [],
    timeoutMin: 5,
    ...over,
  };
}

export class FakePolicy implements JobRunnerPolicy {
  readonly calls: Array<{ job: JobRef; tool: string; input: unknown }> = [];
  constructor(public verdict: PolicyVerdict | ((tool: string) => PolicyVerdict) = "ask") {}
  checkPermission(job: JobRef, tool: string, input: unknown): PolicyVerdict {
    this.calls.push({ job, tool, input });
    return typeof this.verdict === "function" ? this.verdict(tool) : this.verdict;
  }
}

export class FakeHost implements EngineHost {
  readonly asked: PermissionRequest[] = [];
  answer: "allow_once" | "deny" = "deny";
  constructor(readonly policy: JobRunnerPolicy = new FakePolicy()) {}
  async askPermission(req: PermissionRequest): Promise<PermissionDecision> {
    this.asked.push(req);
    return { requestId: req.requestId, jobId: req.jobId, answer: this.answer, by: "user", at: Date.now() };
  }
}

export function makeSpec(over: Partial<EngineStartSpec> & { jobId: string }): EngineStartSpec {
  const template = over.template ?? makeTemplate();
  return {
    template,
    params: {},
    brief: "the brief",
    prompt: "PROMPT TEXT with é and the brief",
    cwd: over.cwd ?? process.cwd(),
    host: new FakeHost(),
    ...over,
  };
}

export interface Rig {
  dir: string;
  dataDir: string;
  cwd: string;
  driver: ClaudeDriver;
  broker: PermissionBroker;
  env: NodeJS.ProcessEnv;
  recordPath: string;
  pidPath: string;
  cleanup(): void;
}

export function makeRig(scenario: string, over: Partial<ClaudeDriverOptions> = {}, env: NodeJS.ProcessEnv = {}): Rig {
  const t = tempDir();
  const dataDir = join(t.dir, "data");
  const cwd = join(t.dir, "hub");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const recordPath = join(t.dir, "record.json");
  const pidPath = join(t.dir, "pids.json");
  const broker = over.broker ?? new PermissionBroker();
  const fullEnv: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_CLAUDE_SCENARIO: scenario,
    FAKE_CLAUDE_RECORD: recordPath,
    FAKE_CLAUDE_PIDFILE: pidPath,
    ...env,
  };
  const driver = new ClaudeDriver({
    command: process.execPath,
    prefixArgs: [FAKE_CLAUDE],
    dataDir,
    ipcPort: 1,
    broker,
    denyPaths: DENY_PATHS,
    env: fullEnv,
    helperCommand: process.execPath,
    helperArgs: [HELPER_JS],
    ...over,
  });
  return { dir: t.dir, dataDir, cwd, driver, broker, env: fullEnv, recordPath, pidPath, cleanup: t.cleanup };
}

export async function collect(iter: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const out: JobEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
