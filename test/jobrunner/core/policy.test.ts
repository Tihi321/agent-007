/** The job runner's own rules (JobRunnerPolicy): Flow budget (I21), Scriptorium start always denied, shell denied. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CorePolicy, flowMaxCredits, isScriptoriumStart, isShellTool, kindOfTool } from "../../../src/jobrunner/policy.js";
import type { FlowCallInfo, PolicyJobView } from "../../../src/jobrunner/policy.js";
import type { JobRef } from "../../../src/jobs/contracts.js";

const REF: JobRef = { jobId: "j1", templateId: "video-clip", engine: "claude" };
const FLOW_TOOL = "mcp__flow-music-mcp__generate_video";

function policy(view: Partial<PolicyJobView> | null = {}) {
  const state: PolicyJobView | undefined = view === null ? undefined : { flowEnabled: true, flowBudget: 100, flowCharged: 0, ...view };
  const calls: FlowCallInfo[] = [];
  const p = new CorePolicy({
    flowServerId: "flow-music-mcp",
    getJob: (id) => (id === "j1" ? state : undefined),
    chargeFlow: (_id, credits) => {
      if (state) state.flowCharged += credits;
      return state?.flowCharged ?? 0;
    },
    onFlowCall: (_id, info) => void calls.push(info),
  });
  return { p, calls, state };
}

test("a Flow call with max_credits that fits the remaining budget is allowed without asking, and reserves the credits", () => {
  const { p, calls, state } = policy();
  assert.equal(p.checkPermission(REF, FLOW_TOOL, { prompt: "x", max_credits: 40 }), "allow");
  assert.equal(state?.flowCharged, 40);
  assert.equal(p.checkPermission(REF, FLOW_TOOL, { max_credits: 60 }), "allow");
  assert.equal(state?.flowCharged, 100);
  assert.deepEqual(calls.map((c) => [c.allowed, c.chargedTotal, c.remaining]), [[true, 40, 60], [true, 100, 0]]);
});

test("a Flow call over the remaining budget is denied without asking, and charges nothing", () => {
  const { p, calls, state } = policy({ flowCharged: 70 });
  assert.equal(p.checkPermission(REF, FLOW_TOOL, { max_credits: 31 }), "deny");
  assert.equal(state?.flowCharged, 70);
  assert.deepEqual(calls.map((c) => [c.allowed, c.maxCredits, c.remaining]), [[false, 31, 30]]);
  assert.equal(p.checkPermission(REF, FLOW_TOOL, { max_credits: 30 }), "allow");
});

test("a Flow call without a usable max_credits is denied", () => {
  const { p } = policy();
  for (const input of [{}, { max_credits: 0 }, { max_credits: -5 }, { max_credits: "40" }, { max_credits: null }, "text", null, [1]]) {
    assert.equal(p.checkPermission(REF, FLOW_TOOL, input as never), "deny", JSON.stringify(input));
  }
  assert.equal(flowMaxCredits({ maxCredits: 7 }), 7);
});

test("U38: flow_generate carries max_credits per scene; the job runner sums them, and every scene needs one", () => {
  const { p, calls, state } = policy();
  const scene = (max_credits?: number) => ({ prompt: "x", type: "video", ...(max_credits !== undefined ? { max_credits } : {}) });
  assert.equal(p.checkPermission(REF, FLOW_TOOL, { scenes: [scene(10), scene(15)] }), "allow");
  assert.equal(state?.flowCharged, 25);
  assert.equal(p.checkPermission(REF, FLOW_TOOL, { scenes: [scene(10), scene()] }), "deny", "a scene with no cap");
  assert.equal(p.checkPermission(REF, FLOW_TOOL, { scenes: [scene(80)] }), "deny", "over the remaining 75");
  assert.equal(p.checkPermission(REF, FLOW_TOOL, { scenes: [] }), "deny");
  assert.equal(p.checkPermission(REF, FLOW_TOOL, { scenes: [scene(-1)] }), "deny");
  assert.equal(p.checkPermission(REF, FLOW_TOOL, { scenes: "x" }), "deny");
  // free images (max_credits 0 on every scene, as video-plan's keyframes) charge nothing and are allowed in an approved Flow job
  assert.equal(p.checkPermission(REF, FLOW_TOOL, { scenes: [{ type: "image", max_credits: 0 }] }), "allow");
  assert.equal(state?.flowCharged, 25);
  assert.equal(flowMaxCredits({ scenes: [scene(3), scene(4)] }), 7);
  assert.equal(flowMaxCredits({ max_credits: 0, scenes: [scene(3)] }), undefined, "a top-level 0 is still refused");
  assert.deepEqual(calls.map((c) => c.allowed), [true, false, false, false, false, false, true]);
});

test("Flow is denied when the template has no Flow budget, and for an unknown or finished job everything is denied", () => {
  assert.equal(policy({ flowEnabled: false, flowBudget: undefined }).p.checkPermission(REF, FLOW_TOOL, { max_credits: 1 }), "deny");
  assert.equal(policy({ flowBudget: 0 }).p.checkPermission(REF, FLOW_TOOL, { max_credits: 1 }), "deny");
  const none = policy(null).p;
  assert.equal(none.checkPermission(REF, "Read", {}), "deny");
  assert.equal(none.checkPermission({ ...REF, jobId: "other" }, "Read", {}), "deny");
});

test("a Scriptorium start is always denied inside a job, however it is asked", () => {
  const { p } = policy();
  for (const [tool, input] of [
    ["mcp__scriptorium__start_factory", {}],
    ["mcp__scriptorium__resume_run", {}],
    ["hub_start", { service: "scriptorium" }],
    ["mcp__hub__hub_start", { service: "Scriptorium" }],
    ["Bash", { command: "pwsh -File scripts\\hub.ps1 start scriptorium" }],
  ] as const) {
    assert.equal(p.checkPermission(REF, tool, input), "deny", tool);
  }
  assert.equal(isScriptoriumStart("mcp__scriptorium__list_books", {}), false, "reading is not starting");
  assert.equal(isScriptoriumStart("hub_start", { service: "vibetts" }), false);
});

test("shell tools are denied: Bash, PowerShell, ACP execute and friends", () => {
  const { p } = policy();
  for (const t of ["Bash", "bash", "PowerShell", "pwsh", "Bash(git status)", "execute", "shell", "terminal"]) {
    assert.equal(isShellTool(t), true, t);
    assert.equal(p.checkPermission(REF, t, { command: "dir" }), "deny", t);
  }
  assert.equal(isShellTool("Read"), false);
});

test("everything else asks the user", () => {
  const { p } = policy();
  for (const t of ["Read", "Edit", "Write", "WebFetch", "mcp__comfy-mcp__generate"]) assert.equal(p.checkPermission(REF, t, { path: "x" }), "ask", t);
});

test("kindOfTool", () => {
  assert.equal(kindOfTool("Bash", "flow-music-mcp"), "execute");
  assert.equal(kindOfTool(FLOW_TOOL, "flow-music-mcp"), "flow");
  assert.equal(kindOfTool("Edit", "flow-music-mcp"), "edit");
  assert.equal(kindOfTool("Read", "flow-music-mcp"), "read");
  assert.equal(kindOfTool("mcp__x__y", "flow-music-mcp"), "other");
});

test("dev 153a: a free Flow tool is allowed inside an approved Flow job without max_credits and charges nothing", () => {
  const { p, calls, state } = policy();
  for (const t of ["flow_status", "flow_assemble", "music_download", "flow_download"]) {
    assert.equal(p.checkPermission(REF, `mcp__flow-music-mcp__${t}`, {}), "allow", t);
  }
  assert.equal(state?.flowCharged, 0);
  assert.ok(calls.every((c) => c.allowed && c.maxCredits === 0));
});

test("dev 153a: a free Flow tool is denied when the job has no Flow approval", () => {
  for (const v of [{ flowEnabled: false }, { flowBudget: 0 }, { flowBudget: undefined }]) {
    assert.equal(policy(v).p.checkPermission(REF, "mcp__flow-music-mcp__flow_status", {}), "deny", JSON.stringify(v));
  }
  assert.equal(policy(null).p.checkPermission(REF, "mcp__flow-music-mcp__flow_status", {}), "deny");
});

test("dev 153b: music_generate, music_remix, music_video, music_retry and generating Flow tools are never allowlisted", () => {
  const { p, state } = policy();
  for (const t of ["music_generate", "music_remix", "music_video", "music_retry", "flow_agent_images", "flow_retry", "flow_trash", "flow_character", "flow_set_key", "flow_inspect"]) {
    assert.equal(p.checkPermission(REF, `mcp__flow-music-mcp__${t}`, {}), "deny", t);
  }
  assert.equal(state?.flowCharged, 0);
});
