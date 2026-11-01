/**
 * System facts (S2.3): fixed PowerShell scripts, one per enum value. Model arguments are NEVER interpolated into a
 * script: `filter` and `limit` are applied in JS after parsing. Scripts run as
 * `powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64>` by absolute path, with a minimal environment,
 * a 20 s timeout and a 16 KB output cap. `replay: "safe"`.
 * The enum value `lmstudio` (frozen in P0.5) reports the CONFIGURED runner's state from the health monitor, with no shell.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Logger } from "../contracts.js";
import type { RunnerName } from "../config/schema.js";
import type { Redactor } from "../logging/redact.js";
import { defineTool } from "../pi/adapter.js";
import type { Static } from "../pi/adapter.js";
import type { HealthStatus } from "../runtime/health.js";
import { ToolRefusal, guarded, toolDescription, wrapUntrusted } from "./folders.js";
import { SYSTEM_FACTS, systemFactsParameters } from "./schemas.js";
import type { SystemFact } from "./schemas.js";

export type ScriptFact = Exclude<SystemFact, "lmstudio">;

const TAIL = "| ConvertTo-Json -Depth 3 -Compress";

/** One fixed script per fact. Each ends with `ConvertTo-Json -Depth 3 -Compress`. No placeholders, no model text. */
export const FACT_SCRIPTS: Readonly<Record<ScriptFact, string>> = {
  os: `$o = Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{ Caption=$o.Caption; Version=$o.Version; BuildNumber=$o.BuildNumber; Architecture=$o.OSArchitecture; InstallDate=$o.InstallDate.ToString('o'); LastBoot=$o.LastBootUpTime.ToString('o'); ComputerName=$o.CSName } ${TAIL}`,
  hardware: `$c = @(Get-CimInstance Win32_Processor | ForEach-Object { [pscustomobject]@{ Name=([string]$_.Name).Trim(); Cores=$_.NumberOfCores; LogicalProcessors=$_.NumberOfLogicalProcessors; MaxClockMHz=$_.MaxClockSpeed } }); $s = Get-CimInstance Win32_ComputerSystem; [pscustomobject]@{ Manufacturer=$s.Manufacturer; Model=$s.Model; TotalMemoryGB=[math]::Round($s.TotalPhysicalMemory/1GB,1); Processors=$c } ${TAIL}`,
  memory: `$o = Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{ TotalGB=[math]::Round($o.TotalVisibleMemorySize/1MB,2); FreeGB=[math]::Round($o.FreePhysicalMemory/1MB,2); UsedGB=[math]::Round(($o.TotalVisibleMemorySize-$o.FreePhysicalMemory)/1MB,2) } ${TAIL}`,
  disks: `Get-CimInstance Win32_LogicalDisk | ForEach-Object { [pscustomobject]@{ Drive=$_.DeviceID; Label=$_.VolumeName; FileSystem=$_.FileSystem; Type=[int]$_.DriveType; SizeGB=[math]::Round(([double]$_.Size)/1GB,1); FreeGB=[math]::Round(([double]$_.FreeSpace)/1GB,1) } } ${TAIL}`,
  processes: `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 100 | ForEach-Object { [pscustomobject]@{ Name=$_.ProcessName; Id=$_.Id; WorkingSetMB=[math]::Round($_.WorkingSet64/1MB,1); CpuSeconds=[math]::Round([double]$_.CPU,1) } } ${TAIL}`,
  services: `Get-Service | ForEach-Object { [pscustomobject]@{ Name=$_.Name; DisplayName=$_.DisplayName; Status=[string]$_.Status; StartType=[string]$_.StartType } } ${TAIL}`,
  apps: `$k = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; Get-ItemProperty -Path $k | Where-Object { $_.DisplayName } | ForEach-Object { [pscustomobject]@{ Name=[string]$_.DisplayName; Version=[string]$_.DisplayVersion; Publisher=[string]$_.Publisher } } | Sort-Object Name -Unique ${TAIL}`,
  uptime: `$o = Get-CimInstance Win32_OperatingSystem; $u = (Get-Date) - $o.LastBootUpTime; [pscustomobject]@{ LastBoot=$o.LastBootUpTime.ToString('o'); UptimeSeconds=[int64]$u.TotalSeconds; Uptime=([string]$u.Days + 'd ' + [string]$u.Hours + 'h ' + [string]$u.Minutes + 'm') } ${TAIL}`,
  network: `Get-NetIPAddress | Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '::1' } | ForEach-Object { [pscustomobject]@{ Interface=$_.InterfaceAlias; Address=$_.IPAddress; Family=[string]$_.AddressFamily; PrefixLength=$_.PrefixLength } } ${TAIL}`,
};

