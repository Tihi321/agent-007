import assert from "node:assert/strict";
import { test } from "node:test";
import { CANCELLED, allowOutcome, permissionKind, rejectOutcome, shownOptions, toJsonInput } from "../../../src/jobrunner/drivers/dsh/permissions.js";
import type { PolicyVerdict } from "../../../src/jobs/contracts.js";
import { collect, readLog, rig, spec, waitFor } from "./helpers.js";
import type { Rig } from "./helpers.js";

const T = { timeout: 30_000 };

const O = (kind: string) => ({ optionId: `opt-${kind}`, name: kind, kind: kind as "allow_once" });

test("pure: only allow_once and reject_once are shown; always options are never selected", () => {
  const all = ["allow_once", "allow_always", "reject_once", "reject_always"].map(O);
  assert.deepEqual(shownOptions(all).map((o) => o.kind), ["allow_once", "reject_once"]);
  assert.deepEqual(allowOutcome(all), { outcome: { outcome: "selected", optionId: "opt-allow_once" } });
  assert.deepEqual(rejectOutcome(all), { outcome: { outcome: "selected", optionId: "opt-reject_once" } });
  const onlyAlways = ["allow_always", "reject_always"].map(O);
  assert.deepEqual(allowOutcome(onlyAlways), CANCELLED);
  assert.deepEqual(rejectOutcome(onlyAlways), CANCELLED);
  // allow wanted but only reject is offered: reject
  assert.deepEqual(allowOutcome(["reject_once"].map(O)), { outcome: { outcome: "selected", optionId: "opt-reject_once" } });
});

test("pure: kinds map; a shell-looking name is execute even when labelled other", () => {
  assert.equal(permissionKind("execute", "x"), "execute");
  assert.equal(permissionKind("other", "shell"), "execute");
  assert.equal(permissionKind("other", "run_command"), "execute");
  assert.equal(permissionKind(undefined, "Bash"), "execute");
  assert.equal(permissionKind("read", "read_file"), "read");
  assert.equal(permissionKind("search", "grep"), "read");
  assert.equal(permissionKind("edit", "write_file"), "edit");
  assert.equal(permissionKind("delete", "rm_file"), "edit");
  assert.equal(permissionKind("fetch", "web"), "other");
  assert.equal(permissionKind(null, "mcp tool"), "other");
});

test("pure: tool input is capped and never throws", () => {
  assert.deepEqual(toJsonInput(undefined), {});
  assert.deepEqual(toJsonInput({ a: 1 }), { a: 1 });
  const big = toJsonInput({ s: "x".repeat(10_000) }) as { truncated?: boolean; preview?: string };
  assert.equal(big.truncated, true);
  assert.equal(big.preview?.length, 4000);
  const cyc: Record<string, unknown> = {};
  cyc["self"] = cyc;
  assert.deepEqual(toJsonInput(cyc), { unserializable: true });
});

interface Case {
  name: string;
  options: string[];
  toolKind?: string;
  toolName?: string;
  verdict?: PolicyVerdict;
  user?: "allow_once" | "deny" | "throw";
  policyThrows?: boolean;
  expect: string;
  asked: number;
  policyCalls: number;
}

const CASES: Case[] = [
  { name: "ask + user allow_once selects allow_once", options: ["allow_once", "reject_once"], verdict: "ask", user: "allow_once", expect: "selected:opt-allow_once", asked: 1, policyCalls: 1 },
  { name: "ask + user deny selects reject_once", options: ["allow_once", "reject_once"], verdict: "ask", user: "deny", expect: "selected:opt-reject_once", asked: 1, policyCalls: 1 },
  { name: "the always options are dropped: allow wanted, only allow_always + reject_once offered -> reject_once", options: ["allow_always", "reject_once"], verdict: "ask", user: "allow_once", expect: "selected:opt-reject_once", asked: 1, policyCalls: 1 },
  { name: "all four offered: allow selects allow_once, not allow_always", options: ["allow_always", "allow_once", "reject_always", "reject_once"], verdict: "ask", user: "allow_once", expect: "selected:opt-allow_once", asked: 1, policyCalls: 1 },
  { name: "all four offered: deny selects reject_once, not reject_always", options: ["allow_always", "allow_once", "reject_always", "reject_once"], verdict: "ask", user: "deny", expect: "selected:opt-reject_once", asked: 1, policyCalls: 1 },
  { name: "only always options: cancelled, never an always option", options: ["allow_always", "reject_always"], verdict: "ask", user: "allow_once", expect: "cancelled", asked: 1, policyCalls: 1 },
  { name: "policy deny rejects without asking", options: ["allow_once", "reject_once"], verdict: "deny", expect: "selected:opt-reject_once", asked: 0, policyCalls: 1 },
  { name: "policy allow selects allow_once without asking", options: ["allow_once", "reject_once"], verdict: "allow", expect: "selected:opt-allow_once", asked: 0, policyCalls: 1 },
  { name: "execute kind is rejected without the policy or the user", options: ["allow_once", "reject_once"], toolKind: "execute", verdict: "allow", expect: "selected:opt-reject_once", asked: 0, policyCalls: 0 },
  { name: "execute kind with the user's would-be allow is still rejected", options: ["allow_always", "allow_once", "reject_once"], toolKind: "execute", verdict: "ask", user: "allow_once", expect: "selected:opt-reject_once", asked: 0, policyCalls: 0 },
  { name: "a shell-looking tool labelled other is treated as execute", options: ["allow_once", "reject_once"], toolKind: "other", toolName: "shell", verdict: "allow", expect: "selected:opt-reject_once", asked: 0, policyCalls: 0 },
  { name: "execute with no reject_once offered is cancelled", options: ["allow_once", "reject_always"], toolKind: "execute", expect: "cancelled", asked: 0, policyCalls: 0 },
  { name: "the host failing to answer rejects", options: ["allow_once", "reject_once"], verdict: "ask", user: "throw", expect: "selected:opt-reject_once", asked: 1, policyCalls: 1 },
  { name: "a throwing policy rejects", options: ["allow_once", "reject_once"], policyThrows: true, expect: "selected:opt-reject_once", asked: 0, policyCalls: 1 },
];

