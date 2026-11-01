/**
 * S26.1 / S26.3 integration, models and proxy (offline, fakes only): a bot whose brain is the proxy (a second fake server standing in
 * for it), the proxy limiter and the local gate in front of the provider calls, the fallback engine on a proxy auth failure, `/model`
 * wired to the settings proposal flow, the room mirror over a fake Telegram API, and the peer conversation across a restart.
 * The real proxy, Strata, LM Studio and Telegram are never contacted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { peerConvDoc } from "../../src/agent/peerRuntime.js";
import { BACKGROUND_CONTEXT } from "../../src/pi/adapter.js";
import type { FetchLike } from "../../src/proxy/health.js";
import type { Behavior } from "../helpers/fakeOpenAi.js";
import { HEALTH_BODY, violations } from "../proxy/helpers.js";
import { script } from "./phase4-script.js";
import { PROXY_KEY, Phase4Rig, USER_ID, waitFor } from "./phase4-rig.js";
import type { Phase4RigOptions } from "./phase4-rig.js";
import { callbackUpdate } from "../telegram/helpers/fakeTelegram.js";

const resp = (status: number, body: unknown): Awaited<ReturnType<FetchLike>> => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const proxyFetch: FetchLike = async (url) => {
  const path = new URL(url).pathname;
  if (path === "/healthz") return resp(200, HEALTH_BODY);
  if (path === "/v1/models") return resp(200, { object: "list", data: [{ id: "codex/gpt-x", object: "model" }] });
  return resp(404, { error: { message: "not found" } });
};

/** research runs on the proxy (Codex) with a local fallback; main stays local and may ask research. */
const CODEX_ROUTE = { primary: "codex", allowed: ["codex", "lmstudio"], fallback: ["lmstudio"], onAuthRequired: "fallback" };

async function withRig(o: Partial<Phase4RigOptions> & { behavior?: Behavior }, fn: (rig: Phase4Rig) => Promise<void>): Promise<void> {
  const rig = await Phase4Rig.open({ behavior: script(), proxyFetch, bots: { research: { route: CODEX_ROUTE } }, ...o });
  try {
    await fn(rig);
  } finally {
    await rig.close();
    rig.clean();
  }
}

test("S26.1: a bot whose brain is the proxy answers through the limiter with the key as a bearer header only, no sampling field, and the key is in no log or audit", async () => {
  await withRig({ proxyBehavior: ({ lastUser }) => ({ type: "text", text: `codex says: ${lastUser}` }) }, async (rig) => {
    await rig.say("research", "hello codex", 1);
    await rig.seen("research", (t) => t === "codex says: hello codex", "the proxy's answer in research's chat");
    const proxy = rig.proxyFake!;
    const chats = proxy.chatRequests();
    assert.ok(chats.length >= 1);
    assert.ok(chats.every((r) => r.authorization === `Bearer ${PROXY_KEY}`), "the key goes in the Authorization header");
    assert.deepEqual(violations(proxy.requests), [], "only the three allowed URLs, no sampling parameter");
    assert.equal(rig.fake.chatRequests().filter((r) => /hello codex/.test(JSON.stringify(r.body))).length, 0, "the local runner never saw the proxy bot's turn");
    await rig.agent.multi!.part("research")!.rt!.bridge.delivery()!.idle();
    assert.ok(!rig.allOutputText().includes(PROXY_KEY), "the proxy key appears in no log, audit or bus audit file");
    assert.ok(!rig.tg("research").sentTexts().some((t) => t.includes(PROXY_KEY)) && !rig.tg("main").sentTexts().some((t) => t.includes(PROXY_KEY)), "nor in any chat");
    // /status: the route, the proxy's /healthz numbers, the limiter, and no "needs login"
    await rig.say("research", "/status", 2);
    const s = await rig.seen("research", (t) => /Proxy: up/.test(t), "research's /status");
    assert.match(s, /Route: primary Codex, active Codex, allowed Codex, LM Studio, fallback LM Studio/);
    assert.match(s, /Proxy: up \(codex active 1, queued 0; claude active 0, queued 2\)/);
    assert.match(s, /Proxy limiter acp-codex: \d of 3 running, \d queued/);
    assert.ok(!/needs a login/.test(s));
  });
});

