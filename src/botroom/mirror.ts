/**
 * The bot room mirror (S24.1, I37, UI-27). A WRITE-ONLY projection of bot-to-bot traffic into one Telegram group or channel,
 * posted by one extra "mirror bot" through the grammY `Api` only.
 *
 * Hard properties (each has a test):
 *  - it never reads: no `getUpdates`, no `bot.start()`, no handlers, no `Bot` object at all; nothing from the room reaches a bot;
 *  - it never blocks or fails the bus: the audit listener only formats and queues, synchronously, inside a try/catch;
 *    posting is a separate timer-driven loop whose errors are counted and logged (content-free), never thrown;
 *  - it is rate limited: lines are batched into posts of a few lines, at most `maxPerMinute` posts in any 60 s (default 15; Telegram's
 *    group limit is 20; never above 20), spaced evenly; a burst beyond the bounded queue is dropped and reported as ONE
 *    "dropped n" line in the next post;
 *  - a 429 pauses posting for `retry_after` and retries the same post once; a second failure drops it (no retry loop);
 *  - text is redacted and truncated per UI-27 (`format.ts`); approvals, tokens and secrets are never in the input.
 */
import { Api } from "grammy";
import type { BotRoomSettings } from "../bots/schema.js";
import type { Logger } from "../contracts.js";
import { createRedactor } from "../logging/redact.js";
import type { Redactor } from "../logging/redact.js";
import { droppedNotice, formatLine, isMirrored, takeBatch } from "./format.js";
import type { BusAuditEvent } from "./format.js";

/** The read-only side of the bus the mirror subscribes to (S26 adapts S21's audit stream to it). Returns an unsubscribe function. */
export interface BusAuditSource {
  subscribe(listener: (event: BusAuditEvent) => void): () => void;
}

/** The only grammY surface used. */
export type RoomApi = Pick<Api, "sendMessage">;

export interface MirrorTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface BotRoomMirrorOptions {
  source: BusAuditSource;
  api: RoomApi;
  settings: BotRoomSettings;
  chatId: number;
  redact: Redactor;
  logger: Logger;
  now?: () => number;
  timers?: MirrorTimers;
  /** Lines gathered before the first post of an idle period. Default 2000 ms. */
  batchWindowMs?: number;
  /** Lines per post. Default 5. */
  linesPerPost?: number;
}

export interface MirrorStats {
  /** Posts that Telegram accepted. */
  posts: number;
  /** Lines inside those posts. */
  postedLines: number;
  /** Lines cut because the queue was full (reported as one notice line). */
  droppedLines: number;
  /** Posts that failed twice or with a non-retryable error, and the lines they held. */
  failedPosts: number;
  failedLines: number;
  /** Lines waiting. */
  queued: number;
  /** Events seen but not mirrored (a kind the room never shows). */
  ignored: number;
}

export interface BotRoomMirror {
  /** Subscribes to the bus audit stream. Idempotent. */
  start(): void;
  /** Unsubscribes and cancels timers. Queued lines are discarded (a stopping host never waits on Telegram). */
  stop(): void;
  stats(): MirrorStats;
}

export const HARD_MAX_PER_MINUTE = 20;
const MAX_RETRY_AFTER_MS = 300_000;
const MAX_BACKOFF_MS = 60_000;

const realTimers: MirrorTimers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

interface Held {
  text: string;
  lines: number;
  attempts: number;
}

function retryAfterMs(e: unknown): number | undefined {
  const err = e as { error_code?: unknown; parameters?: { retry_after?: unknown } } | undefined;
  if (err?.error_code !== 429) return undefined;
  const s = err.parameters?.retry_after;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, (typeof s === "number" && Number.isFinite(s) ? s : 5) * 1000));
}

function errorCode(e: unknown): number | string {
  const err = e as { error_code?: unknown; name?: unknown } | undefined;
  return typeof err?.error_code === "number" ? err.error_code : typeof err?.name === "string" ? err.name : "error";
}

