/**
 * Switching a bot's brain (S22.2, I38, U51, U43). One `ModelSwitcher` per bot.
 *
 * Source of truth: the prefs value `bots.<id>.activePreset` (ONE host `prefs.json`, S20), or `route.primary` when none is stored or
 * the stored one is not usable. A switch is therefore "change the pref"; the CONVERSATIONS follow it:
 *
 *   `ensureApplied(conversationId, conversation)` runs before every submission (the bridge calls it from `beforeSubmit`, see
 *   `TelegramModelUi.extension()`). When the conversation's model differs from the bot's active preset it calls
 *   `conversation.configure({ model })` and READS IT BACK. `extensions` is NEVER passed (footgun 30), so the guard hook stays; the
 *   read-back checks it anyway when `guardExtension` is given. The transcript is kept: `configure` changes only the model, and the
 *   next request replays the history to the new provider (U51: applies from the next request, the in-flight one keeps its pinned model).
 *
 * Who may switch how (I38), decided by `switchVerdict` (the same function the allowlist row uses):
 *   - `auto`  (cloud -> local, local -> local between runners, within one vendor): applied at once and audited.
 *   - `card`  (local -> cloud, cloud -> cloud at another vendor): exactly ONE approval card through the proposal engine; the pref
 *             changes only after Approve, and the conversation follows on its next message.
 *   - `reject` (a preset outside `route.allowed`): nothing happens. `presets`, `route` and `fallback` are not writable here at all
 *             (they have no allowlist row; they are edited only in the settings UI).
 *
 * A fallback (S22.3) is an in-memory OVERRIDE (`setFallback`), never a pref write: it ends when the user switches, when
 * `clearFallback()` is called after the preset recovers, or at a restart.
 */
import type { Logger } from "../contracts.js";
import { BACKGROUND_CONTEXT } from "../pi/adapter.js";
import type { Conversation, Models } from "../pi/adapter.js";
import type { PresetConfig, ResolvedBot, TermsAccepted } from "../bots/schema.js";
import { applyToCopy } from "../settings/allowlist.js";
import { SettingsError } from "../settings/contracts.js";
import type { SettingsAudit } from "../settings/contracts.js";
import type { PrefsStore } from "../settings/prefs.js";
import type { ProposeResult } from "../settings/proposals.js";
import { parsePrefsText } from "../settings/prefs.js";
import { diffValues, serialize, updateAudited } from "../settings/store.js";
import { activePresetProblem, findPreset, presetRef, resolveActivePreset, sameRef } from "./presets.js";
import type { ActivePreset, ModelRef } from "./presets.js";
import { switchVerdict } from "./routes.js";

export interface SwitcherDeps {
  bot: Pick<ResolvedBot, "id" | "route">;
  presets: readonly PresetConfig[];
  terms: () => TermsAccepted;
  prefs: PrefsStore;
  audit: SettingsAudit;
  /** The card path: `ProposalEngine.propose("setting", ...)`. Absent: a widening switch is refused ("no way to ask"). */
  propose?: ((input: { path: string; value: string; reason: string }, ctx: { conversationId: string; chatId: number }) => Promise<ProposeResult>) | undefined;
  /** The bot's own `Models` (a preset whose model it does not hold cannot be served). Absent: every preset counts as served. */
  models?: (() => Pick<Models, "getModel"> | undefined) | undefined;
  /** Optional liveness check of a preset's runner or proxy, asked before a user switch (UI-20c: no silent fallback on a refusal). */
  up?: ((p: PresetConfig) => Promise<boolean>) | undefined;
  /** The extension whose hook must survive `configure()` (the `a7` guard). */
  guardExtension?: string | undefined;
  logger?: Logger | undefined;
}

export interface UserSwitchRequest {
  presetId: string;
  userId: number;
  chatId: number;
  conversationId?: string | undefined;
  conversation?: Conversation | undefined;
}

export type SwitchStatus = "applied" | "card" | "same" | "rejected";
export interface SwitchOutcome {
  status: SwitchStatus;
  text: string;
  preset?: PresetConfig;
}

export interface Ensured {
  notice?: string;
}

export class ModelSwitcher {
  readonly #d: SwitcherDeps;
  readonly #applied = new Map<string, string>();
  readonly #noticed = new Set<string>();
  #override: { preset: PresetConfig; reason: string } | undefined;

  constructor(deps: SwitcherDeps) {
    this.#d = deps;
  }

  get botId(): string {
    return this.#d.bot.id;
  }

  get path(): string {
    return `bots.${this.#d.bot.id}.activePreset`;
  }

