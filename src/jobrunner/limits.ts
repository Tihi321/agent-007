/**
 * Job runner configuration and limits (S11.3, I18, I22).
 *
 * `jobrunner.json` lives in `C:\ProgramData\agent-007\jobrunner\` (the agent user cannot read it, I17). It is parsed
 * strictly here: an unknown key is an error (keys starting with `_` are comments), and there is no way to configure a
 * non-loopback bind (the IPC host is not a setting at all).
 *
 * The limits are the job runner's OWN (I22): they hold whatever the agent sends.
 *   - daily job cap and daily credit cap (counted from the journal, so a restart does not reset them);
 *   - per-template max credits (the template's `flow.maxCredits`, optionally lowered here);
 *   - concurrency per engine (I18: one Claude job and one DeepSeek job at a time; more are queued);
 *   - a duration cap per job (the template's `timeoutMin`, never above `maxDurationMin`);
 *   - an output cap per job (bytes of events kept; past it the job is cancelled).
 */
import { homedir } from "node:os";
import { win32 } from "node:path";
import type { IpcErrorCode } from "../ipc/protocol.js";
import type { JobEngine, JobEvent, JobTemplate, Json } from "../jobs/contracts.js";
import { JOB_ENGINES } from "../jobs/contracts.js";

export const DEFAULT_IPC_PORT = 47007;
/** The settings UI port (UI-19a proposed 47007, which is already the IPC default, so the UI default is the next port). */
export const DEFAULT_SETTINGS_UI_PORT = 47008;
export const DEFAULT_HUB_DIR = "C:\\projects\\Personal\\creative-hub";
export const DEFAULT_PROGRAM_DATA_JOBRUNNER = "C:\\ProgramData\\agent-007\\jobrunner";

export interface EngineConfig {
  enabled: boolean;
  /** `dsh` only: true after the S13.2 live probe proved that dsh asks before running a command. */
  verified?: boolean;
  /** `claude` only: absolute path of the real `claude.exe`. Absent means `claude` on the main user's PATH. */
  path?: string;
}

export interface HubConfig {
  /** The creative-hub folder: `<dir>\scripts\hub.ps1` is the only thing ever run. */
  dir: string;
  /** The fixed list of services (from creative-hub `services.json`). Used when `servicesFile` is not set. */
  services: string[];
  /** Optional: read the service ids from this file (creative-hub `services.json`) instead. */
  servicesFile?: string;
  pwsh: string;
  /** Optional ports per service, for the `hub_status` TCP probe. */
  ports: Record<string, number>;
  startTimeoutSec: number;
  statusTimeoutSec: number;
}

export interface LimitsConfig {
  dailyJobCap: number;
  /** Total of the approved Flow credits per day. 0 (the default) means no Flow job may run: there is no default budget (D11). */
  dailyCreditCap: number;
  /** Lowers a template's `flow.maxCredits` (never raises it). */
  perTemplateMaxCredits: Record<string, number>;
  maxConcurrent: Record<JobEngine, number>;
  maxDurationMin: number;
  outputCapBytes: number;
  maxEventTextChars: number;
  permissionTimeoutSec: number;
  cancelGraceSec: number;
}

/** The Phase 3 settings UI (S18.1): loopback only, off by default. There is no LAN or tunnel mode. */
export interface SettingsUiConfig {
  enabled: boolean;
  /** `127.0.0.1` or `localhost`; the loader refuses anything else. */
  host: string;
  port: number;
  sessionIdleMin: number;
  sessionMaxHours: number;
  /** The agent's Windows user, named when a new allowed folder has no NTFS grant (the UI never changes ACLs). */
  agentUser: string;
}

