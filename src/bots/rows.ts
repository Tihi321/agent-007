/**
 * The allowlist rows Phase 4 adds (S20, I29d, I38): ONE row per configured bot, for `bots.<id>.activePreset`, and no row for any other
 * `bots.*` or `presets` path, so `propose_setting` on those is rejected before any card (`not_writable`). `activePreset` is a prefs
 * value (`prefs.json`, `bots.<id>.activePreset`); the row's `classify` returns the I38 verdict for a switch:
 *
 *   - a preset outside the bot's `route.allowed`                          -> reject
 *   - to a preset of a NARROWER or equal privacy class (cloud -> local, local -> local, same vendor) -> auto (audited)
 *   - local -> cloud, or cloud -> cloud to another vendor (widens egress) -> card
 *
 * `before` is the stored value; when none is stored the bot is on its `route.primary`. One row per bot (not a `*` wildcard) so a bot id
 * that does not exist can never be written, and so each row knows its own bot's `allowed` list. Wire it with `withRows(DEFAULT_ROWS, botRows(resolved))`.
 *
 * Pure subset.
 */
import type { AllowRow } from "../settings/allowlist.js";
import type { Classification } from "../settings/contracts.js";
import { PRESET_ID_PATTERN } from "./schema.js";
import type { PresetConfig, ResolvedBots } from "./schema.js";

/** The vendor of a preset: the proxy provider for an acp preset, the runner for a local one. */
export function vendorOf(p: PresetConfig): string {
  return p.kind === "acp" ? `acp:${p.providerId ?? "?"}` : `local:${p.runner ?? "?"}`;
}

/** The I38 verdict for switching a bot from preset `from` to preset `to` (both must be known presets). */
export function classifySwitch(from: PresetConfig, to: PresetConfig): Classification {
  if (to.privacy === "local") return "auto"; // local -> local, cloud -> local: never widens egress
  if (from.privacy === "cloud" && vendorOf(from) === vendorOf(to)) return "auto"; // same vendor
  return "card"; // local -> cloud, or cloud -> cloud at another vendor
}

export function botRows(resolved: Pick<ResolvedBots, "bots" | "presets">): AllowRow[] {
  const byId = new Map(resolved.presets.map((p) => [p.id, p] as const));
  return resolved.bots.map((bot): AllowRow => ({
    path: `bots.${bot.id}.activePreset`,
    label: `Model of bot ${bot.id}`,
    schema: { type: "string", pattern: PRESET_ID_PATTERN.source, minLength: 1, maxLength: 24, "x-ui": { widget: "text", label: `Active model preset of ${bot.id}` } },
    class: "pref",
    proposable: true,
    telegram: false,
    classify: (before, after): Classification => {
      const to = typeof after === "string" ? byId.get(after) : undefined;
      if (!to || !bot.route.allowed.includes(to.id)) return "reject";
      const from = byId.get(typeof before === "string" ? before : bot.route.primary);
      if (!from) return "card"; // an unknown stored value: widening is assumed
      if (from.id === to.id) return "auto";
      return classifySwitch(from, to);
    },
  }));
}