export function createBotRoomMirror(opts: BotRoomMirrorOptions): BotRoomMirror {
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? realTimers;
  const { logger, redact, api, chatId } = opts;
  const mode = opts.settings.mode === "summary" ? "summary" : "truncated";
  const maxChars = Math.max(20, Math.floor(opts.settings.maxChars));
  const perMinute = Math.min(HARD_MAX_PER_MINUTE, Math.max(1, Math.floor(opts.settings.maxPerMinute)));
  const gapMs = Math.ceil(60_000 / perMinute);
  const batchMs = Math.max(0, opts.batchWindowMs ?? 2000);
  const linesPerPost = Math.max(1, Math.floor(opts.linesPerPost ?? 5));
  const maxQueued = perMinute * linesPerPost;

  const queue: string[] = [];
  let held: Held | undefined;
  let dropped = 0;
  const sent: number[] = [];
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let pausedUntil = 0;
  let failures = 0;
  let timer: unknown;
  let sending = false;
  let stopped = true;
  let unsubscribe: (() => void) | undefined;
  const stats: MirrorStats = { posts: 0, postedLines: 0, droppedLines: 0, failedPosts: 0, failedLines: 0, queued: 0, ignored: 0 };

  const readyIn = (): number => {
    const t = now();
    while (sent.length > 0 && t - (sent[0] as number) >= 60_000) sent.shift();
    const window = sent.length >= perMinute ? (sent[0] as number) + 60_000 - t : 0;
    return Math.max(0, pausedUntil - t, lastAttempt + gapMs - t, window);
  };

  const schedule = (idle: boolean): void => {
    if (stopped || sending || timer !== undefined) return;
    if (queue.length === 0 && dropped === 0 && !held) return;
    const delay = Math.max(readyIn(), idle ? batchMs : 0);
    timer = timers.set(() => {
      timer = undefined;
      void run();
    }, delay);
  };

  const run = async (): Promise<void> => {
    if (stopped || sending) return;
    const wait = readyIn();
    if (wait > 0) {
      timer = timers.set(() => {
        timer = undefined;
        void run();
      }, wait);
      return;
    }
    let post = held;
    if (!post) {
      if (queue.length === 0 && dropped === 0) return;
      const lines = takeBatch(queue, linesPerPost);
      queue.splice(0, lines.length);
      if (dropped > 0) {
        lines.push(droppedNotice(dropped));
        dropped = 0;
      }
      post = { text: lines.join("\n"), lines: lines.length, attempts: 0 };
    }
    held = undefined;
    sending = true;
    post.attempts++;
    const t = now();
    lastAttempt = t;
    sent.push(t);
    try {
      await api.sendMessage(chatId, post.text, { disable_notification: true, link_preview_options: { is_disabled: true } });
      stats.posts++;
      stats.postedLines += post.lines;
      failures = 0;
    } catch (e) {
      failures++;
      const retry = retryAfterMs(e);
      if (retry !== undefined) pausedUntil = Math.max(pausedUntil, now() + retry);
      else pausedUntil = Math.max(pausedUntil, now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 6)));
      if (post.attempts < 2 && retry !== undefined) {
        held = post;
      } else {
        stats.failedPosts++;
        stats.failedLines += post.lines;
      }
      // Content-free: the error code only. The error text can carry the request URL with the token.
      logger.warn("botroom.post_failed", { code: errorCode(e), retry: held !== undefined, ...(retry !== undefined ? { retryAfterSec: Math.round(retry / 1000) } : {}) });
    } finally {
      sending = false;
      stats.queued = queue.length;
    }
    schedule(false);
  };

  const onEvent = (event: BusAuditEvent): void => {
    try {
      if (stopped) return;
      if (!isMirrored(event)) {
        stats.ignored++;
        return;
      }
      const line = formatLine(event, { mode, maxChars, redact });
      if (line === undefined) {
        stats.ignored++;
        return;
      }
      if (queue.length >= maxQueued) {
        dropped++;
        stats.droppedLines++;
      } else {
        queue.push(line);
      }
      stats.queued = queue.length;
      schedule(true);
    } catch {
      // The bus must never feel a mirror fault.
      stats.ignored++;
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      try {
        unsubscribe = opts.source.subscribe(onEvent);
      } catch (e) {
        stopped = true;
        logger.warn("botroom.subscribe_failed", { code: errorCode(e) });
      }
    },
    stop() {
      stopped = true;
      try {
        unsubscribe?.();
      } catch {
        // ignore
      }
      unsubscribe = undefined;
      if (timer !== undefined) timers.clear(timer);
      timer = undefined;
      queue.length = 0;
      held = undefined;
      dropped = 0;
      stats.queued = 0;
    },
    stats: () => ({ ...stats, queued: queue.length }),
  };
}

// ---- host wiring --------------------------------------------------------------------------------------------------------

export type BotRoomDisabledReason = "mode_none" | "no_chat_id" | "no_token";

/** Why the room is off, or undefined when it is on. */
export function botRoomDisabledReason(botRoom: BotRoomSettings, mirrorToken: string | undefined): BotRoomDisabledReason | undefined {
  if (botRoom.mode === "none") return "mode_none";
  if (botRoom.chatId === undefined || !Number.isSafeInteger(botRoom.chatId)) return "no_chat_id";
  if (mirrorToken === undefined || mirrorToken.trim().length === 0) return "no_token";
  return undefined;
}

export interface StartBotRoomOptions {
  botRoom: BotRoomSettings;
  /** `secrets.mirrorBotToken`. */
  mirrorToken: string | undefined;
  source: BusAuditSource;
  logger: Logger;
  /** The host redactor; the mirror token is added to it here. */
  redact?: Redactor;
  /** Tests inject a fake `Api`; production builds one from the token (no network call is made at construction). */
  api?: RoomApi;
  now?: () => number;
  timers?: MirrorTimers;
  batchWindowMs?: number;
  linesPerPost?: number;
}

/**
 * Builds and starts the mirror from the resolved settings, or returns undefined when it is disabled (mode "none", no chat id, no
 * mirror token). It logs which, without any token. S26 calls this once, after the bot bus exists, and calls `stop()` on shutdown.
 */
export function startBotRoomMirror(opts: StartBotRoomOptions): BotRoomMirror | undefined {
  const reason = botRoomDisabledReason(opts.botRoom, opts.mirrorToken);
  if (reason !== undefined) {
    opts.logger.info("botroom.disabled", { reason });
    return undefined;
  }
  const token = opts.mirrorToken as string;
  const own = createRedactor([token]);
  const base = opts.redact;
  const redact: Redactor = (text) => own(base ? base(text) : text);
  const api = opts.api ?? new Api(token);
  const mirror = createBotRoomMirror({
    source: opts.source,
    api,
    settings: opts.botRoom,
    chatId: opts.botRoom.chatId as number,
    redact,
    logger: opts.logger,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.timers ? { timers: opts.timers } : {}),
    ...(opts.batchWindowMs !== undefined ? { batchWindowMs: opts.batchWindowMs } : {}),
    ...(opts.linesPerPost !== undefined ? { linesPerPost: opts.linesPerPost } : {}),
  });
  mirror.start();
  opts.logger.info("botroom.enabled", { mode: opts.botRoom.mode, maxPerMinute: opts.botRoom.maxPerMinute });
  return mirror;
}