export interface JobRunnerConfig {
  ipcPort: number;
  paths: { dataDir: string; configDir: string; templatesDir: string; /** `C:\ProgramData\agent-007\settings`: security.json, personas, audit. */ settingsDir: string };
  settingsUi: SettingsUiConfig;
  /** The cwd of a job must realpath-equal one of these (default: creative-hub only). */
  cwdAllowlist: string[];
  /** Always refused, even if an allowlist entry is under one (Pixotope and work paths, UI-2). */
  denyPaths: string[];
  limits: LimitsConfig;
  engines: Record<JobEngine, EngineConfig>;
  hub: HubConfig;
  flow: { serverId: string };
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`jobrunner.json is invalid: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export interface ConfigEnv {
  localAppData?: string;
  programData?: string;
}

const TOP_KEYS = new Set(["ipcPort", "paths", "cwdAllowlist", "denyPaths", "limits", "engines", "hub", "flow", "settingsUi"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Reader {
  constructor(readonly problems: string[]) {}
  obj(v: unknown, path: string, allowed: Set<string> | string[] | "any"): Record<string, unknown> {
    if (v === undefined) return {};
    if (!isObj(v)) {
      this.problems.push(`${path} must be an object`);
      return {};
    }
    if (allowed === "any") return v;
    const set = allowed instanceof Set ? allowed : new Set(allowed);
    for (const k of Object.keys(v)) if (!k.startsWith("_") && !set.has(k)) this.problems.push(`${path}.${k} is not a known setting`);
    return v;
  }
  int(v: unknown, path: string, def: number, min: number, max: number): number {
    if (v === undefined) return def;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      this.problems.push(`${path} must be an integer from ${min} to ${max}`);
      return def;
    }
    return v;
  }
  bool(v: unknown, path: string, def: boolean): boolean {
    if (v === undefined) return def;
    if (typeof v !== "boolean") {
      this.problems.push(`${path} must be true or false`);
      return def;
    }
    return v;
  }
  str(v: unknown, path: string, def: string): string {
    if (v === undefined) return def;
    if (typeof v !== "string" || v.trim() === "") {
      this.problems.push(`${path} must be a non-empty string`);
      return def;
    }
    return v;
  }
  absPath(v: unknown, path: string, def: string): string {
    const s = this.str(v, path, def);
    if (!win32.isAbsolute(s) || s.startsWith("\\\\")) this.problems.push(`${path} must be an absolute local path`);
    return s;
  }
  pathList(v: unknown, path: string, def: string[], nonEmpty: boolean): string[] {
    if (v === undefined) return [...def];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      this.problems.push(`${path} must be a list of paths`);
      return [...def];
    }
    for (const p of v as string[]) if (!win32.isAbsolute(p) || p.startsWith("\\\\")) this.problems.push(`${path}: "${p}" is not an absolute local path`);
    if (nonEmpty && v.length === 0) this.problems.push(`${path} must not be empty`);
    return [...(v as string[])];
  }
}

/** Parses `jobrunner.json` (already JSON-parsed). Throws `ConfigError` with every problem found. */
export function parseJobRunnerConfig(raw: unknown, env: ConfigEnv = {}): JobRunnerConfig {
  const problems: string[] = [];
  const r = new Reader(problems);
  if (raw === undefined) raw = {};
  const top = r.obj(raw, "jobrunner", TOP_KEYS);
  const localAppData = env.localAppData ?? process.env["LOCALAPPDATA"] ?? win32.join(homedir(), "AppData", "Local");

  const pathsRaw = r.obj(top["paths"], "paths", ["dataDir", "configDir", "templatesDir", "settingsDir"]);
  const configDir = r.absPath(pathsRaw["configDir"], "paths.configDir", DEFAULT_PROGRAM_DATA_JOBRUNNER);
  const paths = {
    dataDir: r.absPath(pathsRaw["dataDir"], "paths.dataDir", win32.join(localAppData, "agent-007-jobrunner")),
    configDir,
    templatesDir: r.absPath(pathsRaw["templatesDir"], "paths.templatesDir", win32.join(configDir, "templates")),
    settingsDir: r.absPath(pathsRaw["settingsDir"], "paths.settingsDir", win32.join(win32.dirname(configDir), "settings")),
  };

  const limRaw = r.obj(top["limits"], "limits", [
    "dailyJobCap",
    "dailyCreditCap",
    "perTemplateMaxCredits",
    "maxConcurrent",
    "maxDurationMin",
    "outputCapBytes",
    "maxEventTextChars",
    "permissionTimeoutSec",
    "cancelGraceSec",
  ]);
  const concRaw = r.obj(limRaw["maxConcurrent"], "limits.maxConcurrent", [...JOB_ENGINES]);
  const perTemplate: Record<string, number> = {};
  const ptRaw = r.obj(limRaw["perTemplateMaxCredits"], "limits.perTemplateMaxCredits", "any");
  for (const [k, v] of Object.entries(ptRaw)) {
    if (k.startsWith("_")) continue;
    perTemplate[k] = r.int(v, `limits.perTemplateMaxCredits.${k}`, 0, 0, 1_000_000);
  }
  const limits: LimitsConfig = {
    dailyJobCap: r.int(limRaw["dailyJobCap"], "limits.dailyJobCap", 20, 0, 10_000),
    dailyCreditCap: r.int(limRaw["dailyCreditCap"], "limits.dailyCreditCap", 0, 0, 10_000_000),
    perTemplateMaxCredits: perTemplate,
    maxConcurrent: {
      claude: r.int(concRaw["claude"], "limits.maxConcurrent.claude", 1, 1, 4),
      dsh: r.int(concRaw["dsh"], "limits.maxConcurrent.dsh", 1, 1, 4),
      hub: r.int(concRaw["hub"], "limits.maxConcurrent.hub", 1, 1, 4),
    },
    maxDurationMin: r.int(limRaw["maxDurationMin"], "limits.maxDurationMin", 360, 1, 1440),
    outputCapBytes: r.int(limRaw["outputCapBytes"], "limits.outputCapBytes", 5 * 1024 * 1024, 1024, 512 * 1024 * 1024),
    maxEventTextChars: r.int(limRaw["maxEventTextChars"], "limits.maxEventTextChars", 8000, 100, 1_000_000),
    permissionTimeoutSec: r.int(limRaw["permissionTimeoutSec"], "limits.permissionTimeoutSec", 1800, 1, 86_400),
    cancelGraceSec: r.int(limRaw["cancelGraceSec"], "limits.cancelGraceSec", 10, 0, 600),
  };

  const engRaw = r.obj(top["engines"], "engines", [...JOB_ENGINES]);
  const engOne = (name: JobEngine, defEnabled: boolean): EngineConfig => {
    const e = r.obj(engRaw[name], `engines.${name}`, name === "dsh" ? ["enabled", "verified"] : name === "claude" ? ["enabled", "path"] : ["enabled"]);
    const out: EngineConfig = { enabled: r.bool(e["enabled"], `engines.${name}.enabled`, defEnabled) };
    if (name === "dsh") out.verified = r.bool(e["verified"], "engines.dsh.verified", false);
    if (name === "claude" && e["path"] !== undefined) {
      const p = r.absPath(e["path"], "engines.claude.path", "");
      if (!/\.exe$/i.test(p)) problems.push("engines.claude.path must be a real executable (.exe): the driver never runs a shell or a .cmd file");
      out.path = p;
    }
    return out;
  };
  // dsh is off until S13.4 and the live probe (S13.2); everything else is on.
  const engines: Record<JobEngine, EngineConfig> = { claude: engOne("claude", true), dsh: engOne("dsh", false), hub: engOne("hub", true) };

  const cwdAllowlist = r.pathList(top["cwdAllowlist"], "cwdAllowlist", [DEFAULT_HUB_DIR], true);
  const denyPaths = r.pathList(top["denyPaths"], "denyPaths", ["C:\\Pixotope", "C:\\ProgramData\\agent-007"], false);

  const hubRaw = r.obj(top["hub"], "hub", ["dir", "services", "servicesFile", "pwsh", "ports", "startTimeoutSec", "statusTimeoutSec"]);
  const portsRaw = r.obj(hubRaw["ports"], "hub.ports", "any");
  const ports: Record<string, number> = {};
  for (const [k, v] of Object.entries(portsRaw)) {
    if (k.startsWith("_")) continue;
    ports[k] = r.int(v, `hub.ports.${k}`, 0, 1, 65535);
  }
  let services: string[] = [];
  if (hubRaw["services"] !== undefined) {
    const s = hubRaw["services"];
    if (!Array.isArray(s) || s.some((x) => typeof x !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(x))) problems.push("hub.services must be a list of service ids (lowercase letters, digits and -)");
    else services = [...(s as string[])];
  }
  const hub: HubConfig = {
    dir: r.absPath(hubRaw["dir"], "hub.dir", DEFAULT_HUB_DIR),
    services,
    pwsh: r.str(hubRaw["pwsh"], "hub.pwsh", "pwsh"),
    ports,
    startTimeoutSec: r.int(hubRaw["startTimeoutSec"], "hub.startTimeoutSec", 120, 1, 3600),
    statusTimeoutSec: r.int(hubRaw["statusTimeoutSec"], "hub.statusTimeoutSec", 30, 1, 600),
  };
  if (hubRaw["servicesFile"] !== undefined) hub.servicesFile = r.absPath(hubRaw["servicesFile"], "hub.servicesFile", "");

  const flowRaw = r.obj(top["flow"], "flow", ["serverId"]);
  const flow = { serverId: r.str(flowRaw["serverId"], "flow.serverId", "flow-music-mcp") };

  const ipcPort = r.int(top["ipcPort"], "ipcPort", DEFAULT_IPC_PORT, 1, 65535);

  const uiRaw = r.obj(top["settingsUi"], "settingsUi", ["enabled", "host", "port", "sessionIdleMin", "sessionMaxHours", "agentUser"]);
  const settingsUi: SettingsUiConfig = {
    enabled: r.bool(uiRaw["enabled"], "settingsUi.enabled", false),
    host: r.str(uiRaw["host"], "settingsUi.host", "127.0.0.1"),
    port: r.int(uiRaw["port"], "settingsUi.port", DEFAULT_SETTINGS_UI_PORT, 1024, 65535),
    sessionIdleMin: r.int(uiRaw["sessionIdleMin"], "settingsUi.sessionIdleMin", 30, 1, 1440),
    sessionMaxHours: r.int(uiRaw["sessionMaxHours"], "settingsUi.sessionMaxHours", 8, 1, 168),
    agentUser: r.str(uiRaw["agentUser"], "settingsUi.agentUser", "agent007"),
  };
  if (settingsUi.host !== "127.0.0.1" && settingsUi.host !== "localhost") problems.push('settingsUi.host must be "127.0.0.1" or "localhost": there is no LAN or tunnel mode');
  if (settingsUi.port === ipcPort) problems.push("settingsUi.port must differ from ipcPort");
  if (problems.length > 0) throw new ConfigError(problems);
  return { ipcPort, paths, settingsUi, cwdAllowlist, denyPaths, limits, engines, hub, flow };
}

// ---- limits ---------------------------------------------------------------------------------------

export interface UsageRecord {
  createdAt: number;
  flowBudgetCredits?: number | undefined;
}

export interface DailyUsage {
  jobs: number;
  credits: number;
}

export type LimitCheck = { ok: true } | { ok: false; code: IpcErrorCode; message: string };

export class Limits {
  constructor(
    readonly config: JobRunnerConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** The local calendar day of a timestamp (the "daily" caps reset at local midnight). */
  dayKey(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  usageToday(records: Iterable<UsageRecord>): DailyUsage {
    const today = this.dayKey(this.now());
    let jobs = 0;
    let credits = 0;
    for (const r of records) {
      if (this.dayKey(r.createdAt) !== today) continue;
      jobs++;
      credits += r.flowBudgetCredits ?? 0;
    }
    return { jobs, credits };
  }

  maxConcurrent(engine: JobEngine): number {
    return this.config.limits.maxConcurrent[engine];
  }

  /** The most credits one job of this template may be approved for: the template's own cap, lowered by the config. */
  maxCreditsFor(template: JobTemplate): number {
    const own = template.flow.enabled ? (template.flow.maxCredits ?? 0) : 0;
    const override = this.config.limits.perTemplateMaxCredits[template.id];
    return override === undefined ? own : Math.min(own, override);
  }

  /** The caps that apply to a new job, before it is journaled. Resume does not call this (the job was counted once). */
  checkSubmit(input: { template: JobTemplate; flowBudgetCredits: number | undefined; usage: DailyUsage }): LimitCheck {
    const { template, flowBudgetCredits, usage } = input;
    const lim = this.config.limits;
    if (usage.jobs >= lim.dailyJobCap) return { ok: false, code: "limit_exceeded", message: `the daily job cap (${lim.dailyJobCap}) is reached` };
    if (!template.flow.enabled) {
      if (flowBudgetCredits !== undefined && flowBudgetCredits !== 0) return { ok: false, code: "bad_request", message: "this template does not use Flow, so no credit budget may be sent" };
      return { ok: true };
    }
    if (flowBudgetCredits === undefined || !Number.isFinite(flowBudgetCredits) || flowBudgetCredits <= 0) {
      return { ok: false, code: "bad_request", message: "this template uses Flow: the approved credit budget (flowBudgetCredits) is required" };
    }
    const perTemplate = this.maxCreditsFor(template);
    if (flowBudgetCredits > perTemplate) return { ok: false, code: "limit_exceeded", message: `the template allows at most ${perTemplate} credits per job` };
    if (usage.credits + flowBudgetCredits > lim.dailyCreditCap) {
      return { ok: false, code: "limit_exceeded", message: `the daily credit cap (${lim.dailyCreditCap}) would be exceeded (${usage.credits} already approved today)` };
    }
    return { ok: true };
  }

  /** The job's time limit: its template's `timeoutMin`, never above `maxDurationMin`. */
  timeoutMs(template: JobTemplate): number {
    return Math.min(template.timeoutMin, this.config.limits.maxDurationMin) * 60_000;
  }

  newOutputBudget(): OutputBudget {
    return new OutputBudget(this.config.limits.outputCapBytes, this.config.limits.maxEventTextChars);
  }
}

// ---- output cap -------------------------------------------------------------------------------------

/** A JobEvent without the fields the core assigns (`jobId`, `seq`, `ts`). */
export type EventBody = JobEvent extends infer E ? (E extends JobEvent ? Omit<E, "jobId" | "seq" | "ts"> : never) : never;

export interface Admitted {
  /** The event to keep, possibly shortened; `undefined` when the cap was already reached. */
  event: EventBody | undefined;
  /** True once the total passed the cap (from this event on, the job must be stopped). */
  exceeded: boolean;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... ${text.length - max} more characters not kept]`;
}

