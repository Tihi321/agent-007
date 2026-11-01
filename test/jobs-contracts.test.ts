/** S9.4: `ALWAYS_LOADED` (I27) and the pure helpers of src/jobs/contracts.ts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOL_SEARCH_TOOL_NAME } from "../src/pi/adapter.js";
import {
  ALWAYS_LOADED,
  DEFERRED_KNOWN_TOOLS,
  DEFERRED_PHASE1_TOOLS,
  MAX_ALWAYS_LOADED,
  MAX_BRIEF_CHARS,
  TERMINAL_JOB_STATES,
  JOB_STATES,
  checkToolCap,
  isTerminalJobState,
  nonDeferredNames,
  parseJobRequest,
} from "../src/jobs/contracts.js";

const EXPECTED = ["tool_search", "dispatch_job", "job_status", "cancel_job", "list_templates", "ask_user", "hub_status", "system_facts", "list_dir", "read_file"];

test("ALWAYS_LOADED is exactly the 10 names of I27, in that order, and at most 10", () => {
  assert.deepEqual([...ALWAYS_LOADED], EXPECTED);
  assert.equal(ALWAYS_LOADED.length, MAX_ALWAYS_LOADED);
  assert.ok(ALWAYS_LOADED.length <= 10);
  assert.equal(new Set(ALWAYS_LOADED).size, ALWAYS_LOADED.length, "no duplicates");
});

test("its tool_search entry is the name Pi Durable's tool_search tool really has", () => {
  assert.equal(ALWAYS_LOADED[0], TOOL_SEARCH_TOOL_NAME);
});

test("the Phase 1 tools that become deferred, and hub_start, are not in ALWAYS_LOADED", () => {
  assert.deepEqual([...DEFERRED_PHASE1_TOOLS], ["search_files", "write_file", "remember", "shell"]);
  for (const n of DEFERRED_KNOWN_TOOLS) assert.equal((ALWAYS_LOADED as readonly string[]).includes(n), false, n);
  for (const n of ["hub_start", "ask_bot", "list_bots", "propose_setting", "switch_persona", "ask_second_opinion"]) assert.ok((DEFERRED_KNOWN_TOOLS as readonly string[]).includes(n), n);
});

test("checkToolCap: the exact 10 pass; an extra, a missing or a duplicate non-deferred tool fails", () => {
  const all = ALWAYS_LOADED.map((name) => ({ name }));
  const deferred = [...DEFERRED_KNOWN_TOOLS, "mcp__vibetts__speak"].map((name) => ({ name, deferred: true }));
  assert.equal(checkToolCap([...all, ...deferred]).ok, true);
  assert.deepEqual(nonDeferredNames([...all, ...deferred]), EXPECTED);

  const extra = checkToolCap([...all, { name: "shell" }, ...deferred]);
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.unexpected, ["shell"]);
  assert.equal(extra.tooMany, true);

  const missing = checkToolCap([...all.filter((t) => t.name !== "ask_user"), ...deferred]);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["ask_user"]);

  const dup = checkToolCap([...all, { name: "read_file" }]);
  assert.equal(dup.ok, false);
  assert.equal(dup.tooMany, true);

  // per-bot form (Phase 4): an allowlist can only narrow
  assert.equal(checkToolCap(all.slice(0, 4), { subset: true }).ok, true);
  assert.equal(checkToolCap([...all.slice(0, 4), { name: "remember" }], { subset: true }).ok, false);
  assert.equal(checkToolCap(all.slice(0, 4)).ok, false, "without subset the full 10 are required");
});

test("job states: terminal ones are exactly succeeded, failed, cancelled, rejected", () => {
  assert.deepEqual([...TERMINAL_JOB_STATES], ["succeeded", "failed", "cancelled", "rejected"]);
  for (const s of JOB_STATES) assert.equal(isTerminalJobState(s), (TERMINAL_JOB_STATES as readonly string[]).includes(s), s);
  assert.equal(isTerminalJobState("interrupted"), false);
});

test("parseJobRequest accepts only templateId, params and brief; a raw command, prompt or cwd is refused", () => {
  const ok = parseJobRequest({ templateId: "tts-line", params: { text: "hi" }, brief: "say hi" });
  assert.deepEqual(ok, { ok: true, value: { templateId: "tts-line", params: { text: "hi" }, brief: "say hi" } });
  assert.deepEqual(parseJobRequest({ templateId: "x" }), { ok: true, value: { templateId: "x", params: {}, brief: "" } });
  for (const extra of ["command", "prompt", "cwd", "argv", "env"]) {
    const r = parseJobRequest({ templateId: "x", params: {}, brief: "", [extra]: "whoami" });
    assert.equal(r.ok, false, extra);
    assert.match((r as { error: string }).error, new RegExp(`unknown field "${extra}"`));
  }
  for (const bad of [null, [], "x", 1]) assert.equal(parseJobRequest(bad).ok, false);
  assert.equal(parseJobRequest({ templateId: "../x", params: {}, brief: "" }).ok, false);
  assert.equal(parseJobRequest({ templateId: "x", params: [], brief: "" }).ok, false);
  assert.equal(parseJobRequest({ templateId: "x", params: {}, brief: 5 }).ok, false);
  assert.equal(parseJobRequest({ templateId: "x", params: {}, brief: "a".repeat(MAX_BRIEF_CHARS + 1) }).ok, false);
});