/** Facts whose result is one object (filter and limit do not apply). */
const OBJECT_FACTS: ReadonlySet<ScriptFact> = new Set<ScriptFact>(["os", "hardware", "memory", "uptime"]);

/** A fixed prelude, also a constant: quiet progress, UTF-8 output, never stop on a non-terminating error. */
export const PS_PRELUDE = "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ";

export const FACT_TIMEOUT_MS = 20_000;
export const FACT_OUTPUT_BYTES = 16 * 1024;
const RAW_OUTPUT_LIMIT = 4 * 1024 * 1024;
const DEFAULT_ROW_LIMIT = 50;

export interface PsRunOptions {
  timeoutMs: number;
  maxBytes: number;
}
export interface PsRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  overflow: boolean;
}
/** Test seam: receives the exact argument vector that would be passed to `powershell.exe`. */
export type PsRunner = (args: readonly string[], opts: PsRunOptions) => Promise<PsRunResult>;

export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** The argument vector for one script. The script is a constant; nothing from the model is in it. */
export function psArgs(script: string): string[] {
  const encoded = Buffer.from(PS_PRELUDE + script, "utf16le").toString("base64");
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
}

function minimalEnv(src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = ["SystemRoot", "windir", "SystemDrive", "TEMP", "TMP", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ALLUSERSPROFILE", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMPUTERNAME", "USERNAME", "USERDOMAIN", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"];
  const out: NodeJS.ProcessEnv = {};
  for (const k of keep) {
    const v = src[k] ?? src[k.toUpperCase()];
    if (v !== undefined) out[k] = v;
  }
  const root = src["SystemRoot"] ?? "C:\\Windows";
  out["PATH"] = `${root}\\System32;${root}`;
  return out;
}

/** Default runner: spawns the absolute `powershell.exe`, no shell, minimal env, hidden window, killed on timeout. */
export function defaultPsRunner(env: NodeJS.ProcessEnv = process.env): PsRunner {
  return (args, opts) =>
    new Promise((resolve) => {
      const child = spawn(powershellPath(env), [...args], { env: minimalEnv(env), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let timedOut = false;
      let overflow = false;
      let settled = false;
      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode, timedOut, overflow });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        setTimeout(() => finish(null), 500).unref();
      }, opts.timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        bytes += d.length;
        if (bytes > opts.maxBytes) {
          overflow = true;
          child.kill();
          return;
        }
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        if (stderr.length < 2000) stderr += d.toString("utf8");
      });
      child.on("error", () => finish(null));
      child.on("close", (code) => finish(code));
    });
}

