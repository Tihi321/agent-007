/**
 * S14.4: the Flow guard on the REAL Harness. A fake Flow tool is registered with the guard's `beforeTool` hook and its
 * charging wrapper; a scripted model calls it. No Flow server exists and no credit is spent.
 *
 * U38 is settled by the S14.5 read-only listTools (plan section 14): see the mapping test below.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { ask } from "../../scripts/smoke/common.js";
import { createFlowGuard, readMaxCredits } from "../../src/jobs/flowGuard.js";
import { flowLedgerDoc, openEntry } from "../../src/jobs/ledger.js";
import { Type, defineExtension, defineTool } from "../../src/pi/adapter.js";
import type { Static } from "../../src/pi/adapter.js";
import { FakeJobApprovalTransport } from "../helpers/fakeJobRunner.js";
import { startFakeOpenAi } from "../helpers/fakeOpenAi.js";
import type { Reply } from "../helpers/fakeOpenAi.js";
import { FakeRunner } from "./helpers/fakeRunner.js";
import { ctx, openJobsRig, sleep, tempDir, until } from "./helpers/rig.js";
import type { JobsRig } from "./helpers/rig.js";

const FLOW_TOOL = "mcp__flow-music-mcp__generate_clip";
const params = Type.Object({ prompt: Type.String(), max_credits: Type.Optional(Type.Any()) });

test("readMaxCredits: missing, zero, negative, a string, NaN and Infinity are refused; a positive number passes", () => {
  assert.equal(readMaxCredits({ prompt: "x" }).ok, false);
  for (const v of [0, -3, "10", Number.NaN, Number.POSITIVE_INFINITY, null]) assert.equal(readMaxCredits({ max_credits: v }).ok, false, String(v));
  assert.deepEqual(readMaxCredits({ max_credits: 12.5 }), { ok: true, value: 12.5 });
  assert.deepEqual(readMaxCredits({ credits_cap: 7 }, ["credits_cap"]), { ok: true, value: 7 }, "the field name is configurable (U38)");
  assert.equal(readMaxCredits("not an object").ok, false);
});

test("U38 mapping (real listTools, plan section 14 S14.5): flow_generate sums scenes[].max_credits, flow_continue/edit/narrate use a top-level max_credits, music_* have none", () => {
  // flow_generate {scenes: [{prompt, type, max_credits}]}: the cap of the call is the sum over its scenes
  assert.deepEqual(readMaxCredits({ scenes: [{ prompt: "a", type: "video", max_credits: 8 }, { prompt: "b", type: "video", max_credits: 12 }] }), { ok: true, value: 20 });
  assert.deepEqual(readMaxCredits({ scenes: [{ prompt: "k", type: "image", max_credits: 0 }, { prompt: "v", type: "video", max_credits: 8 }] }), { ok: true, value: 8 });
  // a scene with no cap (the server would fall back to its own default) or a bad one blocks the whole call
  const noCap = readMaxCredits({ scenes: [{ max_credits: 8 }, { prompt: "b" }] });
  assert.equal(noCap.ok, false);
  assert.match(noCap.ok ? "" : noCap.text, /scene 2 has no max_credits/);
  assert.equal(readMaxCredits({ scenes: [{ max_credits: -1 }] }).ok, false);
  assert.equal(readMaxCredits({ scenes: [{ max_credits: "8" }] }).ok, false);
  assert.equal(readMaxCredits({ scenes: [] }).ok, false);
  // free images only: the agent's own tools still need a paid, approved job (no small-call exception)
  assert.equal(readMaxCredits({ scenes: [{ max_credits: 0 }] }).ok, false);
  // flow_continue, flow_edit, flow_narrate: top level
  assert.deepEqual(readMaxCredits({ from_asset: "a", prompt: "p", max_credits: 4 }), { ok: true, value: 4 });
  // music_generate and music_remix have no cap field: always blocked
  assert.equal(readMaxCredits({ sound: "lofi" }).ok, false);
  assert.equal(readMaxCredits({ song_id: "s", mode: "remix" }).ok, false);
});

test("isFlowTool: only tools of the configured Flow server", () => {
  const g = createFlowGuard({ serverId: "flow-music-mcp" });
  assert.equal(g.isFlowTool(FLOW_TOOL), true);
  assert.equal(g.isFlowTool("mcp__vibetts__speak"), false);
  assert.equal(g.isFlowTool("read_file"), false);
  assert.equal(createFlowGuard({ serverId: "flow-music-mcp", isFlowTool: (n) => n === "x" }).isFlowTool("x"), true);
});

interface Rig {
  rig: JobsRig;
  calls: unknown[];
  toolTexts: string[];
  plan(calls: { name: string; args: unknown }[]): void;
  turn(): Promise<void>;
}

async function flowRig(dir: string, hang = { on: false }): Promise<Rig & { fake: Awaited<ReturnType<typeof startFakeOpenAi>>; runner: FakeRunner }> {
  const guard = createFlowGuard({ serverId: "flow-music-mcp" });
  const calls: unknown[] = [];
  const toolTexts: string[] = [];
  let planned: { name: string; args: unknown }[] | undefined;
  const fake = await startFakeOpenAi({
    behavior: ({ afterTool, lastToolText }): Reply => {
      if (afterTool) {
        toolTexts.push(lastToolText);
        return { type: "text", text: "noted" };
      }
      const p = planned;
      planned = undefined;
      return p ? { type: "tool_calls", calls: p } : { type: "text", text: "nothing to do" };
    },
  });
  const flowTool = guard.wrapTool(
    defineTool({
      name: FLOW_TOOL,
      description: "Generate a video clip with Flow. Spends credits.",
      parameters: params,
      replay: "unsafe",
      execute: async (args: Static<typeof params>, _api, c) => {
        calls.push(args);
        if (hang.on) await new Promise<void>((res) => c.abortSignal?.addEventListener("abort", () => res(), { once: true }));
        return { output: [{ type: "text", text: "clip generated" }] };
      },
    }),
  );
  const extra = ["flow_status", "flow_assemble", "music_generate", "music_remix", "flow_trash"].map((n) =>
    guard.wrapTool(
      defineTool({
        name: `mcp__flow-music-mcp__${n}`,
        description: `fake ${n}`,
        parameters: Type.Object({}, { additionalProperties: true }),
        replay: "unsafe",
        execute: async (args: unknown) => {
          calls.push({ tool: n, args });
          return { output: [{ type: "text", text: `${n} ran` }] };
        },
      }),
    ),
  );
  const runner = new FakeRunner();
  const rig = await openJobsRig({
    dir,
    client: runner.makeClient(),
    transport: new FakeJobApprovalTransport(),
    baseUrl: fake.baseUrl,
    flowHook: true,
    extensions: [defineExtension({ name: "flow-fake", tools: [flowTool, ...extra] })],
  });
  return {
    rig,
    fake,
    runner,
    calls,
    toolTexts,
    plan: (c) => void (planned = c),
    turn: async () => void (await ask(rig.root, "make a clip")),
  };
}

async function approve(rig: JobsRig, approved: number, jobId = "job-flow-1"): Promise<void> {
  await rig.root.commit(async (tx) => {
    openEntry(await tx.doc(flowLedgerDoc), { jobId, conversationId: String(rig.root.id), templateId: "video-short", approved, userId: 4242, at: Date.now() });
  }, ctx);
}

test("no ledger entry: a Flow call is blocked even with a tiny max_credits, and the tool never runs", async () => {
  const dir = tempDir();
  const f = await flowRig(dir);
  try {
    f.plan([{ name: FLOW_TOOL, args: { prompt: "a sunrise", max_credits: 1 } }]);
    await f.turn();
    assert.equal(f.calls.length, 0, "the tool did not execute");
    assert.match(f.toolTexts[0] ?? "", /no approved Flow job/);
    assert.deepEqual((await f.rig.ledger()).calls, {}, "nothing was charged");
  } finally {
    await f.rig.close();
    await f.fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing max_credits is blocked even when a budget exists", async () => {
  const dir = tempDir();
  const f = await flowRig(dir);
  try {
    await approve(f.rig, 40);
    f.plan([{ name: FLOW_TOOL, args: { prompt: "a sunrise" } }]);
    await f.turn();
    assert.equal(f.calls.length, 0);
    assert.match(f.toolTexts[0] ?? "", /no max_credits/);
  } finally {
    await f.rig.close();
    await f.fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("over budget is blocked; exactly at budget runs and is charged; the next call is blocked", async () => {
  const dir = tempDir();
  const f = await flowRig(dir);
  try {
    await approve(f.rig, 10);
    f.plan([{ name: FLOW_TOOL, args: { prompt: "a", max_credits: 11 } }]);
    await f.turn();
    assert.equal(f.calls.length, 0);
    assert.match(f.toolTexts.at(-1) ?? "", /more than the 10 approved credits/);

    f.plan([{ name: FLOW_TOOL, args: { prompt: "b", max_credits: 10 } }]);
    await f.turn();
    assert.equal(f.calls.length, 1, "exactly at the budget runs");
    assert.equal(f.toolTexts.at(-1), "clip generated");
    const e = (await f.rig.ledger()).entries["job-flow-1"]!;
    assert.equal(e.directCharged, 10, "the charge is max_credits, written before the call");

    f.plan([{ name: FLOW_TOOL, args: { prompt: "c", max_credits: 1 } }]);
    await f.turn();
    assert.equal(f.calls.length, 1, "nothing left");
    assert.match(f.toolTexts.at(-1) ?? "", /more than the 0 approved credits/);
  } finally {
    await f.rig.close();
    await f.fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a closed job's entry no longer allows Flow calls", async () => {
  const dir = tempDir();
  const f = await flowRig(dir);
  try {
    await approve(f.rig, 40);
    await f.rig.root.commit(async (tx) => {
      (await tx.doc(flowLedgerDoc)).entries["job-flow-1"]!.open = false;
    }, ctx);
    f.plan([{ name: FLOW_TOOL, args: { prompt: "a", max_credits: 1 } }]);
    await f.turn();
    assert.equal(f.calls.length, 0);
    assert.match(f.toolTexts[0] ?? "", /no approved Flow job/);
  } finally {
    await f.rig.close();
    await f.fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two Flow calls in one round: the charge is atomic, so together they cannot pass the budget", async () => {
  const dir = tempDir();
  const f = await flowRig(dir);
  try {
    await approve(f.rig, 10);
    f.plan([
      { name: FLOW_TOOL, args: { prompt: "a", max_credits: 6 } },
      { name: FLOW_TOOL, args: { prompt: "b", max_credits: 6 } },
    ]);
    await f.turn();
    assert.equal(f.calls.length, 1, "only one of the two ran");
    const e = (await f.rig.ledger()).entries["job-flow-1"]!;
    assert.equal(e.directCharged, 6);
  } finally {
    await f.rig.close();
    await f.fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crash after the call: the tool is not run again (replay unsafe) and the charge survives the restart", async () => {
  const dir = tempDir();
  const hang = { on: true };
  const f = await flowRig(dir, hang);
  let f2: Awaited<ReturnType<typeof flowRig>> | undefined;
  try {
    await approve(f.rig, 40);
    f.plan([{ name: FLOW_TOOL, args: { prompt: "a", max_credits: 15 } }]);
    const sub = await f.rig.root.submit({ type: "input", content: "make a clip" }, ctx);
    await until(() => f.calls.length === 1, 8000, "the Flow call to start");
    await f.rig.close(); // the crash, mid call (the charge was committed before the call)
    await f.fake.close();
    hang.on = false;

    f2 = await flowRig(dir, hang);
    const sub2 = await f2.rig.harness.submission(sub.id, ctx);
    assert.ok(sub2, "the submission survived");
    await sub2!.wait(ctx);
    await sleep(100);
    assert.equal(f2.calls.length, 0, "the tool was not run again after the restart");
    assert.equal(f.calls.length, 1, "exactly one real call in total");
    const e = (await f2.rig.ledger()).entries["job-flow-1"]!;
    assert.equal(e.directCharged, 15, "the ledger kept the charge across the restart");
    assert.ok(f2.toolTexts.some((t) => /interrupted/i.test(t)), `the model was told the call was interrupted: ${f2.toolTexts.join(" | ")}`);
  } finally {
    await f2?.rig.close();
    await f2?.fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ledger survives a restart (reads back the same entry)", async () => {
  const dir = tempDir();
  const f = await flowRig(dir);
  await approve(f.rig, 33);
  await f.rig.close();
  await f.fake.close();
  const f2 = await flowRig(dir);
  try {
    const e = (await f2.rig.ledger()).entries["job-flow-1"];
    assert.equal(e?.approved, 33);
    assert.equal(e?.open, true);
  } finally {
    await f2.rig.close();
    await f2.fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dev 153a: a free Flow tool runs inside an approved job without max_credits and charges nothing; outside one it is refused", async () => {
  const dir = tempDir();
  const f = await flowRig(dir);
  try {
    f.plan([{ name: "mcp__flow-music-mcp__flow_status", args: {} }]);
    await f.turn();
    assert.equal(f.calls.length, 0, "no approved job: refused");
    assert.match(f.toolTexts.at(-1) ?? "", /no approved Flow job/);

    await approve(f.rig, 10);
    f.plan([{ name: "mcp__flow-music-mcp__flow_status", args: {} }]);
    await f.turn();
    f.plan([{ name: "mcp__flow-music-mcp__flow_assemble", args: { dir: "x" } }]);
    await f.turn();
    assert.deepEqual(f.calls.map((c) => (c as { tool: string }).tool), ["flow_status", "flow_assemble"]);
    assert.equal(f.toolTexts.at(-1), "flow_assemble ran");
    const l = await f.rig.ledger();
    assert.equal(l.entries["job-flow-1"]!.directCharged, 0, "nothing charged");
    assert.deepEqual(l.calls, {});

    // a tool outside the allowlist keeps the cap rule
    f.plan([{ name: "mcp__flow-music-mcp__flow_trash", args: { media_id: "m" } }]);
    await f.turn();
    assert.equal(f.calls.length, 2);
    assert.match(f.toolTexts.at(-1) ?? "", /max_credits/);
  } finally {
    await f.rig.close();
    await f.fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dev 153b: music_generate and music_remix stay refused, even inside an approved job, with the unsupported message", async () => {
  const dir = tempDir();
  const f = await flowRig(dir);
  try {
    await approve(f.rig, 100);
    for (const n of ["music_generate", "music_remix"]) {
      f.plan([{ name: `mcp__flow-music-mcp__${n}`, args: { max_credits: 5 } }]);
      await f.turn();
      assert.match(f.toolTexts.at(-1) ?? "", /Flow Music credit approval is not supported yet/);
    }
    assert.equal(f.calls.length, 0);
    assert.equal((await f.rig.ledger()).entries["job-flow-1"]!.directCharged, 0);
  } finally {
    await f.rig.close();
    await f.fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
