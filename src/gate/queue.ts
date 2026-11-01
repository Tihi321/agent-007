/**
 * The gate's waiting line (S25.1, I44): four priority classes with aging.
 *
 *  P0  the user's own message in a bot chat
 *  P1  turns in a user-started chain (peer asks)
 *  P2  peer-initiated or background turns
 *  P3  summaries and compaction
 *
 * A waiting entry moves up one class for every `agingMs` it has waited (never above P0). The order is (effective class, arrival), so an
 * entry that has aged into P0 goes ahead of a fresh P0, and nothing waits forever behind a stream of better entries. Nothing here
 * preempts anything: the queue only decides who is next when a slot frees.
 */
export type Priority = 0 | 1 | 2 | 3;
export const PRIORITIES: readonly Priority[] = [0, 1, 2, 3];
export const P0: Priority = 0;
export const P1: Priority = 1;
export const P2: Priority = 2;
export const P3: Priority = 3;

export function isPriority(n: unknown): n is Priority {
  return n === 0 || n === 1 || n === 2 || n === 3;
}

export interface Queued<T> {
  /** Arrival order; also the tie-break inside a class. */
  readonly id: number;
  readonly priority: Priority;
  readonly bot: string;
  readonly enqueuedAt: number;
  readonly item: T;
}

export class AgingQueue<T> {
  readonly #entries: Queued<T>[] = [];
  #seq = 0;
  readonly #agingMs: number;

  /** `agingMs` of 0 or less switches aging off. */
  constructor(agingMs: number) {
    this.#agingMs = agingMs;
  }

  get size(): number {
    return this.#entries.length;
  }

  add(priority: Priority, bot: string, now: number, item: T): Queued<T> {
    const entry: Queued<T> = { id: ++this.#seq, priority, bot, enqueuedAt: now, item };
    this.#entries.push(entry);
    return entry;
  }

  remove(entry: Queued<T>): boolean {
    const i = this.#entries.indexOf(entry);
    if (i < 0) return false;
    this.#entries.splice(i, 1);
    return true;
  }

  has(entry: Queued<T>): boolean {
    return this.#entries.includes(entry);
  }

  /** The class the entry counts as now: its own class minus one per aging step waited, never below P0. */
  effective(entry: Queued<T>, now: number): Priority {
    if (this.#agingMs <= 0) return entry.priority;
    const steps = Math.floor(Math.max(0, now - entry.enqueuedAt) / this.#agingMs);
    return Math.max(0, entry.priority - steps) as Priority;
  }

  /** Every entry (that passes `filter`) in the order it would be served. */
  order(now: number, filter?: (e: Queued<T>) => boolean): Queued<T>[] {
    const list = filter ? this.#entries.filter(filter) : [...this.#entries];
    return list.sort((a, b) => this.effective(a, now) - this.effective(b, now) || a.id - b.id);
  }

  /** The next entry to serve among those that pass `filter`. */
  pick(now: number, filter?: (e: Queued<T>) => boolean): Queued<T> | undefined {
    let best: Queued<T> | undefined;
    let bestClass = 4;
    for (const e of this.#entries) {
      if (filter && !filter(e)) continue;
      const c = this.effective(e, now);
      if (!best || c < bestClass || (c === bestClass && e.id < best.id)) {
        best = e;
        bestClass = c;
      }
    }
    return best;
  }

  /** How many waiting entries would be served before this one. */
  rank(entry: Queued<T>, now: number): number {
    const mine = this.effective(entry, now);
    let n = 0;
    for (const e of this.#entries) {
      if (e === entry) continue;
      const c = this.effective(e, now);
      if (c < mine || (c === mine && e.id < entry.id)) n++;
    }
    return n;
  }

  /** Waiting entries per base class (not the aged class). */
  counts(): [number, number, number, number] {
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (const e of this.#entries) out[e.priority]++;
    return out;
  }

  oldestWaitMs(now: number): number {
    let oldest = 0;
    for (const e of this.#entries) oldest = Math.max(oldest, now - e.enqueuedAt);
    return oldest;
  }

  entries(): readonly Queued<T>[] {
    return this.#entries;
  }
}
