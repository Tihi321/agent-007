/**
 * One multi-bot eval run (S27.1): the Phase 4 rig (the REAL startup sequence, the real bus and router, per-bot Harness and SQLite, a fake
 * Telegram API per bot) with `main`, `research`, `ops` and, when the case needs it, a cloud bot `cloudy`. Every approval card is DENIED
 * the moment it appears (nothing ever runs; a card is a recorded, blocked attempt). `collectWorld` reads what happened.
 *
 * Nothing here contacts Telegram, a real model (unless the LIVE gateway is on), the real proxy, Strata, LM Studio or a claude/dsh binary.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { viewTranscript } from "../bakeoff/run.js";
import type { EntryRecord } from "../../src/pi/adapter.js";
import { BACKGROUND_CONTEXT } from "../../src/pi/adapter.js";
import { toConversationId } from "../../src/telegram/conversations.js";
import type { Behavior, ChatRequest, FakeServer } from "../../test/helpers/fakeOpenAi.js";
import { HEALTH_BODY } from "../../test/proxy/helpers.js";
import type { FetchLike } from "../../src/proxy/health.js";
import { PEER_ALLOW, PROXY_KEY, Phase4Rig, USER_ID } from "../../test/integration/phase4-rig.js";
import type { Phase4RigOptions } from "../../test/integration/phase4-rig.js";
import { FakeShell } from "../../test/integration/phase4-script.js";
import { startFakeOpenAi, textOf } from "../../test/helpers/fakeOpenAi.js";
import { createRedactor, redactDeep } from "../../src/logging/redact.js";
import { verdictOf } from "./cases.js";
import type { LeakSurface, MultiCase, MultiWorld, ToolCallView } from "./cases.js";
import { forcedAskBehavior, isPeerTurn, peerBehavior, startGateway, startPeerFake, stubBehavior } from "./model.js";
import type { Gateway, LiveTarget, MainHooks } from "./model.js";
import type { MultiRecord } from "./score.js";

export interface RunOptions {
  mode: "stub" | "live";
  /** Live only: the real runner the gateway forwards `main`'s requests to. */
  live?: LiveTarget & { contextWindow: number; maxTokens: number; streamTimeoutMs?: number | undefined };
  timeoutMs: number;
  /** How long nothing may happen before a run with an answer counts as finished. */
  settleMs: number;
  /** Tests: a different stub model (for example a naive one that obeys injected instructions). */
  behaviorFor?: (c: MultiCase, hooks: MainHooks) => Behavior;
}

const REFUSED = /refused|Blocked|denied|not approved|did not approve|No matching tools|unknown tool|not found/i;
const DEFAULT_TOOLS = ["tool_search", "system_facts", "list_dir", "read_file", "search_files", "ask_user"];
const resp = (status: number, body: unknown): Awaited<ReturnType<FetchLike>> => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const proxyFetch: FetchLike = async (url) => {
  const path = new URL(url).pathname;
  if (path === "/healthz") return resp(200, HEALTH_BODY);
  if (path === "/v1/models") return resp(200, { object: "list", data: [{ id: "codex/gpt-x", object: "model" }] });
  return resp(404, { error: { message: "not found" } });
};

/** The rig options a case's `setup` asks for (the model behaviour and the runner are added by the caller). */
export function rigOptionsFor(c: MultiCase): Pick<Phase4RigOptions, "bots" | "main" | "security" | "secrets"> & { cloud: boolean } {
  const s = c.setup;
  const cloud = s.cloud === true;
  const others = ["research", "ops", ...(cloud ? ["cloudy"] : [])];
  const askTools = ["ask_bot", "list_bots"];
  const researchCanAsk = (s.researchAsks?.length ?? 0) > 0 || s.researchAsksMain === true;
  const edge = (to: string): Record<string, unknown> => ({ to, allow: to === "research" && researchCanAsk ? [...PEER_ALLOW, ...askTools] : [...PEER_ALLOW], egress: false });
  const bots: Record<string, Record<string, unknown>> = {
    research: researchCanAsk
      ? { tools: [...DEFAULT_TOOLS, ...askTools], edges: [...(s.researchAsks ?? []).map((to) => ({ to, allow: [...PEER_ALLOW], egress: false })), ...(s.researchAsksMain ? [{ to: "main", allow: [...PEER_ALLOW], egress: false }] : [])] }
      : {},
    ops: {},
  };
  if (cloud) bots["cloudy"] = { route: { primary: "codex", allowed: ["codex"], fallback: [], onAuthRequired: s.cloudyOnAuthRequired ?? "fallback" } };
  const botBus = { edgeMinGapSec: 0, ...(s.botBus ?? {}) };
  return {
    bots,
    main: { edges: (s.mainEdges ?? others).filter((to) => others.includes(to)).map(edge) },
    security: { botBus, ...(s.botRoom ? { botRoom: { mode: "truncated", maxChars: 300, maxPerMinute: 15, chatId: -100123 } } : {}) },
    secrets: { botTokens: { research: "222222:RESEARCH-test-token-bbbbbbbbbbbbbbbbbbbbbb", ops: "333333:OPS-test-token-cccccccccccccccccccccccccc", cloudy: "444444:CLOUDY-test-token-dddddddddddddddddddddd" }, proxyApiKey: PROXY_KEY },
    cloud,
  };
}

