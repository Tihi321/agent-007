/**
 * The route of ONE turn of a user bot (M1, M2), computed from the CURRENT caps, terms and paid grants every time a turn starts and again
 * when it gets the model slot. A stored bot keeps the preset, cloud fallback, local fallback and tools the user picked, but none of them is
 * trusted: the owner may have lowered the user's caps, revoked a terms flag, or switched a paid route off, and that must hold for the bots
 * that already exist, not only for new ones.
 *
 * The chain (plan section 0a item 6): main model, then the cloud fallback, then the local fallback. A link is dropped when it is not in the
 * caps, not configured, refused by the terms, or a paid route without an owner grant or headroom. Tools are the stored tools that are still
 * in the caps. No link left: the turn is refused with a plain message.
 */
import { isPaidPreset } from "../../bots/schema.js";
import type { PresetConfig, TermsAccepted } from "../../bots/schema.js";
import { presetProblem } from "../../models/presets.js";
import { USER_ALWAYS_LOADED_MAX, USER_TOOL_UNIVERSE } from "../capabilities.js";
import type { Caps } from "../schemas.js";
import type { UserBotConfig } from "./userBots.js";

export type DropReason = "caps" | "missing" | "terms" | "paid_off" | "paid_cap";

export interface TurnRouteContext {
  caps: Pick<Caps, "presets" | "tools">;
  presets: readonly PresetConfig[];
  terms: TermsAccepted;
  /** Tokens left on a paid preset for this bot (0 = off or used up). Only asked for paid presets. */
  paidHeadroom(presetId: string): number;
}

export interface TurnRoute {
  primary: string;
  fallback: string[];
  allowed: string[];
}

export type ResolvedTurn =
  | { ok: true; route: TurnRoute; tools: string[]; dropped: { preset: string; why: DropReason }[]; droppedTools: string[]; notice?: string }
  | { ok: false; why: DropReason; message: string; dropped: { preset: string; why: DropReason }[] };

export const REFUSAL: Record<DropReason, string> = {
  caps: "This bot's model is no longer available to your account. Edit the bot and pick another model.",
  missing: "This bot's model is no longer set up on the PC. Edit the bot and pick another model.",
  terms: "This bot's model is switched off by the owner right now. Edit the bot and pick another model.",
  paid_off: "This bot's model is a paid route that is switched off. The owner must enable it for this bot with a spending cap.",
  paid_cap: "This bot's paid model has reached its spending cap. The day cap resets at midnight UTC, the month cap on the 1st.",
};

const NOTICE: Record<DropReason, string> = {
  caps: "is no longer allowed for your account",
  missing: "is not set up on the PC",
  terms: "is switched off by the owner",
  paid_off: "is a paid route that is switched off",
  paid_cap: "has reached its spending cap",
};

/** The chain of a stored bot, in order, without duplicates: main, cloud fallback, local fallback. */
export function chainOf(cfg: Pick<UserBotConfig, "preset" | "cloudFallback" | "fallback">): string[] {
  return [...new Set([cfg.preset, cfg.cloudFallback, cfg.fallback].filter((x): x is string => typeof x === "string" && x !== ""))];
}

/** Why a preset cannot serve this turn, or undefined when it can. */
export function whyNot(id: string, ctx: TurnRouteContext): DropReason | undefined {
  if (!ctx.caps.presets.includes(id)) return "caps";
  const p = ctx.presets.find((x) => x.id === id);
  if (!p) return "missing";
  if (presetProblem(p, ctx.terms)) return "terms";
  if (isPaidPreset(p)) {
    const h = ctx.paidHeadroom(id);
    if (!(h > 0)) return h === -1 ? "paid_off" : "paid_cap";
  }
  return undefined;
}

export function resolveTurnRoute(cfg: Pick<UserBotConfig, "preset" | "cloudFallback" | "fallback" | "tools">, ctx: TurnRouteContext): ResolvedTurn {
  const dropped: { preset: string; why: DropReason }[] = [];
  const keep: string[] = [];
  for (const id of chainOf(cfg)) {
    const why = whyNot(id, ctx);
    if (why) dropped.push({ preset: id, why });
    else keep.push(id);
  }
  if (keep.length === 0) {
    const why = dropped[0]?.why ?? "caps";
    return { ok: false, why, message: REFUSAL[why], dropped };
  }
  const tools = cfg.tools.filter((t) => USER_TOOL_UNIVERSE.includes(t) && ctx.caps.tools.includes(t)).slice(0, USER_ALWAYS_LOADED_MAX);
  const droppedTools = cfg.tools.filter((t) => !tools.includes(t));
  const first = dropped.find((d) => d.preset === cfg.preset);
  const label = (id: string): string => ctx.presets.find((p) => p.id === id)?.label ?? id;
  const notice = first ? `The main model ${NOTICE[first.why]}, so this answer comes from ${label(keep[0] as string)}.` : undefined;
  return { ok: true, route: { primary: keep[0] as string, fallback: keep.slice(1), allowed: keep }, tools, dropped, droppedTools, ...(notice ? { notice } : {}) };
}
