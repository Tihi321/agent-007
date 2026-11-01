/**
 * The in-process `BotBus` (S21.1, I31): registers each bot's runtime, binds a channel to an identity, stamps and routes asks through
 * the `BusRouter`, runs the peer turn with a timeout, audits every message (fail closed on the ask), and tracks chains, taint and
 * the guard answer for every conversation.
 *
 * Only `beginUserTurn` creates a chain with `origin: "user"`. Everything sent on a channel is a peer message.
 */
import { createHash, randomUUID } from "node:crypto";
import type { BotBusLimits } from "../bots/schema.js";
import type { BusAuditSink } from "./audit.js";
import { TAINT_BLOCKED_TOOLS, computePeerCaps, isIngestingTool, summarizePeer } from "./capabilities.js";
import type { ChainRecord, ChainStore } from "./chains.js";
import { MemoryChainStore } from "./chains.js";
import { BusError, parseDraft, peerConversationKey, peerTurnText, wrapPeerMessage, MAX_REPLY_CHARS } from "./contracts.js";
import type { AskResult, BotBus, BotChannel, BotId, BotRuntime, BusBot, BusEvent, BusListener, BusNote, ChainInfo, PeerSummary, SendOptions, Unsubscribe, UserNotice } from "./contracts.js";
import { EdgeLimits, budgetLeft } from "./limits.js";
import type { RefReader } from "./refs.js";
import { BusRouter } from "./router.js";
import type { Routed, SenderContext } from "./router.js";

