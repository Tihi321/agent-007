/**
 * MA3 (UI-45, UI-47): the per-bot DEFAULT BRAIN as the bot editors use it (the owner settings UI forms now, the M2 web editor in S35).
 * Pure functions over the S20 types; nothing here reads a file.
 *
 *  - `brainRoute`: the route a bot gets when Sonnet or Opus is its default: `primary` = the Claude preset, `allowed` = Sonnet, Opus and the
 *    local preset, `fallback` = the local preset (which must have `autoFallback`, so cloud -> local only narrows privacy, I39).
 *  - `applyBrain`: sets that route on a bot document. A Claude-primary bot is cloud-capable (I42), so `shell` and `dispatch_job` are removed
 *    from its tools unless the UI-25 relax flag is on (the loader would refuse them otherwise); the result lists what was removed.
 *  - `brainBadge`: the cloud badge and the one-line egress note the editor shows next to the model choice.
 */
import type { BotConfig, BotRoute, PresetConfig } from "./schema.js";
import { PRIVILEGED_TOOLS } from "./schema.js";

export const BRAIN_CHOICES = ["sonnet", "opus"] as const;
export type BrainChoice = (typeof BRAIN_CHOICES)[number];
/** UI-45: Sonnet is the default for new bots; Opus is chosen per bot (subscription limits). */
export const DEFAULT_BRAIN: BrainChoice = "sonnet";

export const BRAIN_PRESET_IDS: Readonly<Record<BrainChoice, string>> = { sonnet: "claude-sonnet", opus: "claude-opus" };

export function brainRoute(choice: BrainChoice, localPresetId = "strata"): BotRoute {
  return { primary: BRAIN_PRESET_IDS[choice], allowed: [BRAIN_PRESET_IDS.sonnet, BRAIN_PRESET_IDS.opus, localPresetId], fallback: [localPresetId], onAuthRequired: "fallback" };
}

/** The brain a route currently has, or undefined when its primary is not one of the two Claude presets. */
export function brainOf(route: Pick<BotRoute, "primary">): BrainChoice | undefined {
  return BRAIN_CHOICES.find((c) => BRAIN_PRESET_IDS[c] === route.primary);
}

export interface AppliedBrain {
  bot: BotConfig;
  /** Tools taken out because the route is now cloud-capable (I42). Empty when `relax.privilegedTools` is on. */
  removedTools: string[];
  /** Fixed sentences for the editor. */
  notes: string[];
}

export function applyBrain(bot: BotConfig, choice: BrainChoice, opts: { localPresetId?: string } = {}): AppliedBrain {
  const route = brainRoute(choice, opts.localPresetId);
  const removedTools = bot.relax.privilegedTools ? [] : bot.tools.filter((t) => (PRIVILEGED_TOOLS as readonly string[]).includes(t));
  const notes: string[] = [];
  if (removedTools.length > 0) notes.push(`${removedTools.join(", ")} removed: a bot that can use a cloud model does not get them unless you relax that for this bot (I42)`);
  if (bot.readRoots.length > 0 && bot.cloudSafeRoots.length === 0) notes.push("this bot reads only its cloud-safe folders while its route can use Claude; none are set");
  return { bot: { ...bot, route, tools: bot.tools.filter((t) => !removedTools.includes(t)) }, removedTools, notes };
}

export interface BrainBadge {
  cloud: boolean;
  label: string;
  /** One line shown under the model choice. */
  egressNote: string;
}

export function brainBadge(bot: Pick<BotConfig, "route">, presets: readonly PresetConfig[]): BrainBadge {
  const ids = new Set([bot.route.primary, ...bot.route.allowed, ...bot.route.fallback]);
  const primary = presets.find((p) => p.id === bot.route.primary);
  const cloud = presets.some((p) => ids.has(p.id) && p.privacy === "cloud");
  if (!cloud) return { cloud: false, label: primary?.label ?? bot.route.primary, egressNote: "Runs on this PC only; nothing leaves it." };
  const primaryCloud = primary?.privacy === "cloud";
  return {
    cloud: true,
    label: `${primary?.label ?? bot.route.primary} (cloud)`,
    egressNote: primaryCloud
      ? "Messages and the files this bot reads go to Claude through the proxy (your subscription); only its cloud-safe folders are readable."
      : "Runs locally, but can be switched to a cloud model; only its cloud-safe folders are readable.",
  };
}
