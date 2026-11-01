/** The fakes S24 and S26 build on: FakeBotBus scripts replies and feeds a subscriber; a throwing subscriber leaves it unaffected. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BusError } from "../../src/botbus/contracts.js";
import { FakeBotBus, FakeBotRuntime } from "./fakes.js";

test("FakeBotBus records sends, scripts replies and refuses unknown peers like the real bus", async () => {
  const bus = new FakeBotBus();
  bus.replies.set("b", (d) => `got ${(d as { message: string }).message}`);
  const r = await bus.channel("a").send({ to: "b", message: "hi" }, { conversationId: "c" });
  assert.equal(r.reply, "got hi");
  assert.equal(bus.sent[0]?.from, "a");
  await assert.rejects(bus.channel("a").send({ to: "zzz", message: "x" }), (e: unknown) => e instanceof BusError && e.code === "edge_denied");
  assert.equal(bus.hasEdges("a"), true);
});

test("FakeBotBus publishes events to subscribers; a throwing subscriber does not stop the others or the bus", () => {
  const bus = new FakeBotBus();
  const seen: string[] = [];
  bus.onMessage(() => {
    throw new Error("mirror API down");
  });
  const off = bus.onMessage((e) => seen.push(`${e.type}:${e.from}>${e.to}`));
  bus.publish({ type: "ask", from: "a", to: "b", text: "hello" });
  off();
  bus.publish({ type: "reply", from: "b", to: "a" });
  assert.deepEqual(seen, ["ask:a>b"]);
});

test("FakeBotRuntime records the call and binds a conversation id", async () => {
  const rt = new FakeBotRuntime((c) => `seen ${c.envelope.body}`, "b");
  let bound = "";
  const reply = await rt.runPeerTurn({ id: "1", kind: "ask", from: "a", to: "b", chainId: "c", hop: 1, path: ["a", "b"], origin: "peer", taint: false, body: "yo", attachments: [], ts: "", timeoutSec: 5, wait: true }, {} as never, { text: "t", conversationKey: "peer:a", bind: (id) => (bound = id), signal: new AbortController().signal });
  assert.equal(reply.text, "seen yo");
  assert.equal(bound, "b-peer-a-1");
  assert.equal(rt.calls.length, 1);
});