/**
 * Keeps a job's output bounded: each event's text is cut to `maxEventChars`, the total size of the kept events is
 * counted against `capBytes`, and events after the cap are dropped. The `result` event is always admitted (it is the
 * job's answer, already cut to size).
 */
export class OutputBudget {
  private total = 0;
  private over = false;
  private dropped = 0;
  constructor(
    readonly capBytes: number,
    readonly maxEventChars: number,
  ) {}

  get bytes(): number {
    return this.total;
  }
  get exceeded(): boolean {
    return this.over;
  }
  get droppedEvents(): number {
    return this.dropped;
  }

  admit(body: EventBody): Admitted {
    const shortened = this.shorten(body);
    const size = Buffer.byteLength(JSON.stringify(shortened), "utf8");
    if (shortened.kind === "result") {
      this.total += size;
      return { event: shortened, exceeded: this.over };
    }
    if (this.over) {
      this.dropped++;
      return { event: undefined, exceeded: true };
    }
    this.total += size;
    if (this.total > this.capBytes) {
      this.over = true;
      return { event: shortened, exceeded: true };
    }
    return { event: shortened, exceeded: false };
  }

  private shorten(body: EventBody): EventBody {
    const max = this.maxEventChars;
    switch (body.kind) {
      case "text":
        return { ...body, text: clip(body.text, max) };
      case "tool_result":
        return body.text === undefined ? body : { ...body, text: clip(body.text, max) };
      case "progress":
        return { ...body, message: clip(body.message, max) };
      case "result":
        return { ...body, text: clip(body.text, max) };
      case "retry":
        return { ...body, reason: clip(body.reason, max) };
      case "tool_call": {
        const json = JSON.stringify(body.input);
        if (json !== undefined && json.length > max) {
          const note: Json = { truncated: true, chars: json.length, preview: json.slice(0, Math.min(200, max)) };
          return { ...body, input: note };
        }
        return body;
      }
      default:
        return body;
    }
  }
}
