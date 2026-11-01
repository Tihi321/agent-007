/**
 * Bus limits (S21.3, I33): per-chain budgets (messages, time, tokens) and per-edge limits (one in flight, a minimum gap, a daily cap,
 * a circuit breaker). Every refusal is a typed `BusError`; the numbers come from `botBus` in `security.json` (UI-30).
 *
 * Counters live in memory (a restart resets the gap, daily and breaker counters; the chain budget is persisted with the chain
 * record, see `chains.ts`). The message budget counts ASKS, not replies.
 *
 * Pure: no fs, no timers; time is passed in.
 */
import type { BotBusLimits } from "../bots/schema.js";
import { BusError } from "./contracts.js";
import type { BudgetLeft } from "./contracts.js";

export interface ChainUsage {
  messages: number;
  startedAt: number;
  tokens: number;
}

/** Throws `budget_exhausted` (reason `messages`, `seconds` or `tokens`) when the chain may not send another ask. */
export function checkChainBudget(usage: ChainUsage, limits: BotBusLimits, now: number): void {
  if (usage.messages >= limits.chainMaxMessages) throw new BusError("budget_exhausted", "messages");
  if (now - usage.startedAt >= limits.chainMaxSeconds * 1000) throw new BusError("budget_exhausted", "seconds");
  if (usage.tokens >= limits.chainMaxTokens) throw new BusError("budget_exhausted", "tokens");
}

export function budgetLeft(usage: ChainUsage, limits: BotBusLimits, now: number): BudgetLeft {
  return {
    messages: Math.max(0, limits.chainMaxMessages - usage.messages),
    seconds: Math.max(0, Math.floor(limits.chainMaxSeconds - (now - usage.startedAt) / 1000)),
    tokens: Math.max(0, limits.chainMaxTokens - usage.tokens),
  };
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface EdgeStatus {
  from: string;
  to: string;
  inFlight: boolean;
  today: number;
  recent: number;
  pausedUntil?: number;
}

interface EdgeState {
  inFlight: boolean;
  lastAskAt?: number;
  day: string;
  today: number;
  asks: number[];
  pausedUntil?: number;
  noticed: boolean;
}

export interface EdgeLimitsOptions {
  limits: BotBusLimits;
  now: () => number;
  /** Called once when the breaker of an edge trips (the user gets one notice). */
  onTrip?: (from: string, to: string) => void;
}

/** One instance per bus. `admit` reserves the edge (throws a `BusError`), the returned function releases the in-flight slot. */
export class EdgeLimits {
  private readonly edges = new Map<string, EdgeState>();
  constructor(private readonly o: EdgeLimitsOptions) {}

  private state(from: string, to: string): EdgeState {
    const key = `${from}>${to}`;
    let s = this.edges.get(key);
    if (!s) {
      s = { inFlight: false, day: utcDay(this.o.now()), today: 0, asks: [], noticed: false };
      this.edges.set(key, s);
    }
    return s;
  }

  admit(from: string, to: string, onTrip?: (from: string, to: string) => void): () => void {
    const { limits } = this.o;
    const now = this.o.now();
    const s = this.state(from, to);
    if (utcDay(now) !== s.day) {
      s.day = utcDay(now);
      s.today = 0;
    }
    if (s.pausedUntil !== undefined) {
      if (now < s.pausedUntil) throw new BusError("budget_exhausted", "edge_paused");
      delete s.pausedUntil;
      s.noticed = false;
      s.asks = [];
    }
    if (s.inFlight) throw new BusError("busy", "in_flight");
    if (s.lastAskAt !== undefined && now - s.lastAskAt < limits.edgeMinGapSec * 1000) throw new BusError("busy", "gap");
    if (s.today >= limits.edgeDailyCap) throw new BusError("budget_exhausted", "edge_daily_cap");
    const windowMs = limits.breakerWindowMin * 60_000;
    s.asks = s.asks.filter((t) => now - t < windowMs);
    if (s.asks.length >= limits.breakerAsks) {
      s.pausedUntil = now + windowMs;
      if (!s.noticed) {
        s.noticed = true;
        (onTrip ?? this.o.onTrip)?.(from, to);
      }
      throw new BusError("budget_exhausted", "edge_paused");
    }
    s.inFlight = true;
    s.lastAskAt = now;
    s.today += 1;
    s.asks.push(now);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      s.inFlight = false;
    };
  }

  status(): EdgeStatus[] {
    const out: EdgeStatus[] = [];
    for (const [key, s] of this.edges) {
      const [from = "", to = ""] = key.split(">");
      out.push({ from, to, inFlight: s.inFlight, today: s.today, recent: s.asks.length, ...(s.pausedUntil !== undefined ? { pausedUntil: s.pausedUntil } : {}) });
    }
    return out;
  }
}
