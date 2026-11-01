/**
 * S4 (P0.4): crash and resume. The parent spawns a child process that (a) starts a long answer, and (b) in a second
 * case is inside the tools `slow_unsafe` (default replay "unsafe") and `slow_safe` (replay "safe"). The parent kills the
 * child tree mid-turn with `taskkill /PID <pid> /T /F`, reopens the same SQLite file and calls `harness.resume()`.
 * PASS (a): the run completes with exactly one final assistant answer and no SessionFailed.
 * PASS (b): `slow_unsafe` ran exactly once (counter file) and the model got an interrupted result; `slow_safe` reran
 * and completed.
 * On Strata the same run also shows whether killing the client mid-stream frees Strata's sequence (U28): the
 * time from the kill to the first token of the resumed request is recorded.
 */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRunnerReachable, failOutcome, finish, isMain, loadSmokeRunner, parseArgs, smokeOutDir, unreachableOutcome } from "./config.js";
import type { SmokeOutcome, SmokeRunnerConfig } from "./config.js";
import { allEntries, ask, describeSettled, entryHasToolCall, entryStopReason, entryText, errMessage, openRig, sleep } from "./common.js";
import { withTimeout } from "./s2-roundtrip.js";
import { buildS4Extension, counterPath, S4_PROMPTS } from "./s4-shared.js";
import { StallError, waitWithStall } from "./s4-stall.js";
import type { StallWaitStats } from "./s4-stall.js";

export interface S4Options {
  storageDir?: string;
  /** Case (a): how long after SUBMITTED the child is killed. Default 6000. */
  killAfterMs?: number;
  /** Case (b): the tools' sleep. Default 30000. */
  sleepMs?: number;
  /**
   * The resumed run fails only when no new durable revision is committed for this long (default 120000), so a run that
   * is still streaming is never cut off. The stream timeout of the resumed run is set to `hardCapMs`.
   */
  stallMs?: number;
  /** Absolute backstop for the resumed run and the case-b child wait. Default 1800000 (30 min). */
  hardCapMs?: number;
  /** Legacy alias of `hardCapMs`. */
  timeoutMs?: number;
  cases?: ("a" | "b")[];
}

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      child.kill("SIGKILL");
    }
  } else child.kill("SIGKILL");
}

function childScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "s4-child.js");
}

function spawnChild(which: "a" | "b", storage: string, counters: string, sleepMs: number, cfg: SmokeRunnerConfig): { child: ChildProcess; submitted: Promise<void>; exited: Promise<number | null> } {
  const args = [childScript(), "--case", which, "--storage", storage, "--counters", counters, "--sleep-ms", String(sleepMs), "--runner", cfg.runner, "--model", cfg.modelId, "--base-url", cfg.baseUrl];
  if (cfg.compat) args.push("--compat", JSON.stringify(cfg.compat));
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  let err = "";
  const submitted = new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("SUBMITTED")) resolve();
    });
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    child.on("exit", (code) => reject(new Error(`child exited early (code ${code}): ${err.slice(0, 300)}`)));
  });
  submitted.catch(() => undefined);
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  return { child, submitted, exited };
}

async function pollFor(path: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(path)) return true;
    await sleep(100);
  }
  return false;
}

