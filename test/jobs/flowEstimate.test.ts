/**
 * S14.4: the agent side of the live Flow estimate. A fake job runner client answers `flowEstimate` like the real job runner
 * (see test/jobrunner/core/flowEstimate.test.ts for the format captured from creative-hub's video-plan.mjs).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunnerFlowEstimator } from "../../src/jobs/flowEstimate.js";
import { FlowEstimateError, planDispatch } from "../../src/jobs/tools.js";
import type { TemplateSource } from "../../src/jobs/tools.js";
import type { JobTemplateSummary } from "../../src/jobs/contracts.js";
import { FakeJobRunnerClient } from "../helpers/fakeJobRunner.js";

const tpl = (over: Partial<JobTemplateSummary> = {}): JobTemplateSummary =>
  ({
    id: "short-video",
    title: "Short video",
    description: "d",
    engine: "claude",
    cwd: "C:\\projects\\Personal\\creative-hub",
    enabled: true,
    params: { type: "object", properties: { runDir: { type: "string", maxLength: 200 } }, required: ["runDir"] },
    flow: { enabled: true, estimator: "video-plan", maxCredits: 200 },
    paidModels: false,
    autostart: [],
    timeoutMin: 10,
    ...over,
  }) as JobTemplateSummary;

const source = (t: JobTemplateSummary): TemplateSource => ({ list: async () => [t] });
const req = { templateId: "short-video", params: { runDir: "runs/harbour/video" }, brief: "a boat" };

function online(handlers?: ConstructorParameters<typeof FakeJobRunnerClient>[0]): FakeJobRunnerClient {
  const c = new FakeJobRunnerClient(handlers);
  c.setState("online");
  return c;
}

test("a video-plan template: the number from the job runner (23) goes to the card as the estimate", async () => {
  const client = online({ flowEstimate: () => ({ credits: 23, videoCredits: 18, reserve: 5, runDir: "runs/harbour/video" }) });
  const r = await planDispatch(source(tpl()), createRunnerFlowEstimator(client), req);
  assert.equal(r.ok && r.flowEstimateCredits, 23);
  assert.deepEqual(client.calls.filter((c) => c.method === "flowEstimate").map((c) => c.arg), [{ templateId: "short-video", params: { runDir: "runs/harbour/video" } }]);
});

test("the fixed flow.estimate path still needs no runner call", async () => {
  const client = online();
  const r = await planDispatch(source(tpl({ flow: { enabled: true, estimate: 40, maxCredits: 100 } })), createRunnerFlowEstimator(client), req);
  assert.equal(r.ok && r.flowEstimateCredits, 40);
  assert.equal(client.calls.some((c) => c.method === "flowEstimate"), false);
});

test("a failed estimate refuses the dispatch with the reason: runner error, offline, unusable number", async () => {
  const failing = online({
    flowEstimate: () => {
      throw new Error("there is no runs/harbour/video/plan.json yet: the shot plan must exist before the credits can be estimated");
    },
  });
  const a = await planDispatch(source(tpl()), createRunnerFlowEstimator(failing), req);
  assert.equal(a.ok, false);
  assert.match(!a.ok ? a.text : "", /estimate for template "short-video" failed: there is no runs\/harbour\/video\/plan\.json yet.*not dispatched.*never spent without an approved estimate/);

  const offline = new FakeJobRunnerClient({}, "offline");
  const b = await planDispatch(source(tpl()), createRunnerFlowEstimator(offline), req);
  assert.match(!b.ok ? b.text : "", /job runner is offline/);
  assert.equal(offline.calls.length, 0);

  for (const credits of [0, -1, Number.NaN]) {
    const bad = online({ flowEstimate: () => ({ credits, videoCredits: 0, reserve: 0, runDir: "runs/x" }) });
    const c = await planDispatch(source(tpl()), createRunnerFlowEstimator(bad), req);
    assert.equal(c.ok, false, String(credits));
  }
});

test("an estimate above the template cap is refused, and a non-FlowEstimateError from an estimator is not swallowed", async () => {
  const client = online({ flowEstimate: () => ({ credits: 230, videoCredits: 184, reserve: 46, runDir: "runs/x" }) });
  const over = await planDispatch(source(tpl()), createRunnerFlowEstimator(client), req);
  assert.match(!over.ok ? over.text : "", /above this template's cap \(200\)/);
  await assert.rejects(
    planDispatch(
      source(tpl()),
      () => {
        throw new TypeError("bug");
      },
      req,
    ),
    /bug/,
  );
  const explicit = await planDispatch(
    source(tpl()),
    () => {
      throw new FlowEstimateError("my reason");
    },
    req,
  );
  assert.match(!explicit.ok ? explicit.text : "", /failed: my reason/);
});
