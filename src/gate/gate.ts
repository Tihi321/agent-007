/**
 * The local-inference gate (S25.1, I44): one `RunnerGate` per local runner (Strata, LM Studio), in the agent host.
 *
 * Strata serves one sequence at a time behind a FIFO, so several local bots share one slot. The gate decides who is next:
 *  - non-preemptive: a call that holds the slot is never interrupted; only the user's `/stop` (the call's abort signal) frees it early;
 *  - priority classes P0 to P3 with aging (see `queue.ts`), so a P0 turn goes ahead of queued P2 and P3, and nothing starves;
 *  - per-bot concurrency 1 on a runner: a bot's second request waits for its first;
 *  - a depth cap: P2 and P3 requests beyond `maxQueueDepth` waiting entries get `GateBusyError` (P0 and P1 are never refused);
 *  - stickiness: after a bot's call ends in tool use, the slot is kept for that bot for `stickinessSec`, so its tool loop is not split by
 *    another bot's turn (a different system prompt forces a full re-prefill, U57). A strictly better class, or an entry that has
 *    already waited one aging step, breaks the hold, so stickiness delays but never starves;
 *  - one "waiting for the model (n ahead)" notice per request that waits longer than `waitNoticeSec` (user-facing P0 and P1 only),
 *    at most once per bot per cooldown so a tool loop is not announced every round.
 *
 * Time comes from a `GateClock`, so every behaviour is testable with a fake. No network, no Pi imports.
 */
import type { Logger } from "../contracts.js";
import type { GateSettings } from "../bots/schema.js";
import { realClock } from "./clock.js";
import type { GateClock } from "./clock.js";
import { AgingQueue } from "./queue.js";
import type { Priority, Queued } from "./queue.js";

export type GateTuning = Pick<GateSettings, "maxQueueDepth" | "stickinessSec" | "agingSec" | "waitNoticeSec">;

/** `busy`: the queue is full and the request is a P2 or P3. */
export class GateBusyError extends Error {
  readonly code = "busy";
  constructor(
    readonly runner: string,
    readonly queued: number,
    readonly limit: number,
  ) {
    super(`the local model (${runner}) is busy: ${queued} requests are waiting (limit ${limit})`);
    this.name = "GateBusyError";
  }
}

/** The request was aborted (the user's `/stop`) while it waited. */
export class GateAbortedError extends Error {
  readonly code = "aborted";
  constructor(readonly runner: string) {
    super(`aborted while waiting for the local model (${runner})`);
    this.name = "GateAbortedError";
  }
}

export interface AcquireRequest {
  bot: string;
  priority: Priority;
  /** The user's `/stop`: aborts a waiting request, and frees the slot of a running one. */
  signal?: AbortSignal | undefined;
  /** For the wait notice: where to say it. */
  conversationId?: string | undefined;
}

export interface ReleaseOutcome {
  /** The call ended in tool use: the same bot's next model call follows soon (stickiness). */
  continues?: boolean;
  /** Freed by `/stop` or an error: no stickiness. */
  aborted?: boolean;
}

export interface Lease {
  readonly runner: string;
  readonly bot: string;
  readonly priority: Priority;
  /** How long the request waited for the slot. */
  readonly waitedMs: number;
  release(outcome?: ReleaseOutcome): void;
}

export interface WaitNotice {
  runner: string;
  bot: string;
  priority: Priority;
  /** Requests ahead: the running ones plus the queued ones that would go first. */
  ahead: number;
  waitedMs: number;
  conversationId?: string | undefined;
}

/** The text of the wait notice. */
export function waitNoticeText(ahead: number): string {
  return `Waiting for the model (${ahead} ahead).`;
}

export interface RunnerGateOptions {
  runner: string;
  settings: GateTuning;
  /** Concurrent generations the runner serves. Strata: 1 (the default). */
  slots?: number;
  clock?: GateClock;
  logger?: Logger;
  /** Called once per qualifying wait; a throwing or rejecting handler is swallowed (it never blocks the gate). */
  onWait?: (notice: WaitNotice) => void | Promise<void>;
  /** Minimum seconds between two notices for the same bot. Default 60. */
  noticeCooldownSec?: number;
}

