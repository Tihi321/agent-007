/** S9.4: the shared fakes keep the contract interfaces honest (they must compile as implementations and behave). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { IpcClient } from "../../src/ipc/client.js";
import { IpcKey } from "../../src/ipc/hmac.js";
import type { JobApprovalTransport, JobRunnerClient } from "../../src/jobs/contracts.js";
import { FakeJobApprovalTransport, FakeJobRunnerClient } from "../helpers/fakeJobRunner.js";
import { KEY_TEXT_A } from "./helpers.js";

test("IpcClient, FakeJobRunnerClient and FakeJobApprovalTransport all satisfy the contract interfaces", () => {
  const clients: JobRunnerClient[] = [new IpcClient({ port: 1, key: IpcKey.fromBase64Url(KEY_TEXT_A) }), new FakeJobRunnerClient()];
  const transport: JobApprovalTransport = new FakeJobApprovalTransport();
  for (const c of clients) {
    for (const m of ["start", "close", "waitOnline", "submit", "cancel", "status", "listTemplates", "hubStatus", "hubStart", "flowEstimate", "answerPermission", "onJobEvent", "onPermissionRequest", "onJobDone", "onStateChange"]) {
      assert.equal(typeof (c as unknown as Record<string, unknown>)[m], "function", m);
    }
  }
  for (const m of ["requestJobApproval", "requestHubStartApproval", "requestPermission", "postProgress", "postFinal"]) {
    assert.equal(typeof (transport as unknown as Record<string, unknown>)[m], "function", m);
  }
});

test("FakeJobRunnerClient: records calls, rejects offline like the real client, emits to subscribers", async () => {
  const f = new FakeJobRunnerClient();
  const seen: string[] = [];
  f.onJobDone((d) => seen.push(d.jobId));
  const states: string[] = [];
  f.onStateChange((s) => states.push(s));
  const r = await f.submit({ jobId: "j1", request: { templateId: "t", params: {}, brief: "" }, approval: { userId: 1, at: 1 } });
  assert.deepEqual(r, { jobId: "j1", state: "queued", duplicate: false });
  f.emitDone({ jobId: "j1", state: "succeeded", summary: "", artifacts: [], durationMs: 1 });
  assert.deepEqual(seen, ["j1"]);
  f.setState("offline");
  await assert.rejects(f.status(), (e: Error) => e.name === "IpcOfflineError");
  setTimeout(() => f.setState("online"), 10);
  await f.waitOnline({ signal: new AbortController().signal });
  assert.deepEqual(states, ["offline", "online"]);
  assert.deepEqual(f.calls.map((c) => c.method), ["submit", "status"]);
});
