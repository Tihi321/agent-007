/** S25.2: PriorityHints (I44) and the `/status` data (topology, depths, per-bot view). The loader refusal itself is tested in test/bots. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_GATE } from "../../src/bots/schema.js";
import type { PresetConfig } from "../../src/bots/schema.js";
import { LocalGate } from "../../src/gate/gate.js";
import { PriorityHints } from "../../src/gate/hints.js";
import { botGateView, gateStatusLines, localTopology, queueDepths } from "../../src/gate/status.js";
import { FakeClock, SEC, settle } from "./fakes.js";

test("hints: no active turn gives P2 for a turn and P3 for a summary", () => {
  const h = new PriorityHints();
  assert.equal(h.resolve("a").priority, 2);
  assert.equal(h.resolveSummary("a").priority, 3);
  assert.equal(h.resolveSummary("a").conversationId, undefined);
});

test("hints: explicit priority and conversation are used; a summary stays P3 in the turn's conversation", () => {
  const h = new PriorityHints();
  h.begin("a", { priority: 0, conversationId: "c1" });
  assert.deepEqual(h.resolve("a"), { priority: 0, conversationId: "c1" });
  assert.deepEqual(h.resolveSummary("a"), { priority: 3, conversationId: "c1" });
  assert.equal(h.resolve("b").priority, 2, "another bot is unaffected");
});

test("hints: nested turns, the best class wins, ending restores the rest; double end is harmless", () => {
  const h = new PriorityHints();
  const endBg = h.begin("a", { priority: 2 });
  const endUser = h.begin("a", { priority: 0, conversationId: "u" });
  const endPeer = h.begin("a", { priority: 1 });
  assert.equal(h.activeTurns("a"), 3);
  assert.equal(h.resolve("a").priority, 0);
  endUser();
  endUser();
  assert.equal(h.activeTurns("a"), 2);
  assert.equal(h.resolve("a").priority, 1);
  endPeer();
  assert.equal(h.resolve("a").priority, 2);
  endBg();
  assert.equal(h.activeTurns("a"), 0);
  assert.equal(h.resolve("a").priority, 2);
});

test("hints: of equal classes the earliest wins", () => {
  const h = new PriorityHints();
  h.begin("a", { priority: 1, conversationId: "first" });
  h.begin("a", { priority: 1, conversationId: "second" });
  assert.equal(h.resolve("a").conversationId, "first");
});

const preset = (id: string, kind: PresetConfig["kind"], runner?: string): PresetConfig =>
  ({ id, kind, label: id, ...(runner ? { runner } : {}), modelId: "m", contextWindow: 1000, maxTokens: 100, privacy: "local", autoFallback: false }) as unknown as PresetConfig;
const bot = (id: string, primary: string) => ({ id, route: { primary, allowed: [primary], fallback: [], onAuthRequired: "fallback" as const } });
const PRESETS = [preset("s", "local", "strata"), preset("l", "local", "lmstudio"), preset("c", "acp")];

test("topology: bots by runner of their primary preset; proxy primaries are not listed", () => {
  const t = localTopology([bot("a", "s"), bot("b", "l"), bot("c", "c"), bot("d", "s"), bot("e", "nope")], PRESETS, 2);
  assert.deepEqual(t.strataPrimary, ["a", "d"]);
  assert.deepEqual(t.byRunner, { strata: ["a", "d"], lmstudio: ["b"] });
  assert.equal(t.limit, 2);
  assert.equal(t.withinLimit, true);
});

test("topology: over the limit is reported (the loader refuses it), at the limit is fine", () => {
  const three = [bot("a", "s"), bot("b", "s"), bot("c", "s")];
  assert.equal(localTopology(three, PRESETS, DEFAULT_GATE.localBotsOnStrata).withinLimit, false);
  assert.equal(localTopology(three, PRESETS, 3).withinLimit, true);
  const none = localTopology([bot("c", "c")], PRESETS, 1);
  assert.deepEqual(none.strataPrimary, []);
  assert.equal(none.withinLimit, true);
});

test("queue depths, per-bot view and status lines", async () => {
  const clock = new FakeClock();
  const gate = new LocalGate({ settings: { maxQueueDepth: 8, stickinessSec: 0, agingSec: 60, waitNoticeSec: 10 }, clock });
  const strata = gate.runner("strata");
  assert.ok(strata);
  assert.deepEqual([...gateStatusLines(gate.status())].sort(), ["lmstudio: 0 running, 0 waiting", "strata: 0 running, 0 waiting"]);
  void strata.acquire({ bot: "a", priority: 2 });
  void strata.acquire({ bot: "b", priority: 0 });
  void strata.acquire({ bot: "c", priority: 3 });
  await settle();
  clock.advance(12 * SEC);
  const st = gate.status();
  assert.deepEqual(queueDepths(st)["strata"], { running: 1, queued: 2 });
  assert.deepEqual(queueDepths(st)["lmstudio"], { running: 0, queued: 0 });
  const va = botGateView(st, "a").find((v) => v.runner === "strata");
  assert.deepEqual(va, { runner: "strata", running: true, waiting: 0, queued: 2, sticky: false });
  const vb = botGateView(st, "b").find((v) => v.runner === "strata");
  assert.equal(vb?.running, false);
  assert.equal(vb?.waiting, 1);
  const line = gateStatusLines(st).find((l) => l.startsWith("strata:"));
  assert.equal(line, "strata: 1 running, 2 waiting (P0 1, P1 0, P2 0, P3 1), oldest 12s");
});
