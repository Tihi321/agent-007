/**
 * P0.5 bake-off runner. Runs the 12 cases x 3 runs sequentially through the REAL Harness and pi-ai request shape,
 * with stub tools that have the real schemas, and the `shell` stub auto-denying.
 *
 *   node dist/scripts/bakeoff/run.js --runner lmstudio --model <model id> --label C1
 *   node dist/scripts/bakeoff/run.js --runner strata --label C3          (Strata started per P0.3b [GO])
 *
 * Sequential for every candidate (required for Strata, whose FIFO would inflate latency numbers otherwise).
 * Output: `.claude/temp/bakeoff/<label>/<case>-<run>.json`, `summary.json` and `summary.md`. The final line is
 * `BAKEOFF <label> PASS|FAIL ...` (PASS = the candidate qualifies under the pick rule).
 * Loading and unloading models is NOT done here: LM Studio models are loaded by the user ([GO]), and the runner is never
 * started by this script. If the runner is unreachable the script prints a clear FAIL and exits 1.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkProxyTarget, isMain, loadSmokeRunner, parseArgs, repoRoot, unreachableOutcome } from "../smoke/config.js";
import type { SmokeRunnerConfig } from "../smoke/config.js";
import { allEntries, ctx, entryHasToolCall, entryStopReason, entryText, errMessage, openRig } from "../smoke/common.js";
import type { EntryRecord } from "../../src/pi/adapter.js";
import { rawStream, withTimeoutCompat } from "./util.js";
import { CASES, caseById } from "./cases.js";
import type { BakeoffCase, CallView, ParseFailure, RunResult } from "./cases.js";
import { buildBakeoffExtension, preamblePath, STUB_PREFIX } from "./stubs.js";
import { rankCandidates, renderCandidateMarkdown, scoreCandidate } from "./score.js";
import type { CandidateScore, RunRecord } from "./score.js";

export interface BakeoffOptions {
  label?: string;
  runs?: number;
  only?: string[] | undefined;
  /** Per-run timeout (also the stream timeout). Default: `model.streamTimeoutMs` of the dev config, or 600 s. */
  timeoutMs?: number;
  outDir?: string;
  preamble?: string;
  /** Judge against the lower fallback bar, 28/36 (deviation 192). */
  fallback?: boolean;
}

export function bakeoffOutDir(): string {
  return process.env["A7_BAKEOFF_OUT"] ?? join(repoRoot(), ".claude", "temp", "bakeoff");
}

function sanitize(label: string): string {
  return label.replace(/[^\w.-]+/g, "_");
}

interface MsgBlock {
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  text?: string;
}
interface Msg {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  isError?: boolean;
}

/** Builds the case-facing view of a finished conversation from its committed entries. */
export function viewTranscript(entries: EntryRecord[]): Pick<RunResult, "calls" | "finalText" | "assistantTurns" | "parseFailures"> {
  const calls: CallView[] = [];
  const byId = new Map<string, CallView>();
  const parseFailures: ParseFailure[] = [];
  let assistantTurns = 0;
  let finalText = "";
  for (const e of entries) {
    for (const m of (e.model ?? []) as unknown as Msg[]) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        if (entryStopReason(e) !== "aborted") assistantTurns++;
        for (const b of m.content as MsgBlock[]) {
          if (b.type !== "toolCall") continue;
          const args = b.arguments && typeof b.arguments === "object" ? (b.arguments as Record<string, unknown>) : {};
          const view: CallView = { id: b.id ?? `call-${calls.length}`, name: b.name ?? "?", args, isError: false, resultText: "", blocked: false };
          calls.push(view);
          byId.set(view.id, view);
        }
        if (!entryHasToolCall(e) && entryStopReason(e) !== "aborted") finalText = entryText(e);
      } else if (m.role === "toolResult" && m.toolCallId) {
        const v = byId.get(m.toolCallId);
        if (!v) continue;
        const text = Array.isArray(m.content) ? (m.content as MsgBlock[]).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("") : String(m.content ?? "");
        v.isError = m.isError === true;
        v.resultText = text;
        v.blocked = v.isError && /denied this command/i.test(text);
        // A deliberate stub refusal starts with STUB:. Any other error is a harness-level failure: invalid arguments,
        // an unknown tool name or a schema violation, i.e. a tool-call format failure.
        if (v.isError && !text.includes(STUB_PREFIX)) parseFailures.push({ name: v.name, rawArguments: JSON.stringify(v.args), error: text.slice(0, 300) });
      }
    }
  }
  return { calls, finalText, assistantTurns, parseFailures };
}

