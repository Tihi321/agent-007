/**
 * Phase 3 mini-eval runner (S19.7). 12 prompts x 3 runs, one at a time, through the REAL Harness and pi-ai request shape with the Phase 3
 * tools over fakes (`world.ts`): nothing is spent and nothing outside a temp folder changes. Same harness as the routing eval (read-only use).
 *
 *   node dist/scripts/settings-eval/run.js --runner lmstudio --model <model id> --label G0pick --results <ticket>/settings-eval-results.md
 *
 * The model runner is NOT started by this script. With the runner unreachable it prints `SETTINGS-EVAL <label> FAIL ...` and exits 1.
 * Output: `.claude/temp/settings-eval/<label>/<case>-<run>.json`, `summary.md`. The last line is `SETTINGS-EVAL <label> PASS|FAIL ...`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EntryRecord } from "../../src/pi/adapter.js";
import { viewTranscript } from "../bakeoff/run.js";
import { withTimeoutCompat } from "../bakeoff/util.js";
import type { RunResult } from "../bakeoff/cases.js";
import { allEntries, ctx, errMessage, openRig } from "../smoke/common.js";
import { checkProxyTarget, isMain, loadSmokeRunner, parseArgs, repoRoot, unreachableOutcome } from "../smoke/config.js";
import type { SmokeRunnerConfig } from "../smoke/config.js";
import { CASES, MAX_TOOL_CALLS, caseOf } from "./cases.js";
import type { SettingsCase, SettingsResult } from "./cases.js";
import { renderMatrix, renderScoreMarkdown, scoreSettings } from "./score.js";
import type { SettingsRecord, SettingsScore } from "./score.js";
import { openSettingsWorld } from "./world.js";

const BLOCKED = /Blocked:|denied this command|The user denied|was refused|not_writable|invalid_value|secret_shaped|not_allowed|personas_not_active|persona_invalid/i;

export interface SettingsEvalOptions {
  label?: string;
  runs?: number;
  only?: string[] | undefined;
  timeoutMs?: number;
  outDir?: string;
  preamble?: string;
  /** Judge against the lower fallback bar (deviation 192). */
  fallback?: boolean;
  onRun?: (record: SettingsRecord) => void;
}

export function settingsEvalOutDir(): string {
  return process.env["A7_SETTINGS_EVAL_OUT"] ?? join(repoRoot(), ".claude", "temp", "settings-eval");
}

const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "_");

export async function executeSettingsCase(cfg: SmokeRunnerConfig, c: SettingsCase, run: number, outDir: string, o: { timeoutMs: number; preamble: string }): Promise<{ record: SettingsRecord; result: SettingsResult }> {
  const path = join(outDir, `${c.id}-${run}.sqlite`);
  rmSync(path, { force: true });
  const world = await openSettingsWorld({ preamble: o.preamble, ...(c.startPersona ? { startPersona: c.startPersona } : {}) });
  const rig = await openRig({
    storagePath: path,
    cfg,
    extensions: world.extensions,
    settings: { stream: { timeoutMs: o.timeoutMs }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1000 } },
  });
  const t0 = Date.now();
  let base: RunResult;
  try {
    const sub = await rig.root.submit({ type: "input", content: c.prompt }, ctx);
    const settled = await withTimeoutCompat(sub.wait(ctx), o.timeoutMs + 60_000, `${c.id} run ${run}`);
    const view = viewTranscript((await allEntries(rig.root)) as EntryRecord[]);
    base = { status: settled.status === "done" ? "done" : "unanswered", ...(settled.status === "unanswered" ? { reason: settled.reason } : {}), ...view, totalMs: Date.now() - t0 };
  } catch (e) {
    base = { status: /timed out/.test(errMessage(e)) ? "timeout" : "error", reason: errMessage(e), calls: [], finalText: "", assistantTurns: 0, parseFailures: [], totalMs: Date.now() - t0 };
  } finally {
    await rig.close().catch(() => undefined);
  }
  const effects = world.collect();
  await world.close();
  const result: SettingsResult = { ...base, world: effects };
  const verdict = c.check(result);
  const record: SettingsRecord = {
    caseId: c.id,
    run,
    pass: verdict.pass && result.calls.length <= MAX_TOOL_CALLS,
    reason: result.calls.length > MAX_TOOL_CALLS ? `${result.calls.length} tool calls (cap ${MAX_TOOL_CALLS})` : verdict.reason,
    safety: c.safety,
    toolCalls: result.calls.length,
    attemptsBlocked: result.calls.filter((x) => x.isError && BLOCKED.test(x.resultText)).length,
    totalMs: result.totalMs,
  };
  writeFileSync(
    join(outDir, `${c.id}-${run}.json`),
    JSON.stringify({ record, prompt: c.prompt, calls: result.calls.map((x) => ({ name: x.name, args: x.args, isError: x.isError, result: x.resultText.slice(0, 300) })), finalText: result.finalText.slice(0, 1500), world: effects }, null, 2),
  );
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  return { record, result };
}

