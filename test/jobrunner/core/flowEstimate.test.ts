/**
 * S14.4 / S14.5 (U38): the live Flow estimate. The fake reproduces the REAL output of creative-hub
 * `node scripts/video-plan.mjs estimate <run dir>` captured on 2026-10-31 (plan section 14, S14.5) from the harbour fixture:
 * 3 video clips of Omni 360p, 6 s each. Nothing here starts creative-hub, a Flow tool or anything that spends credits.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { IpcHandlerError } from "../../../src/ipc/server.js";
import { createHandler } from "../../../src/jobrunner/server.js";
import { RUN_DIR_PATTERN, normalizeRunDir, parseDryRun, runVideoPlanEstimate } from "../../../src/jobrunner/flowEstimate.js";
import type { Exec } from "../../../src/jobrunner/proc.js";
import { flowTemplate, makeEnv, makeRig } from "./helpers.js";
import type { Env } from "./helpers.js";

/** Captured from the real script (verbatim). */
export const REAL_ESTIMATE_OUTPUT = `The Last Boat (harbour-test): short-film, 16:9, 21 s, 4 shots (3 video clips) with Omni 1.1 Flash 360p

  ch01.s01.sh01   6 s  extreme wide, static, 1 line(s)  6 credits (guessed)
  ch01.s01.sh02   6 s  medium, slow push-in, 1 line(s)  6 credits (guessed)
  ch01.s01.sh03   6 s  medium two-shot, static, 2 line(s)  6 credits (guessed)
  ch01.s01.sh04   3 s  title card  free

Video credits: 18 (3 clip(s) priced pro rata, not quoted by Flow)
Retake reserve (25%): 5  ->  23 with the reserve
Flow budget: 150, spent 0, left 150. Fits with the reserve.
Flow Music budget: 10, spent 0, left 10 (a separate balance from Flow's video credits).
Last known balance: unknown (flow_status shows it)
Music: 1 cue(s) (m1), each song costs credits and is asked first. Images, voices and the assembly are free.

Warnings:
  - runtime 21 s is outside the format's range 60 to 180 s
`;

const SCRIPT = `// fake of creative-hub scripts/video-plan.mjs: prints the captured output for "estimate", refuses anything else
const [cmd] = process.argv.slice(2);
if (cmd !== "estimate") { console.error("fake: only estimate is read-only"); process.exit(3); }
process.stdout.write(${JSON.stringify(REAL_ESTIMATE_OUTPUT)});
`;

function hubWithPlan(env: Env, runDir = "runs/harbour/video"): void {
  mkdirSync(join(env.hub, ...runDir.split("/")), { recursive: true });
  writeFileSync(join(env.hub, ...runDir.split("/"), "plan.json"), "{}");
  mkdirSync(join(env.hub, "scripts"), { recursive: true });
  writeFileSync(join(env.hub, "scripts", "video-plan.mjs"), SCRIPT);
}

const estTemplate = (env: Env, over: Record<string, unknown> = {}) =>
  flowTemplate(env, {
    id: "short-video",
    params: { type: "object", properties: { runDir: { type: "string", maxLength: 200 } }, required: ["runDir"] },
    prompt: "Make the video in {{params.runDir}}.\n{{brief}}",
    flow: { enabled: true, estimator: "video-plan", maxCredits: 200 },
    ...over,
  });

test("parseDryRun reads the real output: video credits 18, reserve 5, 23 with the reserve", () => {
  assert.deepEqual(parseDryRun(REAL_ESTIMATE_OUTPUT), { videoCredits: 18, reserve: 5, withReserve: 23 });
  // a plan with every clip quoted by Flow has no "priced pro rata" note
  assert.deepEqual(parseDryRun("Video credits: 12\nRetake reserve (25%): 3  ->  15 with the reserve\n"), { videoCredits: 12, reserve: 3, withReserve: 15 });
});

