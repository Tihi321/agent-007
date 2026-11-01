/**
 * Owner routes for paid-route spending caps (M2, I58). Only the OWNER may switch a paid route on for a bot, with a per-day and a per-month
 * token cap, after a fresh step-up (I56): it spends the owner's money. An admin cannot. The list shows, for every user's bot whose chain
 * names a paid preset, the grant and the usage of today and this month (ids, names and numbers; never chat text).
 */
import type { PresetConfig } from "../../bots/schema.js";
import type { ChatService } from "../chat/service.js";
import { PaidRouteError } from "../runtime/paidRoutes.js";
import { chainOf } from "../runtime/route.js";
import { recordFor } from "../schemas.js";
import type { RouteCtx, RouteDef, RouteResult } from "../server.js";
import type { WebStack } from "../stack.js";
import { guarded, obj } from "./auth.js";

async function paidApi(fn: () => Promise<RouteResult> | RouteResult): Promise<RouteResult> {
  return guarded(async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PaidRouteError) return { status: e.status, body: { error: "paid", message: e.message } };
      throw e;
    }
  });
}

export function paidAdminRoutes(stack: WebStack, chat: ChatService, presets: () => readonly PresetConfig[]): Record<string, RouteDef> {
  const me = (c: RouteCtx): string => c.session?.userId ?? "";
  const label = (id: string): string => presets().find((p) => p.id === id)?.label ?? id;
  return {
    "POST /api/admin/paid/list": {
      auth: "owner",
      handler: () =>
        paidApi(() => {
          const rows: unknown[] = [];
          for (const [userId, u] of Object.entries(stack.users.read().users)) {
            for (const { id: botId, bot } of chat.bots(userId).list()) {
              for (const preset of chainOf(bot).filter((p) => chat.isPaid(p))) {
                rows.push({ userId, login: u.login, botId, botName: bot.name, label: label(preset), ...chat.paid.status(userId, botId, preset) });
              }
            }
          }
          return { status: 200, body: { routes: rows } };
        }),
    },
    "POST /api/admin/paid/set": {
      auth: "owner",
      stepUp: true,
      handler: (c) =>
        paidApi(() => {
          const b = obj(c.body);
          const userId = b["userId"];
          const botId = b["botId"];
          const preset = b["preset"];
          // the bot must exist and name that preset in its chain: no grant for a bot or model that is not there
          const bot = recordFor(stack.users.read().users, userId) && typeof botId === "string" ? chat.bots(userId as string).get(botId) : undefined;
          if (!bot || typeof preset !== "string" || !chainOf(bot).includes(preset)) throw new PaidRouteError(404, "No such bot or model.");
          const g = chat.paid.setGrant(me(c), { userId, botId, preset, enabled: b["enabled"], perDay: b["perDay"], perMonth: b["perMonth"] }, (p) => chat.isPaid(p));
          return { status: 200, body: { ok: g !== undefined || b["enabled"] !== true, ...chat.paid.status(userId as string, botId as string, preset) } };
        }),
    },
  };
}
