/**
 * The router (S21.2, I32, I33, I36): turns a bot's draft into a stamped `Envelope` or a typed refusal. Every stamped field is set
 * here, from the authenticated channel identity (`sender`) and the chain records, never from the body.
 *
 * Order of checks (cheapest and most informative first; the per-edge counters are charged last, so a refused ask costs nothing):
 *  edge_denied -> async from a peer (refused) -> hop_limit -> loop_detected -> budget_exhausted -> capabilities -> attach_refs -> edge limits.
 *
 * A send from a conversation with no known chain is an ORPHAN: it gets a new peer chain, tainted, hop 0 (it never has user authority).
 */
import type { BusBot, BotId, Envelope, EnvelopeDraft, Origin, PeerCaps, SendOptions } from "./contracts.js";
import { BusError } from "./contracts.js";
import { computePeerCaps } from "./capabilities.js";
import type { ChainRecord, ChainStore } from "./chains.js";
import { checkChainBudget } from "./limits.js";
import type { EdgeLimits } from "./limits.js";
import { assertNoLoop, edgeKey, messageHash } from "./loops.js";
import { resolveRefs } from "./refs.js";
import type { RefReader } from "./refs.js";
import type { BusLimits } from "./contracts.js";

export interface RouterDeps {
  bots: ReadonlyMap<BotId, BusBot>;
  limits: BusLimits;
  chains: ChainStore;
  edges: EdgeLimits;
  refs?: RefReader | undefined;
  now(): number;
  newId(): string;
  flowServerId?: string | undefined;
  isCloud?: ((id: string) => boolean) | undefined;
  /** Is the receiver registered right now? Default: yes. */
  running?: ((id: string) => boolean) | undefined;
}

/** Where a send comes from: the sender's chain stamp. */
export interface SenderContext {
  chain: ChainRecord;
  path: BotId[];
  hop: number;
  taint: boolean;
  origin: Origin;
  /** True when the conversation has no known chain (the ask is a tainted peer chain). */
  orphan: boolean;
  /** True when the sender is in a turn that came from a peer (or is an orphan): no async asks. */
  peerTurn: boolean;
}

export interface Routed {
  envelope: Envelope;
  caps: PeerCaps;
  chain: ChainRecord;
  release(): void;
}

export class BusRouter {
  constructor(private readonly d: RouterDeps) {}

  /** The chain stamp of `sender`'s conversation. Throws `edge_denied` for a sender the bus does not know. */
  senderContext(sender: BotId, opts: SendOptions): SenderContext {
    if (!this.d.bots.has(sender)) throw new BusError("edge_denied", "unknown_sender");
    const conv = opts.conversationId !== undefined ? this.d.chains.getConv(sender, opts.conversationId) : undefined;
    const chain = conv ? this.d.chains.getChain(conv.chainId) : undefined;
    if (conv && chain) {
      return { chain, path: [...conv.path], hop: conv.hop, taint: conv.taint || chain.taint, origin: conv.origin, orphan: false, peerTurn: conv.origin === "peer" };
    }
    const fresh: ChainRecord = { chainId: this.d.newId(), origin: "peer", rootBot: sender, startedAt: this.d.now(), messages: 0, tokens: 0, taint: true, hashes: [], edges: [] };
    return { chain: fresh, path: [sender], hop: 0, taint: true, origin: "peer", orphan: true, peerTurn: true };
  }

  async route(sender: BotId, draft: EnvelopeDraft, ctx: SenderContext, hooks: { onTrip?: (from: string, to: string) => void } = {}): Promise<Routed> {
    const d = this.d;
    const from = d.bots.get(sender) as BusBot;
    const edge = from.edges.find((e) => e.to === draft.to);
    const to = d.bots.get(draft.to);
    if (!edge || !to || draft.to === sender) throw new BusError("edge_denied", "no_edge");
    if (d.running && !d.running(draft.to)) throw new BusError("unavailable", "not_running");
    if (!draft.wait && ctx.peerTurn) throw new BusError("refused", "async_from_peer");

    const hop = ctx.hop + 1;
    if (hop > d.limits.hopLimit) throw new BusError("hop_limit", "hop_limit");
    const path = [...ctx.path, draft.to];
    // a peer turn may only ask when ITS capabilities include `ask_bot` (the intersection along its own path)
    if (ctx.origin === "peer" && !ctx.orphan) {
      const own = computePeerCaps({ bots: d.bots, path: ctx.path, hopLimit: d.limits.hopLimit, taint: ctx.taint, ...(d.flowServerId !== undefined ? { flowServerId: d.flowServerId } : {}), ...(d.isCloud ? { isCloud: d.isCloud } : {}) });
      if (!own.permits("ask_bot")) throw new BusError("refused", "ask_not_permitted");
    }

    assertNoLoop(ctx.path, { hashes: ctx.chain.hashes, edges: ctx.chain.edges }, sender, draft.to, draft.body);
    const now = d.now();
    checkChainBudget(ctx.chain, d.limits, now);

    const taint = ctx.taint;
    const capInput = { bots: d.bots, path, hopLimit: d.limits.hopLimit, taint, ...(d.flowServerId !== undefined ? { flowServerId: d.flowServerId } : {}), ...(d.isCloud ? { isCloud: d.isCloud } : {}) };
    const caps = computePeerCaps(capInput);
    const receiverCloud = (d.isCloud ?? ((id: string) => d.bots.get(id)?.cloudCapable === true))(draft.to);
    const attachments = await resolveRefs(draft.attachRefs, d.refs, { sender, receiverCloud, edgeEgress: edge.egress });

    const release = d.edges.admit(sender, draft.to, hooks.onTrip);

    const chain: ChainRecord = { ...ctx.chain, hashes: [...ctx.chain.hashes], edges: [...ctx.chain.edges] };
    chain.messages += 1;
    chain.hashes.push(messageHash(sender, draft.to, draft.body));
    chain.edges.push(edgeKey(sender, draft.to));
    d.chains.putChain(chain);

    const remaining = Math.max(1, Math.floor(d.limits.chainMaxSeconds - (now - chain.startedAt) / 1000));
    const envelope: Envelope = {
      id: d.newId(),
      kind: "ask",
      from: sender,
      to: draft.to,
      chainId: chain.chainId,
      hop,
      path,
      // only `BotBus.beginUserTurn` starts a user chain: a bus message is always a peer message
      origin: "peer",
      taint,
      body: draft.body,
      attachments,
      ts: new Date(now).toISOString(),
      timeoutSec: Math.min(draft.timeoutSec ?? d.limits.askTimeoutMaxSec, d.limits.askTimeoutMaxSec, remaining),
      wait: draft.wait,
    };
    return { envelope, caps, chain, release };
  }
}
