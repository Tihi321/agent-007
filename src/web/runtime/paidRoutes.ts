/**
 * Paid-route spending caps (M2, plan section 0a item 6, invariant I58). A paid preset (`billing: "paid"`: DeepSeek API, Anthropic API
 * credits, Gemini through the proxy) is OFF for every bot until the OWNER enables it for that one bot with a per-day and a per-month cap.
 * Caps and usage are counted in tokens (input + output, as the endpoint reports them): the gateway has no price table, so a token cap is
 * the spending bound the owner sets. The cap is a hard stop: a turn starts only with headroom, the engine clamps `max_tokens` to the
 * headroom and ends the answer when it is used up, and the chain then falls back (cloud fallback, then local) or refuses with a message.
 *
 * Stores: `web\paid-routes.json` (owner-written grants, validated, fail closed) and `users\<userId>\paid-usage.json` (the gateway's own
 * ledger per bot and preset, day and month in UTC). Every grant change and every paid turn is audited with ids and numbers only.
 */
import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";
import { PRESET_ID_PATTERN } from "../../bots/schema.js";
import type { WebAudit } from "../audit.js";
import { isUserId, isWebBotId } from "../ids.js";
import { userPaths } from "../paths.js";
import { JsonStore, atomicWriteJson } from "../store.js";

export const PAID_MAX_TOKENS_PER_MONTH = 1_000_000_000;

export interface PaidGrant {
  userId: string;
  botId: string;
  preset: string;
  perDay: number;
  perMonth: number;
  enabledAt: number;
  enabledBy: string;
}

export interface PaidRoutesFile {
  schemaVersion: 1;
  grants: PaidGrant[];
}

export class PaidRouteError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PaidRouteError";
    this.status = status;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const intIn = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

export function parsePaidRoutesFile(v: unknown): PaidRoutesFile {
  if (!isObj(v) || v["schemaVersion"] !== 1 || !Array.isArray(v["grants"]) || Object.keys(v).length !== 2) throw new Error("paid-routes.json: must be { schemaVersion: 1, grants: [...] }");
  if (v["grants"].length > 2000) throw new Error("paid-routes.json: too many grants");
  const seen = new Set<string>();
  const grants = v["grants"].map((g, i): PaidGrant => {
    const at = `grants[${i}]`;
    if (!isObj(g) || Object.keys(g).sort().join(",") !== "botId,enabledAt,enabledBy,perDay,perMonth,preset,userId") throw new Error(`${at}: wrong keys`);
    if (!isUserId(g["userId"]) || !isWebBotId(g["botId"]) || typeof g["preset"] !== "string" || !PRESET_ID_PATTERN.test(g["preset"])) throw new Error(`${at}: bad ids`);
    if (!intIn(g["perDay"], 1, PAID_MAX_TOKENS_PER_MONTH) || !intIn(g["perMonth"], 1, PAID_MAX_TOKENS_PER_MONTH) || g["perDay"] > g["perMonth"]) throw new Error(`${at}: caps must be whole numbers, 1 or more, the day cap at most the month cap`);
    if (!intIn(g["enabledAt"], 0, 8_640_000_000_000_000) || !isUserId(g["enabledBy"])) throw new Error(`${at}: bad metadata`);
    const key = `${g["userId"]}/${g["botId"]}/${g["preset"]}`;
    if (seen.has(key)) throw new Error(`${at}: duplicate grant`);
    seen.add(key);
    return { userId: g["userId"], botId: g["botId"], preset: g["preset"], perDay: g["perDay"], perMonth: g["perMonth"], enabledAt: g["enabledAt"], enabledBy: g["enabledBy"] };
  });
  return { schemaVersion: 1, grants };
}

export const paidRoutesStore = (webDir: string): JsonStore<PaidRoutesFile> => new JsonStore("paid-routes.json", win32.join(webDir, "paid-routes.json"), parsePaidRoutesFile, () => ({ schemaVersion: 1, grants: [] }));

interface UsageEntry {
  day: string;
  dayTokens: number;
  month: string;
  monthTokens: number;
}

export interface PaidUsage {
  dayTokens: number;
  monthTokens: number;
}

export interface PaidStatus extends PaidUsage {
  preset: string;
  enabled: boolean;
  perDay: number;
  perMonth: number;
  /** Tokens left before the nearer cap; 0 when off or used up. */
  headroom: number;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

export class PaidRoutes {
  readonly store: JsonStore<PaidRoutesFile>;
  readonly #dataDir: string;
  readonly #audit: WebAudit;
  readonly #now: () => number;

  constructor(o: { dataDir: string; webDir: string; audit: WebAudit; now?: () => number }) {
    this.store = paidRoutesStore(o.webDir);
    this.#dataDir = o.dataDir;
    this.#audit = o.audit;
    this.#now = o.now ?? Date.now;
  }

  grant(userId: string, botId: string, preset: string): PaidGrant | undefined {
    try {
      return this.store.read().grants.find((g) => g.userId === userId && g.botId === botId && g.preset === preset);
    } catch {
      return undefined; // a corrupt grants file enables nothing (fail closed)
    }
  }

