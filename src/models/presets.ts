/**
 * Presets and the active preset (S22.1, I38, I39, I41, I42). Pure functions over the S20 types (`src/bots/schema.ts`); nothing here
 * reads a file or a socket.
 *
 *  - `resolveActivePreset`: the bot's brain right now. The stored `bots.<id>.activePreset` (a prefs value) counts only when it is
 *    one of the route's `allowed` presets, passes `presetProblem` and can be served; anything else falls back to `route.primary`
 *    (a value outside `allowed` is rejected, never trusted: prefs.json is always read back as untrusted input).
 *  - `presetProblem` / `routeProblems`: the runtime re-check of the loader's refusals (a `claude` or `antigravity` preset without
 *    `termsAccepted`; a per-token-billed API-key preset, which is not a kind, a brain or a fallback; the cloud rule of I42), plus
 *    what the loader only warns about (no local preset in the route, a fallback without `autoFallback`).
 *  - `compactionOverrides`: the per-model compaction threshold (75% of that preset's `contextWindow`), keyed `provider/modelId`.
 *
 * Pure subset: imports only the S20 types and `providerIdOf`.
 */
import { providerIdOf } from "../bots/runtime.js";
import { PRIVILEGED_TOOLS, PROXY_KEY_REF, TERMS_PROVIDERS, WEB_PRESET_KINDS } from "../bots/schema.js";
import type { PresetConfig, ResolvedBot, TermsAccepted } from "../bots/schema.js";
import { budgetProblem, compactionOverride } from "../prompt/budget.js";
import { isLiteralLoopbackUrl } from "./sources.js";
import type { CompactionPolicyOverride } from "../prompt/budget.js";

/** Structurally the Pi `ModelRef`: what `conversation.configure({ model })` takes. */
export interface ModelRef {
  provider: string;
  modelId: string;
}

type RouteBot = Pick<ResolvedBot, "route">;

export function presetRef(p: PresetConfig): ModelRef {
  return { provider: providerIdOf(p), modelId: p.modelId };
}

export function sameRef(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.modelId === b.modelId;
}

export function findPreset(presets: readonly PresetConfig[], id: string): PresetConfig | undefined {
  return presets.find((p) => p.id === id);
}

/** True when the preset's vendor needs a terms acknowledgment (`claude`, `antigravity` through the proxy). */
export function needsTerms(p: PresetConfig): boolean {
  return p.kind === "acp" && p.providerId !== undefined && (TERMS_PROVIDERS as readonly string[]).includes(p.providerId);
}

/**
 * Why a preset can never be a brain or a fallback, or undefined. The loader refuses these at start; this is the same rule at the
 * moment of use, so a forged or stale object cannot slip through.
 */
export function presetProblem(p: PresetConfig, terms: TermsAccepted): string | undefined {
  if (!(WEB_PRESET_KINDS as readonly string[]).includes(p.kind)) return `"${p.id}" has kind "${String(p.kind)}": only acp, local and (web only) custom exist, and a per-token-billed API-key preset is never a brain or a fallback (D12, I39)`;
  if (p.kind === "custom") {
    if (p.apiKeyRef !== undefined && !/^webkey:[a-z][a-z0-9]{1,11}$/.test(p.apiKeyRef)) return `"${p.id}" carries a key reference other than its own web key`;
    if (p.providerId !== undefined) return `"${p.id}" is a custom preset, so it has no proxy provider`;
    if (p.privacy !== "cloud" && !(p.baseUrl !== undefined && isLiteralLoopbackUrl(p.baseUrl))) return `"${p.id}" is a custom preset on a host that is not literal loopback, so its privacy class is cloud`;
  } else if (p.apiKeyRef !== undefined && (p.kind !== "acp" || p.apiKeyRef !== PROXY_KEY_REF)) {
    return `"${p.id}" carries a key reference other than the proxy key: a paid API key is never a brain or a fallback`;
  }
  if (p.billing === "paid" && p.privacy !== "cloud") return `"${p.id}" is billed per use, which only a cloud preset can be`;
  if (p.kind === "acp" && p.privacy !== "cloud") return `"${p.id}" goes through the proxy, so its privacy class is cloud`;
  if (p.kind === "local" && p.privacy !== "local") return `"${p.id}" is a local preset, so its privacy class is local`;
  if (needsTerms(p) && terms[p.providerId as keyof TermsAccepted] !== true) return `"${p.id}" uses ${String(p.providerId)} through the proxy, which may break that vendor's terms; it needs the acknowledgment in the settings UI (I41)`;
  return undefined;
}

export interface ActivePreset {
  preset: PresetConfig;
  source: "stored" | "primary";
  /** Why a stored value was not used (the log and `/model` say it). */
  ignored?: string;
}

/**
 * The preset the bot runs on: `stored` (the prefs value) when it is in `route.allowed`, passes `presetProblem` and `servable`
 * (default: always), else `route.primary`. Never throws: an unknown primary returns `undefined` only when the route names a preset
 * that does not exist (the loader refuses that, so it cannot happen on a loaded install).
 */
