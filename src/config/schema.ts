/**
 * config.json schema (S1.2): hand-written validation with defaults.
 * Structural checks live here; semantic checks (loopback, existence, secrets) are in load.ts.
 */
import type { OpenAICompletionsCompat } from "../pi/adapter.js";

export type RunnerName = "lmstudio" | "strata";
export const RUNNER_NAMES: readonly RunnerName[] = ["lmstudio", "strata"];

export interface RunnerBlock {
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  /** Per-runner overrides decided by Phase 0 smoke S2/S3 (U2, U19, U20). */
  compat?: OpenAICompletionsCompat;
}

export interface StrataBlock extends RunnerBlock {
  installDir: string;
  dataDir: string;
  configFile: string;
  logDir: string;
}

export interface RetryConfig {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxAgentDelayMs: number;
}

export interface ModelConfig {
  runner: RunnerName;
  runners: { lmstudio?: RunnerBlock; strata?: StrataBlock };
  streamTimeoutMs: number;
  retry: RetryConfig;
}

export interface ShellConfig {
  enabled: boolean;
  approvalTimeoutSec: number;
  execTimeoutSec: number;
  maxExecTimeoutSec: number;
  maxOutputBytes: number;
  returnBytes: number;
}

export interface PathsConfig {
  /** `C:\ProgramData\agent-007` (config, secrets, Strata copy, Strata log). */
  programDataDir: string;
  /** Agent data root, normally `%LOCALAPPDATA%\agent-007`. */
  dataDir: string;
  stateDir: string;
  workspaceDir: string;
  memoryFile: string;
  userFile: string;
  logsDir: string;
  auditDir: string;
  controlDir: string;
  /** Holds `agent.lock`. */
  runDir: string;
}

export interface LimitsConfig {
  readFileBytes: number;
  searchMaxFiles: number;
  listMaxEntries: number;
  searchMaxResults: number;
}

export interface FolderAllow {
  alias: string;
  path: string;
}

// ---- Phase 2 blocks (S9.4) -------------------------------------------------------------------

/** One creative-hub MCP server. Every tool it exposes to the model is deferred (I27); `allowTools` is the allowlist. */
export interface McpServerConfig {
  /** Used in tool names (`mcp__<id>__<tool>`): 1-32 of letters, digits, "-" and a single "_" at most (never "__"). */
  id: string;
  /** `http://127.0.0.1:<port>/mcp`. The loader refuses a non-loopback host. */
  url: string;
  /** Names of the server's tools the agent may use. Anything else the server lists is dropped. */
  allowTools: string[];
  /** Names of the typed macros (S10.3) enabled for this server. */
  macros: string[];
  /** Per-call timeout override in seconds; default `mcp.callTimeoutSec`. */
  callTimeoutSec?: number;
}

export interface McpConfig {
  servers: McpServerConfig[];
  /** Default per-call timeout in seconds (long, for ComfyUI and Flow). */
  callTimeoutSec: number;
}

export interface JobsConfig {
  /** The job runner's loopback TCP port (I16). The agent connects to `127.0.0.1:<ipcPort>`. */
  ipcPort: number;
  /** Job and permission approval timeout; expiry rejects (UI-12 proposal: 30 minutes). */
  approvalTimeoutSec: number;
  /** Minimum interval between edits of the Telegram progress message. */
  progressIntervalSec: number;
}

export interface FlowConfig {
  /** The id (in `mcp.servers`) of the Flow music/video server whose calls the Flow guard watches (S14.4). */
  serverId: string;
}

export interface SecondOpinionConfig {
  /** Off by default and unbuilt without an explicit yes (I23, UI-15). */
  enabled: boolean;
  /** `http://127.0.0.1:<proxyPort>/v1`; the port comes from the proxy's own settings (U52). */
  baseUrl: string;
  modelId: string;
}

export const DEFAULT_IPC_PORT = 47007;
export const DEFAULT_PROXY_BASE_URL = "http://127.0.0.1:8787/v1";
export const DEFAULT_FLOW_SERVER_ID = "flow-music-mcp";
export const MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]|_(?=[A-Za-z0-9-])){0,31}$/;

