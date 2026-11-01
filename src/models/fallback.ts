/**
 * The fallback engine (S22.3, I39). `decide` is a PURE function: a typed failure of the active preset, the preset and the bot's
 * route in, one of `retry | fallback(preset) | tell_user | fail` out. `FallbackEngine` wraps it with the two bits of state the plan
 * asks for: ONE notice per outage and a "needs login" flag per preset for `/status`.
 *
 * The I39 table, row by row:
 *
 *   auth_required (503 `provider_auth_required` / `auth_required`)  no retry; needs login; then the route rule
 *   connection_refused (the proxy is down: the main user logged off) no retry; an acp preset is marked needs login; then the route rule
 *   provider_busy (503 `provider_busy`)                              wait (Retry-After, 1 to 60 s) and retry, at most twice; then the route rule
 *   queue_full (429 `provider_queue_full`), timeout (504)            ONE backoff retry; then the route rule
 *   model_not_found (404)                                            no retry; refresh the model list; never another model of the same provider
 *   bad_request (400 class)                                          fail: a bug, never a fallback
 *   other                                                            like a timeout
 *
 * "The route rule" is `route.onAuthRequired`: `fallback` picks the first `route.fallback` preset with `autoFallback: true`
 * (nothing else, ever: a per-token-billed preset is not a kind, so none can be selected), `ask` tells the user to choose with
 * `/model`, `fail` fails the turn. Cloud -> cloud at another vendor is new egress, so it needs `autoFallback: true` like any other.
 *
 * Mapping a real error (an HTTP status and the proxy's error code) to a `Failure` is S23's `errors.ts`; this file takes the typed value.
 * Pure subset apart from the optional audit.
 */
import type { BotRoute, PresetConfig, ResolvedBot, TermsAccepted } from "../bots/schema.js";
import { sha256Text } from "../settings/chain.js";
import type { SettingsAudit } from "../settings/contracts.js";
import { findPreset } from "./presets.js";
import { fallbackCandidates } from "./routes.js";

