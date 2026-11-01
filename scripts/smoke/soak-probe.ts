/**
 * P0.7 soak probe: run from the MAIN user while the Strata scheduled task runs under the agent user.
 * Every `--health-min` minutes (default 10) it calls `/health`; every `--completion-min` minutes (default 60) it sends
 * one short streamed completion and records TTFT and decode tok/s. It logs JSONL to `.claude/temp/soak/probes.jsonl`
 * and writes `.claude/temp/soak/summary.json`.
 * PASS = every probe OK, the runner process id unchanged (no crash or restart; read with `tasklist`, which works across
 * users), no hang (no probe over 5 minutes), and tok/s drift within 20% [U23].
 * It starts nothing: if the runner is unreachable at the first probe it prints a clear FAIL and exits 1.
 *   node dist/scripts/smoke/soak-probe.js --runner strata [--hours 24] [--health-min 10] [--completion-min 60]
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkRunnerReachable, isMain, loadSmokeRunner, parseArgs, repoRoot, unreachableOutcome } from "./config.js";
import type { SmokeRunnerConfig } from "./config.js";
import { describeFetchError } from "../../src/runtime/health.js";

export interface ProbeLine {
  at: string;
  kind: "health" | "completion" | "process";
  ok: boolean;
  ms: number;
  detail: string;
  status?: number;
  ttftMs?: number;
  tokPerSec?: number;
  completionTokens?: number;
  pid?: number | undefined;
}

export interface SoakOptions {
  cfg: SmokeRunnerConfig;
  durationMs: number;
  healthEveryMs: number;
  completionEveryMs: number;
  outDir?: string;
  /** Image name of the runner process whose PID is watched. Default `strata.exe`. */
  processImage?: string;
  /** Test seam: returns the PIDs of the runner process, or undefined when it cannot be read. */
  pidProbe?: () => Promise<number[] | undefined>;
  /** A probe that takes longer than this counts as a hang. Default 5 minutes. */
  hangMs?: number;
  driftLimit?: number;
}

export interface SoakSummary {
  runner: string;
  pass: boolean;
  reason: string;
  probes: number;
  healthFailures: number;
  completionFailures: number;
  hangs: number;
  pids: number[];
  pidChanged: boolean;
  tokPerSec: { first?: number | undefined; last?: number | undefined; driftPct?: number | undefined };
  startedAt: string;
  endedAt: string;
}

export function defaultSoakDir(): string {
  return process.env["A7_SOAK_OUT"] ?? join(repoRoot(), ".claude", "temp", "soak");
}

/** PIDs of `image` through `tasklist` (works across users; start time is not available this way). */
export function tasklistPids(image: string): Promise<number[] | undefined> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(undefined);
    execFile("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(undefined);
      const pids = stdout
        .split(/\r?\n/)
        .map((l) => /^"[^"]*","(\d+)"/.exec(l)?.[1])
        .filter((p): p is string => p !== undefined)
        .map(Number);
      resolve(pids);
    });
  });
}