export interface SettingsEvalSummary {
  label: string;
  runner: string;
  modelId: string;
  startedAt: string;
  score: SettingsScore;
  records: SettingsRecord[];
  cases: SettingsCase[];
}

export async function runSettingsEval(cfg: SmokeRunnerConfig, opts: SettingsEvalOptions = {}): Promise<SettingsEvalSummary> {
  const label = opts.label ?? cfg.modelId;
  const outDir = join(opts.outDir ?? settingsEvalOutDir(), sanitize(label));
  mkdirSync(outDir, { recursive: true });
  const runs = opts.runs ?? 3;
  const timeoutMs = opts.timeoutMs ?? cfg.streamTimeoutMs ?? 600_000;
  const preamble = opts.preamble ?? readFileSync(join(repoRoot(), "prompts", "preamble.md"), "utf8");
  const cases = CASES.filter((c) => !opts.only || opts.only.includes(c.id.toUpperCase()));
  const startedAt = new Date().toISOString();
  const records: SettingsRecord[] = [];
  for (const c of cases) {
    for (let run = 1; run <= runs; run++) {
      const { record } = await executeSettingsCase(cfg, c, run, outDir, { timeoutMs, preamble });
      records.push(record);
      opts.onRun?.(record);
    }
  }
  const score = scoreSettings(label, cfg.runner, records, runs, opts.fallback === true);
  const summary: SettingsEvalSummary = { label, runner: cfg.runner, modelId: cfg.modelId, startedAt, score, records, cases };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify({ ...summary, cases: cases.map((c) => ({ id: c.id, safety: c.safety })) }, null, 2));
  writeFileSync(join(outDir, "summary.md"), `${renderScoreMarkdown(score)}\n\n${renderMatrix(cases, records, runs)}\n`);
  return summary;
}

export function renderReport(s: SettingsEvalSummary, o: { mode: string; note?: string }): string {
  return [
    `# Phase 3 mini-eval results: ${s.label}`,
    "",
    `Mode: ${o.mode}`,
    `Runner: ${s.runner}, model: ${s.modelId}. Started ${s.startedAt}.`,
    ...(o.note ? ["", o.note] : []),
    "",
    renderScoreMarkdown(s.score),
    "",
    "## Per-prompt matrix",
    "",
    "A cell shows `pass (n)` with the number of tool calls (tool_search included), or the reason of a failure.",
    "",
    renderMatrix(s.cases, s.records, s.score.runsPerCase),
    "",
  ].join("\n");
}

export { caseOf, MAX_TOOL_CALLS };

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadSmokeRunner(args);
  const label = typeof args.flags["label"] === "string" ? args.flags["label"] : cfg.modelId;
  const reach = await checkProxyTarget(cfg);
  if (!reach.reachable) {
    console.log(`SETTINGS-EVAL ${label} FAIL runner=${cfg.runner}: ${unreachableOutcome("SETTINGS-EVAL", cfg, reach).reason}`);
    process.exitCode = 1;
  } else {
    try {
      const only = args.only?.filter((id) => caseOf(id));
      const s = await runSettingsEval(cfg, {
        label,
        only,
        ...(args.flags["fallback"] === true ? { fallback: true } : {}),
        ...(typeof args.flags["runs"] === "string" ? { runs: Number(args.flags["runs"]) } : {}),
        ...(typeof args.flags["timeout-ms"] === "string" ? { timeoutMs: Number(args.flags["timeout-ms"]) } : {}),
        onRun: (r) => console.log(`  ${r.caseId} run ${r.run}: ${r.pass ? "pass" : "FAIL"} (${r.reason}) ${r.totalMs} ms, ${r.toolCalls} tool call(s)${r.attemptsBlocked ? `, ${r.attemptsBlocked} blocked` : ""}`),
      });
      if (typeof args.flags["results"] === "string") {
        mkdirSync(dirname(args.flags["results"]), { recursive: true });
        writeFileSync(args.flags["results"], renderReport(s, { mode: "LIVE: a real model through the real Harness; the job runner, MCP servers and Telegram are fakes" }));
      }
      console.log(`SETTINGS-EVAL ${label} ${s.score.qualifies ? "PASS" : "FAIL"} runner=${cfg.runner}: ${s.score.passes}/${s.score.runs} runs correct (${(s.score.overallPct * 100).toFixed(1)}%), safety ${s.score.safetyPasses}/${s.score.safetyRuns}${s.score.why.length ? `; ${s.score.why.join("; ")}` : ""}`);
      process.exitCode = s.score.qualifies ? 0 : 1;
    } catch (e) {
      console.log(`SETTINGS-EVAL ${label} FAIL runner=${cfg.runner}: unexpected error: ${errMessage(e)}`);
      process.exitCode = 1;
    }
  }
}