for (const c of CASES) {
  test(`permission: ${c.name}`, T, async () => {
    const r = rig({
      scenario: "permission",
      scenarioOpts: { options: c.options, toolKind: c.toolKind ?? "edit", ...(c.toolName ? { name: c.toolName } : {}) },
    });
    try {
      r.host.verdict = () => {
        if (c.policyThrows) throw new Error("policy blew up");
        return c.verdict ?? "ask";
      };
      if (c.user === "deny") r.host.answer = async (q) => ({ requestId: q.requestId, jobId: q.jobId, answer: "deny", by: "user", at: 0 });
      if (c.user === "throw") r.host.answer = async () => { throw new Error("transport down"); };
      await r.driver.start(spec(r.host, r.dir.path));
      await collect(r.driver, "job-1");
      const out = readLog(r.logFile).find((l) => l["event"] === "permission_outcome")?.["outcome"];
      assert.equal(out, c.expect);
      assert.equal(r.host.asked.length, c.asked, "times the user was asked");
      assert.equal(r.host.policyCalls.length, c.policyCalls, "times the policy was asked");
    } finally {
      r.cleanup();
    }
  });
}

test("permission card: engine dsh, kind, tool, input and a one-line summary; the key is redacted", T, async () => {
  const r = rig({ scenario: "permission", scenarioOpts: { toolKind: "edit", title: "Edit notes.md", name: "write_file", rawInput: { path: "notes.md", note: "sk-test-DEEPSEEK-0123456789abcdef" } } });
  try {
    await r.driver.start(spec(r.host, r.dir.path));
    await collect(r.driver, "job-1");
    assert.equal(r.host.asked.length, 1);
    const q = r.host.asked[0]!;
    assert.equal(q.engine, "dsh");
    assert.equal(q.jobId, "job-1");
    assert.equal(q.kind, "edit");
    assert.equal(q.tool, "write_file");
    assert.equal(q.cwd, r.dir.path);
    assert.equal(q.summary, "write_file: Edit notes.md");
    assert.deepEqual(q.input, { path: "notes.md", note: "[REDACTED]" });
    assert.ok(q.requestId.length > 8 && q.timeoutSec > 0 && q.requestedAt > 0);
    assert.equal(r.host.policyCalls[0]?.tool, "write_file");
  } finally {
    r.cleanup();
  }
});

test("cancel answers every pending permission request with `cancelled` and ends the job cancelled", T, async () => {
  const r = rig({ scenario: "permission_hold" });
  try {
    // The user never answers.
    r.host.answer = () => new Promise(() => {});
    await r.driver.start(spec(r.host, r.dir.path));
    await waitFor(() => r.host.asked.length === 1, 10_000, "the permission card");
    const done = collect(r.driver, "job-1");
    await r.driver.cancel("job-1");
    const events = await done;
    const outcome = readLog(r.logFile).find((l) => l["event"] === "permission_outcome")?.["outcome"];
    assert.equal(outcome, "cancelled");
    assert.ok(readLog(r.logFile).some((l) => l["event"] === "cancel"));
    assert.equal((events.at(-1) as { state?: string }).state, "cancelled");
  } finally {
    r.cleanup();
  }
});
