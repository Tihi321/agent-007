/**
 * S23.3: the bot-side limiter in front of the proxy (plan I40, I44).
 *
 * The proxy has one strict FIFO per provider with a cap of 4, shared with creative-hub's apps. So this host keeps its own limit per
 * provider (default 3, never above 4) and a per-bot concurrency of 1, and it orders waiting calls by the I44 priority classes:
 * P0 the user's own message, P1 a turn in a user-started chain, P2 a peer-initiated or background turn, P3 summaries and compaction.
 * Non-preemptive (a running call is never cut), aged (a waiting call rises one class per `agingMs`, so P3 cannot starve), and a depth
 * cap (a P2 or P3 call beyond `maxQueue` is refused with `LimiterBusyError`; P0 and P1 always queue).
 *
 * Pure and offline: no network, an injectable clock.
 */
import { ProxyError, failureOf } from "./errors.js";

/** 0 is the most urgent. */
export type Priority = 0 | 1 | 2 | 3;

export const PRIORITIES: readonly Priority[] = [0, 1, 2, 3];

/** The proxy's own default cap per provider; this host never goes above it. */
export const PROXY_HARD_CAP = 4;
export const DEFAULT_PROVIDER_LIMIT = 3;

/** The limit actually used: an integer from 1 to 4 (a missing or silly value gives the default 3). */
export function clampProviderLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_PROVIDER_LIMIT;
  return Math.min(Math.max(Math.floor(n), 1), PROXY_HARD_CAP);
}

/** Thrown by `acquire` when the depth cap refuses a P2 or P3 call. */
export class LimiterBusyError extends ProxyError {
  constructor() {
    super(failureOf("limiter_busy"));
    this.name = "LimiterBusyError";
  }
}

export interface LimiterOptions {
  /** Concurrent calls to the provider (clamped to 1..4, default 3). */
  limit?: number;
  /** Concurrent calls per bot (default 1). */
  perBotLimit?: number;
  /** Waiting calls beyond which P2 and P3 are refused (default 8, the gate's `maxQueueDepth`). */
  maxQueue?: number;
  /** A waiting call rises one priority class per this many ms (default 60 000, the gate's `agingSec`). 0 turns aging off. */
  agingMs?: number;
  now?: () => number;
}

export interface AcquireRequest {
  botId: string;
  priority: Priority;
  signal?: AbortSignal | undefined;
}

export type Release = () => void;

export interface LimiterStats {
  limit: number;
  active: number;
  queued: number;
  /** Queued calls per priority class (index = class). */
  queuedByPriority: [number, number, number, number];
}

interface Waiter {
  seq: number;
  botId: string;
  priority: Priority;
  enqueuedAt: number;
  grant: (release: Release) => void;
  fail: (e: unknown) => void;
  cleanup: () => void;
}

function abortError(): Error {
  const e = new Error("the request was aborted while waiting for the proxy");
  e.name = "AbortError";
  return e;
}

/** One limiter per provider id, shared by every bot of the host. */
export class ProviderLimiter {
  readonly limit: number;
  readonly #perBot: number;
  readonly #maxQueue: number;
  readonly #aging: number;
  readonly #now: () => number;
  readonly #waiting: Waiter[] = [];
  readonly #activeByBot = new Map<string, number>();
  #active = 0;
  #seq = 0;

  constructor(opts: LimiterOptions = {}) {
    this.limit = clampProviderLimit(opts.limit);
    this.#perBot = Math.max(1, Math.floor(opts.perBotLimit ?? 1));
    this.#maxQueue = Math.max(0, Math.floor(opts.maxQueue ?? 8));
    this.#aging = Math.max(0, opts.agingMs ?? 60_000);
    this.#now = opts.now ?? Date.now;
  }