test("parseDryRun refuses a changed format, missing lines and numbers that do not add up", () => {
  assert.equal(parseDryRun(""), undefined);
  assert.equal(parseDryRun("Video credits: 18\n"), undefined);
  assert.equal(parseDryRun("Total: 23 credits\n"), undefined);
  assert.equal(parseDryRun("Video credits: 18\nRetake reserve (25%): 5  ->  99 with the reserve\n"), undefined);
  assert.equal(parseDryRun("Video credits: abc\nRetake reserve (25%): 5  ->  23 with the reserve\n"), undefined);
});

test("normalizeRunDir: only plain run folders under runs/", () => {
  assert.deepEqual(normalizeRunDir("runs/harbour/video"), { ok: true, runDir: "runs/harbour/video" });
  assert.deepEqual(normalizeRunDir("runs\\harbour\\video\\"), { ok: true, runDir: "runs/harbour/video" });
  for (const bad of [undefined, "", 5, "harbour", "runs", "runs/..", "runs/../x", "runs/a/../../..", "../runs/a", "C:\\runs\\a", "/runs/a", "runs//a", "runs/a b", "runs/a;calc", "runs/-x", "runs/a/b/c/d/e", "runs/./a", "runs/a/.."]) {
    assert.equal(normalizeRunDir(bad).ok, false, String(bad));
  }
  assert.equal(RUN_DIR_PATTERN.test("runs/x"), true);
});

test("runVideoPlanEstimate: a real node process running the fake script (estimate only) returns 23", async () => {
  const env = makeEnv();
  try {
    hubWithPlan(env);
    const r = await runVideoPlanEstimate(env.hub, "runs/harbour/video");
    assert.deepEqual(r, { credits: 23, videoCredits: 18, reserve: 5, runDir: "runs/harbour/video" });
  } finally {
    env.cleanup();
  }
});

test("runVideoPlanEstimate: argv is fixed (node, scripts/video-plan.mjs, estimate, run dir), no shell", async () => {
  const env = makeEnv();
  try {
    hubWithPlan(env);
    const seen: { exe: string; args: string[]; cwd: string }[] = [];
    const exec: Exec = (exe, args, o) => {
      seen.push({ exe, args: [...args], cwd: o.cwd });
      return Promise.resolve({ code: 0, stdout: REAL_ESTIMATE_OUTPUT, stderr: "", timedOut: false });
    };
    await runVideoPlanEstimate(env.hub, "runs\\harbour\\video", { exec, nodePath: "node-x" });
    assert.deepEqual(seen, [{ exe: "node-x", args: ["scripts/video-plan.mjs", "estimate", "runs/harbour/video"], cwd: env.hub }]);
  } finally {
    env.cleanup();
  }
});

test("runVideoPlanEstimate refuses with a reason: no plan.json, bad run dir, failing script, changed output, timeout, zero credits", async () => {
  const env = makeEnv();
  try {
    hubWithPlan(env);
    const refused = async (runDir: unknown, exec: Exec | undefined, re: RegExp): Promise<void> =>
      assert.rejects(runVideoPlanEstimate(env.hub, runDir, exec ? { exec } : {}), (e: unknown) => {
        assert.match((e as Error).message, re);
        return true;
      });
    await refused("runs/other/video", undefined, /no runs\/other\/video\/plan\.json yet/);
    await refused("runs/../scripts", undefined, /must look like runs/);
    await refused(undefined, undefined, /no runDir was given/);
    const out = (code: number | null, stdout: string, stderr = "", timedOut = false): Exec => () => Promise.resolve({ code, stdout, stderr, timedOut });
    await refused("runs/harbour/video", out(1, "", 'video-plan: no plan.json in runs/x: run "plan" first'), /failed \(exit 1\).*run "plan" first/);
    await refused("runs/harbour/video", out(0, "something else\n"), /no credit lines in the expected format/);
    await refused("runs/harbour/video", out(null, "", "", true), /did not answer in time/);
    await refused("runs/harbour/video", out(0, "Video credits: 0\nRetake reserve (25%): 0  ->  0 with the reserve\n"), /no paid video clips/);
  } finally {
    env.cleanup();
  }
});

