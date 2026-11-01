/** S14.3: the approval rules and card text (no Telegram), and the permission relay. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTOSTART_NOTICE,
  INLINE_BRIEF_MAX_CHARS,
  PAID_MODELS_NOTICE,
  PermissionRelay,
  buildJobCard,
  cardLines,
  cloudUseFor,
  rejectionText,
  waitForApproval,
} from "../../src/jobs/approval.js";
import type { JobApprovalCard, JobApprovalDecision, PermissionDecision, PermissionRequest } from "../../src/jobs/contracts.js";
import { FakeJobApprovalTransport, FakeJobRunnerClient } from "../helpers/fakeJobRunner.js";
import { TPL_BOOK, TPL_FLOW, TPL_PLAIN, TPL_VN } from "./helpers/fixtures.js";
import { memoryLogger } from "../telegram/helpers/fakeTelegram.js";
import { sleep, until } from "./helpers/rig.js";

const card = (over: Partial<JobApprovalCard> = {}): JobApprovalCard => ({
  ...buildJobCard({ jobId: "job-1", conversationId: "1", template: over.template ?? TPL_PLAIN, params: { idea: "gulls" }, brief: "Make a loop.", askedAt: Date.now(), timeoutSec: 60, ...(over.flowEstimateCredits !== undefined ? { flowEstimateCredits: over.flowEstimateCredits } : {}) }),
  ...over,
});

test("buildJobCard: template, params, cwd, engine, cloud, deadline = first ask + timeout", () => {
  const c = buildJobCard({ jobId: "job-1", conversationId: "1", template: TPL_FLOW, params: { idea: "x" }, brief: "b", flowEstimateCredits: 40, askedAt: 1000, timeoutSec: 30 });
  assert.equal(c.cwd, TPL_FLOW.cwd);
  assert.equal(c.engine, "claude");
  assert.deepEqual(c.cloud, ["claude-subscription", "google-flow"]);
  assert.equal(c.flowEstimateCredits, 40);
  assert.equal(c.deadline, 31_000);
  assert.deepEqual(cloudUseFor({ ...TPL_PLAIN, flow: { enabled: true } }), ["claude-subscription", "google-flow"], "a Flow template always shows Flow");
});

test("cardLines: the full card text around the brief", () => {
  const lines = cardLines(card());
  const text = lines.join("\n");
  assert.match(text, /Template: chiptune-loop/);
  assert.match(text, /Engine: claude/);
  assert.match(text, /Cwd: C:\\projects\\Personal\\creative-hub/);
  assert.match(text, /Params: \{"idea":"gulls"\}/);
  assert.match(text, /Uses cloud: Claude subscription/);
  assert.match(text, /Approval timeout: 60 s \(no answer means reject\)/);
  assert.ok(!text.includes("Flow estimate") && !text.includes(PAID_MODELS_NOTICE) && !text.includes(AUTOSTART_NOTICE));
});

test("cardLines: the Flow estimate, the paid-models line and the autostart line appear exactly when they apply", () => {
  const flow = cardLines(card({ template: TPL_FLOW, cloud: ["google-flow"], flowEstimateCredits: 40 })).join("\n");
  assert.match(flow, /Flow estimate: 40 credits\. Approving approves exactly this number/);
  assert.match(flow, /Google Flow/);
  const book = cardLines(card({ template: TPL_BOOK, paidModels: true })).join("\n");
  assert.ok(book.includes("This job may use paid models, per the tools' model settings"));
  assert.ok(book.includes("~\\Scriptorium\\config\\roles.md") && book.includes("~\\VisualNovels\\config\\roles.md"));
  assert.ok(book.includes("~\\BookTranslator\\config\\defaults.json") && book.includes("providers.md"));
  assert.ok(book.includes("agent-007 does not estimate or cap their cost"));
  const vn = cardLines(card({ template: TPL_VN, autostart: TPL_VN.autostart })).join("\n");
  assert.ok(vn.includes("VN Studio may start Pixel Studio, Chiptune Studio and ComfyUI"));
  assert.ok(vn.includes("pixel-studio, chiptune-studio, comfyui"));
  assert.equal(INLINE_BRIEF_MAX_CHARS, 3500);
});

test("waitForApproval: an explicit user approval is accepted", async () => {
  const t = new FakeJobApprovalTransport();
  const out = await waitForApproval({ transport: t, card: card(), signal: new AbortController().signal, now: Date.now, retryDelayMs: 5 });
  assert.equal(out.type === "decided" && out.decision.approved, true);
  assert.equal(out.type === "decided" && out.decision.userId, 1);
});

test("waitForApproval: anything but an explicit user tap is a rejection (timeout, no user id, a claimed approval by timeout)", async () => {
  for (const answer of [{ approved: true, by: "timeout" }, { approved: true, by: "user", userId: undefined }, { approved: false, by: "user" }, { approved: true, by: "stop" }] as Partial<JobApprovalDecision>[]) {
    const t = new FakeJobApprovalTransport();
    t.approvals = [answer];
    const out = await waitForApproval({ transport: t, card: card(), signal: new AbortController().signal, now: Date.now, retryDelayMs: 5 });
    assert.equal(out.type === "decided" && out.decision.approved, false, JSON.stringify(answer));
  }
});

test("waitForApproval: the deadline is a rejection by timeout and the transport's signal is aborted", async () => {
  let seen: AbortSignal | undefined;
  const transport = {
    ...new FakeJobApprovalTransport(),
    requestJobApproval: (_c: JobApprovalCard, signal: AbortSignal) => {
      seen = signal;
      return new Promise<JobApprovalDecision>(() => undefined);
    },
  } as unknown as FakeJobApprovalTransport;
  const c = card({ deadline: Date.now() + 50 });
  const out = await waitForApproval({ transport, card: c, signal: new AbortController().signal, now: Date.now, retryDelayMs: 5 });
  assert.deepEqual(out.type === "decided" && [out.decision.approved, out.decision.by], [false, "timeout"]);
  assert.equal(seen?.aborted, true);
});

test("waitForApproval: an already-passed deadline never asks", async () => {
  const t = new FakeJobApprovalTransport();
  const out = await waitForApproval({ transport: t, card: card({ deadline: Date.now() - 1 }), signal: new AbortController().signal, now: Date.now, retryDelayMs: 5 });
  assert.equal(out.type === "decided" && out.decision.by, "timeout");
  assert.equal(t.jobCards.length, 0);
});

test("waitForApproval: the task's own abort (a restart) is 'closing', a cancel is 'cancelled'", async () => {
  const hang = (): FakeJobApprovalTransport =>
    ({ requestJobApproval: (_c: JobApprovalCard, signal: AbortSignal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ approved: false, by: "stop", at: 1 }))) }) as unknown as FakeJobApprovalTransport;
  const closing = new AbortController();
  const p1 = waitForApproval({ transport: hang(), card: card(), signal: closing.signal, now: Date.now, retryDelayMs: 5 });
  closing.abort();
  assert.equal((await p1).type, "closing");
  const cancel = new AbortController();
  const p2 = waitForApproval({ transport: hang(), card: card(), signal: new AbortController().signal, cancel: cancel.signal, now: Date.now, retryDelayMs: 5 });
  cancel.abort();
  assert.equal((await p2).type, "cancelled");
});

test("waitForApproval: a failed card delivery is retried until it works, and nothing is approved meanwhile", async () => {
  const log = memoryLogger();
  let n = 0;
  const transport = {
    requestJobApproval: async () => {
      if (++n < 3) throw new Error("telegram down");
      return { approved: true, by: "user", userId: 1, at: Date.now() };
    },
  } as unknown as FakeJobApprovalTransport;
  const out = await waitForApproval({ transport, card: card(), signal: new AbortController().signal, now: Date.now, retryDelayMs: 5, logger: log });
  assert.equal(n, 3);
  assert.equal(out.type === "decided" && out.decision.approved, true);
  assert.equal(log.events("jobs.approval_transport_failed").length, 2);
});

test("rejectionText: a sentence for each way a job can be not approved", () => {
  for (const by of ["user", "timeout", "stop", "restart-expired"] as const) assert.ok(rejectionText(by).length > 20);
});

// ---- permission relay -----------------------------------------------------------------------------------------

const perm = (id: string): PermissionRequest => ({ requestId: id, jobId: "job-1", engine: "claude", tool: "Write", input: { f: 1 }, cwd: "C:\\hub", kind: "edit", requestedAt: Date.now(), timeoutSec: 60 });

function relayRig() {
  const client = new FakeJobRunnerClient();
  const transport = new FakeJobApprovalTransport();
  const log = memoryLogger();
  const relay = new PermissionRelay({ client, transport, conversationId: "1", logger: log, now: Date.now });
  return { client, transport, relay, log };
}

test("PermissionRelay: Allow once and Deny reach the runner; the request id is asked once", async () => {
  const { client, transport, relay } = relayRig();
  transport.permissionAnswers = [{ answer: "allow_once" }, { answer: "deny" }];
  relay.handle(perm("p1"));
  relay.handle(perm("p1")); // a repeat while pending or answered
  relay.handle(perm("p2"));
  await until(() => client.decisions.length === 2);
  relay.handle(perm("p1")); // a repeat after it was answered
  await sleep(20);
  assert.deepEqual(client.decisions.map((d) => [d.requestId, d.answer]).sort(), [["p1", "allow_once"], ["p2", "deny"]]);
  assert.equal(transport.permissionRequests.length, 2);
});

test("PermissionRelay: there is no 'always': anything but allow_once from the user is a deny", async () => {
  const { client, transport, relay } = relayRig();
  transport.permissionAnswers = [{ answer: "allow_always" as never }, { answer: "allow_once", by: "timeout" }];
  relay.handle(perm("p1"));
  relay.handle(perm("p2"));
  await until(() => client.decisions.length === 2);
  assert.deepEqual(client.decisions.map((d) => d.answer), ["deny", "deny"]);
});

test("PermissionRelay: a transport failure is a deny by policy", async () => {
  const client = new FakeJobRunnerClient();
  const transport = { requestPermission: async (): Promise<PermissionDecision> => Promise.reject(new Error("no chat")) } as unknown as FakeJobApprovalTransport;
  const relay = new PermissionRelay({ client, transport, conversationId: "1", now: Date.now });
  relay.handle(perm("p1"));
  await until(() => client.decisions.length === 1);
  assert.equal(client.decisions[0]!.answer, "deny");
  assert.equal(client.decisions[0]!.by, "policy");
});

test("PermissionRelay: cancelAll denies pending prompts; dispose answers nothing (the runner keeps them)", async () => {
  const mk = () => {
    const client = new FakeJobRunnerClient();
    const signals: AbortSignal[] = [];
    const transport = {
      requestPermission: (req: PermissionRequest, _c: string, signal: AbortSignal) =>
        new Promise<PermissionDecision>((resolve) => {
          signals.push(signal);
          signal.addEventListener("abort", () => resolve({ requestId: req.requestId, jobId: req.jobId, answer: "deny", by: signal.reason === "dispose" ? "restart" : "cancel", at: Date.now() }));
        }),
    } as unknown as FakeJobApprovalTransport;
    return { client, signals, relay: new PermissionRelay({ client, transport, conversationId: "1", now: Date.now }) };
  };
  const a = mk();
  a.relay.handle(perm("p1"));
  a.relay.cancelAll("cancel");
  await until(() => a.client.decisions.length === 1);
  assert.equal(a.client.decisions[0]!.by, "cancel");
  const b = mk();
  b.relay.handle(perm("p1"));
  b.relay.dispose();
  await sleep(30);
  assert.equal(b.client.decisions.length, 0);
  assert.equal(b.signals[0]!.aborted, true);
});

test("PermissionRelay: an answer that cannot be delivered (runner offline) lets the runner's repeat be asked again", async () => {
  const { client, transport, relay } = relayRig();
  transport.permissionAnswers = [{ answer: "allow_once" }, { answer: "allow_once" }];
  client.setState("offline");
  relay.handle(perm("p1"));
  await until(() => transport.permissionRequests.length === 1);
  await sleep(20);
  assert.equal(client.decisions.length, 0);
  client.setState("online");
  relay.handle(perm("p1"));
  await until(() => client.decisions.length === 1);
  assert.equal(transport.permissionRequests.length, 2);
});
