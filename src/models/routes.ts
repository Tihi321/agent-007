/**
 * A bot's route as the picker and the fallback engine see it (S22.1, I38, I39). Pure.
 *
 *  - `switchVerdict` is the I38 rule for changing the active preset. It is the SAME function the allowlist row uses
 *    (`botRows(...)[i].classify`), so the picker, `propose_setting` and the row can never disagree: a switch to a narrower privacy
 *    class (cloud -> local), local -> local (Strata <-> LM Studio) or within one vendor is `auto`; local -> cloud and cloud -> cloud at
 *    another vendor are `card`; a preset outside `route.allowed` is `reject`.
 *  - `pickerEntries` lists `route.allowed` for the `/model` picker, with the verdict a tap would get.
 *  - `fallbackCandidates` is the I39 list: only `route.fallback` entries with `autoFallback: true` that pass `presetProblem`.
 */
import { botRows, vendorOf } from "../bots/rows.js";
import type { PresetConfig, ResolvedBot, TermsAccepted } from "../bots/schema.js";
import type { Classification } from "../settings/contracts.js";
import { findPreset, presetProblem } from "./presets.js";

type RouteBot = Pick<ResolvedBot, "id" | "route">;

export type Verdict = Classification | "same";

/** The verdict for `from` -> `to` (preset ids; `from` undefined = the bot's primary). */
export function switchVerdict(bot: RouteBot, presets: readonly PresetConfig[], from: string | undefined, to: string): Verdict {
  const row = botRows({ bots: [bot as ResolvedBot], presets: [...presets] })[0];
  if (!row?.classify) return "reject";
  const before = from ?? bot.route.primary;
  if (before === to) return "same";
  return row.classify(before, to, { autoApplyCosmetic: false });
}

export interface RouteEntry {
  preset: PresetConfig;
  roles: ("primary" | "allowed" | "fallback")[];
  verdict: Verdict;
  /** The vendor, for the card and the picker line. */
  vendor: string;
}

/** The presets a bot may switch to, in `route.allowed` order, with the verdict of switching to each from `activeId`. */
export function pickerEntries(bot: RouteBot, presets: readonly PresetConfig[], activeId: string): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const id of bot.route.allowed) {
    const preset = findPreset(presets, id);
    if (!preset) continue;
    const roles: RouteEntry["roles"] = ["allowed"];
    if (bot.route.primary === id) roles.unshift("primary");
    if (bot.route.fallback.includes(id)) roles.push("fallback");
    out.push({ preset, roles, verdict: switchVerdict(bot, presets, activeId, id), vendor: vendorOf(preset) });
  }
  return out;
}

/**
 * The presets the fallback engine may select after `failed` is unavailable, in `route.fallback` order. A preset is never selected
 * unless it is listed in the route's fallback, has `autoFallback: true` and passes `presetProblem` (so no API-key preset and no
 * unacknowledged vendor). `excludeVendorOf` drops presets of the failed preset's own vendor (404 `model_not_found`: another model of
 * the same provider is never substituted).
 */
export function fallbackCandidates(bot: Pick<ResolvedBot, "route">, presets: readonly PresetConfig[], failed: PresetConfig, terms: TermsAccepted, opts: { excludeSameVendor?: boolean } = {}): PresetConfig[] {
  const out: PresetConfig[] = [];
  for (const id of bot.route.fallback) {
    const p = findPreset(presets, id);
    if (!p || p.id === failed.id || !p.autoFallback || presetProblem(p, terms)) continue;
    if (opts.excludeSameVendor && vendorOf(p) === vendorOf(failed)) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