test("S26.1: priority hints are in force for the whole turn: P0 for the user's own message, P1 for a peer turn in a chain the user started, none after", async () => {
  const base = script({ delayMs: 400 });
  const slow: Behavior = (i) => {
    const r = base(i);
    return r.type === "text" ? { ...r, firstDelayMs: 400 } : r;
  };
  await withRig({ behavior: slow, bots: { research: {} } }, async (rig) => {
    const hints = rig.agent.multi!.hints;
    assert.equal(hints.activeTurns("main"), 0);
    await rig.say("main", "hello there", 1);
    await waitFor(() => hints.activeTurns("main") === 1, 5000, "the turn's hint");
    assert.equal(hints.resolve("main").priority, 0, "the user's own turn is P0");
    await rig.seen("main", (t) => t === "echo: hello there", "the answer");
    await waitFor(() => hints.activeTurns("main") === 0, 5000, "the hint ends with the turn");
    // a peer turn inside a chain the user started runs as P1 on the receiving bot
    const seen: number[] = [];
    const timer = setInterval(() => {
      if (hints.activeTurns("research") > 0) seen.push(hints.resolve("research").priority);
    }, 20);
    try {
      await rig.say("main", "please ask research", 2);
      await rig.seen("main", (t) => t.startsWith("main got:") || /research says/.test(t), "the peer answer reaches main", 30_000);
    } finally {
      clearInterval(timer);
    }
    assert.ok(seen.length > 0 && seen.every((p) => p === 1), `the peer turn ran at P1: ${seen.join(",")}`);
  });
});

test("S26.1 / I39: a proxy auth failure falls back to the local preset with ONE notice, a second failure says nothing new, and nothing else is called", async () => {
  let proxyCalls = 0;
  await withRig(
    {
      proxyBehavior: () => {
        proxyCalls++;
        return { type: "error", status: 503, body: { error: { message: "login required", code: "provider_auth_required" } } };
      },
    },
    async (rig) => {
      await rig.say("research", "hello codex", 1);
      const notice = await rig.seen("research", (t) => /needs a login on the main account/.test(t), "the one notice");
      assert.match(notice, /Using LM Studio for now/);
      assert.equal(proxyCalls, 1, "a non-retryable failure is not retried");
      // the next message runs on the fallback preset (the local runner); no second notice
      await rig.say("research", "hello again", 2);
      await rig.seen("research", (t) => t === "echo: hello again", "answered by the local fallback");
      assert.equal(rig.texts("research").filter((t) => /needs a login/.test(t)).length, 1, "ONE notice per outage");
      assert.equal(proxyCalls, 1, "the proxy is not asked again while the fallback is active");
      await rig.say("research", "/status", 3);
      const s = await rig.seen("research", (t) => /needs login: codex/.test(t) || /needs a login on the main account/.test(t) && /Route:/.test(t), "status shows the flag");
      assert.match(s, /model: LM Studio \(fallback: auth_required\)/);
      assert.match(s, /needs login: codex/);
      assert.ok(!rig.allOutputText().includes(PROXY_KEY));
    },
  );
});

test("S22 wired: /model lists the allowed presets; local -> cloud produces exactly ONE card, the model changes only after Approve, and the next turn goes to the proxy", async () => {
  await withRig(
    { proxyBehavior: ({ lastUser }) => ({ type: "text", text: `codex says: ${lastUser}` }), bots: { research: { route: { primary: "lmstudio", allowed: ["lmstudio", "codex"], fallback: [], onAuthRequired: "ask" } } } },
    async (rig) => {
      await rig.say("research", "/model", 1);
      const picker = await rig.seen("research", (t) => /Model now: LM Studio/.test(t), "the picker");
      assert.match(picker, /Codex \[cloud, codex\] \(asks you first\)/);
      await rig.tg("research").bot.handleUpdate(callbackUpdate(USER_ID, "md:s:codex") as never);
      await waitFor(() => rig.cards("research").some((c) => /^st:/.test(c.approve)), 10_000, "the proposal card");
      const cards = rig.cards("research").filter((c) => /^st:/.test(c.approve));
      assert.equal(cards.length, 1, "exactly one card");
      // nothing changed yet: the next message still goes to the local runner
      await rig.say("research", "before approve", 2);
      await rig.seen("research", (t) => t === "echo: before approve", "still local");
      await rig.tap("research", cards[0]!.approve);
      await rig.say("research", "after approve", 3);
      await rig.seen("research", (t) => t === "codex says: after approve", "the proxy answers after the approval");
      assert.equal(rig.cards("research").filter((c) => /^st:/.test(c.approve)).length, 1, "still exactly one card");
    },
  );
});

