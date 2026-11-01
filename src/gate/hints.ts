/**
 * Which priority class a model call belongs to (I44). Pi's model call carries no notion of who started the turn, so the host says it:
 * whoever starts a turn for a bot calls `begin(botId, { priority })` and the returned function when the turn ends.
 *
 *  - the Telegram path (the user's own message in a bot chat)         -> P0
 *  - the bus (peer ask in a chain the user started / any other peer)   -> P1 / P2
 *  - a job or background turn                                         -> P2
 *
 * While several turns of one bot are active the best class wins. A bot with no active hint gets P2 for a turn call (a missing hint
 * degrades to plain arrival order, never to starvation). Summaries and compaction (`complete*`) are always P3, so they never wait ahead
 * of a turn, and they age like everything else.
 */
import type { Priority } from "./queue.js";
import { P2, P3 } from "./queue.js";

export interface TurnHint {
  priority: Priority;
  /** The conversation to tell when the call has to wait (the wait notice goes through the bot's `Notifier`). */
  conversationId?: string | undefined;
}

export class PriorityHints {
  readonly #active = new Map<string, { seq: number; hint: TurnHint }[]>();
  #seq = 0;

  /** Marks a turn of `botId` as started; call the returned function once when it ends (calling it twice is harmless). */
  begin(botId: string, hint: TurnHint): () => void {
    const item = { seq: ++this.#seq, hint };
    const list = this.#active.get(botId) ?? [];
    list.push(item);
    this.#active.set(botId, list);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const cur = this.#active.get(botId);
      if (!cur) return;
      const i = cur.indexOf(item);
      if (i >= 0) cur.splice(i, 1);
      if (cur.length === 0) this.#active.delete(botId);
    };
  }

  /** The hint a turn call of `botId` runs under: the best class among the active turns (the earliest of equals), or P2. */
  resolve(botId: string): TurnHint {
    const list = this.#active.get(botId);
    let best: { seq: number; hint: TurnHint } | undefined;
    for (const it of list ?? []) {
      if (!best || it.hint.priority < best.hint.priority || (it.hint.priority === best.hint.priority && it.seq < best.seq)) best = it;
    }
    return best ? best.hint : { priority: P2 };
  }

  /** What a summary call (`complete*`) runs under: P3, in the conversation of the best active turn if there is one. */
  resolveSummary(botId: string): TurnHint {
    const turn = this.#active.get(botId) ? this.resolve(botId) : undefined;
    return { priority: P3, conversationId: turn?.conversationId };
  }

  /** Active turn count per bot (for tests and `/status`). */
  activeTurns(botId: string): number {
    return this.#active.get(botId)?.length ?? 0;
  }
}
