/**
 * S10.4: hub_status (a probe, no tool call, nothing started) and hub_start (an approval first, then the job runner over IPC;
 * Scriptorium with its own warning; no approval decision means no IPC).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HubStartCard, JobApprovalDecision } from "../../src/jobs/contracts.js";
import {
  SCRIPTORIUM_WARNING,
  VN_STUDIO_AUTOSTART_LINE,
  autostartNotice,
  buildHubStartCard,
  checkHubStatus,
  createHubStartTool,
  createHubStatusTool,
  formatHubStatus,
  renderHubStartCardText,
} from "../../src/mcp/services.js";
import type { HubStartDeps, ProbeFn } from "../../src/mcp/services.js";
import { FakeJobApprovalTransport, FakeJobRunnerClient } from "../helpers/fakeJobRunner.js";
import { FakeMcpServer, closedPort } from "./fakeMcpServer.js";
import { runTool } from "./toolHarness.js";

const DOWN: ProbeFn = async () => ({ state: "down", detail: "nothing is listening on 127.0.0.1:1" });
const UP: ProbeFn = async () => ({ state: "up", detail: "answers MCP initialize" });

const SERVERS = [
  { id: "vibetts", url: "http://127.0.0.1:7723/mcp" },
  { id: "scriptorium", url: "http://127.0.0.1:7341/mcp" },
  { id: "vn-studio", url: "http://127.0.0.1:7459/mcp" },
];

function setup(extra: Partial<HubStartDeps> = {}) {
  const runner = new FakeJobRunnerClient();
  const approvals = new FakeJobApprovalTransport();
  const tool = createHubStartTool({ servers: SERVERS, runner, approvals, approvalTimeoutSec: 1800, probe: DOWN, now: () => 1_000_000, ...extra });
  const hubStartCalls = () => runner.calls.filter((c) => c.method === "hubStart");
  return { runner, approvals, tool, hubStartCalls };
}

test("hub_status: a TCP connect plus initialize; no tool is listed or called, nothing is started", async () => {
  const up = await FakeMcpServer.start({ tools: [{ name: "t" }] });
  const down = await closedPort();
  const runner = new FakeJobRunnerClient();
  try {
    const tool = createHubStatusTool({ servers: [{ id: "vibetts", url: up.url }, { id: "scriptorium", url: `http://127.0.0.1:${down}/mcp` }] });
    const r = await runTool(tool, {});
    assert.equal(r.result.isError, undefined);
    assert.match(r.text, /- vibetts: up/);
    assert.match(r.text, /- scriptorium: NOT AVAILABLE \(nothing is listening on 127\.0\.0\.1:\d+\)/);
    assert.match(r.text, /Not answering: scriptorium\./);
    assert.match(r.text, /never starts a service itself/);
    assert.match(r.text, /hub_start/);
    assert.deepEqual(up.methods.filter((m) => m === "tools/call" || m === "tools/list"), [], "no tool call, not even a listing");
    assert.equal(runner.calls.length, 0, "agent-007 did not start anything");
    assert.equal(tool.deferred, undefined, "hub_status is the always-loaded tool");
    assert.equal(tool.replay, "safe");
  } finally {
    await up.close();
  }
});

test("hub_status: all up has no start offer; none configured says so; a probe that throws counts as down", async () => {
  const rows = await checkHubStatus({ servers: SERVERS, probe: UP });
  assert.ok(rows.every((r) => r.state === "up"));
  assert.ok(!formatHubStatus(rows).includes("hub_start"));
  assert.equal(formatHubStatus([]), "No creative-hub servers are configured.");
  const thrown = await checkHubStatus({
    servers: SERVERS.slice(0, 1),
    probe: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(thrown[0]!.state, "down");
});

test("hub_start: an unknown, malformed or multi-service name is refused with no card and no IPC (Scriptorium is never bundled)", async () => {
  const { tool, approvals, hubStartCalls } = setup();
  for (const service of ["comfyui", "strata", "lmstudio", "", "vibetts,scriptorium", "vibetts scriptorium", "..\\x", "all", "*", "vibetts; calc", "x".repeat(40)]) {
    const r = await runTool(tool, { service });
    assert.equal(r.result.isError, true, service);
    assert.match(r.text, /unknown service/);
    assert.match(r.text, /Nothing was started/);
  }
  assert.equal(approvals.hubCards.length, 0);
  assert.equal(hubStartCalls().length, 0);
});

test("hub_start: no approval decision, no IPC (declined, timed out, expired, a failing transport, or no user id)", async () => {
  for (const decision of [{ approved: false, by: "user" as const }, { approved: false, by: "timeout" as const }, { approved: false, by: "restart-expired" as const }]) {
    const { tool, approvals, hubStartCalls } = setup();
    approvals.approvals = [decision];
    const r = await runTool(tool, { service: "vibetts" });
    assert.equal(r.result.isError, true);
    assert.match(r.text, /did not approve/);
    assert.equal(approvals.hubCards.length, 1);
    assert.equal(hubStartCalls().length, 0, `no IPC after ${decision.by}`);
  }

  const failing = setup();
  failing.approvals.requestHubStartApproval = async () => {
    throw new Error("telegram down");
  };
  const f = await runTool(failing.tool, { service: "vibetts" });
  assert.equal(f.result.isError, true);
  assert.match(f.text, /approval could not be asked/);
  assert.equal(failing.hubStartCalls().length, 0);

  const noUser = setup();
  noUser.approvals.approvals = [{ approved: true, by: "user", userId: undefined as unknown as number }];
  const n = await runTool(noUser.tool, { service: "vibetts" });
  assert.equal(n.result.isError, true);
  assert.equal(noUser.hubStartCalls().length, 0);
});

test("hub_start: after an approval it sends hub_start over IPC with the approval proof; no Scriptorium flag for other services", async () => {
  const started: string[] = [];
  const { tool, approvals, hubStartCalls, runner } = setup({ onStarted: (s) => void started.push(s) });
  runner.handlers.hubStart = (b) => ({ service: b.service, started: true, message: "vibetts started on port 7723" });
  approvals.approvals = [{ approved: true, by: "user", userId: 4242, at: 555 }];
  const r = await runTool(tool, { service: "VibeTTS" }, { conversationId: "conv-9" });
  assert.equal(r.result.isError, undefined);
  assert.match(r.text, /vibetts was started by the job runner/);
  assert.ok(r.text.includes('<untrusted_content source="hub:vibetts">'), "the runner's message is wrapped too");
  assert.deepEqual(approvals.hubCards, [{ conversationId: "conv-9", service: "vibetts", scriptorium: false, timeoutSec: 1800, deadline: 1_000_000 + 1800_000 }]);
  assert.equal(approvals.hubCards[0]!.warning, undefined);
  assert.equal(hubStartCalls().length, 1);
  assert.deepEqual(hubStartCalls()[0]!.arg, { service: "vibetts", approval: { userId: 4242, at: 555 } });
  assert.deepEqual(started, ["vibetts"]);
});

test("hub_start: Scriptorium always carries its own warning and an explicit scriptoriumApproved flag", async () => {
  const { tool, approvals, hubStartCalls, runner } = setup();
  runner.handlers.hubStart = (b) => ({ service: b.service, started: true, message: "ok" });
  approvals.approvals = [{ approved: true, by: "user", userId: 7, at: 9 }];
  const r = await runTool(tool, { service: "Scriptorium" });
  assert.equal(r.result.isError, undefined);
  const card = approvals.hubCards[0] as HubStartCard;
  assert.equal(card.service, "scriptorium");
  assert.equal(card.scriptorium, true);
  assert.equal(card.warning, SCRIPTORIUM_WARNING);
  assert.match(card.warning ?? "", /whole book factory/);
  assert.match(card.warning ?? "", /paid models/);
  assert.deepEqual(hubStartCalls()[0]!.arg, { service: "scriptorium", scriptoriumApproved: true, approval: { userId: 7, at: 9 } });
});

test("hub_start: a declined Scriptorium start sends nothing", async () => {
  const { tool, approvals, hubStartCalls } = setup();
  approvals.approvals = [{ approved: false, by: "user" }];
  const r = await runTool(tool, { service: "scriptorium" });
  assert.equal(r.result.isError, true);
  assert.equal(approvals.hubCards[0]!.scriptorium, true);
  assert.equal(hubStartCalls().length, 0);
});

test("hub_start: a service that already answers needs no approval and sends nothing", async () => {
  const { tool, approvals, hubStartCalls } = setup({ probe: UP });
  const r = await runTool(tool, { service: "vibetts" });
  assert.equal(r.result.isError, undefined);
  assert.match(r.text, /already answering/);
  assert.equal(approvals.hubCards.length, 0);
  assert.equal(hubStartCalls().length, 0);
});

test("hub_start: job runner offline, a refused start, and a remote error are reported clearly", async () => {
  const offline = setup();
  offline.runner.setState("offline");
  offline.approvals.approvals = [{ approved: true, by: "user", userId: 1 }];
  const o = await runTool(offline.tool, { service: "vibetts" });
  assert.equal(o.result.isError, true);
  assert.match(o.text, /job runner is offline/);

  const refused = setup();
  refused.runner.handlers.hubStart = (b) => ({ service: b.service, started: false, message: "start script exited 1" });
  const r = await runTool(refused.tool, { service: "vibetts" });
  assert.equal(r.result.isError, true);
  assert.match(r.text, /was NOT started/);

  const remote = setup();
  remote.runner.handlers.hubStart = () => {
    throw Object.assign(new Error("denied by runner"), { name: "IpcRemoteError", code: "forbidden" });
  };
  const x = await runTool(remote.tool, { service: "vibetts" });
  assert.equal(x.result.isError, true);
  assert.match(x.text, /did not start vibetts \(forbidden\)/);
});

test("hub_start: cancelling the turn aborts the approval wait", async () => {
  let seen: AbortSignal | undefined;
  const waiting = {
    requestHubStartApproval: (_card: HubStartCard, signal: AbortSignal): Promise<JobApprovalDecision> => {
      seen = signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    },
  };
  const { tool, hubStartCalls } = setup({ approvals: waiting });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const r = await runTool(tool, { service: "vibetts" }, { signal: ac.signal });
  assert.equal(seen?.aborted, true);
  assert.equal(r.result.isError, true);
  assert.equal(hubStartCalls().length, 0);
});

test("hub_start is deferred and replay-unsafe", () => {
  const { tool } = setup();
  assert.equal(tool.deferred, true);
  assert.equal(tool.replay, "unsafe");
  assert.equal(tool.name, "hub_start");
});

test("approval card text: Scriptorium has the warning; others do not; a VN Studio template shows the autostart line", () => {
  const sc = buildHubStartCard("scriptorium", "c1", 1800, 0);
  const text = renderHubStartCardText(sc);
  assert.ok(text.includes(SCRIPTORIUM_WARNING));
  assert.match(text, /scriptorium/);
  assert.match(text, /30 min/);
  const plain = renderHubStartCardText(buildHubStartCard("vibetts", "c1", 1800, 0));
  assert.ok(!plain.includes("book factory"));

  assert.equal(autostartNotice(["pixel-studio", "chiptune-studio", "comfyui"]), VN_STUDIO_AUTOSTART_LINE);
  assert.equal(VN_STUDIO_AUTOSTART_LINE, "VN Studio may start Pixel Studio, Chiptune Studio and ComfyUI");
  assert.equal(autostartNotice(["comfyui"]), "VN Studio may start ComfyUI");
  assert.equal(autostartNotice([]), undefined);
});