/** Number of committed document revisions in the SQLite file (grows with every streamed partial). 0 when unreadable. */
export function revisionCount(storage: string): number {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(storage, { readOnly: true });
    const row = db.prepare("select count(*) as n from document_revisions").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function stallDetails(st: StallWaitStats): Record<string, unknown> {
  return { longestStallMs: st.longestStallMs, progressSteps: st.progressSteps, resumedWaitMs: st.elapsedMs };
}

function lines(path: string): number {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
}

async function caseA(cfg: SmokeRunnerConfig, dir: string, o: Required<Pick<S4Options, "killAfterMs" | "sleepMs" | "stallMs" | "hardCapMs">>): Promise<{ pass: boolean; reason: string; details: Record<string, unknown> }> {
  const storage = join(dir, "a", "a7.sqlite");
  const counters = join(dir, "a", "counters");
  rmSync(join(dir, "a"), { recursive: true, force: true });
  mkdirSync(counters, { recursive: true });
  const c = spawnChild("a", storage, counters, o.sleepMs, cfg);
  await withTimeout(c.submitted, 60_000, "child start");
  await sleep(o.killAfterMs);
  killTree(c.child);
  await c.exited;
  const killedAt = Date.now();

  const rig = await openRig({ storagePath: storage, cfg, extensions: [buildS4Extension(counters, o.sleepMs)], settings: { stream: { timeoutMs: o.hardCapMs } }, resume: true });
  try {
    // the same requestId finds the same submission instead of submitting twice
    const { value: out, stats } = await waitWithStall(ask(rig.root, S4_PROMPTS.a, "s4-a"), () => revisionCount(storage), "resumed run", { stallMs: o.stallMs, hardCapMs: o.hardCapMs });
    const entries = await allEntries(rig.root);
    // The crash leaves the streamed part as an assistant entry with stopReason "aborted"; that is not a final answer.
    const assistant = entries.filter((e) => e.kind === "pi.assistant" && !entryHasToolCall(e) && entryText(e).trim() !== "");
    const finals = assistant.filter((e) => entryStopReason(e) !== "aborted" && entryStopReason(e) !== "error");
    const abortedPartials = assistant.length - finals.length;
    const done = out.settled.status === "done";
    const pass = done && finals.length === 1;
    return {
      pass,
      reason: pass ? "resumed run completed with exactly one final assistant answer" : done ? `expected 1 final assistant answer, found ${finals.length}` : `resumed run ended ${out.settled.status}`,
      details: { settled: describeSettled(out.settled), finalAssistantAnswers: finals.length, abortedPartialEntries: abortedPartials, msFromKillToDone: Date.now() - killedAt, ...stallDetails(stats), note: "On Strata, a long msFromKillToDone suggests the orphaned sequence kept running (U28)." },
    };
  } finally {
    await rig.close().catch(() => undefined);
  }
}

async function caseB(cfg: SmokeRunnerConfig, dir: string, o: Required<Pick<S4Options, "killAfterMs" | "sleepMs" | "stallMs" | "hardCapMs">>): Promise<{ pass: boolean; reason: string; details: Record<string, unknown> }> {
  const storage = join(dir, "b", "a7.sqlite");
  const counters = join(dir, "b", "counters");
  rmSync(join(dir, "b"), { recursive: true, force: true });
  mkdirSync(counters, { recursive: true });
  const c = spawnChild("b", storage, counters, o.sleepMs, cfg);
  await withTimeout(c.submitted, 60_000, "child start");
  const started = await pollFor(counterPath(counters, "slow_unsafe"), Math.min(o.hardCapMs, Math.max(o.stallMs, 60_000)));
  if (!started) {
    killTree(c.child);
    await c.exited;
    return { pass: false, reason: "the model never called slow_unsafe in the child, so the crash window was not reached", details: { calledTools: false } };
  }
  await sleep(Math.min(1000, Math.floor(o.sleepMs / 3)));
  killTree(c.child);
  await c.exited;

  const rig = await openRig({ storagePath: storage, cfg, extensions: [buildS4Extension(counters, o.sleepMs)], settings: { stream: { timeoutMs: o.hardCapMs } }, resume: true });
  try {
    const { value: out, stats } = await waitWithStall(ask(rig.root, S4_PROMPTS.b, "s4-b"), () => revisionCount(storage), "resumed run", { stallMs: o.stallMs, hardCapMs: o.hardCapMs });
    const entries = await allEntries(rig.root);
    const toolResults = entries.filter((e) => e.kind === "pi.tool-result").map((e) => entryText(e, "toolResult").slice(0, 200));
    const unsafeRuns = lines(counterPath(counters, "slow_unsafe"));
    const safeRuns = lines(counterPath(counters, "slow_safe"));
    const interrupted = toolResults.some((t) => /interrupt/i.test(t));
    const pass = out.settled.status === "done" && unsafeRuns === 1 && safeRuns >= 2 && interrupted;
    const why: string[] = [];
    if (out.settled.status !== "done") why.push(`run ended ${out.settled.status}`);
    if (unsafeRuns !== 1) why.push(`slow_unsafe ran ${unsafeRuns} times (expected exactly 1)`);
    if (safeRuns < 2) why.push(`slow_safe ran ${safeRuns} time(s) (expected a rerun)`);
    if (!interrupted) why.push("no interrupted tool result reached the model");
    return {
      pass,
      reason: pass ? "slow_unsafe ran once and got an interrupted result; slow_safe reran and completed" : why.join("; "),
      details: { settled: describeSettled(out.settled), slowUnsafeRuns: unsafeRuns, slowSafeRuns: safeRuns, toolResults, ...stallDetails(stats) },
    };
  } finally {
    await rig.close().catch(() => undefined);
  }
}

export async function run(cfg: SmokeRunnerConfig, opts: S4Options = {}): Promise<SmokeOutcome> {
  const reach = await checkRunnerReachable(cfg);
  if (!reach.reachable) return unreachableOutcome("S4", cfg, reach);
  const dir = opts.storageDir ?? join(smokeOutDir(), "s4");
  const o = { killAfterMs: opts.killAfterMs ?? 6000, sleepMs: opts.sleepMs ?? 30_000, stallMs: opts.stallMs ?? 120_000, hardCapMs: opts.hardCapMs ?? opts.timeoutMs ?? 1_800_000 };
  const results: Record<string, { pass: boolean; reason: string; details: Record<string, unknown> }> = {};
  try {
    for (const which of opts.cases ?? ["a", "b"]) results[which] = which === "a" ? await caseA(cfg, dir, o) : await caseB(cfg, dir, o);
  } catch (e) {
    return { id: "S4", runner: cfg.runner, pass: false, reason: `error: ${errMessage(e)}`, details: { results, ...(e instanceof StallError ? { stallKind: e.kind, ...stallDetails(e.stats) } : {}) } };
  }
  const failed = Object.entries(results).filter(([, r]) => !r.pass);
  return {
    id: "S4",
    runner: cfg.runner,
    pass: failed.length === 0,
    reason: failed.length === 0 ? Object.entries(results).map(([k, r]) => `(${k}) ${r.reason}`).join("; ") : failed.map(([k, r]) => `(${k}) ${r.reason}`).join("; "),
    details: { results },
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadSmokeRunner(args);
  try {
    const opts: S4Options = {};
    if (typeof args.flags["kill-after-ms"] === "string") opts.killAfterMs = Number(args.flags["kill-after-ms"]);
    if (typeof args.flags["sleep-ms"] === "string") opts.sleepMs = Number(args.flags["sleep-ms"]);
    if (typeof args.flags["stall-ms"] === "string") opts.stallMs = Number(args.flags["stall-ms"]);
    if (typeof args.flags["hard-cap-ms"] === "string") opts.hardCapMs = Number(args.flags["hard-cap-ms"]);
    finish(await run(cfg, opts));
  } catch (e) {
    finish(failOutcome("S4", cfg.runner, `unexpected error: ${errMessage(e)}`));
  }
}
