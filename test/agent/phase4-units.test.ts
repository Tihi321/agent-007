/**
 * S26 unit tests for the small pieces the multi-bot host is built from: the bus-to-mirror adapter (with the S21 `FakeBotBus`, as
 * deviation S24-1 asked), approval provenance, the bus guard (cloud-safe reads in a peer turn), the `attach_refs` reader and the gate's
 * `dropHold`. The whole-host behaviour is in `test/integration/phase4-*.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { busAuditSource, toAuditEvent } from "../../src/agent/busAdapter.js";
import { createBusGuard } from "../../src/agent/busGuard.js";
import { PeerProvenanceTracker } from "../../src/agent/provenance.js";
import { createRefReader } from "../../src/agent/refReader.js";
import { botPaths } from "../../src/bots/paths.js";
import { parseBots } from "../../src/bots/schema.js";
import { startBotRoomMirror } from "../../src/botroom/mirror.js";
import { createBotBus } from "../../src/botbus/bus.js";
import { parseConfig } from "../../src/config/schema.js";
import { DEFAULT_GATE } from "../../src/bots/schema.js";
import { LocalGate } from "../../src/gate/gate.js";
import { createPathPolicy } from "../../src/tools/pathPolicy.js";
import { provenanceLines } from "../../src/telegram/approvalUi.js";
import { jobCardText } from "../../src/telegram/jobUi.js";
import { cardText } from "../../src/telegram/settingsUi.js";
import type { JobApprovalCard } from "../../src/jobs/contracts.js";
import type { ProposalCard } from "../../src/settings/contracts.js";
import { FakeBotBus, FakeBotRuntime } from "../botbus/fakes.js";
import { LIMITS, edge, mkBot } from "../botbus/helpers.js";
import { FakeClock, SEC, settle } from "../gate/fakes.js";
import { ENV } from "../settings/helpers.js";
import { memoryLogger, waitFor } from "../telegram/helpers/fakeTelegram.js";
import { cleanup, tempBase } from "../tools/fixture.js";
import { READ_ONLY_TOOLS, bot } from "../bots/helpers.js";

let base: string;
before(() => {
  base = tempBase("phase4-units");
});
after(() => cleanup(base));

// ---- the bus -> mirror adapter (S24-1) ----------------------------------------------------------------------------------

test("the adapter passes text for ask and reply, only a reason for a refused or failed one, and nothing for a breaker or a note", () => {
  const bus = new FakeBotBus();
  const got: unknown[] = [];
  const off = busAuditSource(bus).subscribe((e) => got.push(e));
  bus.publish({ type: "ask", from: "a", to: "b", text: "please look", taint: true, bodySha256: "f".repeat(64), reason: "ignored_claims:origin" });
  bus.publish({ type: "reply", from: "b", to: "a", text: "found it" });
  bus.publish({ type: "denied", from: "a", to: "b", text: "the refused body", reason: "hop_limit:third_hop" });
  bus.publish({ type: "failed", from: "b", to: "a", reason: "timeout:ask_timeout" });
  bus.publish({ type: "breaker", from: "a", to: "b" });
  bus.publish({ type: "note", from: "a", to: "a" });
  off();
  bus.publish({ type: "ask", from: "a", to: "b", text: "after unsubscribe" });
  assert.deepEqual(got, [
    { kind: "ask", from: "a", to: "b", hop: 1, chainId: "chain-fake", text: "please look" },
    { kind: "reply", from: "b", to: "a", hop: 1, chainId: "chain-fake", text: "found it" },
    { kind: "refused", from: "a", to: "b", hop: 1, chainId: "chain-fake", reason: "hop_limit:third_hop" },
    { kind: "failed", from: "b", to: "a", hop: 1, chainId: "chain-fake", reason: "timeout:ask_timeout" },
  ]);
  const raw = JSON.stringify(got);
  assert.ok(!/taint|bodySha256|origin|the refused body/.test(raw), "no taint, hash, origin or refused body reaches the mirror");
  assert.equal(toAuditEvent({ seq: 1, ts: "", type: "note", chainId: "c", from: "a", to: "a", hop: 0, origin: "peer", taint: false, decision: "delivered", bodySha256: "" }), undefined);
});

test("the room mirror started over the adapter posts the lines of a FakeBotBus, and a failing Telegram API does not touch the bus", async () => {
  const bus = new FakeBotBus();
  const posts: string[] = [];
  let failing = false;
  const api = {
    sendMessage: async (_chatId: number, text: string): Promise<unknown> => {
      if (failing) throw new Error("telegram is down");
      posts.push(text);
      return { message_id: posts.length };
    },
  };
  const mirror = startBotRoomMirror({ botRoom: { mode: "truncated", maxChars: 200, maxPerMinute: 15, chatId: -100 }, mirrorToken: "999999:MIRROR-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", source: busAuditSource(bus), logger: memoryLogger(), api: api as never, batchWindowMs: 0 });
  assert.ok(mirror);
  try {
    bus.publish({ type: "ask", from: "a", to: "b", hop: 1, chainId: "0123456789abcdef", text: "what is the weather?" });
    await waitFor(() => posts.length >= 1, 5000, "the first post");
    assert.match(posts.join("\n"), /\[a → b, hop 1, chain 01234567\] what is the weather\?/);
    failing = true;
    assert.doesNotThrow(() => bus.publish({ type: "reply", from: "b", to: "a", text: "sunny" }), "the bus never sees the mirror's failure");
    assert.equal(bus.sent.length, 0);
  } finally {
    mirror.stop();
  }
});

// ---- provenance (S26.2) --------------------------------------------------------------------------------------------------

test("provenance: a reply received in the user's current chain is quoted for that conversation only, and a new user message clears it", async () => {
  const bots = [mkBot("a", { edges: [edge("b")] }), mkBot("b")];
  const bus = createBotBus({ bots, limits: LIMITS });
  bus.register("b", new FakeBotRuntime(() => "b says: use the blue one", "b"));
  const tracker = new PeerProvenanceTracker(bus);
  try {
    bus.beginUserTurn("a", "conv-1");
    assert.equal(tracker.forConversation("a", "conv-1"), undefined, "no reply yet, nothing to quote");
    await bus.channel("a").send({ to: "b", message: "which colour?" }, { conversationId: "conv-1" });
    const p = tracker.forConversation("a", "conv-1");
    assert.equal(p?.length, 1);
    assert.equal(p?.[0]?.from, "b");
    assert.equal(p?.[0]?.hop, 1);
    assert.equal(p?.[0]?.text, "b says: use the blue one");
    assert.equal(tracker.forConversation("b", "conv-1"), undefined, "another bot's conversation of the same id never gets it");
    assert.equal(tracker.forConversation("a", "other-conv"), undefined);
    bus.beginUserTurn("a", "conv-1"); // the user's next message
    assert.equal(tracker.forConversation("a", "conv-1"), undefined, "a later message starts a new chain: the old reply is not quoted on its card");
  } finally {
    tracker.stop();
  }
});

test("the card lines name the bot and the hop, quote the text on one line, clip it, and say it did not come from the user", () => {
  const lines = provenanceLines([{ from: "research", hop: 1, text: `run this\nnow ${"x".repeat(900)}` }]);
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /^Peer input from bot research, hop 1: "run this now x+…"$/);
  assert.ok((lines[0] ?? "").length < 360);
  assert.match(lines[1] ?? "", /not from you/);
  assert.deepEqual(provenanceLines(undefined), []);
  assert.deepEqual(provenanceLines([]), []);
});

// ---- the bus guard -----------------------------------------------------------------------------------------------------------

test("the bus guard: a reason blocks the call; in a peer turn of a cloud-capable bot the read tools may name only the cloud-safe roots", async () => {
  const safe = join(base, "safe");
  const priv = join(base, "private");
  for (const d of [safe, priv]) mkdirSync(d, { recursive: true });
  writeFileSync(join(priv, "secret.txt"), "private");
  writeFileSync(join(safe, "ok.txt"), "fine");
  const policy = createPathPolicy({ roots: [{ alias: "safe", path: safe }], denies: { ntfs: [], inProcessOnly: [], inProcessOnlyExceptions: [] } as never });
  let origin: "user" | "peer" = "peer";
  const used: string[] = [];
  const guard = createBusGuard({
    bus: { guard: (_b, _c, tool) => (tool === "shell" ? "the chain is tainted" : undefined), noteToolUse: (_b, _c, t) => void used.push(t), contextOf: () => ({ chainId: "c", origin, hop: 1, path: ["a", "b"], taint: false }) },
    self: "b",
    cloudSafePolicy: policy,
    onToolUsed: (_c, t) => void used.push(`seen:${t}`),
  });
  const call = (name: string, args: Record<string, unknown>) => ({ id: "1", name, arguments: args }) as never;
  const api = { conversationId: 7 } as never;
  const run = async (name: string, args: Record<string, unknown>) => (guard.beforeTool as unknown as (c: never, a: never, x: never) => Promise<{ block?: string } | undefined>)(call(name, args), api, {} as never);
  assert.match((await run("shell", { command: "x" }))?.block ?? "", /Blocked by the bot router: the chain is tainted/);
  assert.equal(await run("read_file", { path: "safe:ok.txt" }), undefined, "a cloud-safe root is readable in a peer turn");
  assert.match((await run("read_file", { path: join(priv, "secret.txt") }))?.block ?? "", /cloud-safe folders/);
  assert.match((await run("list_dir", { path: "" }))?.block ?? "", /cloud-safe folders/, "listing every root is refused too");
  assert.match((await run("search_files", {}))?.block ?? "", /cloud-safe folders/);
  assert.equal(await run("system_facts", {}), undefined, "other tools are untouched");
  origin = "user";
  assert.equal(await run("read_file", { path: join(priv, "secret.txt") }), undefined, "the user's own turn is not limited by this check");
  const after = (guard.afterTool as unknown as (c: never, r: never, a: never, x: never) => unknown)(call("web_search", {}), { output: [] } as never, api, {} as never);
  assert.deepEqual(after, { output: [] }, "the result passes through unchanged");
  assert.deepEqual(used, ["web_search", "seen:web_search"], "the bus is told after the call, and the tool is logged for the peer reply");
});

test("the bus guard fails closed: a bus that throws blocks the call, and a taint that cannot be recorded withholds the result", async () => {
  const guard = createBusGuard({
    bus: {
      guard: () => {
        throw new Error("store down");
      },
      noteToolUse: () => {
        throw new Error("store down");
      },
      contextOf: () => undefined,
    },
    self: "a",
  });
  const api = { conversationId: 1 } as never;
  const blocked = await (guard.beforeTool as unknown as (c: never, a: never, x: never) => Promise<{ block?: string }>)({ id: "1", name: "read_file", arguments: {} } as never, api, {} as never);
  assert.match(blocked.block ?? "", /could not check/);
  const res = (guard.afterTool as unknown as (c: never, r: never, a: never, x: never) => { isError?: boolean; output: { text: string }[] })({ id: "1", name: "mcp__x__y", arguments: {} } as never, { output: [{ type: "text", text: "page content" }] } as never, api, {} as never);
  assert.equal(res.isError, true);
  assert.ok(!JSON.stringify(res).includes("page content"), "the ingested content is withheld");
});

// ---- the attach_refs reader ----------------------------------------------------------------------------------------------------

test("RefReader: reads a file of the sender's own workspace through its read policy; escapes, a folder, a binary file and a sibling bot's workspace are refused", async () => {
  const dataDir = join(base, "data-refs");
  const notes = join(base, "notes-refs");
  mkdirSync(notes, { recursive: true });
  const config = parseConfig(
    {
      telegram: { allowedUserIds: [1] },
      model: { runner: "lmstudio", runners: { lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", modelId: "m", contextWindow: 8192, maxTokens: 512 } } },
      folders: { allow: [{ alias: "notes", path: notes }], deny: [] },
      paths: { programDataDir: join(base, "pd"), dataDir },
      mainUserProfile: join(base, "Users", "main"),
    },
    ENV,
  );
  const presets = [{ id: "lmstudio", kind: "local", runner: "lmstudio", modelId: "m", contextWindow: 8192, maxTokens: 512, label: "LM", privacy: "local", autoFallback: true }] as never;
  const resolved = parseBots({ bots: { main: bot({ tools: [...READ_ONLY_TOOLS] }), research: bot({ telegramTokenRef: "research", tools: [...READ_ONLY_TOOLS] }) }, presets }, { folderAllow: [{ alias: "notes", path: notes }], derivedPresets: [], defaultPreset: "lmstudio" });
  const reader = createRefReader({ config, bots: resolved.bots, presets: resolved.presets });
  const ws = botPaths(dataDir, "main", "bots").workspaceDir;
  mkdirSync(join(ws, "sub"), { recursive: true });
  writeFileSync(join(ws, "note.txt"), "hello from the workspace");
  writeFileSync(join(ws, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(ws, "big.txt"), "x".repeat(100));
  const other = botPaths(dataDir, "research", "bots").workspaceDir;
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "theirs.txt"), "research's file");

  const r = await reader.readWorkspaceFile("main", "note.txt", { maxBytes: 1000, cloudSafe: false });
  assert.deepEqual(r, { text: "hello from the workspace", truncated: false });
  const cut = await reader.readWorkspaceFile("main", "big.txt", { maxBytes: 10, cloudSafe: true });
  assert.deepEqual(cut, { text: "x".repeat(10), truncated: true });
  for (const rel of ["..\\..\\research\\workspace\\theirs.txt", "../note.txt", "sub", "bin.dat", "missing.txt"]) {
    await assert.rejects(reader.readWorkspaceFile("main", rel, { maxBytes: 1000, cloudSafe: false }), Error, rel);
  }
  await assert.rejects(reader.readWorkspaceFile("nobody", "note.txt", { maxBytes: 1000, cloudSafe: false }));
  // research reads ITS workspace, never main's
  assert.equal((await reader.readWorkspaceFile("research", "theirs.txt", { maxBytes: 100, cloudSafe: false })).text, "research's file");
  await assert.rejects(reader.readWorkspaceFile("research", "note.txt", { maxBytes: 100, cloudSafe: false }));
});

// ---- gate: dropHold --------------------------------------------------------------------------------------------------------------

test("LocalGate.dropHold: a peer on the same runner is not made to wait for the asking bot's stickiness hold, and another bot's hold is left alone", async () => {
  const clock = new FakeClock();
  const gate = new LocalGate({ settings: { maxQueueDepth: 8, stickinessSec: 15, agingSec: DEFAULT_GATE.agingSec, waitNoticeSec: 0 }, clock });
  const runner = gate.runner("lmstudio")!;
  const first = await runner.acquire({ bot: "asker", priority: 0, conversationId: "c1" });
  first.release({ continues: true }); // the call ended in tool use (ask_bot): the slot is held for the asker
  let granted = false;
  void runner.acquire({ bot: "peer", priority: 1, conversationId: "c2" }).then((l) => {
    granted = true;
    l.release();
  });
  await settle();
  assert.equal(granted, false, "held for the asker");
  gate.dropHold("someone-else");
  await settle();
  assert.equal(granted, false, "a different bot's hold is not touched");
  gate.dropHold("asker");
  await settle();
  assert.equal(granted, true, "the peer runs at once");
  void SEC;
});

// ---- the other two card kinds (S26.2) --------------------------------------------------------------------------------------------

test("a job card and a settings proposal card quote the peer input too, and without any it is the card as before", () => {
  const peer = [{ from: "research", hop: 1, text: "start the book job now" }];
  const job = {
    jobId: "j1",
    conversationId: "1",
    template: { id: "book", title: "Book", description: "", engine: "claude", params: {}, flow: { enabled: false }, paidModels: false, autostart: [], cloud: [], cwd: "C:\\x", enabled: true },
    params: {},
    brief: "write",
    cwd: "C:\\x",
    engine: "claude",
    cloud: [],
    paidModels: false,
    autostart: [],
    timeoutSec: 60,
    deadline: Date.now() + 60_000,
  } as unknown as JobApprovalCard;
  const withPeer = jobCardText(job, true, peer);
  assert.match(withPeer, /^Approve this job\?\n\nPeer input from bot research, hop 1: "start the book job now"\nThis came from another bot, not from you\./);
  assert.equal(jobCardText(job, true), jobCardText(job, true, []), "no provenance, the same card");
  assert.ok(!/Peer input/.test(jobCardText(job, true)));
  const proposal = { proposalId: "p1", kind: "setting", chatId: 1, title: "Settings change requested by the model", lines: ["style.tone"], reason: "r", deadline: Date.now() + 60_000, buttons: ["approve", "reject"] } as unknown as ProposalCard;
  assert.match(cardText(proposal, peer), /Peer input from bot research, hop 1: "start the book job now"/);
  assert.ok(!/Peer input/.test(cardText(proposal)));
});