export interface Config {
  telegram: { allowedUserIds: number[] };
  model: ModelConfig;
  folders: { allow: FolderAllow[]; deny: string[] };
  shell: ShellConfig;
  paths: PathsConfig;
  limits: LimitsConfig;
  /** The main user's profile dir, used for the `.lmstudio` built-in deny (the agent user's own home is different). */
  mainUserProfile: string;
  /** Phase 2. Defaults apply when the blocks are absent, so a Phase 1 config.json still loads. */
  mcp: McpConfig;
  jobs: JobsConfig;
  flow: FlowConfig;
  secondOpinion: SecondOpinionConfig;
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export interface DefaultsEnv {
  localAppData: string;
  programData: string;
  mainUserProfile: string;
}

export function defaultsFromEnv(env: NodeJS.ProcessEnv = process.env): DefaultsEnv {
  return {
    localAppData: env["LOCALAPPDATA"] ?? "C:\\Users\\agent007\\AppData\\Local",
    programData: env["ProgramData"] ?? env["PROGRAMDATA"] ?? "C:\\ProgramData",
    mainUserProfile: env["AGENT007_MAIN_USER_PROFILE"] ?? env["USERPROFILE"] ?? "C:\\Users\\main",
  };
}

// ---- tiny validation helpers ----------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Collector {
  readonly issues: string[] = [];
  obj(v: unknown, at: string, optional = false): Obj {
    if (v === undefined && optional) return {};
    if (!isObj(v)) {
      this.issues.push(`${at}: expected an object`);
      return {};
    }
    return v;
  }
  str(v: unknown, at: string, fallback?: string): string {
    if (v === undefined && fallback !== undefined) return fallback;
    if (typeof v !== "string" || v.trim() === "") {
      this.issues.push(`${at}: expected a non-empty string`);
      return fallback ?? "";
    }
    return v;
  }
  num(v: unknown, at: string, fallback: number, min = 0, integer = true): number {
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || (integer && !Number.isInteger(v))) {
      this.issues.push(`${at}: expected ${integer ? "an integer" : "a number"} >= ${min}`);
      return fallback;
    }
    return v;
  }
  bool(v: unknown, at: string, fallback: boolean): boolean {
    if (v === undefined) return fallback;
    if (typeof v !== "boolean") {
      this.issues.push(`${at}: expected a boolean`);
      return fallback;
    }
    return v;
  }
}

function winJoin(...parts: string[]): string {
  return parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, ""))).join("\\");
}

function parseCompat(c: Collector, v: unknown, at: string): OpenAICompletionsCompat | undefined {
  if (v === undefined) return undefined;
  const o = c.obj(v, at);
  const out: OpenAICompletionsCompat = {};
  for (const key of ["supportsStore", "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming", "requiresToolResultName"] as const) {
    if (o[key] !== undefined) {
      if (typeof o[key] !== "boolean") c.issues.push(`${at}.${key}: expected a boolean`);
      else out[key] = o[key] as boolean;
    }
  }
  if (o["maxTokensField"] !== undefined) {
    if (o["maxTokensField"] === "max_tokens" || o["maxTokensField"] === "max_completion_tokens") out.maxTokensField = o["maxTokensField"];
    else c.issues.push(`${at}.maxTokensField: expected "max_tokens" or "max_completion_tokens"`);
  }
  return out;
}

function parseRunner(c: Collector, v: unknown, at: string, d: { baseUrl: string; modelId: string; contextWindow: number }): RunnerBlock {
  const o = c.obj(v, at);
  const block: RunnerBlock = {
    baseUrl: c.str(o["baseUrl"], `${at}.baseUrl`, d.baseUrl),
    modelId: c.str(o["modelId"], `${at}.modelId`, d.modelId),
    contextWindow: c.num(o["contextWindow"], `${at}.contextWindow`, d.contextWindow, 1024),
    maxTokens: c.num(o["maxTokens"], `${at}.maxTokens`, 4096, 16),
  };
  const compat = parseCompat(c, o["compat"], `${at}.compat`);
  if (compat) block.compat = compat;
  return block;
}

