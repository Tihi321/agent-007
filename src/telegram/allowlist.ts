/**
 * Numeric-id allowlist and private-chat filter (S4.1, plan section 9). This is the FIRST middleware.
 * Anything that is not a private chat, has no sender, or whose `from.id` is not allowlisted is dropped before any
 * processing: no reply, no `next()`. A drop is logged at `warn` with NO content, at most once per sender per minute.
 *
 * Phase 4 (S20, I37, S24.2): an update whose sender is a BOT (`from.is_bot`) is dropped the same way, whatever its id, so another
 * bot's message (Bot-to-Bot Communication Mode is off, but a bot in a shared room could still write) never reaches a working bot.
 */
import type { Context, MiddlewareFn } from "grammy";
import type { Logger } from "../contracts.js";

export interface Allowlist {
  isAllowed(userId: number | undefined): boolean;
  /** Register first on the bot. */
  readonly middleware: MiddlewareFn<Context>;
}

export interface AllowlistOptions {
  now?: () => number;
  /** Minimum time between two log lines for the same sender. Default 60 000 ms. */
  logIntervalMs?: number;
}

/** The kind of an update (`message`, `callback_query`, ...) taken from its keys; never its content. */
export function updateKind(update: object): string {
  for (const key of Object.keys(update)) if (key !== "update_id") return key;
  return "unknown";
}

export function createAllowlist(allowedUserIds: readonly number[], logger: Logger, opts: AllowlistOptions = {}): Allowlist {
  const allowed = new Set<number>(allowedUserIds.filter((id) => Number.isSafeInteger(id)));
  const now = opts.now ?? Date.now;
  const interval = opts.logIntervalMs ?? 60_000;
  const lastLog = new Map<string, number>();

  const shouldLog = (key: string): boolean => {
    const t = now();
    const prev = lastLog.get(key);
    if (prev !== undefined && t - prev < interval) return false;
    lastLog.set(key, t);
    if (lastLog.size > 1000) {
      for (const [k, at] of lastLog) if (t - at >= interval) lastLog.delete(k);
    }
    return true;
  };

  const isAllowed = (userId: number | undefined): boolean => userId !== undefined && allowed.has(userId);

  const middleware: MiddlewareFn<Context> = async (ctx, next) => {
    const fromId = ctx.from?.id;
    const chatType = ctx.chat?.type;
    const fromBot = ctx.from?.is_bot === true;
    if (!fromBot && isAllowed(fromId) && chatType === "private") {
      await next();
      return;
    }
    const key = fromId === undefined ? "none" : String(fromId);
    if (shouldLog(key)) {
      logger.warn("telegram.dropped", { updateId: ctx.update.update_id, fromId, chatType, kind: updateKind(ctx.update), ...(fromBot ? { fromBot: true } : {}) });
    }
  };

  return { isAllowed, middleware };
}
