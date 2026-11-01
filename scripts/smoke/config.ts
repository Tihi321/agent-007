/**
 * Minimal dev-config reader for the Phase 0 smoke scripts and the bake-off (P0.4).
 *
 * Reads `%LOCALAPPDATA%\agent-007-dev\config.json` (only its `model` block, in the shape S1.2 formalises) and
 * `%LOCALAPPDATA%\agent-007-dev\secrets.json` (tokens). Set `A7_DEV_DIR` to point somewhere else (tests do).
 * `--runner lmstudio|strata` overrides `model.runner` for one run.
 * It never imports the Pi packages: the adapter builds the provider.
 * Tokens are kept in memory only and never printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVISIONAL_LMSTUDIO_MODEL_ID, RUNNER_NAMES, STRATA_MODEL_ID } from "../../src/config/schema.js";
import type { RunnerName } from "../../src/config/schema.js";
import { describeFetchError } from "../../src/runtime/health.js";
import type { OpenAICompletionsCompat } from "../../src/pi/adapter.js";
import { createRedactor } from "../../src/logging/redact.js";
import { checkProxy, formatSetupReport } from "../../src/proxy/discover.js";
import type { FetchLike } from "../../src/proxy/health.js";

export interface SmokeRunnerConfig {
  runner: RunnerName;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  /** LM Studio token or Strata key from the dev secrets file; absent = keyless. */
  apiKey?: string | undefined;
  compat?: OpenAICompletionsCompat | undefined;
  /** `model.streamTimeoutMs` of the dev config, if set. */
  streamTimeoutMs?: number | undefined;
  /** MA4: set when the target is the ACP proxy (`--proxy-port`): the eval talks to `claude/sonnet` through it. */
  viaProxy?: { port: number } | undefined;
}

export interface ParsedArgs {
  runner?: RunnerName | undefined;
  only?: string[] | undefined;
  flags: Record<string, string | true>;
  positional: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else flags[a.slice(2)] = true;
      }
    } else positional.push(a);
  }
  const r = flags["runner"];
  if (typeof r === "string" && !(RUNNER_NAMES as readonly string[]).includes(r)) throw new Error(`--runner must be one of ${RUNNER_NAMES.join(", ")}`);
  const only = typeof flags["only"] === "string" ? flags["only"].split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : undefined;
  return { runner: typeof r === "string" ? (r as RunnerName) : undefined, only, flags, positional };
}

/** True when the module is the process entry point (not imported by a test or run-all). */
export function isMain(metaUrl: string): boolean {
  const a = process.argv[1];
  return a !== undefined && resolve(a) === fileURLToPath(metaUrl);
}

export function repoRoot(): string {
  // dist/scripts/smoke/config.js -> repo root (three levels up)
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function devDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["A7_DEV_DIR"] ?? join(env["LOCALAPPDATA"] ?? join(process.env["USERPROFILE"] ?? ".", "AppData", "Local"), "agent-007-dev");
}