export interface BotBusOptions {
  bots: readonly BusBot[];
  limits: BotBusLimits;
  audit?: BusAuditSink | undefined;
  chains?: ChainStore | undefined;
  refs?: RefReader | undefined;
  /** One notice to the user when an edge breaker trips. */
  notify?: ((notice: UserNotice) => void) | undefined;
  now?: (() => number) | undefined;
  newId?: (() => string) | undefined;
  flowServerId?: string | undefined;
  isCloud?: ((id: string) => boolean) | undefined;
  /** Test seam: the turn timeout in ms for an envelope's `timeoutSec` (default seconds x 1000). */
  timeoutMs?: ((sec: number) => number) | undefined;
}

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export class InProcessBotBus implements BotBus {
  private readonly bots: Map<BotId, BusBot>;
  private readonly runtimes = new Map<BotId, BotRuntime>();
  private readonly listeners = new Set<BusListener>();
  private readonly chains: ChainStore;
  private readonly router: BusRouter;
  private readonly edges: EdgeLimits;
  private readonly now: () => number;
  private seq = 0;
  /** Count of audit lines that could not be written after the ask was delivered (the ask itself fails closed). */
  auditErrors = 0;

  constructor(private readonly o: BotBusOptions) {
    this.bots = new Map(o.bots.map((b) => [b.id, b]));
    this.chains = o.chains ?? new MemoryChainStore();
    this.now = o.now ?? Date.now;
    this.edges = new EdgeLimits({ limits: o.limits, now: this.now });
    this.router = new BusRouter({
      bots: this.bots,
      limits: o.limits,
      chains: this.chains,
      edges: this.edges,
      refs: o.refs,
      now: this.now,
      newId: o.newId ?? (() => randomUUID()),
      flowServerId: o.flowServerId,
      isCloud: o.isCloud,
      running: (id) => this.runtimes.has(id),
    });
  }

  // ---- registration and events ----------------------------------------------------------------------------------------

  register(id: BotId, runtime: BotRuntime): Unsubscribe {
    this.runtimes.set(id, runtime);
    return () => {
      if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
    };
  }

  onMessage(listener: BusListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  edgeStatus(): ReturnType<EdgeLimits["status"]> {
    return this.edges.status();
  }

  private event(type: BusEvent["type"], p: Omit<BusEvent, "seq" | "ts" | "type">): BusEvent {
    return { seq: ++this.seq, ts: new Date(this.now()).toISOString(), type, ...p };
  }

  /** Writes the audit line. `strict`: a failure throws (the ask fails closed); otherwise it is counted. */
  private audit(ev: BusEvent, strict: boolean): void {
    try {
      const { text: _text, ...line } = ev;
      void _text;
      this.o.audit?.record(line);
    } catch {
      if (strict) throw new BusError("unavailable", "audit_failed");
      this.auditErrors += 1;
    }
  }

  private emit(ev: BusEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch {
        /* a listener never blocks the bus */
      }
    }
  }

  // ---- chains ---------------------------------------------------------------------------------------------------------

  beginUserTurn(bot: BotId, conversationId: string): ChainInfo {
    const rec: ChainRecord = { chainId: this.o.newId?.() ?? randomUUID(), origin: "user", rootBot: bot, startedAt: this.now(), messages: 0, tokens: 0, taint: false, hashes: [], edges: [] };
    this.chains.putChain(rec);
    this.chains.putConv(bot, conversationId, { chainId: rec.chainId, origin: "user", hop: 0, path: [bot], taint: false, at: this.now() });
    return { chainId: rec.chainId, origin: "user", hop: 0, path: [bot], taint: false };
  }

  contextOf(bot: BotId, conversationId: string): ChainInfo | undefined {
    const conv = this.chains.getConv(bot, conversationId);
    if (!conv) return undefined;
    const chain = this.chains.getChain(conv.chainId);
    return { chainId: conv.chainId, origin: conv.origin, hop: conv.hop, path: [...conv.path], taint: conv.taint || chain?.taint === true };
  }

  noteToolUse(bot: BotId, conversationId: string, tool: string): void {
    if (!isIngestingTool(tool, this.o.flowServerId)) return;
    const conv = this.chains.getConv(bot, conversationId);
    if (!conv) return;
    this.chains.putConv(bot, conversationId, { ...conv, taint: true });
    this.taintChain(conv.chainId);
  }

  private taintChain(chainId: string): void {
    const chain = this.chains.getChain(chainId);
    if (chain && !chain.taint) this.chains.putChain({ ...chain, taint: true });
  }

  guard(bot: BotId, conversationId: string, tool: string, opts: { peerConversation?: boolean } = {}): string | undefined {
    const info = this.contextOf(bot, conversationId);
    const peer = opts.peerConversation === true || info?.origin === "peer";
    if (peer) {
      if (!info) return "a peer turn with no known chain has no tools";
      return computePeerCaps(this.capInput(info.path, info.taint)).denied(tool);
    }
    if (info?.taint && TAINT_BLOCKED_TOOLS.includes(tool)) return "the chain is tainted: no gated tool exists in it";
    return undefined;
  }

  private capInput(path: readonly string[], taint: boolean) {
    return { bots: this.bots, path, hopLimit: this.o.limits.hopLimit, taint, ...(this.o.flowServerId !== undefined ? { flowServerId: this.o.flowServerId } : {}), ...(this.o.isCloud ? { isCloud: this.o.isCloud } : {}) };
  }

  // ---- queries --------------------------------------------------------------------------------------------------------

  hasEdges(self: BotId): boolean {
    return (this.bots.get(self)?.edges.length ?? 0) > 0;
  }

  peersOf(self: BotId, conversationId?: string): PeerSummary[] {
    const me = this.bots.get(self);
    if (!me) return [];
    const info = conversationId !== undefined ? this.contextOf(self, conversationId) : undefined;
    const path = info?.path ?? [self];
    const taint = conversationId !== undefined && info === undefined ? true : (info?.taint ?? false);
    const out: PeerSummary[] = [];
    for (const e of me.edges) {
      const recv = this.bots.get(e.to);
      if (!recv) continue;
      out.push(summarizePeer(this.capInput([...path, e.to], taint), recv, e.egress));
    }
    return out;
  }

  recordNote(note: BusNote): void {
    try {
      this.o.audit?.note(note, new Date(this.now()).toISOString());
    } catch {
      this.auditErrors += 1;
    }
  }

  // ---- sending --------------------------------------------------------------------------------------------------------

  channel(self: BotId): BotChannel {
    return { id: self, send: (draft, opts) => this.send(self, draft, opts ?? {}) };
  }

  private async send(self: BotId, raw: unknown, opts: SendOptions): Promise<AskResult> {
    const draft = parseDraft(raw);
    const ctx = this.router.senderContext(self, opts);
    const bodySha256 = sha(draft.body);
    const stamp = { chainId: ctx.chain.chainId, from: self, to: draft.to, hop: ctx.hop + 1, origin: "peer" as const, taint: ctx.taint, bodySha256 };

    let routed: Routed;
    try {
      routed = await this.router.route(self, draft, ctx, { onTrip: (f, t) => this.tripped(f, t, ctx, opts) });
    } catch (e) {
      if (e instanceof BusError) {
        const ev = this.event("denied", { ...stamp, decision: "denied", reason: `${e.code}:${e.reason}` });
        this.audit(ev, false);
        this.emit({ ...ev, text: draft.body });
      }
      throw e;
    }

    const { envelope, caps, chain, release } = routed;
    const askEv = this.event("ask", { ...stamp, decision: "delivered", ...(draft.ignoredClaims.length > 0 ? { reason: `ignored_claims:${draft.ignoredClaims.join(",")}` } : {}) });
    try {
      this.audit(askEv, true);
    } catch (e) {
      release();
      throw e;
    }
    this.emit({ ...askEv, text: draft.body });

    const left = (): AskResult["budget_left"] => budgetLeft(this.chains.getChain(chain.chainId) ?? chain, this.o.limits, this.now());
    const base = { from: envelope.to, chain_id: envelope.chainId, hop: envelope.hop };

    if (!envelope.wait) {
      void this.runTurn(routed, ctx).catch(() => undefined).finally(release);
      return { reply: null, ...base, budget_left: left(), queued: true };
    }
    try {
      const reply = await this.runTurn(routed, ctx);
      return { reply: wrapPeerMessage({ from: envelope.to, hop: envelope.hop, taint: reply.taint, body: reply.text }), ...base, budget_left: left() };
    } finally {
      release();
    }
  }

  private tripped(from: string, to: string, ctx: SenderContext, opts: SendOptions): void {
    this.recordNote({ event: "breaker", bot: from, detail: `edge ${from} to ${to} paused` });
    const text = `The bots ${from} and ${to} asked each other too often, so I paused that link. Nothing else was affected.`;
    try {
      this.o.notify?.({ kind: "breaker", bot: ctx.chain.rootBot, ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}), text });
    } catch {
      /* a notice that cannot be shown never blocks the refusal */
    }
  }

  /** Runs the receiver's peer turn with a timeout; records the reply, tokens and taint; audits the outcome. */
  private async runTurn(routed: Routed, _ctx: SenderContext): Promise<{ text: string; taint: boolean }> {
    void _ctx;
    const { envelope, caps } = routed;
    const runtime = this.runtimes.get(envelope.to);
    const stamp = { chainId: envelope.chainId, from: envelope.to, to: envelope.from, hop: envelope.hop, origin: "peer" as const, bodySha256: "" };
    const fail = (e: BusError, taint: boolean): never => {
      const ev = this.event("failed", { ...stamp, taint, decision: "denied", reason: `${e.code}:${e.reason}` });
      this.audit(ev, false);
      this.emit({ ...ev, text: e.reason });
      throw e;
    };
    if (!runtime) return fail(new BusError("unavailable", "not_running"), envelope.taint);

    const ac = new AbortController();
    let bound: string | undefined;
    const turn = runtime.runPeerTurn(envelope, caps, {
      text: peerTurnText(envelope),
      conversationKey: peerConversationKey(envelope.from),
      bind: (conversationId) => {
        bound = conversationId;
        this.chains.putConv(envelope.to, conversationId, { chainId: envelope.chainId, origin: "peer", hop: envelope.hop, path: [...envelope.path], taint: envelope.taint, at: this.now() });
      },
      signal: ac.signal,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_res, rej) => {
      timer = setTimeout(() => {
        ac.abort();
        rej(new BusError("timeout", "ask_timeout"));
      }, this.o.timeoutMs ? this.o.timeoutMs(envelope.timeoutSec) : envelope.timeoutSec * 1000);
    });
    let reply;
    try {
      reply = await Promise.race([turn, timeout]);
    } catch (e) {
      turn.catch(() => undefined);
      if (e instanceof BusError) return fail(e, envelope.taint);
      return fail(new BusError("unavailable", "turn_failed"), envelope.taint);
    } finally {
      if (timer) clearTimeout(timer);
    }

    let taint = envelope.taint;
    for (const t of reply.toolsUsed ?? []) {
      if (isIngestingTool(t, this.o.flowServerId)) {
        taint = true;
        if (bound !== undefined) this.noteToolUse(envelope.to, bound, t);
        this.taintChain(envelope.chainId);
      }
    }
    const chain = this.chains.getChain(envelope.chainId);
    if (chain && typeof reply.tokens === "number" && reply.tokens > 0) this.chains.putChain({ ...chain, tokens: chain.tokens + Math.floor(reply.tokens) });
    if (this.chains.getChain(envelope.chainId)?.taint) taint = true;
    const text = (reply.text.trim() === "" ? "(no reply)" : reply.text).slice(0, MAX_REPLY_CHARS);
    const ev = this.event("reply", { ...stamp, taint, decision: "delivered", bodySha256: sha(text) });
    this.audit(ev, false);
    this.emit({ ...ev, text });
    return { text, taint };
  }
}

export function createBotBus(o: BotBusOptions): InProcessBotBus {
  return new InProcessBotBus(o);
}
