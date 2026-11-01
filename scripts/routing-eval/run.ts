/**
 * Routing eval runner (S16.1, I24). Runs the 40 prompts x 3 runs, one at a time, through the REAL Harness and pi-ai request
 * shape with the Phase 2 tool set over fakes (`world.ts`): nothing is spent, no job runs, no Flow call is made.
 *
 *   node dist/scripts/routing-eval/run.js --runner lmstudio --model <model id> --label G0pick
 *   node dist/scripts/routing-eval/run.js --runner strata --label C3 --runs 3 --results <ticket>/routing-eval-results.md
 *
 * The model runner is NOT started by this script; it must already be running (LM Studio loaded by the user, or Strata per
 * P0.3b [GO]). With the runner unreachable it prints `ROUTING-EVAL <label> FAIL ...` and exits 1.
 * Output: `.claude/temp/routing-eval/<label>/<case>-<run>.json`, `summary.json`, `summary.md`; with `--results` also the
 * Markdown report (per-prompt matrix) for the ticket folder. The last line is `ROUTING-EVAL <label> PASS|FAIL ...`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EntryRecord } from "../../src/pi/adapter.js";
import { allEntries, ctx, errMessage, openRig } from "../smoke/common.js";
import { checkRunnerReachable, isMain, loadSmokeRunner, parseArgs, repoRoot, unreachableOutcome } from "../smoke/config.js";
import type { SmokeRunnerConfig } from "../smoke/config.js";
import { viewTranscript } from "../bakeoff/run.js";
import { withTimeoutCompat } from "../bakeoff/util.js";
import type { RunResult } from "../bakeoff/cases.js";
import { CASES, caseOf } from "./cases.js";
import type { EvalCase, EvalResult } from "./cases.js";
import { MAX_TOOL_CALLS_PER_RUN, renderMatrix, renderScoreMarkdown, scoreEval } from "./score.js";
import type { EvalRecord, EvalScore } from "./score.js";
import { openEvalWorld } from "./world.js";

export interface RoutingEvalOptions {
  label?: string;
  runs?: number;
  only?: string[] | undefined;
  timeoutMs?: number;
  outDir?: string;
  preamble?: string;
  /** Judge against the lower fallback bar, 85% (deviation 192). */
  fallback?: boolean;
  /** Called after each run (the CLI prints a line). */
  onRun?: (record: EvalRecord) => void;
}

export function routingEvalOutDir(): string {
  return process.env["A7_ROUTING_EVAL_OUT"] ?? join(repoRoot(), ".claude", "temp", "routing-eval");
}

const sanitize = (label: string): string => label.replace(/[^\w.-]+/g, "_");

const BLOCKED = /Blocked:|denied this command|The user denied|was refused|did not approve|not approved|STUB:/i;

export async function executeEvalCase(cfg: SmokeRunnerConfig, c: EvalCase, run: number, outDir: string, o: { timeoutMs: number; preamble: string }): Promise<{ record: EvalRecord; result: EvalResult }> {
  const path = join(outDir, `${c.id}-${run}.sqlite`);
  rmSync(path, { force: true });
  const world = await openEvalWorld({ preamble: o.preamble });
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
  const result: EvalResult = { ...base, world: effects };
  const verdict = c.check(result);
  const record: EvalRecord = {
    caseId: c.id,
    run,
    pass: verdict.pass,
    reason: verdict.reason,
    safety: c.safety,
    toolCalls: result.calls.length,
    attemptsBlocked: result.calls.filter((x) => x.isError && BLOCKED.test(x.resultText)).length,
    totalMs: result.totalMs,
  };
  writeFileSync(
    join(outDir, `${c.id}-${run}.json`),
    JSON.stringify({ record, prompt: c.prompt.length > 600 ? `${c.prompt.slice(0, 200)} ... [${c.prompt.length} chars]` : c.prompt, calls: result.calls.map((x) => ({ name: x.name, args: x.args, isError: x.isError, result: x.resultText.slice(0, 300) })), finalText: result.finalText.slice(0, 1500), world: effects }, null, 2),
  );
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  return { record, result };
}

export interface RoutingEvalSummary {
  label: string;
  runner: string;
  modelId: string;
  startedAt: string;
  score: EvalScore;
  records: EvalRecord[];
  cases: EvalCase[];
}

export async function runRoutingEval(cfg: SmokeRunnerConfig, opts: RoutingEvalOptions = {}): Promise<RoutingEvalSummary> {
  const label = opts.label ?? cfg.modelId;
  const outDir = join(opts.outDir ?? routingEvalOutDir(), sanitize(label));
  mkdirSync(outDir, { recursive: true });
  const runs = opts.runs ?? 3;
  const timeoutMs = opts.timeoutMs ?? cfg.streamTimeoutMs ?? 600_000;
  const preamble = opts.preamble ?? readFileSync(join(repoRoot(), "prompts", "preamble.md"), "utf8");
  const cases = CASES.filter((c) => !opts.only || opts.only.includes(c.id.toUpperCase()));
  const startedAt = new Date().toISOString();
  const records: EvalRecord[] = [];
  for (const c of cases) {
    for (let run = 1; run <= runs; run++) {
      const { record } = await executeEvalCase(cfg, c, run, outDir, { timeoutMs, preamble });
      records.push(record);
      opts.onRun?.(record);
    }
  }
  const score = scoreEval(label, cfg.runner, records, runs, opts.fallback === true);
  const summary: RoutingEvalSummary = { label, runner: cfg.runner, modelId: cfg.modelId, startedAt, score, records, cases };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify({ ...summary, cases: cases.map((c) => ({ id: c.id, safety: c.safety, category: c.category })) }, null, 2));
  writeFileSync(join(outDir, "summary.md"), `${renderScoreMarkdown(score)}\n\n${renderMatrix(cases, records, runs)}\n`);
  return summary;
}

/** The report for the ticket folder (`routing-eval-results.md`). */
export function renderReport(s: RoutingEvalSummary, o: { mode: string; note?: string }): string {
  return [
    `# Routing eval results: ${s.label}`,
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

export { MAX_TOOL_CALLS_PER_RUN, caseOf };

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadSmokeRunner(args);
  const label = typeof args.flags["label"] === "string" ? args.flags["label"] : cfg.modelId;
  const reach = await checkRunnerReachable(cfg);
  if (!reach.reachable) {
    console.log(`ROUTING-EVAL ${label} FAIL runner=${cfg.runner}: ${unreachableOutcome("ROUTING-EVAL", cfg, reach).reason}`);
    process.exitCode = 1;
  } else {
    try {
      const only = args.only?.filter((id) => caseOf(id));
      const s = await runRoutingEval(cfg, {
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
      console.log(`ROUTING-EVAL ${label} ${s.score.qualifies ? "PASS" : "FAIL"} runner=${cfg.runner}: ${s.score.passes}/${s.score.runs} runs correct (${(s.score.overallPct * 100).toFixed(1)}%), safety ${s.score.safetyPasses}/${s.score.safetyRuns}${s.score.why.length ? `; ${s.score.why.join("; ")}` : ""}`);
      process.exitCode = s.score.qualifies ? 0 : 1;
    } catch (e) {
      console.log(`ROUTING-EVAL ${label} FAIL runner=${cfg.runner}: unexpected error: ${errMessage(e)}`);
      process.exitCode = 1;
    }
  }
}
