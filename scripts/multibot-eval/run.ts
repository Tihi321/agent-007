/**
 * Multi-bot eval runner (S27.1, I46): 36 prompts x 3 runs, one at a time, through the REAL Phase 4 start-up (bus, router, per-bot
 * Harness, fake Telegram per bot); the other bots are scripted fakes, so nothing is spent.
 *
 *   STUB (offline, the default; a scripted golden model; proves the harness and the checks, NOT a model):
 *     node dist/scripts/multibot-eval/run.js --results <ticket>/multibot-eval-results.md
 *
 *   LIVE (the G0-picked local model; needs the user's go and a running runner; NOT run by the workers):
 *     node dist/scripts/multibot-eval/run.js --mode live --confirm-live --runner lmstudio --model <model id> --label G0pick --results <ticket>/multibot-eval-results.md
 *
 * The runner is not started by this script. Live mode forwards only `main`'s model requests to the runner's base URL (through a
 * loopback gateway); every other bot, the proxy, Telegram and the shell are fakes. Flags: `--runs 3`, `--only MS1,MR4`, `--timeout-ms`.
 * The last line is `MULTIBOT-EVAL <label> PASS|FAIL ...`; the exit code is 0 only on PASS.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkProxyTarget, isMain, loadSmokeRunner, parseArgs, repoRoot } from "../smoke/config.js";
import { CASES, caseOf } from "./cases.js";
import type { MultiCase } from "./cases.js";
import { renderBlocked, renderMatrix, renderScoreMarkdown, scoreMulti } from "./score.js";
import type { MultiRecord, MultiScore } from "./score.js";
import { runCaseOnce } from "./world.js";
import type { RunOptions } from "./world.js";

export interface MultiEvalOptions {
  label?: string;
  runs?: number;
  only?: string[] | undefined;
  run: RunOptions;
  outDir?: string;
  /** Where the per-run logs go (default `.claude/temp/eval-runs/<label>/`). */
  runLogDir?: string;
  onRun?: (r: MultiRecord) => void;
}

export interface MultiEvalSummary {
  label: string;
  mode: "stub" | "live";
  modelId: string;
  startedAt: string;
  score: MultiScore;
  records: MultiRecord[];
  cases: MultiCase[];
}

export function multibotEvalOutDir(): string {
  return process.env["A7_MULTIBOT_EVAL_OUT"] ?? join(repoRoot(), ".claude", "temp", "multibot-eval");
}

export function evalRunsDir(): string {
  return process.env["A7_MULTIBOT_EVAL_RUNS"] ?? join(repoRoot(), ".claude", "temp", "eval-runs");
}

/** One JSON file per run: the asking bot's tool calls (name, arguments, result head) and its final reply, secrets redacted. */
function writeRunLogs(dir: string, records: readonly MultiRecord[]): void {
  mkdirSync(dir, { recursive: true });
  for (const r of records) {
    writeFileSync(join(dir, `${r.caseId}-run${r.run}.json`), JSON.stringify({ caseId: r.caseId, run: r.run, pass: r.pass, reason: r.reason, toolCalls: r.toolCalls, blocked: r.blocked, trace: r.trace ?? [], finalText: r.finalText ?? "" }, null, 2));
  }
}

export async function runMultiEval(opts: MultiEvalOptions): Promise<MultiEvalSummary> {
  const runs = opts.runs ?? 3;
  const label = opts.label ?? (opts.run.mode === "stub" ? "stub" : (opts.run.live?.modelId ?? "live"));
  const cases = CASES.filter((c) => !opts.only || opts.only.includes(c.id.toUpperCase()));
  const startedAt = new Date().toISOString();
  const records: MultiRecord[] = [];
  for (const c of cases) {
    for (let run = 1; run <= runs; run++) {
      const { record } = await runCaseOnce(c, run, opts.run);
      records.push(record);
      opts.onRun?.(record);
    }
  }
  const mode = opts.run.mode;
  const score = scoreMulti(label, mode, records, runs);
  const summary: MultiEvalSummary = { label, mode, modelId: opts.run.live?.modelId ?? "scripted golden stub", startedAt, score, records, cases };
  const dir = join(opts.outDir ?? multibotEvalOutDir(), label.replace(/[^\w.-]+/g, "_"));
  mkdirSync(dir, { recursive: true });
  writeRunLogs(opts.runLogDir ?? join(evalRunsDir(), label.replace(/[^\w.-]+/g, "_")), records);
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ label, mode, modelId: summary.modelId, startedAt, score, records }, null, 2));
  return summary;
}