function walkText(dir: string, out: string[], skip: Set<string>): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    try {
      if (statSync(p).isDirectory()) walkText(p, out, skip);
      else if (!skip.has(p) && statSync(p).size < 2_000_000) out.push(readFileSync(p, "utf8"));
    } catch {
      /* unreadable: skip */
    }
  }
}

/** Files a peer could have caused to be written: every bot's memory, workspace, skills and prefs folder, and the shared folder. */
function writableFilesText(rig: Phase4Rig, skip: Set<string>): string {
  const out: string[] = [];
  const botsDir = join(rig.dirs.data, "bots");
  let ids: string[] = [];
  try {
    ids = readdirSync(botsDir);
  } catch {
    /* none */
  }
  for (const id of ids) for (const sub of ["memory", "workspace", "skills", "prefs"]) walkText(join(botsDir, id, sub), out, skip);
  walkText(join(rig.dirs.programData, "shared"), out, skip);
  return out.join("\n");
}

async function transcriptOf(rig: Phase4Rig): Promise<{ calls: ToolCallView[]; finalText: string }> {
  const multi = rig.agent.multi;
  const rt = multi?.part("main")?.rt;
  const cid = rt?.bridge.conversationOf(USER_ID);
  if (!rt || !cid) return { calls: [], finalText: "" };
  const conv = await rt.harness.conversation(toConversationId(cid), BACKGROUND_CONTEXT);
  if (!conv) return { calls: [], finalText: "" };
  const entries: EntryRecord[] = [];
  let cursor: Awaited<ReturnType<typeof conv.entries>>["next"];
  for (let k = 0; k < 50; k++) {
    const page = await conv.entries({ order: "ascending" }, 200, cursor, BACKGROUND_CONTEXT);
    entries.push(...(page.items as EntryRecord[]));
    if (!page.next) break;
    cursor = page.next;
  }
  const view = viewTranscript(entries);
  return {
    finalText: view.finalText,
    calls: view.calls.map((x) => ({ name: x.name, args: x.args, resultText: x.resultText, refused: x.isError && REFUSED.test(x.resultText) })),
  };
}

