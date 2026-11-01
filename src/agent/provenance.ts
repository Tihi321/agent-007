/**
 * Approval provenance (S26.2, I35). When a bot receives a reply to its own `ask_bot` and, in the same turn, asks the user for an
 * approval (a shell command, a job, a settings proposal), the card says so: "Peer input from bot X, hop n" and quotes the peer's text.
 * The user then sees that the request may have come from another bot, not from them.
 *
 * The tracker listens to the bus's reply events (read-only, `BusObserver`). A reply event carries the chain id and the asking bot
 * (`to`); a user turn's conversation is bound to its chain by `bus.beginUserTurn`, so "the replies of this turn" is "the replies of
 * this conversation's current chain". A new user message starts a new chain, so an older peer reply is never quoted on a later card.
 * Cards never cross chats: each bot's cards go through its own transport, and the tracker is only consulted with that bot's id.
 *
 * Nothing here can approve anything: it only returns text for a card. Bodies are kept in memory, clipped, and never persisted.
 */
import type { PeerProvenance } from "../contracts.js";
import type { BotBus, BusEvent, BusObserver, Unsubscribe } from "../botbus/contracts.js";

export const MAX_QUOTE_CHARS = 600;
const MAX_ITEMS_PER_CHAIN = 4;
const MAX_CHAINS = 200;

export class PeerProvenanceTracker {
  readonly #byKey = new Map<string, PeerProvenance[]>();
  readonly #off: Unsubscribe;

  constructor(
    private readonly bus: Pick<BotBus, "contextOf"> & BusObserver,
  ) {
    this.#off = bus.onMessage((ev) => this.#on(ev));
  }

  #on(ev: BusEvent): void {
    // `reply`: the peer `from` answered `to`; `text` is the reply (never written to the audit log).
    if (ev.type !== "reply" || ev.text === undefined) return;
    const key = `${ev.to}|${ev.chainId}`;
    const list = this.#byKey.get(key) ?? [];
    list.push({ from: ev.from, hop: ev.hop, text: ev.text.slice(0, MAX_QUOTE_CHARS) });
    while (list.length > MAX_ITEMS_PER_CHAIN) list.shift();
    this.#byKey.delete(key);
    this.#byKey.set(key, list);
    while (this.#byKey.size > MAX_CHAINS) this.#byKey.delete(this.#byKey.keys().next().value as string);
  }

  /** The peer replies the current turn of `bot`'s `conversationId` received, oldest first; undefined when there are none. */
  forConversation(bot: string, conversationId: string): readonly PeerProvenance[] | undefined {
    const chain = this.bus.contextOf(bot, conversationId);
    if (!chain) return undefined;
    const list = this.#byKey.get(`${bot}|${chain.chainId}`);
    return list && list.length > 0 ? list.map((p) => ({ ...p })) : undefined;
  }

  stop(): void {
    this.#off();
    this.#byKey.clear();
  }
}