async function healthProbe(cfg: SmokeRunnerConfig): Promise<ProbeLine> {
  const t0 = Date.now();
  const url = `${new URL(cfg.baseUrl).origin}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    await res.arrayBuffer().catch(() => undefined);
    return { at: new Date().toISOString(), kind: "health", ok: res.ok, ms: Date.now() - t0, status: res.status, detail: res.ok ? "ok" : `HTTP ${res.status}` };
  } catch (e) {
    return { at: new Date().toISOString(), kind: "health", ok: false, ms: Date.now() - t0, detail: describeFetchError(e) };
  }
}

/** One short streamed completion; tok/s = completion tokens / decode time (total minus TTFT). */
export async function completionProbe(cfg: SmokeRunnerConfig): Promise<ProbeLine> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.modelId, messages: [{ role: "user", content: "Write about 80 words on the sea." }], max_tokens: 128, stream: true, stream_options: { include_usage: true } }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok || !res.body) return { at: new Date().toISOString(), kind: "completion", ok: false, ms: Date.now() - t0, status: res.status, detail: `HTTP ${res.status}` };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let ttft: number | undefined;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (ttft === undefined && /(^|\n)data: /.test(buf)) ttft = Date.now() - t0;
    }
    const total = Date.now() - t0;
    let tokens: number | undefined;
    let chars = 0;
    for (const line of buf.split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      try {
        const j = JSON.parse(line.slice(6)) as { usage?: { completion_tokens?: number }; choices?: { delta?: { content?: string } }[] };
        if (j.usage?.completion_tokens !== undefined) tokens = j.usage.completion_tokens;
        chars += j.choices?.[0]?.delta?.content?.length ?? 0;
      } catch {
        /* partial line */
      }
    }
    const completionTokens = tokens ?? Math.max(1, Math.round(chars / 4));
    const decodeMs = Math.max(1, total - (ttft ?? 0));
    const line: ProbeLine = { at: new Date().toISOString(), kind: "completion", ok: chars > 0, ms: total, status: res.status, detail: chars > 0 ? (tokens === undefined ? "ok (tokens estimated from text)" : "ok") : "empty answer", completionTokens, tokPerSec: Math.round((completionTokens / decodeMs) * 10_000) / 10 };
    if (ttft !== undefined) line.ttftMs = ttft;
    return line;
  } catch (e) {
    return { at: new Date().toISOString(), kind: "completion", ok: false, ms: Date.now() - t0, detail: describeFetchError(e) };
  }
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function summarize(lines: ProbeLine[], o: { runner: string; startedAt: string; hangMs: number; driftLimit: number }): SoakSummary {
  const health = lines.filter((l) => l.kind === "health");
  const comps = lines.filter((l) => l.kind === "completion");
  const hangs = lines.filter((l) => l.kind !== "process" && l.ms > o.hangMs).length;
  const pids = [...new Set(lines.filter((l) => l.kind === "process" && l.pid !== undefined).map((l) => l.pid as number))];
  const pidChanged = pids.length > 1;
  const rates = comps.filter((c) => c.ok && c.tokPerSec !== undefined).map((c) => c.tokPerSec as number);
  const first = median(rates.slice(0, 3));
  const last = median(rates.slice(-3));
  const driftPct = first !== undefined && last !== undefined && first > 0 ? Math.round(((first - last) / first) * 1000) / 10 : undefined;
  const healthFailures = health.filter((h) => !h.ok).length;
  const completionFailures = comps.filter((c) => !c.ok).length;
  const why: string[] = [];
  if (health.length === 0) why.push("no health probe ran");
  if (healthFailures > 0) why.push(`${healthFailures} health probe(s) failed`);
  if (completionFailures > 0) why.push(`${completionFailures} completion probe(s) failed`);
  if (hangs > 0) why.push(`${hangs} probe(s) took over ${Math.round(o.hangMs / 1000)} s (hang)`);
  if (pidChanged) why.push(`runner process id changed (${pids.join(" -> ")}): crash or restart`);
  if (driftPct !== undefined && driftPct > o.driftLimit * 100) why.push(`tok/s dropped ${driftPct}% (limit ${o.driftLimit * 100}%)`);
  return {
    runner: o.runner,
    pass: why.length === 0,
    reason: why.length === 0 ? `all ${health.length} health and ${comps.length} completion probes OK, process id stable, tok/s drift ${driftPct ?? "n/a"}%` : why.join("; "),
    probes: lines.length,
    healthFailures,
    completionFailures,
    hangs,
    pids,
    pidChanged,
    tokPerSec: { first, last, driftPct },
    startedAt: o.startedAt,
    endedAt: new Date().toISOString(),
  };
}

export async function runSoak(o: SoakOptions): Promise<SoakSummary> {
  const outDir = o.outDir ?? defaultSoakDir();
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "probes.jsonl");
  rmSync(file, { force: true });
  const startedAt = new Date().toISOString();
  const lines: ProbeLine[] = [];
  const record = (l: ProbeLine) => {
    lines.push(l);
    appendFileSync(file, JSON.stringify(l) + "\n");
  };
  const pidProbe = o.pidProbe ?? (() => tasklistPids(o.processImage ?? "strata.exe"));
  const end = Date.now() + o.durationMs;
  let nextHealth = 0;
  let nextCompletion = 0;
  for (;;) {
    const now = Date.now();
    if (now >= nextHealth) {
      const h = await healthProbe(o.cfg);
      record(h);
      const pids = await pidProbe();
      if (pids !== undefined) for (const pid of pids) record({ at: new Date().toISOString(), kind: "process", ok: true, ms: 0, detail: "pid seen", pid });
      nextHealth = Date.now() + o.healthEveryMs;
    }
    if (Date.now() >= nextCompletion) {
      record(await completionProbe(o.cfg));
      nextCompletion = Date.now() + o.completionEveryMs;
    }
    if (Date.now() >= end) break;
    await new Promise((r) => setTimeout(r, Math.max(20, Math.min(nextHealth, nextCompletion, end) - Date.now())));
  }
  const summary = summarize(lines, { runner: o.cfg.runner, startedAt, hangMs: o.hangMs ?? 300_000, driftLimit: o.driftLimit ?? 0.2 });
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadSmokeRunner(args);
  const reach = await checkRunnerReachable(cfg);
  if (!reach.reachable) {
    mkdirSync(dirname(join(defaultSoakDir(), "x")), { recursive: true });
    console.log(`SOAK FAIL runner=${cfg.runner}: ${unreachableOutcome("SOAK", cfg, reach).reason}`);
    process.exitCode = 1;
  } else {
    const num = (k: string, d: number) => (typeof args.flags[k] === "string" ? Number(args.flags[k]) : d);
    const s = await runSoak({
      cfg,
      durationMs: num("hours", 24) * 3_600_000,
      healthEveryMs: num("health-min", 10) * 60_000,
      completionEveryMs: num("completion-min", 60) * 60_000,
    });
    console.log(`SOAK ${s.pass ? "PASS" : "FAIL"} runner=${s.runner}: ${s.reason}`);
    process.exitCode = s.pass ? 0 : 1;
  }
}
