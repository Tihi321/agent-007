/**
 * Phase 2 integration rig (S15): the Phase 1 rig (real startup sequence, real Harness on SQLite, fake OpenAI server, fake
 * Telegram) plus a REAL job runner process (`helpers/jobrunnerProcess.js`: production `startJobRunner`, the HMAC IPC on
 * 127.0.0.1, the production Claude driver around the fake `claude` script). Nothing contacts Telegram, creative-hub or a real
 * `claude`; every directory is under the temp folder.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Behavior, BehaviorInput } from "../helpers/fakeOpenAi.js";
import { E2e, USER_ID, readLogs, viaToolSearch, waitFor } from "./rig.js";

export { USER_ID, waitFor, viaToolSearch };

const RUNNER_JS = fileURLToPath(new URL("./helpers/jobrunnerProcess.js", import.meta.url));

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A claude template rooted at `hub`. Shell tools are disallowed (the loader insists). */
export function claudeTemplate(hub: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "list-runs",
    title: "List the runs folder",
    description: "Read-only job: lists the files in runs/ and says what is there.",
    engine: "claude",
    cwd: hub,
    prompt: "List the files in runs/ and summarise them.\n<brief>{{brief}}</brief>",
    params: { type: "object", properties: { topic: { type: "string", maxLength: 40 } } },
    permissionMode: "default",
    allowedTools: ["Read", "Glob", "Grep"],
    disallowedTools: ["Bash", "PowerShell"],
    mcpServers: [],
    flow: { enabled: false },
    paidModels: false,
    autostart: [],
    timeoutMin: 5,
    ...over,
  };
}

export interface RunnerLayout {
  root: string;
  hub: string;
  pixotope: string;
  dataDir: string;
  configDir: string;
  templatesDir: string;
  configPath: string;
  port: number;
  key: string;
}

export function layoutRunner(root: string, port: number, key: string, templates: Record<string, unknown>[]): RunnerLayout {
  const hub = join(root, "creative-hub");
  const pixotope = join(root, "Pixotope");
  const dataDir = join(root, "jr-data");
  const configDir = join(root, "jr-config");
  const templatesDir = join(configDir, "templates");
  for (const d of [hub, pixotope, dataDir, templatesDir]) mkdirSync(d, { recursive: true });
  for (const t of templates) writeFileSync(join(templatesDir, `${String(t["id"])}.json`), JSON.stringify(t, null, 2));
  const configPath = join(configDir, "jobrunner.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      ipcPort: port,
      paths: { dataDir, configDir, templatesDir },
      cwdAllowlist: [hub],
      denyPaths: [pixotope],
      limits: { dailyJobCap: 20, dailyCreditCap: 500, cancelGraceSec: 1, permissionTimeoutSec: 600 },
      engines: { claude: { enabled: true }, dsh: { enabled: false, verified: false }, hub: { enabled: true } },
      hub: { dir: hub, services: [], pwsh: "pwsh-not-used" },
      flow: { serverId: "flow-music-mcp" },
    }),
  );
  writeFileSync(join(dataDir, "secrets.json"), JSON.stringify({ ipcHmacKey: key }));
  return { root, hub, pixotope, dataDir, configDir, templatesDir, configPath, port, key };
}

/** The job runner as a child process. */
export class RunnerProc {
  child: ChildProcess | undefined;
  stderr = "";