test("S26.1: the room mirror shows the ask and the reply of a chain (text only, no taint or approval), and only ever uses sendMessage", async () => {
  const posts: { chatId: number; text: string }[] = [];
  const calls: string[] = [];
  const api = {
    sendMessage: async (chatId: number, text: string): Promise<unknown> => {
      calls.push("sendMessage");
      posts.push({ chatId, text });
      return { message_id: posts.length };
    },
  };
  await withRig({ bots: { research: {} }, security: { botRoom: { mode: "truncated", maxChars: 300, maxPerMinute: 15, chatId: -100123 } }, mirrorApi: api }, async (rig) => {
    assert.ok(rig.agent.multi!.mirror, "the mirror started (mode, chat and token are set)");
    await rig.say("main", "please ask research", 1);
    await rig.seen("main", (t) => t.startsWith("main got:"), "the peer answer");
    await waitFor(() => posts.length >= 1 && /research says tea is a drink/.test(posts.map((p) => p.text).join("\n")), 15_000, "the room posts");
    const all = posts.map((p) => p.text).join("\n");
    assert.match(all, /\[main → research, hop 1, chain [0-9a-f]{8}] what is tea\?/);
    assert.match(all, /\[research → main, hop 1, chain [0-9a-f]{8}] research says tea is a drink/);
    assert.ok(posts.every((p) => p.chatId === -100123));
    assert.ok(!/taint|approv/i.test(all), "no taint flag or approval text in the room");
    assert.ok(calls.every((c) => c === "sendMessage"), "the mirror only posts");
    await rig.say("main", "/status", 2);
    const s = await rig.seen("main", (t) => /Bot room: on/.test(t), "status shows the room");
    assert.match(s, /Bot room: on \(\d+ posts, 0 dropped\)/);
  });
});

test("S26.1 / U59 (offline): after a restart the same sender gets the SAME peer conversation, and the chain store keeps its records", async () => {
  await withRig({ bots: { research: {} } }, async (rig) => {
    await rig.say("main", "please ask research", 1);
    await rig.seen("main", (t) => t.startsWith("main got:"), "first peer answer");
    const before = await rig.agent.multi!.part("research")!.rt!.harness.snapshot(peerConvDoc, BACKGROUND_CONTEXT);
    assert.ok(before?.convs["peer:main"], "a peer conversation exists for the sender main");
    await rig.agent.stop();
    await rig.start();
    const after = await rig.agent.multi!.part("research")!.rt!.harness.snapshot(peerConvDoc, BACKGROUND_CONTEXT);
    assert.equal(after?.convs["peer:main"], before?.convs["peer:main"], "the same conversation after the restart");
    await rig.say("main", "please ask research again", 2);
    await waitFor(() => rig.texts("main").filter((t) => t.startsWith("main got:")).length >= 1, 20_000, "an answer after the restart");
    const again = await rig.agent.multi!.part("research")!.rt!.harness.snapshot(peerConvDoc, BACKGROUND_CONTEXT);
    assert.equal(Object.keys(again?.convs ?? {}).length, 1, "still one peer conversation for one sender");
  });
});

