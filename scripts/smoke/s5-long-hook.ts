/**
 * S5 (P0.4): long waits in `beforeTool` (the shape of the Telegram approval gate).
 * S5 (default): `beforeTool` on `gate_me` awaits a timer of N minutes (default 5, `--minutes 15` for the long run),
 * then returns undefined. PASS: the tool runs after the wait and the turn completes, with no stream or lease timeout
 * during the wait.
 * S5b (`--restart`): the hook first writes `api.memo("a7.approval.asked:<call.id>", {askedAt})` and the parent kills the
 * process during the wait. After `resume()` the hook must rerun (spec 7.2) and `api.memo` must return the ORIGINAL
 * `askedAt`. Then a decision memo is written, the process is killed again before the tool finishes, and after a second
 * resume the hook must not ask again (or must find the decision memo).
 * Also records whether `call.id` exists on `ToolHookCall` (U3), and memo scope.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRunnerReachable, failOutcome, finish, isMain, loadSmokeRunner, parseArgs, smokeOutDir, unreachableOutcome } from "./config.js";
import type { SmokeOutcome, SmokeRunnerConfig } from "./config.js";
import { ask, describeSettled, errMessage, openRig, sleep } from "./common.js";
import { killTree } from "./s4-crash-resume.js";
import { withTimeout } from "./s2-roundtrip.js";
import { buildS5Extension, S5_PROMPT } from "./s5-shared.js";
import type { S5Event } from "./s5-shared.js";

export interface S5RunOptions {
  storageDir?: string;
  /** Hook wait in ms for the plain variant (default 5 minutes). */
  waitMs?: number;
  timeoutMs?: number;
}

export interface S5bOptions {
  storageDir?: string;
  /** The first (long) hook wait that gets killed. */
  longWaitMs?: number;
  /** The hook wait in the later processes. */
  shortWaitMs?: number;
  /** The tool sleep in the processes that reach the tool. */
  toolSleepMs?: number;
  timeoutMs?: number;
}

export function readEvents(file: string): S5Event[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as S5Event);
}

async function waitForEvent(file: string, pred: (e: S5Event) => boolean, ms: number): Promise<S5Event | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = readEvents(file).find(pred);
    if (hit) return hit;
    await sleep(100);
  }
  return undefined;
}

export async function runPlain(cfg: SmokeRunnerConfig, opts: S5RunOptions = {}): Promise<SmokeOutcome> {
  const reach = await checkRunnerReachable(cfg);
  if (!reach.reachable) return unreachableOutcome("S5", cfg, reach);
  const dir = opts.storageDir ?? join(smokeOutDir(), "s5");
  const waitMs = opts.waitMs ?? 5 * 60_000;
  const timeout = opts.timeoutMs ?? waitMs + 180_000;
  const log = join(dir, "plain.events.jsonl");
  rmSync(join(dir, "plain.sqlite"), { force: true });
  rmSync(log, { force: true });
  const rig = await openRig({
    storagePath: join(dir, "plain.sqlite"),
    cfg,
    extensions: [buildS5Extension({ hookWaitMs: waitMs, toolSleepMs: 10, memo: false, logFile: log })],
    settings: { stream: { timeoutMs: 600_000 } },
  });
  try {
    const out = await withTimeout(ask(rig.root, S5_PROMPT), timeout, "gated run");
    const ev = readEvents(log);
    const hookStart = ev.find((e) => e.ev === "hook-start");
    const hookEnd = ev.find((e) => e.ev === "hook-end");
    const toolRan = ev.some((e) => e.ev === "tool-end");
    const waited = hookStart && hookEnd ? hookEnd.at - hookStart.at : 0;
    const pass = out.settled.status === "done" && toolRan && waited >= waitMs - 50;
    return {
      id: "S5",
      runner: cfg.runner,
      pass,
      reason: pass ? `hook waited ${Math.round(waited / 1000)} s, then the tool ran and the turn completed` : out.settled.status !== "done" ? `turn ended ${out.settled.status}` : !toolRan ? "tool never ran" : `hook waited only ${waited} ms`,
      details: { settled: describeSettled(out.settled), waitedMs: waited, configuredWaitMs: waitMs, toolRan, callIdOnHookCall: hookStart?.callIdType ?? "unknown", callId: hookStart?.callId },
    };
  } catch (e) {
    return { id: "S5", runner: cfg.runner, pass: false, reason: errMessage(e), details: {} };
  } finally {
    await rig.close().catch(() => undefined);
  }
}

function spawnChild(storage: string, log: string, hookWaitMs: number, toolSleepMs: number, cfg: SmokeRunnerConfig): { child: ChildProcess; exited: Promise<number | null> } {
  const script = join(dirname(fileURLToPath(import.meta.url)), "s5-child.js");
  const args = [script, "--storage", storage, "--log", log, "--hook-wait-ms", String(hookWaitMs), "--tool-sleep-ms", String(toolSleepMs), "--runner", cfg.runner, "--model", cfg.modelId, "--base-url", cfg.baseUrl];
  if (cfg.compat) args.push("--compat", JSON.stringify(cfg.compat));
  const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  return { child, exited: new Promise((r) => child.on("exit", (c) => r(c))) };
}