export function smokeOutDir(): string {
  return process.env["A7_SMOKE_OUT"] ?? join(repoRoot(), ".claude", "temp", "smoke");
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_URL: Record<RunnerName, string> = { lmstudio: "http://127.0.0.1:1234/v1", strata: "http://127.0.0.1:8080/v1" };
const DEFAULT_MODEL: Record<RunnerName, string> = { lmstudio: PROVISIONAL_LMSTUDIO_MODEL_ID, strata: STRATA_MODEL_ID };
const DEFAULT_CONTEXT: Record<RunnerName, number> = { lmstudio: 81920 - 8192, strata: 131072 - 8192 };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Resolves the runner to test. `--model <id>` overrides the model id (the bake-off uses it per candidate),
 * `--base-url` the URL (the S7 proxy), `--compat '<json>'` the compat flags for one run, `--no-key` drops the key.
 */
export function loadSmokeRunner(args: ParsedArgs, dir: string = devDir()): SmokeRunnerConfig {
  const cfg = readJson(join(dir, "config.json"));
  const secrets = readJson(join(dir, "secrets.json"));
  const model = (cfg?.["model"] ?? {}) as Record<string, unknown>;
  const configured = str(model["runner"]);
  const runner: RunnerName =
    args.runner ?? (configured && (RUNNER_NAMES as readonly string[]).includes(configured) ? (configured as RunnerName) : "lmstudio");
  const proxyPortFlag = args.flags["proxy-port"];
  if (typeof proxyPortFlag === "string") {
    // MA4: the Claude brain through the proxy. The key is the proxy key in the dev secrets file (never printed); the runner name is nominal.
    const port = Number(proxyPortFlag);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--proxy-port must be 1 to 65535");
    return {
      runner,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: typeof args.flags["model"] === "string" ? args.flags["model"] : "claude/sonnet",
      contextWindow: 200000 - 8192,
      maxTokens: 8192,
      apiKey: args.flags["no-key"] ? undefined : str(secrets?.["proxyApiKey"]),
      streamTimeoutMs: num(model["streamTimeoutMs"]),
      viaProxy: { port },
    };
  }
  const block = ((model["runners"] ?? {}) as Record<string, Record<string, unknown> | undefined>)[runner] ?? {};
  const keyName = runner === "lmstudio" ? "lmStudioApiToken" : "strataApiKey";
  const apiKey = args.flags["no-key"] ? undefined : str(secrets?.[keyName]);
  let compat: OpenAICompletionsCompat | undefined = block["compat"] as OpenAICompletionsCompat | undefined;
  if (typeof args.flags["compat"] === "string") compat = { ...(compat ?? {}), ...(JSON.parse(args.flags["compat"]) as OpenAICompletionsCompat) };
  return {
    runner,
    baseUrl: typeof args.flags["base-url"] === "string" ? args.flags["base-url"] : (str(block["baseUrl"]) ?? DEFAULT_URL[runner]),
    modelId: typeof args.flags["model"] === "string" ? args.flags["model"] : (str(block["modelId"]) ?? DEFAULT_MODEL[runner]),
    contextWindow: num(block["contextWindow"]) ?? DEFAULT_CONTEXT[runner],
    maxTokens: num(block["maxTokens"]) ?? 4096,
    apiKey,
    compat,
    streamTimeoutMs: num(model["streamTimeoutMs"]),
  };
}

// ---- results -------------------------------------------------------------------------------

export interface SmokeOutcome {
  id: string;
  runner: RunnerName;
  pass: boolean;
  reason: string;
  /** Evidence for `phase0-report.md`; never contains secrets. */
  details: Record<string, unknown>;
}

export function formatSmokeLine(o: SmokeOutcome): string {
  return `SMOKE ${o.id} ${o.pass ? "PASS" : "FAIL"} runner=${o.runner}: ${o.reason}`;
}

/** Writes `.claude/temp/smoke/<id>.json` (per runner too) and returns the final line. */
export function writeSmokeResult(o: SmokeOutcome, outDir: string = smokeOutDir()): string {
  mkdirSync(outDir, { recursive: true });
  const body = JSON.stringify({ ...o, at: new Date().toISOString() }, null, 2);
  writeFileSync(join(outDir, `${o.id}.json`), body);
  writeFileSync(join(outDir, `${o.id}.${o.runner}.json`), body);
  return formatSmokeLine(o);
}

/** Prints the final line, writes the JSON, and sets the exit code (0 PASS, 1 FAIL). */
export function finish(o: SmokeOutcome): void {
  console.log(writeSmokeResult(o));
  process.exitCode = o.pass ? 0 : 1;
}

export function failOutcome(id: string, runner: RunnerName, reason: string, details: Record<string, unknown> = {}): SmokeOutcome {
  return { id, runner, pass: false, reason, details };
}

// ---- reachability --------------------------------------------------------------------------

export interface Reachability {
  reachable: boolean;
  /** HTTP status of GET /models when reachable. */
  status?: number;
  detail: string;
}

/** Does anything answer at the runner URL? Any HTTP status (even 401) counts as reachable. */
export async function checkRunnerReachable(cfg: Pick<SmokeRunnerConfig, "baseUrl">, timeoutMs = 5000): Promise<Reachability> {
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer().catch(() => undefined);
    return { reachable: true, status: res.status, detail: `HTTP ${res.status}` };
  } catch (e) {
    const err = e as { name?: string };
    if (err.name === "TimeoutError" || err.name === "AbortError") return { reachable: false, detail: `no answer within ${timeoutMs} ms` };
    return { reachable: false, detail: describeFetchError(e) };
  }
}

/**
 * MA4: for a proxy target, one `GET /healthz` + `GET /v1/models` check (the S23 setup check) instead of the bare reachability probe.
 * Refuses when the proxy has no key, does not list the model, or reports the Claude login as an API key. No chat call is made here.
 */
export async function checkProxyTarget(cfg: SmokeRunnerConfig, fetchFn?: FetchLike): Promise<Reachability> {
  if (!cfg.viaProxy) return checkRunnerReachable(cfg);
  const provider = cfg.modelId.startsWith("claude/") ? "claude" : "codex";
  const r = await checkProxy({ port: cfg.viaProxy.port, apiKey: cfg.apiKey, presets: [{ id: "eval", kind: "acp", modelId: cfg.modelId, providerId: provider as "claude" | "codex" }], ...(fetchFn ? { fetch: fetchFn } : {}) });
  const line = formatSetupReport(r, createRedactor([cfg.apiKey])).filter((l) => /FAILED|SKIPPED|NEEDS ATTENTION|UNAVAILABLE|warning/.test(l)).join("; ");
  return r.ok ? { reachable: true, status: 200, detail: "proxy ok" } : { reachable: false, detail: line || "setup check not OK" };
}

export function unreachableOutcome(id: string, cfg: SmokeRunnerConfig, r: Reachability): SmokeOutcome {
  return failOutcome(id, cfg.runner, `runner unreachable (${r.detail} at ${cfg.baseUrl}); nothing was started. Start the runner first (LM Studio server, or Strata per P0.3b [GO]).`, {
    baseUrl: cfg.baseUrl,
    detail: r.detail,
    live: "UNTESTED",
  });
}