/** Provisional until the G0 decision (UI-10): candidate C1 from the bake-off. */
export const PROVISIONAL_LMSTUDIO_MODEL_ID = "nail-qwen3.6-35b-a3b-mtp";
export const STRATA_MODEL_ID = "qwen3.8-flash-next-iq3_s";

/**
 * Validates and fills defaults. Throws `ConfigError` listing every structural problem.
 * `env` supplies the Windows path defaults; it is a parameter so tests do not depend on the host.
 */
export function parseConfig(raw: unknown, env: DefaultsEnv): Config {
  const c = new Collector();
  const root = c.obj(raw, "config");

  // telegram
  const tg = c.obj(root["telegram"], "telegram");
  const idsRaw = tg["allowedUserIds"];
  const allowedUserIds: number[] = [];
  if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
    c.issues.push("telegram.allowedUserIds: expected a non-empty array of numeric Telegram user ids");
  } else {
    idsRaw.forEach((id, i) => {
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) c.issues.push(`telegram.allowedUserIds[${i}]: expected a positive integer`);
      else allowedUserIds.push(id);
    });
  }

  // model
  const m = c.obj(root["model"], "model");
  const runnerRaw = m["runner"];
  let runner: RunnerName = "lmstudio";
  if (runnerRaw === undefined) runner = "lmstudio";
  else if (typeof runnerRaw === "string" && (RUNNER_NAMES as readonly string[]).includes(runnerRaw)) runner = runnerRaw as RunnerName;
  else c.issues.push(`model.runner: unknown runner ${JSON.stringify(runnerRaw)} (expected "lmstudio" or "strata")`);

  const runnersRaw = c.obj(m["runners"], "model.runners", true);
  const runners: ModelConfig["runners"] = {};
  if (runnersRaw["lmstudio"] !== undefined) {
    runners.lmstudio = parseRunner(c, runnersRaw["lmstudio"], "model.runners.lmstudio", {
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: PROVISIONAL_LMSTUDIO_MODEL_ID,
      contextWindow: 81920 - 8192,
    });
  }
  if (runnersRaw["strata"] !== undefined) {
    const so = c.obj(runnersRaw["strata"], "model.runners.strata");
    const base = parseRunner(c, so, "model.runners.strata", {
      baseUrl: "http://127.0.0.1:8080/v1",
      modelId: STRATA_MODEL_ID,
      contextWindow: 131072 - 8192,
    });
    runners.strata = {
      ...base,
      installDir: c.str(so["installDir"], "model.runners.strata.installDir", "D:\\Strata"),
      dataDir: c.str(so["dataDir"], "model.runners.strata.dataDir", "D:\\Strata-data"),
      configFile: c.str(so["configFile"], "model.runners.strata.configFile", winJoin(env.programData, "agent-007", "strata", "strata.json")),
      logDir: c.str(so["logDir"], "model.runners.strata.logDir", winJoin(env.programData, "agent-007", "logs")),
    };
  }
  const retryRaw = c.obj(m["retry"], "model.retry", true);
  const model: ModelConfig = {
    runner,
    runners,
    streamTimeoutMs: c.num(m["streamTimeoutMs"], "model.streamTimeoutMs", 600_000, 1000),
    retry: {
      enabled: c.bool(retryRaw["enabled"], "model.retry.enabled", true),
      maxRetries: c.num(retryRaw["maxRetries"], "model.retry.maxRetries", 50, 0),
      baseDelayMs: c.num(retryRaw["baseDelayMs"], "model.retry.baseDelayMs", 2000, 0),
      maxAgentDelayMs: c.num(retryRaw["maxAgentDelayMs"], "model.retry.maxAgentDelayMs", 60_000, 0),
    },
  };

  // folders
  const f = c.obj(root["folders"], "folders", true);
  const allow: FolderAllow[] = [];
  if (f["allow"] !== undefined && !Array.isArray(f["allow"])) c.issues.push("folders.allow: expected an array of {alias, path}");
  else
    (f["allow"] as unknown[] | undefined)?.forEach((e, i) => {
      const eo = c.obj(e, `folders.allow[${i}]`);
      const alias = c.str(eo["alias"], `folders.allow[${i}].alias`);
      if (alias && !/^[A-Za-z0-9_-]{1,32}$/.test(alias)) c.issues.push(`folders.allow[${i}].alias: use 1-32 letters, digits, "_" or "-"`);
      allow.push({ alias, path: c.str(eo["path"], `folders.allow[${i}].path`) });
    });
  const deny: string[] = [];
  if (f["deny"] !== undefined && !Array.isArray(f["deny"])) c.issues.push("folders.deny: expected an array of paths");
  else
    (f["deny"] as unknown[] | undefined)?.forEach((e, i) => {
      deny.push(c.str(e, `folders.deny[${i}]`));
    });

  // shell
  const s = c.obj(root["shell"], "shell", true);
  const shell: ShellConfig = {
    enabled: c.bool(s["enabled"], "shell.enabled", true),
    approvalTimeoutSec: c.num(s["approvalTimeoutSec"], "shell.approvalTimeoutSec", 600, 10),
    execTimeoutSec: c.num(s["execTimeoutSec"], "shell.execTimeoutSec", 120, 5),
    maxExecTimeoutSec: c.num(s["maxExecTimeoutSec"], "shell.maxExecTimeoutSec", 600, 5),
    maxOutputBytes: c.num(s["maxOutputBytes"], "shell.maxOutputBytes", 65536, 1024),
    returnBytes: c.num(s["returnBytes"], "shell.returnBytes", 8192, 256),
  };
  if (shell.execTimeoutSec > shell.maxExecTimeoutSec) c.issues.push("shell.execTimeoutSec must not exceed shell.maxExecTimeoutSec");

  // paths
  const p = c.obj(root["paths"], "paths", true);
  const programDataDir = c.str(p["programDataDir"], "paths.programDataDir", winJoin(env.programData, "agent-007"));
  const dataDir = c.str(p["dataDir"], "paths.dataDir", winJoin(env.localAppData, "agent-007"));
  const paths: PathsConfig = {
    programDataDir,
    dataDir,
    stateDir: c.str(p["stateDir"], "paths.stateDir", winJoin(dataDir, "state")),
    workspaceDir: c.str(p["workspaceDir"], "paths.workspaceDir", winJoin(dataDir, "workspace")),
    memoryFile: c.str(p["memoryFile"], "paths.memoryFile", winJoin(dataDir, "memory", "MEMORY.md")),
    userFile: c.str(p["userFile"], "paths.userFile", winJoin(programDataDir, "config", "USER.md")),
    logsDir: c.str(p["logsDir"], "paths.logsDir", winJoin(dataDir, "logs")),
    auditDir: c.str(p["auditDir"], "paths.auditDir", winJoin(dataDir, "audit")),
    controlDir: c.str(p["controlDir"], "paths.controlDir", winJoin(dataDir, "control")),
    runDir: c.str(p["runDir"], "paths.runDir", winJoin(dataDir, "run")),
  };

  // limits
  const l = c.obj(root["limits"], "limits", true);
  const limits: LimitsConfig = {
    readFileBytes: c.num(l["readFileBytes"], "limits.readFileBytes", 32768, 1024),
    searchMaxFiles: c.num(l["searchMaxFiles"], "limits.searchMaxFiles", 5000, 1),
    listMaxEntries: c.num(l["listMaxEntries"], "limits.listMaxEntries", 500, 1),
    searchMaxResults: c.num(l["searchMaxResults"], "limits.searchMaxResults", 200, 1),
  };

  const mainUserProfile = c.str(root["mainUserProfile"], "mainUserProfile", env.mainUserProfile);

  // mcp (Phase 2)
  const mcpRaw = c.obj(root["mcp"], "mcp", true);
  const mcpServers: McpServerConfig[] = [];
  if (mcpRaw["servers"] !== undefined && !Array.isArray(mcpRaw["servers"])) c.issues.push("mcp.servers: expected an array of {id, url, allowTools, macros}");
  else
    (mcpRaw["servers"] as unknown[] | undefined)?.forEach((e, i) => {
      const at = `mcp.servers[${i}]`;
      const eo = c.obj(e, at);
      const id = c.str(eo["id"], `${at}.id`);
      if (id && !MCP_SERVER_ID_PATTERN.test(id)) c.issues.push(`${at}.id: use 1-32 letters, digits, "-" or a single "_" (never "__"; it is part of the tool name)`);
      const server: McpServerConfig = {
        id,
        url: c.str(eo["url"], `${at}.url`),
        allowTools: stringList(c, eo["allowTools"], `${at}.allowTools`),
        macros: stringList(c, eo["macros"], `${at}.macros`),
      };
      if (eo["callTimeoutSec"] !== undefined) server.callTimeoutSec = c.num(eo["callTimeoutSec"], `${at}.callTimeoutSec`, 300, 1);
      mcpServers.push(server);
    });
  const mcp: McpConfig = { servers: mcpServers, callTimeoutSec: c.num(mcpRaw["callTimeoutSec"], "mcp.callTimeoutSec", 300, 1) };

  // jobs (Phase 2)
  const jobsRaw = c.obj(root["jobs"], "jobs", true);
  const jobs: JobsConfig = {
    ipcPort: c.num(jobsRaw["ipcPort"], "jobs.ipcPort", DEFAULT_IPC_PORT, 1024),
    approvalTimeoutSec: c.num(jobsRaw["approvalTimeoutSec"], "jobs.approvalTimeoutSec", 1800, 10),
    progressIntervalSec: c.num(jobsRaw["progressIntervalSec"], "jobs.progressIntervalSec", 30, 1),
  };
  if (jobs.ipcPort > 65535) c.issues.push("jobs.ipcPort: expected a port between 1024 and 65535");

  // flow (Phase 2)
  const flowRaw = c.obj(root["flow"], "flow", true);
  const flow: FlowConfig = { serverId: c.str(flowRaw["serverId"], "flow.serverId", DEFAULT_FLOW_SERVER_ID) };

  // secondOpinion (Phase 2, off by default)
  const soRaw = c.obj(root["secondOpinion"], "secondOpinion", true);
  const secondOpinion: SecondOpinionConfig = {
    enabled: c.bool(soRaw["enabled"], "secondOpinion.enabled", false),
    baseUrl: c.str(soRaw["baseUrl"], "secondOpinion.baseUrl", DEFAULT_PROXY_BASE_URL),
    modelId: parseOptionalString(c, soRaw["modelId"], "secondOpinion.modelId"),
  };
  if (secondOpinion.enabled && secondOpinion.modelId === "") c.issues.push("secondOpinion.modelId: required when secondOpinion.enabled is true");

  if (c.issues.length > 0) throw new ConfigError(c.issues);
  return {
    telegram: { allowedUserIds },
    model,
    folders: { allow, deny },
    shell,
    paths,
    limits,
    mainUserProfile,
    mcp,
    jobs,
    flow,
    secondOpinion,
  };
}

/** A string that may be empty (the empty string means "not set"). */
function parseOptionalString(c: Collector, v: unknown, at: string): string {
  if (v === undefined) return "";
  if (typeof v !== "string") {
    c.issues.push(`${at}: expected a string`);
    return "";
  }
  return v.trim();
}

function stringList(c: Collector, v: unknown, at: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    c.issues.push(`${at}: expected an array of strings`);
    return [];
  }
  const out: string[] = [];
  v.forEach((x, i) => {
    if (typeof x !== "string" || x.trim() === "") c.issues.push(`${at}[${i}]: expected a non-empty string`);
    else out.push(x);
  });
  return out;
}
