/**
 * S26.1 to S26.3 integration (offline, fakes only): the real startup sequence on a migrated fixture install with two bots (`main` and
 * `research`, an edge main -> research), each with its own Harness, SQLite file and fake Telegram API, over a fake local runner (and a
 * second fake standing in for the proxy). Live parts (the real Telegram, Strata, LM Studio and the real proxy) are the user's.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkBotRegistry, expectedAlwaysLoaded } from "../../src/bots/registry.js";
import { ALWAYS_LOADED } from "../../src/jobs/contracts.js";
import { PEER_FORBIDDEN_TOOLS } from "../../src/bots/schema.js";
import { BACKGROUND_CONTEXT } from "../../src/pi/adapter.js";
import { toConversationId } from "../../src/telegram/conversations.js";
import { runMain } from "../../src/main.js";
import { FakeShell, script } from "./phase4-script.js";
import { PEER_ALLOW, Phase4Rig, USER_ID, waitFor } from "./phase4-rig.js";
import type { Phase4RigOptions } from "./phase4-rig.js";

async function withRig(o: Partial<Phase4RigOptions>, fn: (rig: Phase4Rig, shell: FakeShell) => Promise<void>): Promise<void> {
  const shell = new FakeShell();
  const rig = await Phase4Rig.open({ behavior: script(), start: { shellRunner: shell }, ...o });
  try {
    await fn(rig, shell);
  } finally {
    await rig.close();
    rig.clean();
  }
}

test("S26.1: both bots start, each with its own bridge, Harness and SQLite file; main has a bus extension, research has none", async () => {
  await withRig({}, async (rig) => {
    const multi = rig.agent.multi;
    assert.ok(multi, "a bots block starts the multi-bot host");
    assert.deepEqual(multi.manager.running().sort(), ["main", "research"]);
    const main = multi.part("main")?.rt;
    const research = multi.part("research")?.rt;
    assert.ok(main && research);
    assert.notEqual(main.harness, research.harness);
    assert.notEqual(main.storagePath, research.storagePath);
    assert.ok(existsSync(main.storagePath) && existsSync(research.storagePath));
    assert.match(main.storagePath, /bots\\main\\state\\agent\.sqlite$/);
    assert.match(research.storagePath, /bots\\research\\state\\agent\.sqlite$/);
    // the AgentHandle's single-bot fields are main's
    assert.equal(rig.agent.harness, main.harness);
    assert.ok(multi.bus.hasEdges("main") && !multi.bus.hasEdges("research"));
  });
});

test("S26.1: user -> main -> research -> reply, through the router, the bus audit has the lines and no body, research's chat is silent", async () => {
  await withRig({}, async (rig) => {
    await rig.say("main", "please ask research about tea", 1);
    const answer = await rig.seen("main", (t) => t.startsWith("main got:"), "main's answer with the peer reply");
    assert.match(answer, /<peer_message from=\\+"research/);
    assert.match(answer, /research says tea is a drink/);
    const result = JSON.parse(answer.slice("main got: ".length)) as { budget_left: { tokens: number }; hop: number };
    assert.equal(result.hop, 1);
    assert.ok(result.budget_left.tokens < 60_000, "the peer turn reported its tokens to the chain budget");
    // research's own chat never saw the peer turn
    assert.equal(rig.tg("research").sentTexts().length, 0, "a peer turn is not delivered to the user's chat");
    // the peer turn arrived as a user-role data block from the authenticated identity
    const peerReq = rig.fake.chatRequests().find((r) => JSON.stringify(r.body?.messages).includes('<peer_message from=\\"main\\"'));
    assert.ok(peerReq, "research's model saw a <peer_message from=main> block");
    // the bus audit: ask and reply, same chain, origin peer, a body hash and no body
    const lines = rig.busAudit();
    const ask = lines.find((l) => l["type"] === "ask");
    const reply = lines.find((l) => l["type"] === "reply");
    assert.ok(ask && reply, "an ask line and a reply line");
    assert.equal(ask["from"], "main");
    assert.equal(ask["to"], "research");
    assert.equal(ask["origin"], "peer");
    assert.equal(reply["chain_id"], ask["chain_id"]);
    assert.match(String(ask["body_sha256"]), /^[0-9a-f]{64}$/);
    const raw = JSON.stringify(lines);
    assert.ok(!raw.includes("what is tea") && !raw.includes("tea is a drink"), "no body in the bus audit");
    // the peers section is in main's prompt (it has an edge) and not in research's
    const sysOf = (r: { body?: { messages: { role: string; content?: unknown }[] } }): string => JSON.stringify(r.body?.messages.find((m) => m.role === "system" || m.role === "developer")?.content ?? "");
    const mainReq = rig.fake.chatRequests().find((r) => /please ask research/.test(JSON.stringify(r.body?.messages)) && !/peer_message from/.test(JSON.stringify(r.body?.messages[1])));
    assert.ok(mainReq && sysOf(mainReq).includes("## Other bots"), "main's prompt carries the peers section");
    assert.ok(!sysOf(peerReq).includes("## Other bots"), "research's prompt has none (no edge)");
  });
});

test("S26.1: the whole-registry count per bot equals ALWAYS_LOADED intersected with the allowlist; the bus tools are registered and deferred only for main", async () => {
  await withRig({}, async (rig) => {
    const multi = rig.agent.multi;
    assert.ok(multi);
    for (const id of ["main", "research"]) {
      const p = multi.part(id);
      assert.ok(p?.rt);
      const rep = checkBotRegistry(p.rt.registry, p.spec, { guardExtension: "a7" });
      assert.ok(rep.ok, `${id}: ${JSON.stringify(rep)}`);
      assert.deepEqual([...rep.nonDeferred].sort(), expectedAlwaysLoaded(p.spec).sort(), `${id}: the non-deferred set is ALWAYS_LOADED within its allowlist`);
      assert.ok(rep.nonDeferred.length <= 10);
    }
    const main = multi.part("main")!;
    assert.deepEqual([...checkBotRegistry(main.rt!.registry, main.spec).nonDeferred].sort(), [...ALWAYS_LOADED].sort(), "main (a full allowlist) has exactly the 10 of I27");
    const names = (id: string): string[] => multi.part(id)!.rt!.registry.snapshot().tools().map((t) => t.tool.name);
    assert.ok(names("main").includes("ask_bot") && names("main").includes("list_bots"));
    assert.ok(!names("research").includes("ask_bot") && !names("research").includes("shell") && !names("research").includes("write_file"));
    const deferred = (id: string, n: string): unknown => (multi.part(id)!.rt!.registry.snapshot().tools().find((t) => t.tool.name === n)?.tool as { deferred?: boolean } | undefined)?.deferred;
    assert.equal(deferred("main", "ask_bot"), true);
    assert.equal(deferred("main", "list_bots"), true);
    // and the model is offered exactly the 10 on a real request (ask_bot is found with tool_search)
    await rig.say("main", "hello", 1);
    await rig.seen("main", (t) => t === "echo: hello", "main answers");
    const reqs = rig.fake.chatRequests();
    const offered = (reqs[reqs.length - 1]?.body?.tools ?? []).map((t) => t.function?.name ?? "");
    assert.deepEqual([...offered].sort(), [...ALWAYS_LOADED].sort());
  });
});

test("S26.1: a /new conversation in each bot is still gated: the guard hook survives, and main still asks before running a shell command", async () => {
  await withRig({}, async (rig, shell) => {
    for (const id of ["main", "research"]) {
      await rig.say(id, "hello there", 1);
      await rig.seen(id, (t) => t === "echo: hello there", `${id} answers`);
      await rig.say(id, "/new", 2);
      await rig.seen(id, (t) => /new conversation/i.test(t), `${id} starts a new conversation`);
      await rig.say(id, "hello again", 3);
      await rig.seen(id, (t) => t === "echo: hello again", `${id} answers in the new conversation`);
      const rt = rig.agent.multi!.part(id)!.rt!;
      const cid = rt.bridge.conversationOf(USER_ID);
      assert.ok(cid);
      const conv = await rt.harness.conversation(toConversationId(cid), BACKGROUND_CONTEXT);
      const agent = await conv!.agent(BACKGROUND_CONTEXT);
      const guard = agent.extensions.find((e) => e.name === "a7");
      assert.ok(guard && (guard.hooks ?? []).length >= 1, `${id}: the a7 guard hook is in the new conversation`);
    }
    await rig.say("main", "run whoami", 4);
    const card = await rig.card("main", 1);
    assert.match(card.text, /^Approve shell command\?/);
    assert.equal(shell.commands.length, 0, "nothing runs before the tap");
    assert.ok(!/Peer input/.test(card.text), "no peer input in a turn that received none");
    await rig.tap("main", card.approve);
    await rig.seen("main", (t) => t.startsWith("shell said:"), "the shell answer");
    assert.deepEqual(shell.commands, ["whoami"]);
  });
});

test("I36: a peer turn never gets shell, file write, dispatch_job, Flow or remember; a shell attempt from inside a peer turn runs nothing and raises no card", async () => {
  await withRig({}, async (rig, shell) => {
    await rig.say("main", "please ask evil", 1);
    await rig.seen("main", (t) => t.startsWith("main got:"), "main gets research's answer");
    const peerReqs = rig.fake.chatRequests().filter((r) => /<peer_message from=\\"main\\"/.test(JSON.stringify(r.body?.messages)));
    assert.ok(peerReqs.length >= 1);
    for (const r of peerReqs) {
      const offered = (r.body?.tools ?? []).map((t) => t.function?.name ?? "");
      for (const forbidden of [...PEER_FORBIDDEN_TOOLS, "shell", "write_file", "dispatch_job", "remember", "propose_setting", "switch_persona", "ask_bot", "list_bots"]) assert.ok(!offered.includes(forbidden), `a peer turn is not offered ${forbidden} (offered: ${offered.join(",")})`);
      assert.ok(offered.every((n) => PEER_ALLOW.includes(n) || n === "tool_search"), `only the edge's tools are offered: ${offered.join(",")}`);
    }
    // the shell tool is not even discoverable in a peer turn: tool_search finds nothing for it
    const searched = peerReqs.flatMap((r) => (r.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content)));
    assert.ok(searched.some((s) => /No matching tools found/.test(s)), "tool_search does not find the shell tool in a peer turn");
    assert.equal(shell.commands.length, 0, "no shell command ran");
    assert.equal(rig.cards("research").length + rig.cards("main").length, 0, "no approval card in any chat");
  });
});


test("S26.2: a card in a turn that received a peer reply quotes the peer text and says which bot and hop; a turn with none shows no such line", async () => {
  await withRig({}, async (rig, shell) => {
    await rig.say("main", "please chain whoami", 1);
    const card = await rig.card("main", 1);
    assert.match(card.text, /^Approve shell command\?/);
    assert.match(card.text, /Peer input from bot research, hop 1: "[^"]*research says tea is a drink/);
    assert.match(card.text, /This came from another bot, not from you/);
    assert.match(card.text, /\nwhoami\n/);
    assert.equal(rig.cards("research").length, 0, "cards never cross chats: research's chat has none");
    // a foreign user's tap and a tap in the OTHER bot's chat do nothing
    await rig.tap("main", card.approve, 999);
    await rig.tap("research", card.approve);
    assert.equal(shell.commands.length, 0, "neither a stranger nor another bot's chat can approve");
    // the user's own tap, in this bot's own chat, does
    await rig.tap("main", card.approve);
    await rig.seen("main", (t) => t.startsWith("shell said:"), "the shell ran after the user's own tap");
    assert.deepEqual(shell.commands, ["whoami"]);
    // a later user message starts a new chain: its card has no peer line
    await rig.say("main", "run whoami", 2);
    const second = await rig.card("main", 2);
    assert.ok(!/Peer input/.test(second.text));
  });
});

test("S26.2: the approval is completed only by the user's callback in that bot's own chat (the grant exists in one place)", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const root = join(process.cwd(), "src");
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && /approvals\.grant\(|tokens\.grant\(/.test(readFileSync(p, "utf8"))) hits.push(p.replace(/\\/g, "/").split("/src/")[1] ?? p);
    }
  };
  walk(root);
  assert.deepEqual(hits, ["approval/gate.ts"], "only the approval gate grants a token, after the transport's decision");
});

test("I36(3): in a tainted chain the shell tool is refused by the router before any approval card exists", async () => {
  let rigRef: Phase4Rig | undefined;
  const shell = new FakeShell();
  const rig = await Phase4Rig.open({
    behavior: script({
      onAfterListDir: () => {
        // the model has just read content from outside: the chain is tainted (what a web or MCP tool would do through the guard's afterTool)
        const multi = rigRef!.agent.multi!;
        const cid = multi.part("main")!.rt!.bridge.conversationOf(USER_ID)!;
        multi.bus.noteToolUse("main", cid, "mcp__hub__fetch_page");
      },
    }),
    start: { shellRunner: shell },
  });
  rigRef = rig;
  try {
    await rig.say("main", "taint then whoami", 1);
    const answer = await rig.seen("main", (t) => t.startsWith("shell said:"), "the blocked result");
    assert.match(answer, /Blocked by the bot router/);
    assert.equal(rig.cards("main").length, 0, "no approval card was ever produced");
    assert.equal(shell.commands.length, 0);
  } finally {
    await rig.close();
    rig.clean();
  }
});

test("S26.1: each user message starts its own chain; the audit and the bus see the chain id of the message that asked", async () => {
  await withRig({}, async (rig) => {
    await rig.say("main", "ask research once", 1);
    await rig.seen("main", (t) => t.startsWith("main got:"), "first answer");
    await rig.say("main", "ask research twice", 2);
    await waitFor(() => rig.texts("main").filter((t) => t.startsWith("main got:")).length >= 2, 20_000, "second answer");
    const asks = rig.busAudit().filter((l) => l["type"] === "ask");
    assert.equal(asks.length, 2);
    assert.notEqual(asks[0]?.["chain_id"], asks[1]?.["chain_id"], "two user messages, two chains");
  });
});

test("S26.3: /status in each bot shows the bots, the route and active preset, the local gate, the bot links and the room", async () => {
  await withRig({}, async (rig) => {
    await rig.say("main", "/status", 1);
    const text = await rig.seen("main", (t) => /^agent-007 status/m.test(t) || /Bots: main running/.test(t), "main's /status");
    assert.match(text, /Bots: main running, research running/);
    assert.match(text, /Route: primary LM Studio, active LM Studio, allowed LM Studio/);
    assert.match(text, /Local gate lmstudio: \d+ running, \d+ waiting/);
    assert.match(text, /Local bots by runner: lmstudio 2/);
    assert.match(text, /Bot links: research; asks today 0/);
    assert.match(text, /Bot room: off/);
    await rig.say("research", "/status", 1);
    const r = await rig.seen("research", (t) => /Bots: main running/.test(t), "research's /status");
    assert.ok(!/Bot links/.test(r), "research has no edge, so no link line");
  });
});

test("S26.1: an edge breaker trip is refused with one typed error, noted in the bus audit, and the user gets ONE notice in the chat of the bot whose chain tripped it", async () => {
  await withRig({ security: { botBus: { edgeMinGapSec: 0, breakerAsks: 2, breakerWindowMin: 10 } } }, async (rig) => {
    for (const n of [1, 2, 3, 4]) {
      await rig.say("main", `please ask research round ${n}`, n);
      await waitFor(() => rig.texts("main").filter((t) => t.startsWith("main got:")).length >= n, 20_000, `answer ${n}`);
    }
    const answers = rig.texts("main").filter((t) => t.startsWith("main got:"));
    assert.ok(!/refused/.test(answers[0] ?? "") && !/refused/.test(answers[1] ?? ""), "the first two asks went through");
    assert.match(answers[2] ?? "", /ask_bot refused: budget_exhausted \(edge_paused\)/);
    assert.match(answers[3] ?? "", /ask_bot refused: budget_exhausted \(edge_paused\)/);
    const notices = rig.texts("main").filter((t) => /asked each other too often/.test(t));
    assert.equal(notices.length, 1, "ONE notice to the user, however many asks were refused");
    const notes = rig.busAudit().filter((l) => l["type"] === "note" && l["event"] === "breaker");
    assert.equal(notes.length, 1, "one breaker note in the bus audit");
    assert.match(rig.agent.multi!.bus.edgeStatus().map((e) => `${e.from}>${e.to}:${e.pausedUntil !== undefined}`).join(), /main>research:true/);
    await rig.say("main", "/status", 9);
    const s = await rig.seen("main", (t) => /Link main to research is PAUSED/.test(t), "the status shows the paused link");
    assert.match(s, /Bot links: research; asks today 2/);
  });
});

test("main.ts: runMain starts the multi-bot host, says which bots run, and a graceful shutdown stops every bot", async () => {
  await withRig({}, async (rig) => {
    await rig.agent.stop();
    const listeners = new Map<string, (...a: unknown[]) => void>();
    const proc = { on: (e: string, l: (...a: unknown[]) => void) => void listeners.set(e, l), off: () => undefined };
    const out: string[] = [];
    const done = runMain({ configPath: rig.dirs.configPath, secretsPath: rig.dirs.secretsPath, telegram: true, checkAcl: false }, { proc, out: (l) => void out.push(l), err: (l) => void out.push(l), start: rig.startOptions() });
    await waitFor(() => out.some((l) => l.startsWith("agent-007 started")), 20_000, "the started line");
    assert.match(out.find((l) => l.startsWith("agent-007 started")) ?? "", /bots main\+research\)$/);
    listeners.get("message")?.({ type: "shutdown" });
    assert.equal(await done, 0);
    assert.ok(out.includes("agent-007 stopped"));
  });
});