export async function executeCase(cfg: SmokeRunnerConfig, c: BakeoffCase, run: number, outDir: string, o: { timeoutMs: number; preamble: string }): Promise<{ record: RunRecord; result: RunResult }> {
  const path = join(outDir, `${c.id}-${run}.sqlite`);
  rmSync(path, { force: true });
  const rig = await openRig({
    storagePath: path,
    cfg,
    extensions: [buildBakeoffExtension(o.preamble)],
    settings: { stream: { timeoutMs: o.timeoutMs }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1000 } },
  });
  const t0 = Date.now();
  let result: RunResult;
  try {
    const sub = await rig.root.submit({ type: "input", content: c.prompt }, ctx);
    const settled = await withTimeoutCompat(sub.wait(ctx), o.timeoutMs + 60_000, `${c.id} run ${run}`);
    const view = viewTranscript(await allEntries(rig.root));
    const usage = await rig.harness.usage(ctx).catch(() => undefined);
    const outputTokens = usage ? Object.values(usage.models).reduce((n, u) => n + ((u as unknown as { output?: number }).output ?? 0), 0) : undefined;
    result = {
      status: settled.status === "done" ? "done" : "unanswered",
      ...(settled.status === "unanswered" ? { reason: settled.reason } : {}),
      ...view,
      totalMs: Date.now() - t0,
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  } catch (e) {
    result = { status: /timed out/.test(errMessage(e)) ? "timeout" : "error", reason: errMessage(e), calls: [], finalText: "", assistantTurns: 0, parseFailures: [], totalMs: Date.now() - t0 };
  } finally {
    await rig.close().catch(() => undefined);
  }
  const verdict = c.check(result);
  const record: RunRecord = {
    caseId: c.id,
    run,
    pass: verdict.pass,
    reason: verdict.reason,
    toolCalls: result.calls.length,
    parseFailures: result.parseFailures.length,
    totalMs: result.totalMs,
    outputTokens: result.outputTokens,
  };
  writeFileSync(join(outDir, `${c.id}-${run}.json`), JSON.stringify({ record, result: { ...result, finalText: result.finalText.slice(0, 2000) }, prompt: c.prompt.length > 600 ? `${c.prompt.slice(0, 200)} ... [${c.prompt.length} chars]` : c.prompt }, null, 2));
  return { record, result };
}

export interface BakeoffSummary {
  label: string;
  runner: string;
  modelId: string;
  score: CandidateScore;
  ttftMs: number | undefined;
  /** Decode rate estimate over all runs: output tokens / total time. Includes prefill and tool time, so it is a floor. */
  approxTokPerSec: number | undefined;
  records: RunRecord[];
  startedAt: string;
}

export async function runBakeoff(cfg: SmokeRunnerConfig, opts: BakeoffOptions = {}): Promise<BakeoffSummary> {
  const label = opts.label ?? cfg.modelId;
  const outDir = join(opts.outDir ?? bakeoffOutDir(), sanitize(label));
  mkdirSync(outDir, { recursive: true });
  const runs = opts.runs ?? 3;
  const timeoutMs = opts.timeoutMs ?? cfg.streamTimeoutMs ?? 600_000;
  let preamble = opts.preamble;
  if (preamble === undefined) preamble = readFileSync(preamblePath(), "utf8");
  const cases = CASES.filter((c) => !opts.only || opts.only.includes(c.id));
  const startedAt = new Date().toISOString();

  const probe = await rawStream(cfg, "Reply with the single word OK.", timeoutMs);
  const records: RunRecord[] = [];
  for (const c of cases) {
    for (let run = 1; run <= runs; run++) {
      const { record } = await executeCase(cfg, c, run, outDir, { timeoutMs, preamble });
      records.push(record);
      console.log(`  ${c.id} run ${run}: ${record.pass ? "pass" : "FAIL"} (${record.reason}) ${record.totalMs} ms, ${record.toolCalls} tool call(s)`);
    }
  }
  const score = scoreCandidate(label, cfg.runner, records, runs, cases.length, opts.fallback === true);
  const tokens = records.reduce((n, r) => n + (r.outputTokens ?? 0), 0);
  const ms = records.reduce((n, r) => n + r.totalMs, 0);
  const summary: BakeoffSummary = {
    label,
    runner: cfg.runner,
    modelId: cfg.modelId,
    score,
    ttftMs: probe.ttftMs,
    approxTokPerSec: tokens > 0 && ms > 0 ? Math.round((tokens / (ms / 1000)) * 10) / 10 : undefined,
    records,
    startedAt,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, "summary.md"), `${renderCandidateMarkdown(score)}\n\nTTFT (short prompt): ${probe.ttftMs ?? "n/a"} ms. Approx decode: ${summary.approxTokPerSec ?? "n/a"} tok/s (a floor: includes prefill and tool time).\n`);
  return summary;
}

export { rankCandidates };

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadSmokeRunner(args);
  const label = typeof args.flags["label"] === "string" ? args.flags["label"] : cfg.modelId;
  const reach = await checkProxyTarget(cfg);
  if (!reach.reachable) {
    console.log(`BAKEOFF ${label} FAIL runner=${cfg.runner}: ${unreachableOutcome("BAKEOFF", cfg, reach).reason}`);
    process.exitCode = 1;
  } else {
    try {
      const only = args.only?.filter((id) => caseById(id));
      const s = await runBakeoff(cfg, {
        label,
        only,
        ...(args.flags["fallback"] === true ? { fallback: true } : {}),
        ...(typeof args.flags["runs"] === "string" ? { runs: Number(args.flags["runs"]) } : {}),
        ...(typeof args.flags["timeout-ms"] === "string" ? { timeoutMs: Number(args.flags["timeout-ms"]) } : {}),
      });
      console.log(`BAKEOFF ${label} ${s.score.qualifies ? "PASS" : "FAIL"} runner=${cfg.runner}: ${s.score.passes}/${s.score.runs} passes${s.score.why.length ? `; ${s.score.why.join("; ")}` : ""}`);
      process.exitCode = s.score.qualifies ? 0 : 1;
    } catch (e) {
      console.log(`BAKEOFF ${label} FAIL runner=${cfg.runner}: unexpected error: ${errMessage(e)}`);
      process.exitCode = 1;
    }
  }
}