export interface RunnerGateStatus {
  runner: string;
  slots: number;
  running: { bot: string; priority: Priority; runningMs: number }[];
  /** Entries waiting for a slot. */
  queued: number;
  /** Waiting entries by base class P0 to P3. */
  byPriority: [number, number, number, number];
  oldestWaitMs: number;
  waiting: { bot: string; priority: Priority; effective: Priority; waitedMs: number }[];
  sticky?: { bot: string; remainingMs: number };
  /** Requests refused with `busy` since the gate was built. */
  busyRefused: number;
}

interface Waiter {
  resolve: (lease: Lease) => void;
  reject: (e: Error) => void;
  conversationId: string | undefined;
  granted: boolean;
  cleanup: () => void;
}

interface Running {
  bot: string;
  priority: Priority;
  startedAt: number;
}

interface Hold {
  bot: string;
  priority: Priority;
  until: number;
  cancel: () => void;
}

export class RunnerGate {
  readonly runner: string;
  readonly #slots: number;
  readonly #clock: GateClock;
  readonly #settings: GateTuning;
  readonly #queue: AgingQueue<Waiter>;
  readonly #running = new Map<number, Running>();
  readonly #runningBots = new Map<string, number>();
  readonly #lastNotice = new Map<string, number>();
  readonly #o: RunnerGateOptions;
  #leaseSeq = 0;
  #hold: Hold | undefined;
  #cancelWake: (() => void) | undefined;
  #busy = 0;

  constructor(opts: RunnerGateOptions) {
    this.#o = opts;
    this.runner = opts.runner;
    this.#slots = Math.max(1, Math.floor(opts.slots ?? 1));
    this.#clock = opts.clock ?? realClock;
    this.#settings = opts.settings;
    this.#queue = new AgingQueue<Waiter>(opts.settings.agingSec * 1000);
  }

