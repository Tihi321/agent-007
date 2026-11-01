/** Ids of the web gateway (S28). A userId is a random 128-bit value in hex, never derived from a login (logins can be reused). */
import { randomBytes } from "node:crypto";

export const USER_ID_PATTERN = /^[0-9a-f]{32}$/;
export const WEB_BOT_ID_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;
export const THREAD_ID_PATTERN = /^[0-9a-f]{24}$/;

export const newUserId = (): string => randomBytes(16).toString("hex");
export const newThreadId = (): string => randomBytes(12).toString("hex");
export const newInviteId = (): string => randomBytes(8).toString("hex");

export const isUserId = (s: unknown): s is string => typeof s === "string" && USER_ID_PATTERN.test(s);
export const isWebBotId = (s: unknown): s is string => typeof s === "string" && WEB_BOT_ID_PATTERN.test(s);
export const isThreadId = (s: unknown): s is string => typeof s === "string" && THREAD_ID_PATTERN.test(s);

/** The runtime bot id of a user's bot. The colon cannot appear in an owner bot id (BOT_ID_PATTERN), so the two namespaces never collide. */
export const runtimeBotId = (userId: string, botId: string): string => `u:${userId}:${botId}`;
export function parseRuntimeBotId(id: string): { userId: string; botId: string } | undefined {
  const m = /^u:([0-9a-f]{32}):([a-z][a-z0-9-]{1,23})$/.exec(id);
  return m ? { userId: m[1] as string, botId: m[2] as string } : undefined;
}