test("manager.flowEstimate: a video-plan template returns the number; other templates, bad params and a cwd outside the allowlist are refused", async () => {
  const env = makeEnv();
  try {
    hubWithPlan(env);
    const rig = makeRig({
      env,
      templates: [
        estTemplate(env),
        flowTemplate(env, { id: "fixed", prompt: "{{brief}}", params: { type: "object", properties: {} } }), // flow.estimate 40: no estimator
      ],
    });
    assert.deepEqual(await rig.manager.flowEstimate({ templateId: "short-video", params: { runDir: "runs/harbour/video" } }), { credits: 23, videoCredits: 18, reserve: 5, runDir: "runs/harbour/video" });
    const code = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
      } catch (e) {
        assert.ok(e instanceof IpcHandlerError);
        return `${e.code}: ${e.message}`;
      }
      return "no error";
    };
    assert.match(await code(rig.manager.flowEstimate({ templateId: "nope", params: {} })), /^unknown_template/);
    assert.match(await code(rig.manager.flowEstimate({ templateId: "fixed", params: {} })), /^unsupported: .*no video-plan estimator/);
    assert.match(await code(rig.manager.flowEstimate({ templateId: "short-video", params: {} })), /^invalid_params: .*runDir/);
    assert.match(await code(rig.manager.flowEstimate({ templateId: "short-video", params: { runDir: "runs/none/video" } })), /^invalid_params: .*plan\.json/);
    assert.match(await code(rig.manager.flowEstimate({ templateId: "short-video", params: { runDir: "..\\..\\Windows" } })), /^invalid_params: .*must look like runs/);
  } finally {
    env.cleanup();
  }
});

test("manager.flowEstimate: a cwd outside the allowlist is refused before anything runs", async () => {
  const env = makeEnv();
  try {
    hubWithPlan(env);
    let ran = false;
    const rig = makeRig({
      env,
      templates: [estTemplate(env, { id: "elsewhere" })],
      overrides: {
        checkCwd: () => ({ ok: false, reason: "the cwd is not in the job runner's cwd allowlist" }),
        runFlowEstimate: () => {
          ran = true;
          return Promise.reject(new Error("must not run"));
        },
      },
    });
    await assert.rejects(rig.manager.flowEstimate({ templateId: "elsewhere", params: { runDir: "runs/harbour/video" } }), (e: unknown) => e instanceof IpcHandlerError && e.code === "cwd_refused");
    assert.equal(ran, false);
  } finally {
    env.cleanup();
  }
});

test("the IPC handler routes flow_estimate and validates its body strictly", async () => {
  const env = makeEnv();
  try {
    hubWithPlan(env);
    const rig = makeRig({ env, templates: [estTemplate(env)] });
    const handle = createHandler(rig.manager);
    const ctx = { principal: "main" } as never;
    assert.deepEqual(await handle("flow_estimate", { templateId: "short-video", params: { runDir: "runs/harbour/video" } }, ctx), { credits: 23, videoCredits: 18, reserve: 5, runDir: "runs/harbour/video" });
    await assert.rejects(handle("flow_estimate", { templateId: "short-video", params: {}, extra: 1 } as never, ctx), (e: unknown) => e instanceof IpcHandlerError && e.code === "bad_request");
    await assert.rejects(handle("flow_estimate", { params: {} }, ctx), (e: unknown) => e instanceof IpcHandlerError && e.code === "bad_request");
    await assert.rejects(handle("flow_estimate", { templateId: "short-video", params: [] as never }, ctx), (e: unknown) => e instanceof IpcHandlerError && e.code === "bad_request");
    // a per-job permission helper may not ask for an estimate
    await assert.rejects(handle("flow_estimate", { templateId: "short-video", params: {} }, { principal: "job:j1" } as never), (e: unknown) => e instanceof IpcHandlerError && e.code === "forbidden");
  } finally {
    env.cleanup();
  }
});