export async function runRestart(cfg: SmokeRunnerConfig, opts: S5bOptions = {}): Promise<SmokeOutcome> {
  const reach = await checkRunnerReachable(cfg);
  if (!reach.reachable) return unreachableOutcome("S5b", cfg, reach);
  const dir = join(opts.storageDir ?? join(smokeOutDir(), "s5"), "restart");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const storage = join(dir, "a7.sqlite");
  const log = join(dir, "events.jsonl");
  const longWait = opts.longWaitMs ?? 120_000;
  const shortWait = opts.shortWaitMs ?? 1500;
  const toolSleep = opts.toolSleepMs ?? 30_000;
  const timeout = opts.timeoutMs ?? 180_000;
  const details: Record<string, unknown> = {};
  try {
    // process 1: the hook asks and starts its long wait; killed during the wait
    const p1 = spawnChild(storage, log, longWait, toolSleep, cfg);
    const first = await waitForEvent(log, (e) => e.ev === "hook-start", 120_000);
    if (!first) {
      killTree(p1.child);
      return { id: "S5b", runner: cfg.runner, pass: false, reason: "the model never called gate_me in process 1, so the hook wait was not reached", details };
    }
    await sleep(700);
    killTree(p1.child);
    await p1.exited;

    // process 2: resume; the hook must rerun with the ORIGINAL askedAt, finish its (short) wait, write the decision memo,
    // and reach the slow tool, where it is killed again
    const p2 = spawnChild(storage, log, shortWait, toolSleep, cfg);
    const reachedTool = await waitForEvent(log, (e) => e.ev === "tool-start", 120_000);
    if (!reachedTool) {
      killTree(p2.child);
      return { id: "S5b", runner: cfg.runner, pass: false, reason: "after the first restart the hook never completed and the tool was not reached", details: { events: readEvents(log) } };
    }
    await sleep(500);
    killTree(p2.child);
    await p2.exited;

    // process 3 (in this process): resume again; the hook must not ask again, or must find the decision memo
    const before = readEvents(log).length;
    const rig = await openRig({
      storagePath: storage,
      cfg,
      extensions: [buildS5Extension({ hookWaitMs: shortWait, toolSleepMs: 500, memo: true, logFile: log })],
      settings: { stream: { timeoutMs: 600_000 } },
      resume: true,
    });
    let settledDesc: unknown;
    try {
      const out = await withTimeout(ask(rig.root, S5_PROMPT, "s5b"), timeout, "second resume");
      settledDesc = describeSettled(out.settled);
    } finally {
      await rig.close().catch(() => undefined);
    }
    const events = readEvents(log);
    const starts = events.filter((e) => e.ev === "hook-start");
    const askedAts = starts.map((e) => e.askedAt);
    const originalKept = starts.length >= 2 && askedAts.every((a) => a === askedAts[0]) && askedAts[0] !== undefined;
    const afterSecond = events.slice(before);
    const askedAgain = afterSecond.some((e) => e.ev === "hook-start");
    const foundDecision = afterSecond.some((e) => e.ev === "hook-decision-found");
    const idType = starts[0]?.callIdType ?? "unknown";
    Object.assign(details, { settledAfterSecondResume: settledDesc, hookStartsAcrossProcesses: starts.map((s) => ({ pid: s.pid, askedAt: s.askedAt })), askedAgainAfterDecision: askedAgain, decisionMemoFound: foundDecision, callIdOnHookCall: idType, callId: starts[0]?.callId });
    const why: string[] = [];
    if (!originalKept) why.push(`askedAt did not survive the restart (hook starts: ${starts.length}, askedAt values: ${askedAts.join(",")})`);
    if (askedAgain && !foundDecision) why.push("after the decision memo the hook asked again");
    const pass = why.length === 0;
    return { id: "S5b", runner: cfg.runner, pass, reason: pass ? `hook reran after the restart with the original askedAt; after the decision it ${foundDecision ? "found the decision memo" : "was not asked again"} (call.id is a ${idType})` : why.join("; "), details };
  } catch (e) {
    return { id: "S5b", runner: cfg.runner, pass: false, reason: errMessage(e), details };
  }
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadSmokeRunner(args);
  try {
    if (args.flags["restart"]) {
      const o: S5bOptions = {};
      if (typeof args.flags["short-wait-ms"] === "string") o.shortWaitMs = Number(args.flags["short-wait-ms"]);
      finish(await runRestart(cfg, o));
    } else {
      const minutes = typeof args.flags["minutes"] === "string" ? Number(args.flags["minutes"]) : 5;
      finish(await runPlain(cfg, { waitMs: Math.round(minutes * 60_000) }));
    }
  } catch (e) {
    finish(failOutcome("S5", cfg.runner, `unexpected error: ${errMessage(e)}`));
  }
}
