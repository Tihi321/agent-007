/**
 * Fakes for the BotBus (S21.1): `FakeBotRuntime` serves peer turns from a script; `FakeBotBus` is an in-memory `BotBus` that records
 * what was sent and lets a test publish audit events, for the S24 and S26 tests. Not a test file.
 */
import { BusError } from "../../src/botbus/contracts.js";
import type { AskResult, BotBus, BotChannel, BotId, BotRuntime, BusEvent, BusListener, BusNote, ChainInfo, Envelope, PeerCaps, PeerReply, PeerSummary, PeerTurnContext, SendOptions, Unsubscribe } from "../../src/botbus/contracts.js";

export interface RuntimeCall {
  envelope: Envelope;
  caps: PeerCaps;
  text: string;
  conversationKey: string;
}

export type RuntimeScript = (call: RuntimeCall, ctx: PeerTurnContext) => PeerReply | string | Promise<PeerReply | string>;

/** A bot runtime whose reply comes from a script. Binds a conversation id like the real runtime does. */
export class FakeBotRuntime implements BotRuntime {
  readonly calls: RuntimeCall[] = [];
  private n = 0;
  constructor(
    private readonly script: RuntimeScript = (c) => `echo: ${c.envelope.body}`,
    private readonly botId = "fake",
  ) {}
  async runPeerTurn(envelope: Envelope, caps: PeerCaps, ctx: PeerTurnContext): Promise<PeerReply> {
    this.n += 1;
    ctx.bind(`${this.botId}-peer-${envelope.from}-${this.n}`);
    const call: RuntimeCall = { envelope, caps, text: ctx.text, conversationKey: ctx.conversationKey };
    this.calls.push(call);
    const r = await this.script(call, ctx);
    return typeof r === "string" ? { text: r } : r;
  }
}

/** An in-memory `BotBus`: `channel(self).send` returns a scripted reply and records the draft; events are published by hand. */
export class FakeBotBus implements BotBus {
  readonly sent: { from: BotId; draft: unknown; opts?: SendOptions }[] = [];
  readonly notes: BusNote[] = [];
  readonly registered = new Map<BotId, BotRuntime>();
  private readonly listeners = new Set<BusListener>();
  private seq = 0;
  /** `to -> reply text`, or a function; a missing entry is `edge_denied`. */
  replies = new Map<BotId, string | ((draft: unknown) => string)>();
  constructor(private readonly chain: ChainInfo = { chainId: "chain-fake", origin: "user", hop: 0, path: [], taint: false }) {}

  register(id: BotId, runtime: BotRuntime): Unsubscribe {
    this.registered.set(id, runtime);
    return () => this.registered.delete(id);
  }
  onMessage(l: BusListener): Unsubscribe {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  /** Publishes an event to the subscribers (a throwing listener is the subscriber's problem; the bus is unaffected). */
  publish(p: Partial<BusEvent> & Pick<BusEvent, "type" | "from" | "to">): BusEvent {
    const ev: BusEvent = { seq: ++this.seq, ts: new Date(0).toISOString(), chainId: "chain-fake", hop: 1, origin: "peer", taint: false, decision: "delivered", bodySha256: "0".repeat(64), ...p };
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch {
        /* never blocks the bus */
      }
    }
    return ev;
  }
  channel(self: BotId): BotChannel {
    return {
      id: self,
      send: async (draft, opts): Promise<AskResult> => {
        this.sent.push({ from: self, draft, ...(opts ? { opts } : {}) });
        const to = (draft as { to?: string }).to ?? "";
        const r = this.replies.get(to);
        if (r === undefined) throw new BusError("edge_denied", "no_edge");
        const reply = typeof r === "function" ? r(draft) : r;
        return { reply, from: to, chain_id: this.chain.chainId, hop: 1, budget_left: { messages: 5, seconds: 300, tokens: 60000 } };
      },
    };
  }
  beginUserTurn(_bot?: BotId, _conv?: string): ChainInfo {
    return { ...this.chain };
  }
  contextOf(_bot?: BotId, _conv?: string): ChainInfo | undefined {
    return { ...this.chain };
  }
  noteToolUse(_b?: BotId, _c?: string, _t?: string): void {}
  guard(_b?: BotId, _c?: string, _t?: string, _o?: { peerConversation?: boolean }): string | undefined {
    return undefined;
  }
  peersOf(_s?: BotId, _c?: string): PeerSummary[] {
    return [];
  }
  hasEdges(_s?: BotId): boolean {
    return this.replies.size > 0;
  }
  recordNote(n: BusNote): void {
    this.notes.push(n);
  }
}