  private constructor(
    readonly layout: RunnerLayout,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  static async start(layout: RunnerLayout, env: NodeJS.ProcessEnv): Promise<RunnerProc> {
    const p = new RunnerProc(layout, env);
    await p.spawn();
    return p;
  }

  private spawn(): Promise<void> {
    const child = spawn(process.execPath, [RUNNER_JS, this.layout.configPath], {
      env: { ...process.env, ...this.env },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    this.child = child;
    child.stderr?.on("data", (d: Buffer) => {
      this.stderr += d.toString();
    });
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the job runner process did not become ready: ${this.stderr.slice(0, 400)}`)), 20_000);
      child.once("message", (m) => {
        if (typeof m === "object" && m !== null && (m as { type?: unknown }).type === "ready") {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`the job runner process exited with ${String(code)}: ${this.stderr.slice(0, 400)}`));
      });
    });
  }

  /** Graceful stop (the production `runner.stop()`), then waits for the exit. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.send({ type: "shutdown" });
    await Promise.race([exited, sleep(10_000).then(() => void child.kill())]);
    await exited.catch(() => undefined);
  }

  /** Stops it and starts a new process on the same folders (the journal and the audit are on disk). */
  async restart(): Promise<void> {
    await this.stop();
    this.stderr = "";
    await this.spawn();
  }

  /** Every line of the job runner's audit log (`audit\jobs-YYYYMM.jsonl`). */
  audit(): Record<string, unknown>[] {
    const dir = join(this.layout.dataDir, "audit");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort()
      .flatMap((n) =>
        readFileSync(join(dir, n), "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as Record<string, unknown>),
      );
  }
}

export interface Phase2RigOptions {
  /** `FAKE_CLAUDE_SCENARIO` of the job runner's fake claude: ok | slow | error | crash | hang | askperm. */
  scenario: string;
  behavior: Behavior;
  templates?: Record<string, unknown>[];
  /** Config blocks merged into the agent's `mcp`. */
  mcpServers?: { id: string; url: string; allowTools: string[]; macros: string[] }[];
}

export class Phase2Rig {
  private constructor(
    readonly e2e: E2e,
    readonly runner: RunnerProc,
    readonly layout: RunnerLayout,
    readonly pidFile: string,
  ) {}

  static async open(o: Phase2RigOptions): Promise<Phase2Rig> {
    const port = await freePort();
    const key = randomBytes(32).toString("base64url");
    // The runner's tree lives next to the agent's temp folder; the rig removes it in `close()`.
    const e2eRoot = (await E2e.open({ behavior: viaToolSearchFor(o.behavior), config: { phase2: { jobs: { ipcPort: port, approvalTimeoutSec: 600, progressIntervalSec: 1 }, mcp: { servers: o.mcpServers ?? [], callTimeoutSec: 20 } }, secrets: { ipcHmacKey: key } }, start: { phase2: { jobs: { pollMs: 300, retryDelayMs: 100 }, statusProbeMs: 3000 } } }));
    const root = join(dirname(e2eRoot.dirs.root), `${e2eRoot.dirs.root.split(/[\\/]/).pop()}-jr`);
    mkdirSync(root, { recursive: true });
    const layout = layoutRunner(root, port, key, o.templates ?? [claudeTemplate(join(root, "creative-hub"))]);
    const pidFile = join(root, "claude-pids.json");
    const runner = await RunnerProc.start(layout, { FAKE_CLAUDE_SCENARIO: o.scenario, FAKE_CLAUDE_PIDFILE: pidFile, FAKE_CLAUDE_RECORD: join(root, "claude-record.json") });
    const rig = new Phase2Rig(e2eRoot, runner, layout, pidFile);
    await waitFor(() => e2eRoot.agent.phase2.client.state === "online", 15_000, "the agent to connect to the job runner");
    return rig;
  }

  /** What went wrong, for a failed test: the runner's stderr and log tail, its audit, and the agent's warnings and errors. */
  diagnostics(): string {
    const lines: string[] = [`runner stderr: ${this.runner.stderr.slice(-600)}`];
    const logDir = join(this.layout.dataDir, "logs");
    if (existsSync(logDir)) {
      for (const n of readdirSync(logDir)) lines.push(`runner log ${n}:\n${readFileSync(join(logDir, n), "utf8").split("\n").slice(-25).join("\n")}`);
    }
    lines.push(`runner audit: ${JSON.stringify(this.runner.audit().map((e) => [e["event"], e["jobId"]]))}`);
    const agent = readLogs(this.e2e.dirs).filter((l) => l["level"] === "warn" || l["level"] === "error").slice(-15);
    lines.push(`agent warn/error: ${JSON.stringify(agent)}`);
    lines.push(`telegram texts: ${JSON.stringify(this.e2e.texts().slice(-12))}`);
    return lines.join("\n");
  }

  async close(): Promise<void> {
    await this.e2e.close();
    await this.runner.stop();
    // a hung fake claude may still own its pid file
    try {
      const pids = JSON.parse(readFileSync(this.pidFile, "utf8")) as { pid?: number; childPid?: number };
      for (const pid of [pids.pid, pids.childPid]) if (pid !== undefined && isAlive(pid)) process.kill(pid);
    } catch {
      /* none */
    }
    rmSync(this.e2e.dirs.root, { recursive: true, force: true });
    rmSync(this.layout.root, { recursive: true, force: true });
  }
}

/** Phase 2 tools that are deferred: MCP tools and `hub_start`, next to the Phase 1 four. */
function viaToolSearchFor(inner: Behavior): Behavior {
  return viaToolSearch(inner, { extraDeferred: (n) => n.startsWith("mcp__") || n === "hub_start", queries: { "mcp__flow-music-mcp__generate_clip": "flow music video clip generate" } });
}

/** The job id the model saw in an earlier tool result. */
export function jobIdFromHistory(i: BehaviorInput): string | undefined {
  for (const m of [...(i.request.messages ?? [])].reverse()) {
    if (m.role !== "tool") continue;
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const hit = /job-[0-9a-f]{12}/.exec(text);
    if (hit) return hit[0];
  }
  return undefined;
}
