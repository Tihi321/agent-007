/**
 * S9 (I27): the deferred-tool mechanism, proved against the real Pi Durable Harness and a fake OpenAI-compatible
 * server. A tool registered with `deferred: true` is not offered to the model; `tool_search` (the adapter's
 * `createToolSearchExtension`) loads it, and the next request offers it. S10, S14 and S15 register their deferred tools
 * this way.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allEntries, ask, openRig } from "../scripts/smoke/common.js";
import { ALWAYS_LOADED, checkToolCap } from "../src/jobs/contracts.js";
import { TOOL_SEARCH_TOOL_NAME, Type, createToolSearchExtension, defineExtension, defineTool } from "../src/pi/adapter.js";
import { startFakeOpenAi } from "./helpers/fakeOpenAi.js";
import type { BehaviorInput, Reply } from "./helpers/fakeOpenAi.js";

function toolNames(req: { tools?: { function?: { name?: string } }[] } | undefined): string[] {
  return (req?.tools ?? []).map((t) => t.function?.name ?? "").sort();
}

test("a deferred tool is not offered until tool_search loads it; then the next request offers it and it can run", async () => {
  const calls: unknown[] = [];
  const always = defineTool({
    name: "always_tool",
    description: "A tool that is always offered.",
    parameters: Type.Object({}),
    execute: async () => ({ output: [{ type: "text", text: "pong" }] }),
  });
  const deferred = defineTool({
    name: "mcp__demo__speak",
    description: "Speak a line of text aloud with text to speech.",
    parameters: Type.Object({ text: Type.String() }),
    deferred: true,
    execute: async (args) => {
      calls.push(args);
      return { output: [{ type: "text", text: "spoken" }] };
    },
  });
  const ext = defineExtension({ name: "demo", tools: [always, deferred] });

  const behavior = ({ afterTool, lastToolText, count }: BehaviorInput): Reply => {
    if (count === 1) return { type: "tool_calls", calls: [{ name: TOOL_SEARCH_TOOL_NAME, args: { query: "speak text aloud" } }] };
    if (count === 2) {
      assert.ok(afterTool && /mcp__demo__speak/.test(lastToolText), `tool_search result names the tool: ${lastToolText}`);
      return { type: "tool_calls", calls: [{ name: "mcp__demo__speak", args: { text: "hello" } }] };
    }
    return { type: "text", text: "done" };
  };
  const fake = await startFakeOpenAi({ behavior });
  const dir = mkdtempSync(join(tmpdir(), "a7-toolsearch-"));
  try {
    const rig = await openRig({
      storagePath: join(dir, "t.sqlite"),
      cfg: { runner: "lmstudio", baseUrl: fake.baseUrl, modelId: "fake-model", contextWindow: 8192, maxTokens: 256, apiKey: "k-123456" },
      extensions: [createToolSearchExtension(), ext],
    });
    try {
      const out = await ask(rig.root, "Please speak hello");
      assert.equal(out.settled.status, "done");
      const reqs = fake.chatRequests().map((r) => r.body);
      assert.equal(reqs.length, 3);
      assert.deepEqual(toolNames(reqs[0]), ["always_tool", "tool_search"], "the deferred tool is not offered at first");
      assert.deepEqual(toolNames(reqs[1]), ["always_tool", "mcp__demo__speak", "tool_search"], "tool_search loaded it");
      assert.deepEqual(toolNames(reqs[2]), ["always_tool", "mcp__demo__speak", "tool_search"], "it stays offered on the branch");
      assert.deepEqual(calls, [{ text: "hello" }]);
      assert.ok((await allEntries(rig.root)).length > 3);
    } finally {
      await rig.close();
    }
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deferred tool cannot be called by name before it is loaded", async () => {
  const calls: unknown[] = [];
  const deferred = defineTool({
    name: "hidden_tool",
    description: "Hidden until loaded.",
    parameters: Type.Object({}),
    deferred: true,
    execute: async () => {
      calls.push(1);
      return { output: [{ type: "text", text: "ran" }] };
    },
  });
  const fake = await startFakeOpenAi({
    behavior: ({ afterTool, count }) => (count === 1 ? { type: "tool_calls", calls: [{ name: "hidden_tool", args: {} }] } : afterTool ? { type: "text", text: "ok" } : { type: "text", text: "ok" }),
  });
  const dir = mkdtempSync(join(tmpdir(), "a7-toolsearch-"));
  try {
    const rig = await openRig({
      storagePath: join(dir, "t.sqlite"),
      cfg: { runner: "lmstudio", baseUrl: fake.baseUrl, modelId: "fake-model", contextWindow: 8192, maxTokens: 256, apiKey: "k-123456" },
      extensions: [createToolSearchExtension(), defineExtension({ name: "demo", tools: [deferred] })],
    });
    try {
      const out = await ask(rig.root, "call the hidden tool");
      assert.equal(out.settled.status, "done");
      assert.deepEqual(toolNames(fake.chatRequests()[0]?.body), ["tool_search"]);
      assert.deepEqual(calls, [], "the deferred tool did not execute");
    } finally {
      await rig.close();
    }
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the cap check works on real registrations: the tool_search tool counts as one of the 10", () => {
  const ext = createToolSearchExtension();
  const tools = [...(ext.tools ?? [])];
  const report = checkToolCap(tools, { subset: true });
  assert.equal(report.ok, true);
  assert.deepEqual(report.nonDeferred, ["tool_search"]);
  assert.equal(ALWAYS_LOADED[0], "tool_search");
});