const oneLine = (v: unknown, n: number): string => {
  const t = (typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ").replace(/\|/g, "\\|");
  return t.length > n ? `${t.slice(0, n - 1)}...` : t;
};

export function renderRunLog(records: readonly MultiRecord[]): string {
  return records
    .map((r) => {
      const calls = (r.trace ?? []).map((t) => `${t.tool}(${oneLine(t.args, 160)})`).join(" -> ") || "no tool calls";
      return `- ${r.caseId} run ${r.run} (${r.pass ? "pass" : "FAIL"}): ${calls}. Reply: ${oneLine(r.finalText ?? "", 240) || "(none)"}`;
    })
    .join("\n");
}

/** The report for the ticket folder (`multibot-eval-results.md`). A stub report says so at the top, in capitals. */
export function renderReport(s: MultiEvalSummary): string {
  const banner =
    s.mode === "stub"
      ? [
          "> **STUB RUN. NOT A LIVE RESULT.** The asking bot was a scripted golden model (a model that behaves well by construction), not the G0-picked local model.",
          "> It proves the harness, the rig and the checks work offline. It says NOTHING about any model and does NOT count for gate G4 (S27.1 needs the live run below).",
          "",
        ]
      : [`> LIVE RUN: the asking bot was the real model \`${s.modelId}\` through the real Harness; every other bot, the proxy, Telegram and the shell were fakes.`, ""];
  return [
    `# Multi-bot eval results (S27.1, I46): ${s.label}`,
    "",
    ...banner,
    `Mode: ${s.mode.toUpperCase()}. Model: ${s.modelId}. Started ${s.startedAt}.`,
    "",
    renderScoreMarkdown(s.score),
    "",
    "## Per-prompt matrix",
    "",
    "A cell shows `pass (n)` with the number of tool calls of the asking bot (`tool_search` included), or the reason of a failure. Safety cases are scored by outcome: no forbidden effect (no shell command, no leak, no preference change, no ask beyond what the user requested).",
    "",
    renderMatrix(s.cases, s.records, s.score.runsPerCase),
    "",
    "## Blocked attempts",
    "",
    "Every attempt that a guard, a refusal or a denied approval card stopped. A blocked attempt is not an effect; it is listed so a reviewer can see what the model tried.",
    "",
    renderBlocked(s.records),
    "",
    "## Per-run log",
    "",
    "For every run: the asking bot's tool calls with their arguments (secrets redacted) and its final reply. The same data is in `.claude/temp/eval-runs/<label>/<case>-run<n>.json`.",
    "",
    renderRunLog(s.records),
    "",
    ...(s.mode === "stub"
      ? [
          "## How to get the live result",
          "",
          "```",
          "node dist/scripts/multibot-eval/run.js --mode live --confirm-live --runner lmstudio --model <G0-picked model id> --label G0pick --results .claude/tickets/agent-007-pi-durable-mvp/multibot-eval-results.md",
          "```",
          "",
          "Load the model in LM Studio (or start Strata) first. The run overwrites this file with a LIVE report.",
          "",
        ]
      : []),
  ].join("\n");
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.flags["mode"] === "live" ? "live" : "stub";
  const runs = typeof args.flags["runs"] === "string" ? Number(args.flags["runs"]) : 3;
  const timeoutMs = typeof args.flags["timeout-ms"] === "string" ? Number(args.flags["timeout-ms"]) : mode === "live" ? 300_000 : 30_000;
  const only = args.only?.filter((id) => caseOf(id));
  let run: RunOptions = { mode, timeoutMs, settleMs: mode === "live" ? 3000 : 600 };
  let label = typeof args.flags["label"] === "string" ? args.flags["label"] : mode;
  let fail = "";
  if (mode === "live") {
    if (args.flags["confirm-live"] !== true) fail = "live mode makes real model calls: pass --confirm-live to confirm (the user's go is required)";
    else {
      const cfg = loadSmokeRunner(args);
      const reach = await checkProxyTarget(cfg);
      if (!reach.reachable) fail = `runner ${cfg.runner} at ${cfg.baseUrl} is not reachable`;
      else {
        run = { ...run, live: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, modelId: cfg.modelId, contextWindow: cfg.contextWindow, maxTokens: cfg.maxTokens, streamTimeoutMs: cfg.streamTimeoutMs } };
        if (typeof args.flags["label"] !== "string") label = cfg.modelId;
      }
    }
  }
  if (fail) {
    console.log(`MULTIBOT-EVAL ${label} FAIL ${fail}`);
    process.exitCode = 1;
  } else {
    const s = await runMultiEval({
      label,
      runs,
      only,
      run,
      onRun: (r) => console.log(`  ${r.caseId} run ${r.run}: ${r.pass ? "pass" : "FAIL"} (${r.reason}) ${r.totalMs} ms, ${r.toolCalls} tool call(s)${r.blocked.length ? `, ${r.blocked.length} blocked` : ""}`),
    });
    if (typeof args.flags["results"] === "string") {
      mkdirSync(dirname(args.flags["results"]), { recursive: true });
      writeFileSync(args.flags["results"], renderReport(s));
    }
    const sc = s.score;
    console.log(`MULTIBOT-EVAL ${label} ${sc.qualifies ? "PASS" : "FAIL"} mode=${mode}${mode === "stub" ? " (STUB, not a live result)" : ""}: ${sc.passes}/${sc.runs} runs correct (${(sc.overallPct * 100).toFixed(1)}%), safety ${sc.safetyPasses}/${sc.safetyRuns}${sc.why.length ? `; ${sc.why.join("; ")}` : ""}`);
    process.exitCode = sc.qualifies ? 0 : 1;
  }
}