export async function runCaseOnce(c: MultiCase, run: number, o: RunOptions): Promise<{ record: MultiRecord; world: MultiWorld }> {
  const t0 = Date.now();
  const shell = new FakeShell();
  let rigRef: Phase4Rig | undefined;
  let tainted = false;
  const hooks: MainHooks = {
    onMainAfterTool: () => {
      if (!c.setup.taintMain || tainted || !rigRef) return;
      tainted = true;
      // what a web or MCP tool does through the guard: the user chain is marked tainted (as in the S26 wiring test)
      const multi = rigRef.agent.multi;
      const cid = multi?.part("main")?.rt?.bridge.conversationOf(USER_ID);
      if (multi && cid) multi.bus.noteToolUse("main", cid, "mcp__hub__fetch_page");
    },
  };
  const mirror = { calls: [] as string[], texts: [] as string[] };
  const mirrorApi = new Proxy({}, {
    get: (_t, key) => key === "then" || typeof key === "symbol" ? undefined : async (...args: unknown[]) => {
      mirror.calls.push(String(key));
      if (key === "sendMessage") mirror.texts.push(String(args[1] ?? ""));
      return {};
    },
  }) as NonNullable<Phase4RigOptions["mirrorApi"]>;

  const opts = rigOptionsFor(c);
  let gateway: Gateway | undefined;
  let peerFake: FakeServer | undefined;
  let forcer: FakeServer | undefined;
  let rig: Phase4Rig | undefined;
  let status: MultiWorld["status"] = "done";
  let reason = "";
  try {
    const behavior: Behavior = o.mode === "stub" ? (o.behaviorFor ?? stubBehavior)(c, hooks) : peerBehavior(c);
    let runner: Phase4RigOptions["runner"];
    if (o.mode === "live") {
      if (!o.live) throw new Error("live mode needs a runner");
      peerFake = await startPeerFake(c);
      if (c.forceAsk) forcer = await startFakeOpenAi({ behavior: forcedAskBehavior(c), modelId: "forced-ask" });
      gateway = await startGateway(o.live, peerFake, hooks, forcer);
      // the bots only need A token for the loopback gateway (the real runner's key stays inside the gateway)
      runner = { baseUrl: gateway.baseUrl, apiKey: "gateway-local-token", modelId: o.live.modelId, contextWindow: o.live.contextWindow, maxTokens: o.live.maxTokens, ...(o.live.streamTimeoutMs ? { streamTimeoutMs: o.live.streamTimeoutMs } : {}) };
    }
    const proxyBehavior: Behavior | undefined = opts.cloud ? (c.setup.proxyReply ? () => c.setup.proxyReply! : peerBehavior(c)) : undefined;
    rig = await Phase4Rig.open({
      behavior,
      start: { shellRunner: shell },
      bots: opts.bots,
      main: opts.main,
      security: opts.security,
      secrets: opts.secrets,
      ...(proxyBehavior ? { proxyBehavior, proxyFetch } : {}),
      ...(c.setup.botRoom ? { mirrorApi } : {}),
      ...(runner ? { runner } : {}),
    });
    rigRef = rig;
    const skip = new Set<string>();
    for (const l of c.leaks ?? []) {
      if (!l.seed) continue;
      const p = l.seed.file.startsWith("pd:") ? join(rig.dirs.programData, l.seed.file.slice(3)) : join(rig.dirs.data, l.seed.file);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, l.seed.content);
      skip.add(p);
    }
    const prefsFile = join(rig.dirs.data, "bots", "main", "prefs", "prefs.json");
    const readPrefs = (): string => {
      try {
        return readFileSync(prefsFile, "utf8");
      } catch {
        return "";
      }
    };
    const prefsBefore = readPrefs();
    const reqCount = (): number => (gateway ? gateway.requests.length : rig!.fake.chatRequests().length);
    const inFlight = (): number => gateway?.inFlight() ?? 0;

    await rig.say("main", c.prompt, 1);
    // drive the run: deny every approval card at once, finish when main has answered and nothing has happened for a while
    const denied = new Set<string>();
    const cards: { bot: string; text: string }[] = [];
    const cardTexts = new Set<string>();
    const ids = [...rig.tgs.keys()];
    const deadline = Date.now() + o.timeoutMs;
    let lastReq = -1;
    let lastChange = Date.now();
    for (;;) {
      for (const bot of ids) {
        for (const card of rig.cards(bot)) {
          cardTexts.add(card.text);
          if (denied.has(card.approve)) continue;
          denied.add(card.approve);
          cards.push({ bot, text: card.text });
          await rig.tap(bot, card.deny);
        }
      }
      const n = reqCount() + (rig.proxyFake?.chatRequests().length ?? 0);
      if (n !== lastReq) {
        lastReq = n;
        lastChange = Date.now();
      }
      const answeredNow = rig.texts("main").some((t) => !cardTexts.has(t));
      if (answeredNow && inFlight() === 0 && Date.now() - lastChange >= o.settleMs) break;
      if (Date.now() > deadline) {
        status = "timeout";
        reason = `no answer within ${o.timeoutMs} ms`;
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    await rig.agent.multi?.part("main")?.rt?.bridge.delivery()?.idle().catch(() => undefined);
    // the room mirror posts a moment after the bus message
    if (c.setup.botRoom) for (let k = 0; k < 60 && !mirror.texts.some((t) => t.includes("ROOMINJECT")); k++) await new Promise((r) => setTimeout(r, 50));

    // ---- collect ----
    const bodies: ChatRequest[] = gateway ? gateway.requests : rig.fake.chatRequests().flatMap((r) => (r.body ? [r.body] : []));
    const transcript = await transcriptOf(rig);
    const audit = rig.busAudit();
    const allTexts = ids.flatMap((id) => rig!.texts(id));
    const surfaces: Record<LeakSurface, () => string> = {
      files: () => writableFilesText(rig!, skip),
      requests: () => JSON.stringify(bodies.map((b) => b.messages)),
      texts: () => allTexts.join("\n"),
      logs: () => rig!.allOutputText(),
      proxy: () => JSON.stringify((rig!.proxyFake?.requests ?? []).map((r) => r.body ?? {})),
    };
    const memo = new Map<LeakSurface, string>();
    const surfaceText = (s: LeakSurface): string => {
      if (!memo.has(s)) memo.set(s, surfaces[s]());
      return memo.get(s) as string;
    };
    const leaks: MultiWorld["leaks"] = [];
    for (const l of c.leaks ?? []) for (const s of l.surfaces) if (surfaceText(s).includes(l.marker)) leaks.push({ marker: l.marker, surface: s });
    const peerBlocked = bodies
      .filter((b) => isPeerTurn(textOf([...(b.messages ?? [])].reverse().find((m) => m.role === "user")?.content)))
      .flatMap((b) => (b.messages ?? []).filter((m) => m.role === "tool").map((m) => textOf(m.content)))
      .filter((t) => /not found|unknown tool|not available|refused|No matching tools|Blocked/i.test(t))
      .map((t) => t.replace(/\s+/g, " ").slice(0, 100));
    const world: MultiWorld = {
      status,
      reason,
      finalText: rig.texts("main").filter((t) => !cardTexts.has(t)).join("\n") || transcript.finalText,
      calls: transcript.calls,
      asks: audit.filter((l) => l["type"] === "ask").map((l) => ({ from: String(l["from"]), to: String(l["to"]), hop: Number(l["hop"]), taint: l["taint"] === true })),
      denials: audit.filter((l) => l["type"] === "denied" || l["type"] === "failed").map((l) => `${String(l["from"])}>${String(l["to"])} ${String(l["reason"] ?? "")}`),
      shellCommands: [...shell.commands],
      cards,
      tainted,
      leaks,
      mirrorCalls: mirror.calls,
      mirrorTexts: mirror.texts,
      prefsChanged: readPrefs() !== prefsBefore,
      proxyChatRequests: rig.proxyFake?.chatRequests().length ?? 0,
      loginNotices: allTexts.filter((t) => /needs a login on the main account/.test(t)).length,
      peerBlocked,
    };
    return finish(c, run, world, Date.now() - t0, redactorFor(o));
  } catch (e) {
    status = "error";
    reason = e instanceof Error ? e.message : String(e);
    return finish(c, run, emptyWorld(status, reason), Date.now() - t0, redactorFor(o));
  } finally {
    await rig?.close().catch(() => undefined);
    rig?.clean();
    await gateway?.close().catch(() => undefined);
    await peerFake?.close().catch(() => undefined);
    await forcer?.close().catch(() => undefined);
  }
}

const emptyWorld = (status: MultiWorld["status"], reason: string): MultiWorld => ({
  status, reason, finalText: "", calls: [], asks: [], denials: [], shellCommands: [], cards: [], tainted: false, leaks: [], mirrorCalls: [], mirrorTexts: [], prefsChanged: false, proxyChatRequests: 0, loginNotices: 0, peerBlocked: [],
});

const TEST_SECRETS = ["222222:RESEARCH-test-token-bbbbbbbbbbbbbbbbbbbbbb", "333333:OPS-test-token-cccccccccccccccccccccccccc", "444444:CLOUDY-test-token-dddddddddddddddddddddd", PROXY_KEY, "gateway-local-token", "lm-test-token-123456"];
/** Redactor for the per-run log: the rig's test secrets, the live runner key, and token-shaped strings. */
function redactorFor(o: RunOptions): (t: string) => string {
  const exact = createRedactor([...TEST_SECRETS, o.live?.apiKey]);
  return (t) => exact(t).replace(/Bearer\s+[\w.~+/=-]{6,}/gi, "Bearer [REDACTED]").replace(/\b(?:sk|pk|key|tok)-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
}
const SECRET_KEY = /token|secret|password|api[_-]?key|authorization/i;
function redactArgs(args: unknown, redact: (t: string) => string): unknown {
  const walk = (k: string, v: unknown, d: number): unknown => {
    if (typeof v === "string") return SECRET_KEY.test(k) ? "[REDACTED]" : redact(v);
    if (d > 8 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(k, x, d + 1));
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([kk, x]) => [kk, walk(kk, x, d + 1)]));
  };
  return redactDeep(walk("", args, 0), redact);
}

function finish(c: MultiCase, run: number, world: MultiWorld, totalMs: number, redact: (t: string) => string): { record: MultiRecord; world: MultiWorld } {
  const v = world.status === "error" ? { pass: false, reason: `run error: ${world.reason}` } : verdictOf(c, world);
  const blocked: string[] = [
    ...world.cards.map((x) => `approval card denied in ${x.bot}'s chat: ${x.text.split("\n")[0]}`),
    ...world.denials.map((d) => `bus refused ${d}`),
    ...world.calls.filter((x) => x.refused).map((x) => `${x.name} refused: ${x.resultText.replace(/^ask_bot refused: /, "").replace(/\s+/g, " ").slice(0, 100)}`),
    ...world.peerBlocked.map((p) => `peer turn: ${p}`),
  ];
  return { world, record: { caseId: c.id, run, pass: v.pass, reason: v.reason, safety: c.safety, toolCalls: world.calls.length, blocked, totalMs, trace: world.calls.map((x) => ({ tool: x.name, args: redactArgs(x.args, redact), result: redact(x.resultText).slice(0, 300) })), finalText: redact(world.finalText) } };
}
