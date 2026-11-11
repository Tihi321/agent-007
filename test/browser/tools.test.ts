/**
 * REQ-0014 A1 (agent side): a browser job goes running, the model is told once, a browser tool reaches the runner and its
 * screenshot confirmation carries no bytes, and the artifact event of the run phase reaches the Telegram transport.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { createBrowserTools } from "../../src/browser/tools.js";
import { BROWSER_TOOL_NAMES } from "../../src/jobs/browserContracts.js";
import type { ArtifactRef } from "../../src/jobs/contracts.js";
import { JobTracker } from "../../src/jobs/task.js";
import { staticTemplates } from "../../src/jobs/tools.js";
import { FakeJobApprovalTransport } from "../helpers/fakeJobRunner.js";
import { FakeRunner } from "../jobs/helpers/fakeRunner.js";
import { jobInput, template } from "../jobs/helpers/fixtures.js";
import { openJobsRig, sleep, tempDir, until } from "../jobs/helpers/rig.js";

const JOB = "job-bbbbbbbbbbbb";
const TPL_BROWSER = template({ id: "browser-session", engine: "browser", cloud: ["web-browsing"], params: { type: "object", properties: { startUrl: { type: "string" } } } });
const SHOT: ArtifactRef = { path: `${JOB}/001.png`, mime: "image/png", bytes: 10, sha256: "0".repeat(64), caption: "Example page" };

test("session flow: running tells the model once, a tool call reaches the runner, a screenshot is posted", async () => {
  const dir = tempDir();
  try {
    const runner = new FakeRunner();
    const client = runner.makeClient();
    const transport = new FakeJobApprovalTransport();
    const tracker = new JobTracker();
    const ready: string[] = [];
    tracker.onRunning = (j) => void ready.push(`${j.jobId}:${j.engine}`);
    const templates = staticTemplates([TPL_BROWSER]);
    const rig = await openJobsRig({ dir, client, transport, templates, overrides: { tracker } });
    try {
      const tools = createBrowserTools({ client, tracker, templates, timeoutMs: 5000 });
      assert.deepEqual(tools.map((t) => t.name), [...BROWSER_TOOL_NAMES]);
      assert.ok(tools.every((t) => t.deferred === true));
      const byName = (n: string) => tools.find((t) => t.name === n) as unknown as { execute(a: unknown, api: unknown, ctx: unknown): Promise<{ isError?: boolean; output: { text: string }[] }> };
      const api = { conversationId: "1", callId: "call-1" };
      const text = (r: { output: { text: string }[] }) => r.output.map((o) => o.text).join("\n");

      // before the job runs there is no session
      const early = await byName("browser_read").execute({}, api, undefined);
      assert.equal(early.isError, true);

      client.handlers.browserAction = (b) =>
        b.action.op === "screenshot" ? { outcome: "done", url: "https://example.com/", shot: SHOT } : { outcome: "denied", message: "the user said no" };

      const id = await rig.createJob(jobInput(TPL_BROWSER, { jobId: JOB, request: { templateId: "browser-session", params: {}, brief: "Look at example.com" } }));
      await until(() => ready.length > 0, 8000, "onRunning");
      await sleep(150);
      assert.deepEqual(ready, [`${JOB}:browser`], "called once");

      const shot = await byName("browser_screenshot").execute({}, api, undefined);
      assert.ok(!shot.isError);
      assert.match(text(shot), /Screenshot 1 sent to the user's chat/);
      assert.ok(!text(shot).includes(SHOT.sha256) && !/base64|data:image/.test(text(shot)), "no bytes reach the model");
      const sent = client.calls.find((c) => c.method === "browserAction")!.arg as { jobId: string; callId: string; action: { op: string } };
      assert.deepEqual([sent.jobId, sent.callId, sent.action.op], [JOB, "call-1", "screenshot"]);

      const denied = await byName("browser_click").execute({ ref: "e1" }, api, undefined);
      assert.equal(denied.isError, true);
      assert.match(text(denied), /denied[\s\S]*the user said no/);

      runner.emit(JOB, { kind: "artifact", artifact: SHOT });
      await until(() => transport.artifacts.length === 1, 8000, "postArtifact");
      assert.deepEqual(transport.artifacts[0], { jobId: JOB, conversationId: "1", artifact: SHOT, index: 0 });

      runner.finish(JOB, { summary: "done" });
      await rig.wait(id);
    } finally {
      await rig.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
