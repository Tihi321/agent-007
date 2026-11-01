import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApprovalGate, denyText, MAX_COMMAND_CHARS } from "../../src/approval/gate.js";
import type { ApprovalGateDeps } from "../../src/approval/gate.js";
import { createKillSwitch } from "../../src/approval/killSwitch.js";
import { createApprovalTokens } from "../../src/approval/tokens.js";
import type { ApprovalDecision, AuditEvent } from "../../src/contracts.js";
import { createMemoryAuditLog } from "../../src/logging/audit.js";
import { createMemoryLogger } from "../../src/logging/logger.js";
import { sha256Command } from "../../src/shell/tool.js";
import { approveNow, cfg, denyNow, fakeContext, fakeHookApi, neverAnswer, scriptedTransport, shellCall, sleep } from "../shell/fakes.js";
import type { ScriptedTransport } from "../shell/fakes.js";

interface Rig {
  deps: ApprovalGateDeps;
  audit: ReturnType<typeof createMemoryAuditLog>;
  tokens: ReturnType<typeof createApprovalTokens>;
  ks: ReturnType<typeof createKillSwitch>;
  dir: string;
  clock: { t: number };
  cleanup(): void;
}

function rig(transport: ScriptedTransport, opts: { approvalTimeoutSec?: number; chat?: number | undefined; clock?: { t: number } } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "a7-gate-"));
  const audit = createMemoryAuditLog();
  const tokens = createApprovalTokens();
  const ks = createKillSwitch({ controlDir: dir, shellEnabled: () => true });
  const clock = opts.clock ?? { t: 1_000_000 };
  const chat = "chat" in opts ? opts.chat : 77;
  const deps: ApprovalGateDeps = {
    transport,
    killSwitch: ks,
    chats: { chatForConversation: () => chat },
    approvals: tokens,
    audit,
    getShellConfig: () => cfg({ approvalTimeoutSec: opts.approvalTimeoutSec ?? 600 }),
    cwd: "C:\\ws",
    logger: createMemoryLogger(),
    now: () => clock.t,
    pollMs: 20,
  };
  return { deps, audit, tokens, ks, dir, clock, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const events = (a: ReturnType<typeof createMemoryAuditLog>, name: AuditEvent["event"]) => a.events.filter((e) => e.event === name);

test("a non-shell tool passes through untouched, with no memo and no transport call", async () => {
  const t = scriptedTransport(approveNow());
  const r = rig(t);
  try {
    const store = new Map<string, unknown>();
    const gate = createApprovalGate(r.deps);
    const out = await gate.beforeTool(shellCall("x", { name: "read_file" }), fakeHookApi(store), fakeContext());
    assert.equal(out, undefined);
    assert.equal(store.size, 0);
    assert.equal(t.requests.length, 0);
    assert.equal(r.audit.events.length, 0);
  } finally {
    r.cleanup();
  }
});

test("approve: returns undefined, asks once with the full request, audits requested and decided, grants a one-shot token", async () => {
  const t = scriptedTransport(approveNow(42));
  const r = rig(t);
  try {
    const store = new Map<string, unknown>();
    const gate = createApprovalGate(r.deps);
    const out = await gate.beforeTool(shellCall("Write-Output hi", { reason: "greet", timeoutSec: 30 }), fakeHookApi(store), fakeContext());
    assert.equal(out, undefined);
    assert.equal(t.requests.length, 1);
    const req = t.requests[0]!;
    assert.equal(req.key, "conv1:call1");
    assert.equal(req.conversationId, "conv1");
    assert.equal(req.chatId, 77);
    assert.equal(req.tool, "shell");
    assert.equal(req.command, "Write-Output hi");
    assert.equal(req.reason, "greet");
    assert.equal(req.cwd, "C:\\ws");
    assert.equal(req.timeoutSec, 30);
    assert.equal(req.deadline, 1_000_000 + 600_000);

    const requested = events(r.audit, "requested")[0];
    const decided = events(r.audit, "decided")[0];
    assert.ok(requested && requested.event === "requested" && requested.id === "conv1:call1" && requested.deadline === req.deadline);
    assert.ok(decided && decided.event === "decided" && decided.approved === true && decided.by === "user" && decided.userId === 42);

    assert.equal(r.tokens.consume("conv1:call1", sha256Command("Write-Output hi")), true, "one token was granted");
    assert.equal(r.tokens.consume("conv1:call1", sha256Command("Write-Output hi")), false, "and it is one-shot");
    assert.equal(gate.pendingCount(), 0);
  } finally {
    r.cleanup();
  }
});

test("approval is once per command: each tool call id asks again, the same call id never does", async () => {
  const t = scriptedTransport(approveNow());
  const r = rig(t);
  try {
    const store = new Map<string, unknown>();
    const gate = createApprovalGate(r.deps);
    const api = fakeHookApi(store);
    await gate.beforeTool(shellCall("Write-Output 1", { id: "a" }), api, fakeContext());
    await gate.beforeTool(shellCall("Write-Output 1", { id: "b" }), api, fakeContext());
    assert.equal(t.requests.length, 2, "the same text under a new call id is a new command and needs a new approval");
    await gate.beforeTool(shellCall("Write-Output 1", { id: "a" }), api, fakeContext());
    assert.equal(t.requests.length, 2, "a rerun of call a reuses the memoised decision");
  } finally {
    r.cleanup();
  }
});

test("deny: returns a block that tells the model not to retry; audit decided approved:false; no token", async () => {
  const t = scriptedTransport(denyNow(42));
  const r = rig(t);
  try {
    const gate = createApprovalGate(r.deps);
    const out = await gate.beforeTool(shellCall("Remove-Item x"), fakeHookApi(new Map()), fakeContext());
    assert.ok(out && typeof out.block === "string");
    assert.match(out.block ?? "", /denied/i);
    assert.match(out.block ?? "", /not retry/i);
    const d = events(r.audit, "decided")[0];
    assert.ok(d && d.event === "decided" && d.approved === false && d.by === "user");
    assert.equal(r.tokens.size(), 0);
  } finally {
    r.cleanup();
  }
});

test("timeout: nobody answers, the deadline passes, the call is blocked with by:timeout and the card is told to close", async () => {
  const t = scriptedTransport(neverAnswer());
  // 0.3 s approval timeout; the fake clock stands still, so the real timer is the 300 ms
  const r = rig(t, { approvalTimeoutSec: 0.3 });
  try {
    const gate = createApprovalGate(r.deps);
    const started = Date.now();
    const out = await gate.beforeTool(shellCall("Write-Output hi"), fakeHookApi(new Map()), fakeContext());
    const waited = Date.now() - started;
    assert.ok(out?.block);
    assert.match(out.block, /timed out/i);
    assert.ok(waited >= 250 && waited < 2500, `waited ${waited} ms`);
    const d = events(r.audit, "decided")[0];
    assert.ok(d && d.event === "decided" && d.by === "timeout" && d.approved === false);
    assert.equal(t.signals[0]?.aborted, true, "the transport's signal is aborted so it can edit the card");
    assert.equal(r.tokens.size(), 0);
    assert.equal(gate.pendingCount(), 0);
  } finally {
    r.cleanup();
  }
});

test("already past the deadline when first seen: deny by timeout without asking", async () => {
  const t = scriptedTransport(approveNow());
  const r = rig(t, { approvalTimeoutSec: 0 });
  try {
    const gate = createApprovalGate(r.deps);
    const out = await gate.beforeTool(shellCall("Write-Output hi"), fakeHookApi(new Map()), fakeContext());
    assert.ok(out?.block);
    assert.equal(t.requests.length, 0);
    const d = events(r.audit, "decided")[0];
    assert.ok(d && d.event === "decided" && d.by === "timeout");
  } finally {
    r.cleanup();
  }
});

test("restart keeps the ORIGINAL deadline: a new gate over the same memo store asks again with the same deadline", async () => {
  const store = new Map<string, unknown>();
  const failing = scriptedTransport(() => Promise.reject(new Error("telegram down (process about to die)")));
  const r1 = rig(failing, { clock: { t: 5_000_000 } });
  let firstDeadline = 0;
  try {
    const gate1 = createApprovalGate(r1.deps);
    const out = await gate1.beforeTool(shellCall("Write-Output hi"), fakeHookApi(store), fakeContext());
    assert.ok(out?.block, "a transport failure blocks without memoising a decision");
    firstDeadline = failing.requests[0]!.deadline;
    assert.equal(firstDeadline, 5_000_000 + 600_000);
    assert.equal(store.has("a7.approval.decision:conv1:call1"), false, "no decision was memoised");
    assert.equal(store.has("a7.approval.asked:conv1:call1"), true, "the ask time was");
  } finally {
    r1.cleanup();
  }

  // "restart": a brand new gate, a later clock, the same memo store
  const t2 = scriptedTransport(approveNow());
  const r2 = rig(t2, { clock: { t: 5_000_000 + 120_000 } });
  try {
    const gate2 = createApprovalGate(r2.deps);
    const out = await gate2.beforeTool(shellCall("Write-Output hi"), fakeHookApi(store), fakeContext());
    assert.equal(out, undefined);
    assert.equal(t2.requests.length, 1);
    assert.equal(t2.requests[0]?.deadline, firstDeadline, "same deadline as before the restart, not now + 600 s");
  } finally {
    r2.cleanup();
  }
});

test("restart-expired: the deadline passed while the process was down, so the rerun denies with by:restart-expired and never asks", async () => {
  const store = new Map<string, unknown>();
  const failing = scriptedTransport(() => Promise.reject(new Error("down")));
  const r1 = rig(failing, { clock: { t: 1_000 } });
  try {
    await createApprovalGate(r1.deps).beforeTool(shellCall("Write-Output hi"), fakeHookApi(store), fakeContext());
  } finally {
    r1.cleanup();
  }
  const t2 = scriptedTransport(approveNow());
  const r2 = rig(t2, { clock: { t: 1_000 + 600_000 + 1 } });
  try {
    const out = await createApprovalGate(r2.deps).beforeTool(shellCall("Write-Output hi"), fakeHookApi(store), fakeContext());
    assert.ok(out?.block);
    assert.match(out.block, /expired while the agent was restarting/);
    assert.equal(t2.requests.length, 0, "no new card for an expired approval");
    const d = events(r2.audit, "decided")[0];
    assert.ok(d && d.event === "decided" && d.by === "restart-expired" && d.approved === false);
    assert.equal(r2.tokens.size(), 0);

    // and a third run reads the memoised decision: same block, still no ask
    const out3 = await createApprovalGate(r2.deps).beforeTool(shellCall("Write-Output hi"), fakeHookApi(store), fakeContext());
    assert.ok(out3?.block);
    assert.equal(t2.requests.length, 0);
  } finally {
    r2.cleanup();
  }
});

test("a decision already memoised does not re-ask: approved is granted again after a restart, denied stays denied", async () => {
  const store = new Map<string, unknown>();
  const t1 = scriptedTransport(approveNow());
  const r1 = rig(t1);
  try {
    assert.equal(await createApprovalGate(r1.deps).beforeTool(shellCall("Write-Output hi"), fakeHookApi(store), fakeContext()), undefined);
  } finally {
    r1.cleanup();
  }
  // restart before the tool ran: the in-memory token is gone, the memo is not
  const t2 = scriptedTransport(denyNow());
  const r2 = rig(t2);
  try {
    const out = await createApprovalGate(r2.deps).beforeTool(shellCall("Write-Output hi"), fakeHookApi(store), fakeContext());
    assert.equal(out, undefined, "the memoised approval wins; a new transport is not consulted");
    assert.equal(t2.requests.length, 0);
    assert.equal(r2.tokens.consume("conv1:call1", sha256Command("Write-Output hi")), true, "the token is re-granted from the memo");
  } finally {
    r2.cleanup();
  }

  const store2 = new Map<string, unknown>();
  const r3 = rig(scriptedTransport(denyNow()));
  const r4 = rig(scriptedTransport(approveNow()));
  try {
    await createApprovalGate(r3.deps).beforeTool(shellCall("Write-Output hi"), fakeHookApi(store2), fakeContext());
    const out = await createApprovalGate(r4.deps).beforeTool(shellCall("Write-Output hi"), fakeHookApi(store2), fakeContext());
    assert.ok(out?.block, "a memoised denial is final");
  } finally {
    r3.cleanup();
    r4.cleanup();
  }
});

test("a memoised approval does not apply to a different command under the same call id", async () => {
  const store = new Map<string, unknown>();
  const r = rig(scriptedTransport(approveNow()));
  try {
    const gate = createApprovalGate(r.deps);
    assert.equal(await gate.beforeTool(shellCall("Write-Output safe"), fakeHookApi(store), fakeContext()), undefined);
    const out = await gate.beforeTool(shellCall("Remove-Item -Recurse C:\\"), fakeHookApi(store), fakeContext());
    assert.ok(out?.block);
    assert.match(out.block, /does not match/);
  } finally {
    r.cleanup();
  }
});

test("kill switch during the wait: block with by:killswitch, the transport is aborted, within 100 ms of turnOn", async () => {
  const t = scriptedTransport(neverAnswer());
  const r = rig(t);
  try {
    const gate = createApprovalGate(r.deps);
    const pendingCall = gate.beforeTool(shellCall("Write-Output hi"), fakeHookApi(new Map()), fakeContext());
    await sleep(30);
    assert.equal(gate.pendingCount(), 1);
    const t0 = Date.now();
    await r.ks.turnOn("test");
    const out = await pendingCall;
    const took = Date.now() - t0;
    assert.ok(out?.block);
    assert.match(out.block, /kill switch/i);
    assert.ok(took < 100, `took ${took} ms`);
    const d = events(r.audit, "decided")[0];
    assert.ok(d && d.event === "decided" && d.by === "killswitch" && d.approved === false);
    assert.equal(t.signals[0]?.aborted, true);
    assert.equal(r.tokens.size(), 0);
    assert.equal(gate.pendingCount(), 0);
  } finally {
    r.cleanup();
  }
});

test("kill switch from the flag file or config (no onChange fired) also cancels a pending approval, via the poll", async () => {
  const t = scriptedTransport(neverAnswer());
  const r = rig(t);
  let enabled = true;
  r.deps.killSwitch = createKillSwitch({ controlDir: r.dir, shellEnabled: () => enabled });
  try {
    const gate = createApprovalGate(r.deps);
    const pendingCall = gate.beforeTool(shellCall("Write-Output hi"), fakeHookApi(new Map()), fakeContext());
    await sleep(30);
    enabled = false;
    const out = await pendingCall;
    assert.ok(out?.block);
    const d = events(r.audit, "decided")[0];
    assert.ok(d && d.event === "decided" && d.by === "killswitch");
  } finally {
    r.cleanup();
  }
});

test("kill switch already on: blocks, audits blocked, never asks and never memoises", async () => {
  const t = scriptedTransport(approveNow());
  const r = rig(t);
  try {
    await r.ks.turnOn("test");
    const store = new Map<string, unknown>();
    const out = await createApprovalGate(r.deps).beforeTool(shellCall("Write-Output hi"), fakeHookApi(store), fakeContext());
    assert.deepEqual(out, { block: "Shell is disabled (kill switch)." });
    assert.equal(t.requests.length, 0);
    assert.equal(store.size, 0);
    const b = events(r.audit, "blocked").find((e) => e.id === "conv1:call1");
    assert.ok(b && b.event === "blocked" && b.reason === "killswitch" && b.command === "Write-Output hi");
  } finally {
    r.cleanup();
  }
});

test("an approval that lands just after the kill switch turned on is not usable: blocked, no token", async () => {
  let on = false;
  const ks = { isOn: () => on, onChange: () => undefined, turnOn: async () => undefined };
  const t = scriptedTransport(async () => {
    on = true; // the switch flips (flag file, say) while the answer is on its way; no onChange fires
    return { approved: true, by: "user", userId: 1, at: Date.now() };
  });
  const r = rig(t);
  r.deps.killSwitch = ks;
  try {
    const out = await createApprovalGate(r.deps).beforeTool(shellCall("Write-Output hi"), fakeHookApi(new Map()), fakeContext());
    assert.deepEqual(out, { block: "Shell is disabled (kill switch)." });
    assert.equal(r.tokens.size(), 0);
  } finally {
    r.cleanup();
  }
});

test("/stop (context abort) during the wait: block with by:stop", async () => {
  const t = scriptedTransport(neverAnswer());
  const r = rig(t);
  try {
    const ac = new AbortController();
    const gate = createApprovalGate(r.deps);
    const p = gate.beforeTool(shellCall("Write-Output hi"), fakeHookApi(new Map()), fakeContext(ac.signal));
    await sleep(20);
    ac.abort();
    const out = await p;
    assert.ok(out?.block);
    assert.match(out.block, /\/stop/);
    const d = events(r.audit, "decided")[0];
    assert.ok(d && d.event === "decided" && d.by === "stop" && d.approved === false);
    assert.equal(t.signals[0]?.aborted, true);
  } finally {
    r.cleanup();
  }
});

test("already-aborted context blocks at once; cancelConversation cancels only that conversation's pending approvals", async () => {
  const t = scriptedTransport(neverAnswer());
  const r = rig(t);
  try {
    const gate = createApprovalGate(r.deps);
    const ac = new AbortController();
    ac.abort();
    const out = await gate.beforeTool(shellCall("Write-Output hi", { id: "pre" }), fakeHookApi(new Map()), fakeContext(ac.signal));
    assert.ok(out?.block);

    const p1 = gate.beforeTool(shellCall("Write-Output 1", { id: "x1" }), fakeHookApi(new Map(), "convA"), fakeContext());
    const p2 = gate.beforeTool(shellCall("Write-Output 2", { id: "x2" }), fakeHookApi(new Map(), "convB"), fakeContext());
    await sleep(20);
    assert.equal(gate.pendingCount(), 2);
    assert.equal(gate.cancelConversation("convA", "stop"), 1);
    const o1 = await p1;
    assert.ok(o1?.block);
    assert.equal(gate.pendingCount(), 1);
    assert.equal(gate.cancelConversation("convB", "stop"), 1);
    await p2;
  } finally {
    r.cleanup();
  }
});

test("invalid commands (empty, whitespace, over the limit) are blocked without asking or memoising", async () => {
  const t = scriptedTransport(approveNow());
  const r = rig(t);
  try {
    const store = new Map<string, unknown>();
    const gate = createApprovalGate(r.deps);
    for (const cmd of ["", "   ", "x".repeat(MAX_COMMAND_CHARS + 1)]) {
      const out = await gate.beforeTool(shellCall(cmd), fakeHookApi(store), fakeContext());
      assert.ok(out?.block, `command of ${cmd.length} chars`);
    }
    assert.equal(t.requests.length, 0);
    assert.equal(store.size, 0);
    // each invalid command leaves a `decided` audit line with by:"invalid" (S6 contract fix)
    const decided = events(r.audit, "decided");
    assert.equal(decided.length, 3);
    for (const d of decided) assert.ok(d.event === "decided" && d.approved === false && d.by === "invalid" && d.id === "conv1:call1");
    // exactly at the limit is allowed
    assert.equal(await gate.beforeTool(shellCall("x".repeat(MAX_COMMAND_CHARS), { id: "lim" }), fakeHookApi(store), fakeContext()), undefined);
  } finally {
    r.cleanup();
  }
});

test("no chat for the conversation: blocked, not asked", async () => {
  const t = scriptedTransport(approveNow());
  const r = rig(t, { chat: undefined });
  try {
    const out = await createApprovalGate(r.deps).beforeTool(shellCall("Write-Output hi"), fakeHookApi(new Map()), fakeContext());
    assert.ok(out?.block);
    assert.equal(t.requests.length, 0);
  } finally {
    r.cleanup();
  }
});

test("a transport that claims approval without approved:true is not trusted; first writer wins on the decision memo", async () => {
  const t = scriptedTransport(async () => ({ approved: "yes" as unknown as boolean, by: "user", at: 1 }));
  const r = rig(t);
  try {
    const out = await createApprovalGate(r.deps).beforeTool(shellCall("Write-Output hi"), fakeHookApi(new Map()), fakeContext());
    assert.ok(out?.block);
    assert.equal(r.tokens.size(), 0);
  } finally {
    r.cleanup();
  }

  // first writer wins: a decision written by another run between the check and our write is the one used
  const store = new Map<string, unknown>();
  const r2 = rig(scriptedTransport(async () => {
    store.set("a7.approval.decision:conv1:call1", { approved: false, by: "stop", at: 1, commandSha256: sha256Command("Write-Output hi") });
    return { approved: true, by: "user", userId: 1, at: 2 };
  }));
  try {
    const out = await createApprovalGate(r2.deps).beforeTool(shellCall("Write-Output hi"), fakeHookApi(store), fakeContext());
    assert.ok(out?.block, "the earlier denial stands");
    assert.equal(r2.tokens.size(), 0);
  } finally {
    r2.cleanup();
  }
});

test("denyText covers every decision source", () => {
  for (const by of ["user", "timeout", "killswitch", "stop", "restart-expired", "invalid"] as const) assert.ok(denyText({ by }).length > 10, by);
});