  /** Owner only (checked by the route). `enabled: false` removes the grant; the usage ledger stays. */
  setGrant(actorId: string, req: { userId: unknown; botId: unknown; preset: unknown; enabled: unknown; perDay?: unknown; perMonth?: unknown }, isPaid: (preset: string) => boolean): PaidGrant | undefined {
    const { userId, botId, preset } = req;
    if (!isUserId(userId) || !isWebBotId(botId) || typeof preset !== "string" || !PRESET_ID_PATTERN.test(preset)) throw new PaidRouteError(404, "No such bot or model.");
    if (!isPaid(preset)) throw new PaidRouteError(400, "That model is not a paid route.");
    if (req.enabled !== true) {
      this.store.update((d) => {
        d.grants = d.grants.filter((g) => !(g.userId === userId && g.botId === botId && g.preset === preset));
      });
      this.#audit.write({ kind: "paid_grant", user: actorId, detail: { target: userId, bot: botId, preset, enabled: false } });
      return undefined;
    }
    if (!intIn(req.perDay, 1, PAID_MAX_TOKENS_PER_MONTH) || !intIn(req.perMonth, 1, PAID_MAX_TOKENS_PER_MONTH)) throw new PaidRouteError(400, "Set both caps: tokens per day and per month (whole numbers, 1 or more).");
    if (req.perDay > req.perMonth) throw new PaidRouteError(400, "The day cap cannot be above the month cap.");
    const g: PaidGrant = { userId, botId, preset, perDay: req.perDay, perMonth: req.perMonth, enabledAt: this.#now(), enabledBy: actorId };
    this.store.update((d) => {
      d.grants = d.grants.filter((x) => !(x.userId === userId && x.botId === botId && x.preset === preset));
      d.grants.push(g);
    });
    this.#audit.write({ kind: "paid_grant", user: actorId, detail: { target: userId, bot: botId, preset, enabled: true, perDay: g.perDay, perMonth: g.perMonth } });
    return g;
  }

  /** Drops every grant of a bot (the bot was deleted) or of a user (the user was deleted). */
  dropFor(userId: string, botId?: string): void {
    try {
      this.store.update((d) => {
        d.grants = d.grants.filter((g) => !(g.userId === userId && (botId === undefined || g.botId === botId)));
      });
    } catch {
      /* a corrupt file is refused at the next read anyway */
    }
  }

  #ledgerFile(userId: string): string {
    return win32.join(userPaths(this.#dataDir, userId).root, "paid-usage.json");
  }

  #ledger(userId: string): Map<string, UsageEntry> {
    const m = new Map<string, UsageEntry>();
    const f = this.#ledgerFile(userId);
    if (!existsSync(f)) return m;
    try {
      const raw = JSON.parse(readFileSync(f, "utf8")) as unknown;
      if (!isObj(raw) || !isObj(raw["entries"])) throw new Error("bad ledger");
      for (const [k, v] of Object.entries(raw["entries"])) {
        const ok = /^[a-z][a-z0-9-]{1,23}\/[A-Za-z0-9._-]+$/.test(k) && isObj(v) && typeof v["day"] === "string" && typeof v["month"] === "string" && intIn(v["dayTokens"], 0, Number.MAX_SAFE_INTEGER) && intIn(v["monthTokens"], 0, Number.MAX_SAFE_INTEGER);
        if (!ok) throw new Error("bad ledger");
        m.set(k, { day: v["day"] as string, dayTokens: v["dayTokens"] as number, month: v["month"] as string, monthTokens: v["monthTokens"] as number });
      }
    } catch {
      // a damaged ledger must not reset spending to zero: count every entry as used up until the owner looks (fail closed)
      m.set("*", { day: dayOf(this.#now()), dayTokens: Number.MAX_SAFE_INTEGER, month: monthOf(this.#now()), monthTokens: Number.MAX_SAFE_INTEGER });
    }
    return m;
  }

  usage(userId: string, botId: string, preset: string): PaidUsage {
    const l = this.#ledger(userId);
    const e = l.get("*") ?? l.get(`${botId}/${preset}`);
    const now = this.#now();
    return { dayTokens: e && e.day === dayOf(now) ? e.dayTokens : 0, monthTokens: e && e.month === monthOf(now) ? e.monthTokens : 0 };
  }

  status(userId: string, botId: string, preset: string): PaidStatus {
    const g = this.grant(userId, botId, preset);
    const u = this.usage(userId, botId, preset);
    const headroom = g ? Math.max(0, Math.min(g.perDay - u.dayTokens, g.perMonth - u.monthTokens)) : 0;
    return { preset, enabled: g !== undefined, perDay: g?.perDay ?? 0, perMonth: g?.perMonth ?? 0, ...u, headroom };
  }

  /** Adds a turn's tokens to the bot's ledger and audits it; a turn that reaches a cap is audited as `paid_cap_hit`. */
  record(userId: string, botId: string, preset: string, tokens: number): PaidStatus {
    const now = this.#now();
    const l = this.#ledger(userId);
    if (!l.has("*")) {
      const key = `${botId}/${preset}`;
      const e = l.get(key);
      const day = dayOf(now);
      const month = monthOf(now);
      const n = Math.max(0, Math.ceil(tokens));
      l.set(key, { day, dayTokens: (e && e.day === day ? e.dayTokens : 0) + n, month, monthTokens: (e && e.month === month ? e.monthTokens : 0) + n });
      atomicWriteJson(this.#ledgerFile(userId), { entries: Object.fromEntries(l) });
    }
    const s = this.status(userId, botId, preset);
    this.#audit.write({ kind: "paid_usage", user: userId, detail: { bot: botId, preset, tokens: Math.ceil(tokens), day: s.dayTokens, month: s.monthTokens } });
    if (s.enabled && s.headroom === 0) this.#audit.write({ kind: "paid_cap_hit", user: userId, detail: { bot: botId, preset, which: s.dayTokens >= s.perDay ? "day" : "month" } });
    return s;
  }
}