  /** Resolves with a lease when the slot is yours; rejects with `GateBusyError` or `GateAbortedError`. Release the lease when the call ends. */
  acquire(req: AcquireRequest): Promise<Lease> {
    if (req.signal?.aborted) return Promise.reject(new GateAbortedError(this.runner));
    return new Promise<Lease>((resolve, reject) => {
      const now = this.#clock.now();
      const waiter: Waiter = { resolve, reject, conversationId: req.conversationId, granted: false, cleanup: () => undefined };
      const entry = this.#queue.add(req.priority, req.bot, now, waiter);

      const cancels: (() => void)[] = [];
      waiter.cleanup = () => {
        for (const c of cancels.splice(0)) c();
      };
      if (req.signal) {
        const onAbort = () => {
          if (!this.#queue.remove(entry)) return;
          waiter.cleanup();
          reject(new GateAbortedError(this.runner));
          this.#pump();
        };
        req.signal.addEventListener("abort", onAbort, { once: true });
        cancels.push(() => req.signal?.removeEventListener("abort", onAbort));
      }
      const noticeMs = this.#settings.waitNoticeSec * 1000;
      if (req.priority <= 1 && noticeMs > 0 && this.#o.onWait) {
        cancels.push(this.#clock.setTimer(noticeMs, () => this.#notice(entry)));
      }

      this.#pump();

      if (!waiter.granted && req.priority >= 2 && this.#queue.size > this.#settings.maxQueueDepth) {
        this.#queue.remove(entry);
        waiter.cleanup();
        this.#busy++;
        this.#o.logger?.warn("gate.busy", { runner: this.runner, bot: req.bot, priority: req.priority, queued: this.#queue.size, limit: this.#settings.maxQueueDepth });
        reject(new GateBusyError(this.runner, this.#queue.size, this.#settings.maxQueueDepth));
        this.#pump();
      }
    });
  }

  status(): RunnerGateStatus {
    const now = this.#clock.now();
    const waiting = this.#queue.order(now).map((e) => ({ bot: e.bot, priority: e.priority, effective: this.#queue.effective(e, now), waitedMs: now - e.enqueuedAt }));
    const hold = this.#liveHold(now);
    return {
      runner: this.runner,
      slots: this.#slots,
      running: [...this.#running.values()].map((r) => ({ bot: r.bot, priority: r.priority, runningMs: now - r.startedAt })),
      queued: this.#queue.size,
      byPriority: this.#queue.counts(),
      oldestWaitMs: this.#queue.oldestWaitMs(now),
      waiting,
      ...(hold ? { sticky: { bot: hold.bot, remainingMs: hold.until - now } } : {}),
      busyRefused: this.#busy,
    };
  }

  // ---- internals ---------------------------------------------------------------------------------------------------------

  #liveHold(now: number): Hold | undefined {
    const h = this.#hold;
    if (h && h.until <= now) {
      this.#clearHold();
      return undefined;
    }
    return h;
  }

  #clearHold(): void {
    this.#hold?.cancel();
    this.#hold = undefined;
  }

  #notice(entry: Queued<Waiter>): void {
    if (entry.item.granted || !this.#queue.has(entry)) return;
    const now = this.#clock.now();
    const cooldownMs = (this.#o.noticeCooldownSec ?? 60) * 1000;
    const last = this.#lastNotice.get(entry.bot);
    if (last !== undefined && now - last < cooldownMs) return;
    this.#lastNotice.set(entry.bot, now);
    const notice: WaitNotice = {
      runner: this.runner,
      bot: entry.bot,
      priority: entry.priority,
      ahead: this.#running.size + this.#queue.rank(entry, now),
      waitedMs: now - entry.enqueuedAt,
      conversationId: entry.item.conversationId,
    };
    this.#o.logger?.info("gate.wait_notice", { runner: this.runner, bot: entry.bot, priority: entry.priority, ahead: notice.ahead });
    try {
      void Promise.resolve(this.#o.onWait?.(notice)).catch(() => undefined);
    } catch {
      /* a notifier failure never blocks the gate */
    }
  }

  #pump(): void {
    while (this.#running.size < this.#slots) {
      const now = this.#clock.now();
      const eligible = (e: Queued<Waiter>) => !this.#runningBots.has(e.bot);
      let next = this.#queue.pick(now, eligible);
      if (!next) return;
      const hold = this.#liveHold(now);
      if (hold && next.bot !== hold.bot) {
        const breaks = this.#queue.effective(next, now) < hold.priority || (this.#settings.agingSec > 0 && now - next.enqueuedAt >= this.#settings.agingSec * 1000);
        if (!breaks) {
          const mine = this.#queue.pick(now, (e) => eligible(e) && e.bot === hold.bot);
          if (!mine) {
            this.#scheduleWake(now); // keep the slot for the sticky bot; the window's timer or the wake below pumps again
            return;
          }
          next = mine;
        }
      }
      this.#clearHold();
      this.#grant(next, now);
    }
  }

  /** While a hold keeps other entries out, look again when the oldest of them has waited one aging step (it then outranks the hold). */
  #scheduleWake(now: number): void {
    this.#cancelWake?.();
    this.#cancelWake = undefined;
    const agingMs = this.#settings.agingSec * 1000;
    if (agingMs <= 0) return;
    let oldest = Number.POSITIVE_INFINITY;
    for (const e of this.#queue.entries()) oldest = Math.min(oldest, e.enqueuedAt);
    if (!Number.isFinite(oldest)) return;
    const wake = this.#clock.setTimer(Math.max(0, oldest + agingMs - now), () => {
      this.#cancelWake = undefined;
      this.#pump();
    });
    this.#cancelWake = wake;
  }

  #grant(entry: Queued<Waiter>, now: number): void {
    this.#queue.remove(entry);
    entry.item.granted = true;
    entry.item.cleanup();
    const id = ++this.#leaseSeq;
    this.#running.set(id, { bot: entry.bot, priority: entry.priority, startedAt: now });
    this.#runningBots.set(entry.bot, (this.#runningBots.get(entry.bot) ?? 0) + 1);
    let released = false;
    const lease: Lease = {
      runner: this.runner,
      bot: entry.bot,
      priority: entry.priority,
      waitedMs: now - entry.enqueuedAt,
      release: (outcome) => {
        if (released) return;
        released = true;
        this.#running.delete(id);
        const n = (this.#runningBots.get(entry.bot) ?? 1) - 1;
        if (n <= 0) this.#runningBots.delete(entry.bot);
        else this.#runningBots.set(entry.bot, n);
        const stickyMs = this.#settings.stickinessSec * 1000;
        if (outcome?.continues && !outcome.aborted && stickyMs > 0 && this.#slots === 1) this.#setHold(entry.bot, entry.priority, stickyMs);
        this.#pump();
      },
    };
    entry.item.resolve(lease);
  }

  /**
   * Ends the stickiness hold if it belongs to `bot` (S26): a bot that asks a peer on the SAME runner would otherwise keep the slot reserved for
   * its next call while the peer's turn waits for it (a wait of up to `stickinessSec` per ask). A hold of another bot is left alone.
   */
  dropHold(bot: string): boolean {
    if (!this.#hold || this.#hold.bot !== bot) return false;
    this.#clearHold();
    this.#pump();
    return true;
  }

  #setHold(bot: string, priority: Priority, ms: number): void {
    this.#clearHold();
    const hold: Hold = {
      bot,
      priority,
      until: this.#clock.now() + ms,
      cancel: this.#clock.setTimer(ms, () => {
        if (this.#hold !== hold) return;
        this.#hold = undefined;
        this.#pump();
      }),
    };
    this.#hold = hold;
  }
}

// ---- the set of runner gates ---------------------------------------------------------------------------------------------

export const DEFAULT_GATED_RUNNERS: readonly string[] = ["lmstudio", "strata"];

export interface LocalGateOptions {
  settings: GateTuning;
  /** Provider ids that get a gate (default `lmstudio` and `strata`), each with an optional slot count. */
  runners?: readonly string[] | Readonly<Record<string, { slots?: number }>>;
  clock?: GateClock;
  logger?: Logger;
  onWait?: (notice: WaitNotice) => void | Promise<void>;
  noticeCooldownSec?: number;
}

export interface GateStatus {
  runners: RunnerGateStatus[];
}

/** One gate per local runner, shared by every bot in the process. The provider id of a model (`lmstudio`, `strata`) names its gate. */
export class LocalGate {
  readonly #gates = new Map<string, RunnerGate>();

  constructor(opts: LocalGateOptions) {
    const spec = opts.runners ?? DEFAULT_GATED_RUNNERS;
    const entries: [string, { slots?: number }][] = Array.isArray(spec) ? (spec as readonly string[]).map((r) => [r, {}]) : Object.entries(spec as Record<string, { slots?: number }>);
    for (const [runner, o] of entries) {
      this.#gates.set(
        runner,
        new RunnerGate({
          runner,
          settings: opts.settings,
          ...(o.slots !== undefined ? { slots: o.slots } : {}),
          ...(opts.clock ? { clock: opts.clock } : {}),
          ...(opts.logger ? { logger: opts.logger } : {}),
          ...(opts.onWait ? { onWait: opts.onWait } : {}),
          ...(opts.noticeCooldownSec !== undefined ? { noticeCooldownSec: opts.noticeCooldownSec } : {}),
        }),
      );
    }
  }

  /** Ends `bot`'s stickiness hold on every runner (see `RunnerGate.dropHold`). */
  dropHold(bot: string): void {
    for (const g of this.#gates.values()) g.dropHold(bot);
  }

  /** The gate for a provider id, or undefined for a provider that is not gated (the proxy has its own limiter, S23). */
  runner(providerId: string): RunnerGate | undefined {
    return this.#gates.get(providerId);
  }

  runners(): string[] {
    return [...this.#gates.keys()];
  }

  status(): GateStatus {
    return { runners: [...this.#gates.values()].map((g) => g.status()) };
  }
}