export interface SystemFactsDeps {
  /** The configured runner (`model.runner`) and its model id, for `fact: "lmstudio"`. */
  runner: RunnerName;
  modelId: string;
  /** The S1.5 health monitor (or a fake). */
  health?: { status(): HealthStatus } | undefined;
  runPowerShell?: PsRunner;
  redact?: Redactor | undefined;
  logger?: Logger | undefined;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const RUNNER_DISPLAY: Record<RunnerName, string> = { lmstudio: "LM Studio", strata: "Strata" };

function parsePsJson(stdout: string): unknown {
  const text = stdout.replace(/^\uFEFF/, "").trim();
  if (text === "") return undefined; // ConvertTo-Json of nothing prints nothing
  return JSON.parse(text) as unknown;
}

function rowMatches(row: unknown, needle: string): boolean {
  if (row === null || typeof row !== "object") return String(row).toLowerCase().includes(needle);
  return Object.values(row as Record<string, unknown>).some((v) => (typeof v === "string" || typeof v === "number") && String(v).toLowerCase().includes(needle));
}

/** Serialises a result, dropping rows from the end until it fits the cap. */
function fit(fact: SystemFact, payload: { rows?: unknown[]; total?: number; data?: unknown }, cap: number): string {
  const build = (rows: unknown[] | undefined, truncated: boolean): string =>
    JSON.stringify(rows !== undefined ? { fact, count: rows.length, total: payload.total ?? rows.length, truncated, rows } : { fact, data: payload.data });
  if (payload.rows === undefined) {
    const s = build(undefined, false);
    return s.length <= cap ? s : `${s.slice(0, cap - 40)}...[truncated at ${cap} bytes]`;
  }
  let rows = payload.rows;
  let s = build(rows, rows.length < (payload.total ?? rows.length));
  while (Buffer.byteLength(s) > cap && rows.length > 0) {
    rows = rows.slice(0, Math.max(0, Math.floor(rows.length * 0.8) - (rows.length > 5 ? 0 : 1)));
    s = build(rows, true);
  }
  return s;
}

export async function systemFacts(deps: SystemFactsDeps, args: { fact: SystemFact; filter?: string | undefined; limit?: number | undefined }): Promise<string> {
  if (!(SYSTEM_FACTS as readonly string[]).includes(args.fact)) throw new ToolRefusal(`unknown fact ${JSON.stringify(String(args.fact).slice(0, 40))}.`);
  const cap = deps.maxOutputBytes ?? FACT_OUTPUT_BYTES;

  if (args.fact === "lmstudio") {
    const st = deps.health?.status();
    const data: Record<string, unknown> = {
      runner: deps.runner,
      runnerName: RUNNER_DISPLAY[deps.runner],
      modelId: deps.modelId,
      state: st === undefined ? "unknown" : st.up ? "up" : "down",
    };
    if (st) {
      data["since"] = new Date(st.since).toISOString();
      data["lastCheckedAt"] = new Date(st.lastCheckedAt).toISOString();
      data["detail"] = deps.redact ? deps.redact(st.detail) : st.detail;
    }
    return wrapUntrusted("system_facts:lmstudio", fit("lmstudio", { data }, cap));
  }

  const fact = args.fact as ScriptFact;
  const run = deps.runPowerShell ?? defaultPsRunner();
  const res = await run(psArgs(FACT_SCRIPTS[fact]), { timeoutMs: deps.timeoutMs ?? FACT_TIMEOUT_MS, maxBytes: RAW_OUTPUT_LIMIT });
  if (res.timedOut) throw new ToolRefusal(`system_facts ${fact} timed out after ${(deps.timeoutMs ?? FACT_TIMEOUT_MS) / 1000} s.`);
  if (res.overflow) throw new ToolRefusal(`system_facts ${fact}: the result was too large.`);
  if (res.exitCode !== 0) throw new ToolRefusal(`system_facts ${fact} failed (exit ${res.exitCode ?? "none"}).`);
  let parsed: unknown;
  try {
    parsed = parsePsJson(res.stdout);
  } catch {
    throw new ToolRefusal(`system_facts ${fact}: the result could not be parsed.`);
  }

  if (OBJECT_FACTS.has(fact)) return wrapUntrusted(`system_facts:${fact}`, fit(fact, { data: parsed ?? {} }, cap));

  let rows: unknown[] = parsed === undefined ? [] : Array.isArray(parsed) ? parsed : [parsed];
  const needle = args.filter?.trim().toLowerCase();
  if (needle) rows = rows.filter((r) => rowMatches(r, needle));
  const total = rows.length;
  const limit = Math.max(1, Math.min(200, Math.trunc(args.limit ?? DEFAULT_ROW_LIMIT)));
  return wrapUntrusted(`system_facts:${fact}`, fit(fact, { rows: rows.slice(0, limit), total }, cap));
}

export function createSystemFactsTool(deps: SystemFactsDeps) {
  return defineTool({
    name: "system_facts",
    description: toolDescription("system_facts"),
    parameters: systemFactsParameters,
    replay: "safe",
    execute: (args: Static<typeof systemFactsParameters>) => guarded("system_facts", deps.logger, () => systemFacts(deps, args)),
  });
}