  /** Resolves with a release function once a slot is free. Rejects with `AbortError` or `LimiterBusyError`. Release exactly once (extra calls are ignored). */
  acquire(req: AcquireRequest): Promise<Release> {
    if (req.signal?.aborted) return Promise.reject(abortError());
    // Every pump leaves only waiters that are blocked (the provider is full, or their own bot is running), so a free slot for this bot means nobody is ahead of it.
    if (this.#canStart(req.botId)) return Promise.resolve(this.#start(req.botId));
    if (req.priority >= 2 && this.#waiting.length >= this.#maxQueue) return Promise.reject(new LimiterBusyError());
    return new Promise<Release>((resolve, reject) => {
      const w: Waiter = {
        seq: this.#seq++,
        botId: req.botId,
        priority: req.priority,
        enqueuedAt: this.#now(),
        grant: resolve,
        fail: reject,
        cleanup: () => req.signal?.removeEventListener("abort", onAbort),
      };
      const onAbort = (): void => {
        const i = this.#waiting.indexOf(w);
        if (i < 0) return;
        this.#waiting.splice(i, 1);
        w.cleanup();
        w.fail(abortError());
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiting.push(w);
      this.#pump();
    });
  }

  stats(): LimiterStats {
    const byPriority: [number, number, number, number] = [0, 0, 0, 0];
    for (const w of this.#waiting) byPriority[w.priority]++;
    return { limit: this.limit, active: this.#active, queued: this.#waiting.length, queuedByPriority: byPriority };
  }

  #canStart(botId: string): boolean {
    return this.#active < this.limit && (this.#activeByBot.get(botId) ?? 0) < this.#perBot;
  }

  #start(botId: string): Release {
    this.#active++;
    this.#activeByBot.set(botId, (this.#activeByBot.get(botId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      const n = (this.#activeByBot.get(botId) ?? 1) - 1;
      if (n <= 0) this.#activeByBot.delete(botId);
      else this.#activeByBot.set(botId, n);
      this.#pump();
    };
  }

  /** The class a waiter counts as now: its own, minus one per `agingMs` waited (never below P0). */
  #effective(w: Waiter, now: number): number {
    if (this.#aging === 0) return w.priority;
    return Math.max(0, w.priority - Math.floor((now - w.enqueuedAt) / this.#aging));
  }

  #pump(): void {
    for (;;) {
      if (this.#active >= this.limit) return;
      const now = this.#now();
      let best: Waiter | undefined;
      let bestEff = 99;
      for (const w of this.#waiting) {
        if ((this.#activeByBot.get(w.botId) ?? 0) >= this.#perBot) continue; // that bot already has its call running
        const eff = this.#effective(w, now);
        if (best === undefined || eff < bestEff || (eff === bestEff && w.seq < best.seq)) {
          best = w;
          bestEff = eff;
        }
      }
      if (best === undefined) return;
      this.#waiting.splice(this.#waiting.indexOf(best), 1);
      best.cleanup();
      best.grant(this.#start(best.botId));
    }
  }
}

export interface ProxyLimitersOptions {
  /** The limit for a provider id (default: `defaultLimit` for all). Clamped to 1..4. */
  limitFor?: (providerId: string) => number | undefined;
  /** The `gate.proxyMaxConcurrent` value (default 3). */
  defaultLimit?: number;
  perBotLimit?: number;
  maxQueue?: number;
  agingMs?: number;
  now?: () => number;
}

/** The host's set of limiters, one per provider id, created on first use. Construct ONE per host and share it between the bots. */
export class ProxyLimiters {
  readonly #opts: ProxyLimitersOptions;
  readonly #byProvider = new Map<string, ProviderLimiter>();

  constructor(opts: ProxyLimitersOptions = {}) {
    this.#opts = opts;
  }

  for(providerId: string): ProviderLimiter {
    let l = this.#byProvider.get(providerId);
    if (!l) {
      const limit = this.#opts.limitFor?.(providerId) ?? this.#opts.defaultLimit;
      l = new ProviderLimiter({
        ...(limit !== undefined ? { limit } : {}),
        ...(this.#opts.perBotLimit !== undefined ? { perBotLimit: this.#opts.perBotLimit } : {}),
        ...(this.#opts.maxQueue !== undefined ? { maxQueue: this.#opts.maxQueue } : {}),
        ...(this.#opts.agingMs !== undefined ? { agingMs: this.#opts.agingMs } : {}),
        ...(this.#opts.now ? { now: this.#opts.now } : {}),
      });
      this.#byProvider.set(providerId, l);
    }
    return l;
  }

  /** `/status` data: active, queued and limit per provider that has been used. */
  stats(): Record<string, LimiterStats> {
    return Object.fromEntries([...this.#byProvider].map(([id, l]) => [id, l.stats()]));
  }
}