export function resolveActivePreset(bot: RouteBot, presets: readonly PresetConfig[], stored: unknown, terms: TermsAccepted, servable: (p: PresetConfig) => boolean = () => true): ActivePreset | undefined {
  const primary = findPreset(presets, bot.route.primary);
  let ignored: string | undefined;
  if (stored !== undefined && stored !== null) {
    const p = typeof stored === "string" ? findPreset(presets, stored) : undefined;
    if (!p) ignored = "the stored preset does not exist";
    else if (!bot.route.allowed.includes(p.id)) ignored = `"${p.id}" is not one of the presets this bot may use`;
    else if (presetProblem(p, terms)) ignored = presetProblem(p, terms);
    else if (!servable(p)) ignored = `"${p.id}" cannot be served right now`;
    else return { preset: p, source: "stored" };
  }
  if (!primary) return undefined;
  return { preset: primary, source: "primary", ...(ignored ? { ignored } : {}) };
}

/** The reason an `activePreset` value is refused, or undefined when it is acceptable (an outside-`allowed` value is rejected). */
export function activePresetProblem(bot: RouteBot, presets: readonly PresetConfig[], id: unknown, terms: TermsAccepted): string | undefined {
  if (typeof id !== "string") return "the preset id must be text";
  const p = findPreset(presets, id);
  if (!p) return `there is no preset "${id.slice(0, 40)}"`;
  if (!bot.route.allowed.includes(p.id)) return `"${p.id}" is not one of the presets this bot may use (route.allowed)`;
  return presetProblem(p, terms);
}

export interface RouteReport {
  /** Refusals: the route must not run as it is. */
  issues: string[];
  /** Things worth saying in `/status`: they do not stop the bot. */
  warnings: string[];
}

/** True when any preset of the route (primary, allowed or fallback) is a local one. */
export function hasLocalRoute(bot: RouteBot, presets: readonly PresetConfig[]): boolean {
  const ids = new Set([bot.route.primary, ...bot.route.allowed, ...bot.route.fallback]);
  return presets.some((p) => ids.has(p.id) && p.privacy === "local" && p.kind === "local");
}

/** The cloud-capable rule (I42): a bot with any cloud preset in its route. */
export function isCloudCapableRoute(bot: RouteBot, presets: readonly PresetConfig[]): boolean {
  const ids = new Set([bot.route.primary, ...bot.route.allowed, ...bot.route.fallback]);
  return presets.some((p) => ids.has(p.id) && p.privacy === "cloud");
}

export function routeProblems(bot: Pick<ResolvedBot, "id" | "route" | "tools" | "relax">, presets: readonly PresetConfig[], terms: TermsAccepted): RouteReport {
  const issues: string[] = [];
  const warnings: string[] = [];
  const at = `bots.${bot.id}.route`;
  const ids = [bot.route.primary, ...bot.route.allowed, ...bot.route.fallback];
  for (const id of new Set(ids)) {
    const p = findPreset(presets, id);
    if (!p) {
      issues.push(`${at}: "${id}" is not one of the presets`);
      continue;
    }
    const why = presetProblem(p, terms);
    if (why) issues.push(`${at}: ${why}`);
    const room = p.maxTokens < p.contextWindow ? budgetProblem({ id: providerIdOf(p), modelId: p.modelId, contextWindow: p.contextWindow, maxTokens: p.maxTokens }) : "maxTokens must be smaller than contextWindow";
    if (room) warnings.push(`${at}: preset "${id}": ${room}`);
  }
  if (!bot.route.allowed.includes(bot.route.primary)) issues.push(`${at}.allowed: must include the primary preset "${bot.route.primary}"`);
  for (const id of bot.route.fallback) {
    const p = findPreset(presets, id);
    if (p && !p.autoFallback) warnings.push(`${at}.fallback: "${id}" has autoFallback off, so it is never selected automatically`);
  }
  if (!hasLocalRoute(bot, presets)) warnings.push(`${at}: no local preset in the route; the bot has no local fallback (every shipped bot should have one)`);
  if (isCloudCapableRoute(bot, presets) && !bot.relax.privilegedTools) {
    for (const t of PRIVILEGED_TOOLS) if (bot.tools.includes(t)) issues.push(`bots.${bot.id}.tools: "${t}" on a bot whose route can use a cloud preset sends tool output to a vendor (I42)`);
  }
  const primary = findPreset(presets, bot.route.primary);
  if (primary?.privacy === "cloud" && !bot.route.fallback.some((id) => findPreset(presets, id)?.privacy === "local" && findPreset(presets, id)?.autoFallback)) {
    warnings.push(`${at}: the primary preset is a cloud one and no local fallback with autoFallback is listed; the bot is offline while the proxy is down`);
  }
  return { issues, warnings };
}

/**
 * Per-model compaction overrides for a bot's route, keyed `"<provider>/<modelId>"` (U10, U51): the blocking threshold is 75% of each
 * preset's own `contextWindow`. A preset whose `maxTokens` is not below its window is skipped (the loader's own budget check says why).
 */
export function compactionOverrides(bot: RouteBot, presets: readonly PresetConfig[]): Record<string, CompactionPolicyOverride> {
  const out: Record<string, CompactionPolicyOverride> = {};
  const ids = new Set([bot.route.primary, ...bot.route.allowed, ...bot.route.fallback]);
  for (const p of presets) {
    if (!ids.has(p.id) || p.maxTokens >= p.contextWindow) continue;
    out[`${providerIdOf(p)}/${p.modelId}`] = compactionOverride(p.contextWindow);
  }
  return out;
}