export const FAILURE_KINDS = ["auth_required", "provider_busy", "queue_full", "timeout", "model_not_found", "bad_request", "connection_refused", "other"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface Failure {
  kind: FailureKind;
  /** The proxy's `Retry-After`, in seconds (503 `provider_busy`). */
  retryAfterSec?: number;
}

export type Decision =
  | { action: "retry"; afterMs: number; reason: string }
  | { action: "fallback"; preset: PresetConfig; message: string; needsLogin: boolean; refreshModels: boolean }
  | { action: "tell_user"; message: string; needsLogin: boolean; refreshModels: boolean; choices: PresetConfig[] }
  | { action: "fail"; message: string };

export const BUSY_RETRIES = 2;
export const BACKOFF_RETRIES = 1;
export const BACKOFF_MS = 2000;
const BUSY_DEFAULT_MS = 5000;
const BUSY_MIN_MS = 1000;
const BUSY_MAX_MS = 60_000;

export interface DecideContext {
  presets: readonly PresetConfig[];
  terms: TermsAccepted;
  /** Retries already made for this outage of this preset (0 on the first failure). */
  attempt?: number;
}

const vendorName = (p: PresetConfig): string => (p.kind === "acp" ? (p.providerId ?? "the proxy") : (p.runner ?? "a local runner"));

function exhausted(error: Failure, preset: PresetConfig, route: BotRoute, ctx: DecideContext, needsLogin: boolean, why: string): Decision {
  const refreshModels = error.kind === "model_not_found";
  const choices = fallbackCandidates({ route }, ctx.presets, preset, ctx.terms, { excludeSameVendor: refreshModels });
  const head = `${preset.label} ${why}`;
  if (route.onAuthRequired === "fail") return { action: "fail", message: `${head}. This bot is set to stop rather than switch.` };
  if (route.onAuthRequired === "ask") {
    const list = choices.length > 0 ? ` Use /model to pick another: ${choices.map((c) => c.label).join(", ")}.` : " No fallback is configured for this bot.";
    return { action: "tell_user", message: `${head}.${list}`, needsLogin, refreshModels, choices };
  }
  const next = choices[0];
  if (!next) return { action: "tell_user", message: `${head}, and no fallback is configured for this bot.`, needsLogin, refreshModels, choices };
  const egress = next.privacy === "cloud" && preset.privacy !== "cloud" ? ` It sends text to ${vendorName(next)}.` : "";
  return { action: "fallback", preset: next, message: `${head}. Using ${next.label} for now.${egress}`, needsLogin, refreshModels };
}

/** The I39 decision for one failure of `preset`. Pure. */
export function decide(error: Failure, preset: PresetConfig, route: BotRoute, ctx: DecideContext): Decision {
  const attempt = ctx.attempt ?? 0;
  const acp = preset.kind === "acp";
  switch (error.kind) {
    case "bad_request":
      return { action: "fail", message: `The model call was refused as malformed (${preset.label}). That is a bug, so nothing was switched.` };
    case "auth_required":
      return exhausted(error, preset, route, ctx, acp, "needs a login on the main account");
    case "connection_refused":
      return exhausted(error, preset, route, ctx, acp, acp ? "cannot be reached (the proxy is not running, or the main account is logged off)" : "is not running");
    case "model_not_found":
      return exhausted(error, preset, route, ctx, false, "no longer lists this model");
    case "provider_busy": {
      if (attempt < BUSY_RETRIES) {
        const ms = error.retryAfterSec !== undefined ? Math.round(error.retryAfterSec * 1000) : BUSY_DEFAULT_MS;
        return { action: "retry", afterMs: Math.min(BUSY_MAX_MS, Math.max(BUSY_MIN_MS, ms)), reason: "provider_busy" };
      }
      return exhausted(error, preset, route, ctx, false, "stayed busy");
    }
    case "queue_full":
    case "timeout":
    case "other": {
      if (attempt < BACKOFF_RETRIES) return { action: "retry", afterMs: BACKOFF_MS, reason: error.kind };
      return exhausted(error, preset, route, ctx, false, error.kind === "queue_full" ? "is overloaded" : error.kind === "timeout" ? "timed out" : "failed");
    }
  }
}

export interface FallbackEngineDeps {
  bot: Pick<ResolvedBot, "id" | "route">;
  presets: readonly PresetConfig[];
  terms: () => TermsAccepted;
  /** Audits the first failure of an outage (and the fallback it chose). Failure to write never blocks the notice. */
  audit?: SettingsAudit | undefined;
  /** The prefs revision for the audit line (unchanged by a fallback). */
  revision?: (() => string) | undefined;
}

export interface Handled {
  decision: Decision;
  /** The text for the user, set on the FIRST non-retry failure of a preset's outage only. */
  notice?: string;
}

/** Per bot: one notice per outage, a needs-login flag per preset, one audit line per outage. */
export class FallbackEngine {
  readonly #d: FallbackEngineDeps;
  readonly #outages = new Set<string>();
  readonly #needsLogin = new Set<string>();

  constructor(deps: FallbackEngineDeps) {
    this.#d = deps;
  }

  handle(error: Failure, presetId: string, attempt = 0): Handled {
    const preset = findPreset(this.#d.presets, presetId);
    if (!preset) return { decision: { action: "fail", message: "That model is not configured." } };
    const decision = decide(error, preset, this.#d.bot.route, { presets: this.#d.presets, terms: this.#d.terms(), attempt });
    if (decision.action === "retry") return { decision };
    if (decision.action !== "fail" && decision.needsLogin) this.#needsLogin.add(preset.id);
    if (this.#outages.has(preset.id)) return { decision }; // the second failure of the same outage says nothing new
    this.#outages.add(preset.id);
    this.#audit(error, preset, decision);
    return { decision, notice: decision.message };
  }

  /** The preset answered: its outage and its needs-login flag end. */
  succeeded(presetId: string): void {
    this.#outages.delete(presetId);
    this.#needsLogin.delete(presetId);
  }

  /** Preset ids to show as "needs login" in `/status`. */
  needsLogin(): string[] {
    return [...this.#needsLogin];
  }

  inOutage(presetId: string): boolean {
    return this.#outages.has(presetId);
  }

  #audit(error: Failure, preset: PresetConfig, decision: Decision): void {
    const audit = this.#d.audit;
    if (!audit) return;
    const rev = this.#d.revision?.() ?? sha256Text("");
    try {
      audit.append({
        source: "system",
        kind: "setting",
        target: { file: "prefs.json", path: `bots.${this.#d.bot.id}.activePreset` },
        diff: decision.action === "fallback" ? [{ path: `bots.${this.#d.bot.id}.activePreset`, op: "replace", before: preset.id, after: decision.preset.id }] : [],
        decision: "auto",
        baseRevision: rev,
        afterRevision: rev,
        note: `fallback: ${error.kind} -> ${decision.action}`,
      });
    } catch {
      // the notice is still sent; the audit log being down is reported by its own writer
    }
  }
}
