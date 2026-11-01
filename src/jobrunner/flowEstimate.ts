/**
 * The live Flow estimate (S14.4, S14.5, U38). For a template with `flow.estimator: "video-plan"` the job runner runs exactly
 *
 *     <node> scripts/video-plan.mjs estimate <runDir>        (cwd: the template's cwd, which the cwd allowlist has accepted)
 *
 * as a fixed argv (no shell). `estimate` is the read-only mode of creative-hub's planner: it reads `<runDir>/plan.json`
 * and prints the dry run; it writes nothing and calls no Flow tool (checked in `scripts/video-plan.mjs`, section 14 S14.5).
 * `<runDir>` comes from the template's `runDir` param and must be a folder under `runs/` with a plain name, so nothing but a
 * run folder of the hub can be named. `plan` (which writes) is never run from here.
 *
 * Output format (real, from `dryRun` in video-plan.mjs; see plan section 14 S14.5):
 *
 *     Video credits: 18[ (2 clip(s) priced pro rata, not quoted by Flow)]
 *     Retake reserve (25%): 5  ->  23 with the reserve
 *     Flow budget: 150, spent 0, left 150. Fits with the reserve.
 *
 * The number approved is the "with the reserve" total (video credits plus the retake reserve): `next` lets a shot be retaken
 * once, so the video credits alone would under-budget the job. Flow Music credits (songs) are a separate balance, not in it.
 */
import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { FlowEstimateReply } from "../jobs/contracts.js";
import { nodeExec } from "./proc.js";
import type { Exec } from "./proc.js";

/** `runs/<name>[/<name>...]`, at most 4 plain segments, no dots-only segment, no drive, no `..`. */
export const RUN_DIR_PATTERN = /^runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}$/;
export const ESTIMATE_TIMEOUT_MS = 30_000;

export class FlowEstimateRefused extends Error {
  readonly code: "invalid_params" | "internal";
  constructor(code: "invalid_params" | "internal", message: string) {
    super(message);
    this.name = "FlowEstimateRefused";
    this.code = code;
  }
}

/** The run dir in the form the script gets (forward slashes), or why it is refused. */
export function normalizeRunDir(raw: unknown): { ok: true; runDir: string } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "no runDir was given: a Flow estimate needs the folder of an existing shot plan (runs/<slug>/video with a plan.json)" };
  const runDir = raw.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!RUN_DIR_PATTERN.test(runDir)) return { ok: false, reason: `runDir "${raw.slice(0, 80)}" must look like runs/<name>/video (plain folder names under runs/)` };
  if (runDir.split("/").some((s) => /^\.+$/.test(s))) return { ok: false, reason: "runDir must not contain . or .. segments" };
  return { ok: true, runDir };
}

/** Parses the dry run text. Returns undefined when the lines the number comes from are not there (the format changed). */
export function parseDryRun(stdout: string): { videoCredits: number; reserve: number; withReserve: number } | undefined {
  const video = /^Video credits:\s*(\d+)\b/m.exec(stdout);
  const reserve = /^Retake reserve \([^)]*\):\s*(\d+)\s*->\s*(\d+) with the reserve/m.exec(stdout);
  if (!video || !reserve) return undefined;
  const videoCredits = Number(video[1]);
  const res = Number(reserve[1]);
  const withReserve = Number(reserve[2]);
  if (![videoCredits, res, withReserve].every((n) => Number.isSafeInteger(n) && n >= 0)) return undefined;
  if (withReserve !== videoCredits + res) return undefined; // the two lines must agree, or the format is not what we know
  return { videoCredits, reserve: res, withReserve };
}

export interface FlowEstimateDeps {
  exec?: Exec;
  nodePath?: string;
  timeoutMs?: number;
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
}

/**
 * Runs the estimator in `cwd` (already accepted by the cwd allowlist) for `runDirRaw`. Throws `FlowEstimateRefused` with a
 * message the model and the user can read.
 */
export async function runVideoPlanEstimate(cwd: string, runDirRaw: unknown, deps: FlowEstimateDeps = {}): Promise<FlowEstimateReply> {
  const exists = deps.exists ?? existsSync;
  const realpath = deps.realpath ?? ((p: string) => realpathSync.native(p));
  const dir = normalizeRunDir(runDirRaw);
  if (!dir.ok) throw new FlowEstimateRefused("invalid_params", dir.reason);
  const planFile = join(cwd, ...dir.runDir.split("/"), "plan.json");
  if (!exists(planFile)) throw new FlowEstimateRefused("invalid_params", `there is no ${dir.runDir}/plan.json yet: the shot plan must exist before the credits can be estimated`);
  try {
    // a junction inside runs/ that leads out of it is refused
    const runsReal = realpath(join(cwd, "runs"));
    const planReal = realpath(planFile);
    if (!planReal.toLowerCase().startsWith((runsReal + sep).toLowerCase())) throw new FlowEstimateRefused("invalid_params", "runDir resolves outside runs/");
  } catch (e) {
    if (e instanceof FlowEstimateRefused) throw e;
    throw new FlowEstimateRefused("invalid_params", "runDir could not be resolved");
  }
  const script = join(cwd, "scripts", "video-plan.mjs");
  if (!exists(script)) throw new FlowEstimateRefused("internal", "scripts/video-plan.mjs is not in the template's folder");
  const r = await (deps.exec ?? nodeExec)(deps.nodePath ?? process.execPath, ["scripts/video-plan.mjs", "estimate", dir.runDir], { cwd, timeoutMs: deps.timeoutMs ?? ESTIMATE_TIMEOUT_MS, maxBytes: 32 * 1024 });
  if (r.timedOut) throw new FlowEstimateRefused("internal", "video-plan.mjs did not answer in time");
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 200);
    throw new FlowEstimateRefused("internal", `video-plan.mjs estimate failed (exit ${r.code ?? "none"})${why ? `: ${why}` : ""}`);
  }
  const parsed = parseDryRun(r.stdout);
  if (!parsed) throw new FlowEstimateRefused("internal", "the output of video-plan.mjs estimate has no credit lines in the expected format, so no number was taken from it");
  if (parsed.withReserve <= 0) throw new FlowEstimateRefused("internal", "the plan has no paid video clips (0 credits), so there is nothing to approve for Flow");
  return { credits: parsed.withReserve, videoCredits: parsed.videoCredits, reserve: parsed.reserve, runDir: dir.runDir };
}
