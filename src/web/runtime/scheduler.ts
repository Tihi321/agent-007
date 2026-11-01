/**
 * Turn scheduling for web chat (S33, I51, UI-40, T8). One model server serves everybody, so a guest must not starve the owner:
 *
 *   owner Telegram P0  <  peer P1  <  user web turn 1.5  <  background P2  <  summaries P3
 *
 * Per-key concurrency is 1 (a user's second turn waits for their first), the queue has a depth cap with a clear "busy" refusal, equal
 * classes are served round-robin by least recently served key (so one chatty user cannot keep another waiting), and a waiting web turn
 * ages toward P1 but never ahead of P0 or P1. Non-preemptive: a running turn is never interrupted; only the caller's abort frees it.
 *
 * The real wiring grants a slot here first and then takes the shared local-model gate (`src/gate`) at P2, which has no half class; the
 * ordering of web turns against the owner is decided by this queue and by the gate's P0 and P1 classes.
 */
export const CLASS_PRIORITY = { owner: 0, peer: 1, web: 1.5, background: 2, summary: 3 } as const;
export type TurnClass = keyof typeof CLASS_PRIORITY;

export class SchedulerBusyError extends Error {
  readonly code = "busy";
  constructor(readonly queued: number) {
    super(`the model is busy: ${queued} turns are waiting`);
    this.name = "SchedulerBusyError";
  }
}

export class SchedulerAbortedError extends Error {
  readonly code = "aborted";
  constructor() {
    super("aborted while waiting for the model");
    this.name = "SchedulerAbortedError";
  }
}

export interface TurnLease {
  readonly key: string;
  readonly cls: TurnClass;
  readonly waitedMs: number;
  release(): void;
}

interface Waiter {
  key: string;
  cls: TurnClass;
  at: number;
  seq: number;
  resolve(l: TurnLease): void;
  reject(e: Error): void;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
}

export interface SchedulerOptions {
  /** Concurrent turns the model serves (Strata: 1). */
  slots?: number;
  /** Waiting entries allowed before a web, background or summary turn is refused. Owner and peer turns are never refused. */
  maxQueue?: number;
  agingMs?: number;
  now?: () => number;
}

export class TurnScheduler {
  readonly #slots: number;
  readonly #maxQueue: number;
  readonly #agingMs: number;
  readonly #now: () => number;
  readonly #running = new Map<string, TurnClass>();
  readonly #waiting: Waiter[] = [];
  readonly #lastServed = new Map<string, number>();
  #seq = 0;
  #served = 0;

  constructor(o: SchedulerOptions = {}) {
    this.#slots = o.slots ?? 1;
    this.#maxQueue = o.maxQueue ?? 8;
    this.#agingMs = o.agingMs ?? 60_000;
    this.#now = o.now ?? Date.now;
  }

  acquire(req: { key: string; cls: TurnClass; signal?: AbortSignal | undefined }): Promise<TurnLease> {
    if (req.signal?.aborted) return Promise.reject(new SchedulerAbortedError());
    const strict = req.cls !== "owner" && req.cls !== "peer";
    if (strict && this.#waiting.length >= this.#maxQueue) return Promise.reject(new SchedulerBusyError(this.#waiting.length));
    // a user may have one turn waiting behind their running one, not a pile
    if (req.cls === "web" && this.#waiting.filter((w) => w.key === req.key).length >= 1 && this.#running.has(req.key)) return Promise.reject(new SchedulerBusyError(this.#waiting.length));
    return new Promise<TurnLease>((resolve, reject) => {
      const w: Waiter = { key: req.key, cls: req.cls, at: this.#now(), seq: ++this.#seq, resolve, reject, signal: req.signal };
      if (req.signal) {
        w.onAbort = () => {
          const i = this.#waiting.indexOf(w);
          if (i >= 0) {
            this.#waiting.splice(i, 1);
            reject(new SchedulerAbortedError());
          }
        };
        req.signal.addEventListener("abort", w.onAbort, { once: true });
      }
      this.#waiting.push(w);
      this.#pump();
    });
  }

  #effective(w: Waiter): number {
    const base = CLASS_PRIORITY[w.cls];
    if (base <= 1 || this.#agingMs <= 0) return base;
    const steps = Math.floor((this.#now() - w.at) / this.#agingMs);
    return Math.max(1.0001, base - steps * 0.5); // ages toward P1 but never ahead of P0 or P1
  }

  #pump(): void {
    while (this.#running.size < this.#slots) {
      const ready = this.#waiting.filter((w) => !this.#running.has(w.key));
      if (ready.length === 0) return;
      ready.sort((a, b) => this.#effective(a) - this.#effective(b) || (this.#lastServed.get(a.key) ?? 0) - (this.#lastServed.get(b.key) ?? 0) || a.seq - b.seq);
      const next = ready[0] as Waiter;
      this.#waiting.splice(this.#waiting.indexOf(next), 1);
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      this.#running.set(next.key, next.cls);
      this.#lastServed.set(next.key, ++this.#served);
      const started = this.#now();
      let released = false;
      next.resolve({
        key: next.key,
        cls: next.cls,
        waitedMs: started - next.at,
        release: () => {
          if (released) return;
          released = true;
          this.#running.delete(next.key);
          this.#pump();
        },
      });
    }
  }

  status(): { running: { key: string; cls: TurnClass }[]; queued: number; byClass: Record<TurnClass, number> } {
    const byClass: Record<TurnClass, number> = { owner: 0, peer: 0, web: 0, background: 0, summary: 0 };
    for (const w of this.#waiting) byClass[w.cls]++;
    return { running: [...this.#running].map(([key, cls]) => ({ key, cls })), queued: this.#waiting.length, byClass };
  }
}
