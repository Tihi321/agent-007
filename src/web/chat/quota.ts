/** Daily usage of ONE user (S34): chats started and tokens used today, in `users\<userId>\quota.json`, against the caps the owner set. */
import { existsSync, readFileSync } from "node:fs";
import { userPaths } from "../paths.js";
import type { Caps } from "../schemas.js";
import { atomicWriteJson } from "../store.js";

export interface QuotaState {
  day: string;
  chats: number;
  tokens: number;
}

export class QuotaError extends Error {
  readonly status = 429;
  readonly which: "chats" | "tokens";
  constructor(which: "chats" | "tokens", message: string) {
    super(message);
    this.name = "QuotaError";
    this.which = which;
  }
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class QuotaStore {
  readonly #file: string;
  readonly #now: () => number;

  constructor(dataDir: string, userId: string, now: () => number = Date.now) {
    this.#file = userPaths(dataDir, userId).quotaFile;
    this.#now = now;
  }

  state(): QuotaState {
    const day = dayOf(this.#now());
    try {
      if (existsSync(this.#file)) {
        const s = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<QuotaState>;
        if (s.day === day && typeof s.chats === "number" && typeof s.tokens === "number") return { day, chats: s.chats, tokens: s.tokens };
      }
    } catch {
      /* a damaged quota file counts as a new day: it can only help the user, and the caps still bound each turn */
    }
    return { day, chats: 0, tokens: 0 };
  }

  /** Throws a `QuotaError` with a plain message when the day's chats or tokens are used up. */
  check(caps: Pick<Caps, "maxChatsPerDay" | "maxTokensPerDay">): QuotaState {
    const s = this.state();
    if (s.chats >= caps.maxChatsPerDay) throw new QuotaError("chats", `You have used all ${caps.maxChatsPerDay} messages for today. It resets at midnight UTC.`);
    if (s.tokens >= caps.maxTokensPerDay) throw new QuotaError("tokens", `You have used today's allowance of ${caps.maxTokensPerDay} tokens. It resets at midnight UTC.`);
    return s;
  }

  record(delta: { chats?: number; tokens?: number }): QuotaState {
    const s = this.state();
    s.chats += delta.chats ?? 0;
    s.tokens += delta.tokens ?? 0;
    atomicWriteJson(this.#file, s);
    return s;
  }
}