test("S23.1 wired: a preset the proxy does not list at start-up is refused as a switch target and shown in /status; the bot itself still starts", async () => {
  const noCodex: FetchLike = async (url) => (new URL(url).pathname === "/v1/models" ? resp(200, { object: "list", data: [{ id: "claude/sonnet", object: "model" }] }) : proxyFetch(url));
  await withRig(
    { proxyFetch: noCodex, proxyBehavior: () => ({ type: "text", text: "never asked" }), bots: { research: { route: { primary: "lmstudio", allowed: ["lmstudio", "codex"], fallback: [], onAuthRequired: "ask" } } } },
    async (rig) => {
      assert.deepEqual(rig.agent.multi!.manager.running().sort(), ["main", "research"]);
      await rig.say("research", "/model codex", 1);
      await rig.seen("research", (t) => /Codex is not answering right now, so nothing was changed/.test(t), "the refusal");
      assert.equal(rig.cards("research").length, 0, "no card for a model the proxy does not have");
      await rig.say("research", "/status", 2);
      await rig.seen("research", (t) => /Not listed by the proxy at start-up: codex/.test(t), "status names it");
      assert.equal(rig.proxyFake!.chatRequests().length, 0, "the proxy was never asked to generate");
    },
  );
});

test("S22 wired: a persona change keeps the model the bot is on now (the switcher's live reference is the persona applier's base model)", async () => {
  const lm2 = { id: "lm2", kind: "local", runner: "lmstudio", label: "LM Studio 2", modelId: "other-model", contextWindow: 8192, maxTokens: 512, privacy: "local", autoFallback: true };
  await withRig({ presets: [lm2], bots: { research: { route: { primary: "lmstudio", allowed: ["lmstudio", "lm2"], fallback: [], onAuthRequired: "ask" } } } }, async (rig) => {
    const modelOfLast = (): string | undefined => rig.fake.chatRequests().at(-1)?.body?.model;
    await rig.say("research", "hello", 1);
    await rig.seen("research", (t) => t === "echo: hello", "first answer");
    assert.equal(modelOfLast(), "fake-model");
    await rig.say("research", "/model lm2", 2);
    await rig.seen("research", (t) => /Now using LM Studio 2/.test(t), "the switch applied at once (local to local)");
    await rig.say("research", "second", 3);
    await rig.seen("research", (t) => t === "echo: second", "answered on the new model");
    assert.equal(modelOfLast(), "other-model");
    // a persona change reapplies the base model: it must be the CURRENT one, not the route's primary
    await rig.tg("research").bot.handleUpdate(callbackUpdate(USER_ID, "pe:s:readonly") as never);
    await waitFor(() => rig.texts("research").some((t) => /readonly/i.test(t) && /persona/i.test(t)), 10_000, "the persona applied").catch(() => undefined);
    await rig.say("research", "third", 4);
    await rig.seen("research", (t) => t === "echo: third", "answered after the persona change");
    assert.equal(modelOfLast(), "other-model", "the persona change did not reset the model to the primary");
  });
});

test("S25 wired: two local bots share one runner slot; the second bot's P0 turn waits and its OWN chat gets the 'waiting for the model' notice (the lookup is late, by bot id)", async () => {
  const slowEcho: Behavior = (i) => {
    const r = script()(i);
    return r.type === "text" && !/<peer_message/.test(i.lastUser) ? { ...r, firstDelayMs: /slow/.test(i.lastUser) ? 2500 : 0 } : r;
  };
  await withRig({ behavior: slowEcho, bots: { research: {} }, security: { gate: { waitNoticeSec: 1 } } }, async (rig) => {
    await rig.say("main", "slow please", 1);
    await waitFor(() => rig.agent.multi!.gate.status().runners.some((r) => r.running.some((x) => x.bot === "main")), 10_000, "main holds the slot");
    await rig.say("research", "quick one", 1);
    const notice = await rig.seen("research", (t) => /waiting for the model/i.test(t), "research's wait notice", 15_000);
    assert.match(notice, /waiting for the model/i);
    assert.ok(!rig.texts("main").some((t) => /waiting for the model/i.test(t)), "main, who holds the slot, got no notice");
    await rig.seen("research", (t) => t === "echo: quick one", "research is answered after main's turn");
    await rig.seen("main", (t) => t === "echo: slow please", "and main's own answer");
  });
});
