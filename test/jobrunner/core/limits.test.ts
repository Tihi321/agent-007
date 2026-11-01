/** S11.1 / S11.3 done-check: jobrunner.json parsing (no way to configure a non-loopback bind), each cap, and the output budget. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, Limits, OutputBudget, parseJobRunnerConfig } from "../../../src/jobrunner/limits.js";
import type { JobTemplate } from "../../../src/jobs/contracts.js";
import { parseTemplate } from "../../../src/jobrunner/templates.js";
import { claudeTemplate, flowTemplate } from "./helpers.js";

const HUB = { hub: "C:\\projects\\Personal\\creative-hub" };

function tpl(raw: Record<string, unknown>): JobTemplate {
  const r = parseTemplate(raw, { flowServerId: "flow-music-mcp" });
  assert.ok(r.ok, JSON.stringify(r));
  return (r as { ok: true; template: JobTemplate }).template;
}

test("defaults: creative-hub is the only allowed cwd, dsh is off, one job per engine, no default Flow budget", () => {
  const c = parseJobRunnerConfig({}, { localAppData: "C:\\Users\\me\\AppData\\Local" });
  assert.equal(c.ipcPort, 47007);
  assert.deepEqual(c.cwdAllowlist, ["C:\\projects\\Personal\\creative-hub"]);
  assert.ok(c.denyPaths.includes("C:\\Pixotope"));
  assert.equal(c.engines.dsh.enabled, false);
  assert.equal(c.engines.dsh.verified, false);
  assert.equal(c.engines.claude.enabled, true);
  assert.deepEqual(c.limits.maxConcurrent, { claude: 1, dsh: 1, hub: 1 });
  assert.equal(c.limits.dailyCreditCap, 0, "no default Flow budget (D11)");
  assert.equal(c.paths.dataDir, "C:\\Users\\me\\AppData\\Local\\agent-007-jobrunner");
  assert.equal(c.paths.templatesDir, "C:\\ProgramData\\agent-007\\jobrunner\\templates");
});

test("the config is strict: there is no setting for the bind host, and unknown keys and bad values are errors", () => {
  for (const bad of [{ ipcHost: "0.0.0.0" }, { host: "0.0.0.0" }, { listen: "0.0.0.0:47007" }, { limits: { dailyJobCap: -1 } }, { limits: { maxConcurrent: { claude: 9 } } }, { cwdAllowlist: [] }, { cwdAllowlist: ["relative"] }, { cwdAllowlist: ["\\\\server\\share"] }, { engines: { claude: { enabled: "yes" } } }, { ipcPort: 0 }, { hub: { services: ["Bad Name"] } }]) {
    assert.throws(() => parseJobRunnerConfig(bad), ConfigError, JSON.stringify(bad));
  }
  assert.throws(() => parseJobRunnerConfig({ ipcHost: "0.0.0.0" }), /ipcHost is not a known setting/);
  // underscore keys are comments
  assert.doesNotThrow(() => parseJobRunnerConfig({ _comment: "hi", limits: { _note: 1 } }));
});

test("daily job cap: counted from the records of today, so a restart does not reset it", () => {
  const now = new Date(2026, 5, 10, 12, 0, 0).getTime();
  const c = parseJobRunnerConfig({ limits: { dailyJobCap: 2 } });
  const lim = new Limits(c, () => now);
  const t = tpl(claudeTemplate(HUB));
  const ok = lim.checkSubmit({ template: t, flowBudgetCredits: undefined, usage: lim.usageToday([{ createdAt: now - 1000 }]) });
  assert.equal(ok.ok, true);
  const full = lim.checkSubmit({ template: t, flowBudgetCredits: undefined, usage: lim.usageToday([{ createdAt: now - 1000 }, { createdAt: now - 2000 }]) });
  assert.equal(full.ok, false);
  if (!full.ok) {
    assert.equal(full.code, "limit_exceeded");
    assert.match(full.message, /daily job cap \(2\)/);
  }
  // yesterday's jobs do not count
  const yesterday = new Date(2026, 5, 9, 23, 0, 0).getTime();
  assert.deepEqual(lim.usageToday([{ createdAt: yesterday }, { createdAt: yesterday }]), { jobs: 0, credits: 0 });
});

test("credit caps: a Flow budget is required, per-template and daily caps hold, and a non-Flow template takes none", () => {
  const now = Date.now();
  const c = parseJobRunnerConfig({ limits: { dailyCreditCap: 150, perTemplateMaxCredits: { "video-clip": 80 } } });
  const lim = new Limits(c, () => now);
  const flow = tpl(flowTemplate(HUB)); // maxCredits 100
  const usage = (credits: number) => ({ jobs: 0, credits });
  const check = (credits: number | undefined, used = 0) => lim.checkSubmit({ template: flow, flowBudgetCredits: credits, usage: usage(used) });
  assert.equal(lim.maxCreditsFor(flow), 80, "the config lowers the template cap");
  assert.equal(check(undefined).ok, false, "required");
  assert.equal(check(0).ok, false);
  assert.equal(check(80).ok, true);
  const over = check(81);
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.message, /at most 80 credits/);
  const daily = check(60, 100);
  assert.equal(daily.ok, false);
  if (!daily.ok) assert.match(daily.message, /daily credit cap \(150\)/);
  assert.equal(check(50, 100).ok, true);
  const plain = tpl(claudeTemplate(HUB));
  assert.equal(lim.checkSubmit({ template: plain, flowBudgetCredits: 10, usage: usage(0) }).ok, false);
  assert.equal(lim.checkSubmit({ template: plain, flowBudgetCredits: undefined, usage: usage(0) }).ok, true);
  // the default daily credit cap is 0: no Flow job without the user setting one
  const lim0 = new Limits(parseJobRunnerConfig({}), () => now);
  assert.equal(lim0.checkSubmit({ template: flow, flowBudgetCredits: 10, usage: usage(0) }).ok, false);
});

test("duration cap: the template's timeout, never above maxDurationMin", () => {
  const lim = new Limits(parseJobRunnerConfig({ limits: { maxDurationMin: 30 } }));
  assert.equal(lim.timeoutMs(tpl(claudeTemplate(HUB, { timeoutMin: 10 }))), 10 * 60_000);
  assert.equal(lim.timeoutMs(tpl(claudeTemplate(HUB, { timeoutMin: 120 }))), 30 * 60_000);
});

test("concurrency limit per engine comes from the config", () => {
  const lim = new Limits(parseJobRunnerConfig({ limits: { maxConcurrent: { claude: 2 } } }));
  assert.equal(lim.maxConcurrent("claude"), 2);
  assert.equal(lim.maxConcurrent("dsh"), 1);
});

test("output cap: long text is cut, the total is counted, events past the cap are dropped, the result is always kept", () => {
  const b = new OutputBudget(2000, 100);
  const a1 = b.admit({ kind: "text", text: "x".repeat(500) });
  assert.ok(a1.event && a1.event.kind === "text" && a1.event.text.length < 200);
  assert.match((a1.event as { text: string }).text, /more characters not kept/);
  assert.equal(a1.exceeded, false);
  let exceeded = false;
  for (let i = 0; i < 40 && !exceeded; i++) exceeded = b.admit({ kind: "text", text: "y".repeat(90) }).exceeded;
  assert.equal(exceeded, true);
  assert.equal(b.exceeded, true);
  const dropped = b.admit({ kind: "text", text: "late" });
  assert.equal(dropped.event, undefined);
  assert.equal(b.droppedEvents, 1);
  const res = b.admit({ kind: "result", text: "z".repeat(1000) });
  assert.ok(res.event && res.event.kind === "result", "the result is always admitted");
  const big = new OutputBudget(10_000, 100).admit({ kind: "tool_call", tool: "Read", input: { path: "p".repeat(500) } });
  assert.ok(big.event && big.event.kind === "tool_call");
  assert.deepEqual(Object.keys((big.event as { input: object }).input).sort(), ["chars", "preview", "truncated"]);
});