  /** The stored `activePreset` value, untrusted. */
  stored(): unknown {
    const bots = this.#d.prefs.get().prefs["bots"];
    if (typeof bots !== "object" || bots === null || !Object.prototype.hasOwnProperty.call(bots, this.#d.bot.id)) return undefined;
    const mine = (bots as Record<string, unknown>)[this.#d.bot.id];
    return typeof mine === "object" && mine !== null ? (mine as Record<string, unknown>)["activePreset"] : undefined;
  }

  #servable = (p: PresetConfig): boolean => {
    const models = this.#d.models?.();
    if (!models) return true;
    const ref = presetRef(p);
    return models.getModel(ref.provider, ref.modelId) !== undefined;
  };

  /** The pref-resolved preset (stored when valid and served, else primary). */
  resolved(): ActivePreset {
    const r = resolveActivePreset(this.#d.bot, this.#d.presets, this.stored(), this.#d.terms(), this.#servable);
    if (!r) throw new Error(`bot ${this.#d.bot.id}: the primary preset "${this.#d.bot.route.primary}" does not exist`);
    return r;
  }

  /** The preset the bot answers with now: a fallback override, else the resolved preset. */
  effective(): PresetConfig {
    return this.#override?.preset ?? this.resolved().preset;
  }

  get fallbackActive(): { preset: PresetConfig; reason: string } | undefined {
    return this.#override;
  }

  modelRef(): ModelRef {
    return presetRef(this.effective());
  }

  /**
   * A `ModelRef` that always reads the CURRENT model (getters). Pass it as `PersonaApplier`'s `baseModel`: that applier calls
   * `configure({ model: base })` whenever a persona changes, and with a fixed value it would silently undo a `/model` switch.
   */
  liveModelRef(): ModelRef {
    const now = (): ModelRef => this.modelRef();
    return {
      get provider(): string {
        return now().provider;
      },
      get modelId(): string {
        return now().modelId;
      },
    };
  }

  // ---- the conversation follows the bot ----------------------------------------------------------------------------

  /**
   * Makes the conversation's model the bot's current preset. Cheap when nothing changed (one map lookup). A preset the bot's `Models`
   * does not hold is never configured: the conversation stays where it is (logged once).
   */
  async ensureApplied(conversationId: string, conv: Conversation): Promise<Ensured> {
    const resolved = this.#override ? undefined : this.resolved();
    const want = this.#override?.preset ?? (resolved as ActivePreset).preset;
    const notice = resolved?.ignored ? this.#noticeOnce(`ignored:${resolved.ignored}`, `The saved model choice cannot be used (${resolved.ignored}); this bot runs on ${want.label}.`) : undefined;
    if (this.#applied.get(conversationId) === want.id) return notice ? { notice } : {};
    const ref = presetRef(want);
    const agent = await conv.agent(BACKGROUND_CONTEXT);
    if (!sameRef(agent.model as ModelRef | undefined, ref)) {
      if (!this.#servable(want)) {
        this.#d.logger?.warn("models.preset_not_served", { bot: this.#d.bot.id, preset: want.id });
        return notice ? { notice } : {};
      }
      await this.#configure(conv, ref, agent.model as ModelRef | undefined);
    }
    this.#applied.set(conversationId, want.id);
    return notice ? { notice } : {};
  }

  #noticeOnce(key: string, text: string): string | undefined {
    if (this.#noticed.has(key)) return undefined;
    this.#noticed.add(key);
    return text;
  }

  async #configure(conv: Conversation, ref: ModelRef, before: ModelRef | undefined): Promise<void> {
    // `extensions` is never passed (footgun 30): the host default selection, and with it the guard hook, stays.
    await conv.configure({ model: ref }, BACKGROUND_CONTEXT);
    const agent = await conv.agent(BACKGROUND_CONTEXT);
    const guard = this.#d.guardExtension === undefined ? undefined : agent.extensions.find((e) => e.name === this.#d.guardExtension);
    const guardLost = this.#d.guardExtension !== undefined && (!guard || (guard.hooks ?? []).length === 0);
    if (!sameRef(agent.model as ModelRef | undefined, ref) || guardLost) {
      await conv.configure({ model: before ?? null }, BACKGROUND_CONTEXT).catch(() => undefined);
      this.#d.logger?.error("models.apply_readback_failed", { bot: this.#d.bot.id, guardPresent: !guardLost });
      throw new SettingsError("apply_failed", "the model could not be switched safely (the approval hook or the model did not hold); nothing was changed");
    }
  }

  // ---- the user's own switch ---------------------------------------------------------------------------------------

  async switchByUser(req: UserSwitchRequest): Promise<SwitchOutcome> {
    const d = this.#d;
    const problem = activePresetProblem(d.bot, d.presets, req.presetId, d.terms());
    const target = findPreset(d.presets, req.presetId);
    if (problem || !target) return { status: "rejected", text: `That model cannot be used: ${problem ?? "unknown preset"}.` };
    const current = this.effective();
    const resolved = this.resolved().preset;
    // Going back to the preset the bot is configured to use while a fallback runs: nothing widens, no write.
    if (this.#override && target.id === resolved.id) {
      this.clearFallback();
      await this.#follow(req);
      return { status: "applied", preset: target, text: `Back on ${target.label}. It applies from your next message.` };
    }
    if (target.id === current.id) return { status: "same", preset: target, text: `Already using ${target.label}.` };
    const verdict = switchVerdict(d.bot as ResolvedBot, d.presets, current.id, target.id);
    if (verdict === "reject") return { status: "rejected", preset: target, text: "That model is not one this bot may use." };
    if (verdict === "same") return { status: "same", preset: target, text: `Already using ${target.label}.` };
    if (!(await this.#reachable(target))) return { status: "rejected", preset: target, text: `${target.label} is not answering right now, so nothing was changed.` };
    if (verdict === "card") return this.#card(req, target);
    try {
      await this.#writePref(target.id, req.userId, req.conversationId);
    } catch (e) {
      return { status: "rejected", preset: target, text: e instanceof SettingsError ? `Not switched: ${e.message}` : "Not switched: the setting could not be saved." };
    }
    this.clearFallback();
    await this.#follow(req);
    return { status: "applied", preset: target, text: `Now using ${target.label}. It applies from your next message.` };
  }

  async #reachable(p: PresetConfig): Promise<boolean> {
    if (!this.#servable(p)) return false;
    if (!this.#d.up) return true;
    try {
      return await this.#d.up(p);
    } catch {
      return false;
    }
  }

  async #card(req: UserSwitchRequest, target: PresetConfig): Promise<SwitchOutcome> {
    const d = this.#d;
    if (!d.propose) return { status: "rejected", preset: target, text: "That switch needs your approval and no way to ask is available right now." };
    const where = target.privacy === "cloud" ? `sends this bot's text and tool output to ${target.kind === "acp" ? (target.providerId ?? "the proxy") : "a cloud model"}` : "changes the brain";
    try {
      const r = await d.propose({ path: this.path, value: target.id, reason: `chosen in /model: ${target.label} ${where}` }, { conversationId: req.conversationId ?? "", chatId: req.chatId });
      if (r.status === "applied") {
        this.clearFallback();
        await this.#follow(req);
        return { status: "applied", preset: target, text: r.summary };
      }
      return { status: "card", preset: target, text: `${target.label} ${where}, so I asked for your approval. The model changes only after you tap Approve.` };
    } catch (e) {
      return { status: "rejected", preset: target, text: e instanceof SettingsError ? `Not switched: ${e.message}` : "Not switched: the approval could not be requested." };
    }
  }

  async #writePref(presetId: string, userId: number, conversationId: string | undefined): Promise<void> {
    const d = this.#d;
    const segs = ["bots", d.bot.id, "activePreset"];
    await updateAudited({
      file: d.prefs.file,
      audit: d.audit,
      compute: (text) => {
        const cur = parsePrefsText(text);
        const next = applyToCopy(cur.prefs as Record<string, unknown>, segs, presetId);
        const diff = diffValues(cur.prefs, next);
        if (diff.length === 0) return undefined;
        return {
          newText: serialize(next),
          entry: {
            source: "telegram",
            kind: "setting",
            ...(conversationId ? { conversationId } : {}),
            target: { file: "prefs.json", path: this.path },
            diff,
            decision: "applied",
            approver: { kind: "tg", userId },
          },
        };
      },
    });
    d.prefs.invalidate();
  }

  async #follow(req: UserSwitchRequest): Promise<void> {
    if (!req.conversation || !req.conversationId) return;
    try {
      await this.ensureApplied(req.conversationId, req.conversation);
    } catch (e) {
      this.#d.logger?.warn("models.follow_failed", { bot: this.#d.bot.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ---- fallback override (S22.3) -----------------------------------------------------------------------------------

  /** The fallback engine chose `preset`: the bot answers with it (in memory only) until `clearFallback()`. */
  setFallback(preset: PresetConfig, reason: string): void {
    this.#override = { preset, reason };
  }

  clearFallback(): void {
    this.#override = undefined;
  }
}
