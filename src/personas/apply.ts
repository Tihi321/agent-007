/**
 * Applying a persona to a conversation (S19.2, I27f, U43, U43a, U43b). `ensureApplied` runs before each submission (the bridge calls
 * it from its admission path) and after a switch. It computes the persona's `effective` set and calls
 * `conversation.configure({tools, model?})`: `tools` is an ARRAY of registrations, which the Pi API documents as "enables exactly
 * these", so a tool that is not listed is hidden from the model and from the `tool_search` index (U43b). `extensions` is NEVER passed
 * (footgun 30): the host default selection stays, so the guard hook stays. The default persona is the whole ceiling, so for it
 * `configure()` is not called at all (a no-persona install behaves exactly as Phase 2), except to undo an earlier persona.
 *
 * After `configure()` the result is READ BACK (`conversation.agent()`): if the guard extension's hook is missing, or a tool outside the
 * persona's set is still offered, the change is reverted and the turn is refused (fail closed). The persona's model preset is switched
 * the same way; a preset on a runner that is not running refuses the switch (UI-20c), with no silent fallback.
 */
import type { Logger } from "../contracts.js";
import { BACKGROUND_CONTEXT } from "../pi/adapter.js";
import type { Conversation, Registry, ToolRegistration } from "../pi/adapter.js";
import { SettingsError } from "../settings/contracts.js";
import type { EffectivePersona } from "../settings/contracts.js";
import type { PersonaResolver, Resolved } from "./resolver.js";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface PresetModel {
  ref: ModelRef;
  /** Resolves true when the preset's runner answers. Called when a persona's preset differs from the base model. */
  up(): Promise<boolean>;
}

export interface ApplyDeps {
  resolver: PersonaResolver;
  registry: () => Registry | undefined;
  getConversation: (conversationId: string) => Promise<Conversation | undefined>;
  /** The model every conversation starts with (the active runner). */
  baseModel: ModelRef;
  /** A preset id to its model and a runner check; absent = presets are not switched. */
  presetModel?: ((presetId: string) => PresetModel | undefined) | undefined;
  /** The host extension whose hook must survive `configure()`. */
  guardExtension: string;
  logger?: Logger | undefined;
}

export interface Ensured {
  notice?: string;
}

/** The tool and MCP names a persona may use, as registry names. */
export function allowedToolNames(e: EffectivePersona): Set<string> {
  const names = new Set<string>(e.tools);
  for (const [server, tools] of Object.entries(e.mcp)) for (const t of tools) names.add(`mcp__${server}__${t}`);
  return names;
}

export class PersonaApplier {
  readonly #d: ApplyDeps;
  readonly #applied = new Map<string, string>();

  constructor(deps: ApplyDeps) {
    this.#d = deps;
    deps.resolver.setApplier((id) => this.apply(id));
  }

  /** The user or the model switched: apply now, whatever was applied before (also undoes an older persona after a restart). */
  async apply(conversationId: string): Promise<void> {
    const conv = await this.#d.getConversation(conversationId);
    if (!conv) return;
    this.#applied.delete(conversationId);
    await this.ensureApplied(conversationId, conv, true);
  }

  async ensureApplied(conversationId: string, conv: Conversation, force = false): Promise<Ensured> {
    const r = this.#d.resolver.resolve(conversationId);
    const notice = this.#d.resolver.noticeFor(conversationId);
    const sig = signature(r);
    if (this.#applied.get(conversationId) === sig) return notice ? { notice } : {};
    if (r.personaId === "default" && !r.fallback && !force && !this.#applied.has(conversationId)) {
      this.#applied.set(conversationId, sig); // never configured in this process and nothing to undo
      return notice ? { notice } : {};
    }
    await this.#configure(conv, r, force);
    this.#applied.set(conversationId, sig);
    return notice ? { notice } : {};
  }

  /**
   * `userSwitch` is true only when the user (or the model, with approval) switched persona now (`apply()`). Only then does the persona's
   * `modelPreset` pick the model. Every other path (the first turn after a restart, a changed tool set) uses the base model, which is
   * the bot's `bots.<id>.activePreset`: that value is the source of truth and a persona never overwrites it.
   */
  async #configure(conv: Conversation, r: Resolved, userSwitch: boolean): Promise<void> {
    const registry = this.#d.registry();
    if (!registry) throw new SettingsError("persona_invalid", "the tool registry is not ready");
    // a snapshot: the dependency may be a live getter object (`ModelSwitcher.liveModelRef()`)
    const base: ModelRef = { provider: this.#d.baseModel.provider, modelId: this.#d.baseModel.modelId };
    const preset = userSwitch ? this.#d.presetModel?.(r.effective.modelPreset) : undefined;
    const wantModel = preset && (preset.ref.provider !== base.provider || preset.ref.modelId !== base.modelId) ? preset : undefined;
    if (wantModel && !(await wantModel.up())) throw new SettingsError("persona_invalid", `the model for this persona is on a runner that is not running (${wantModel.ref.provider}); nothing was changed`);

    if (r.personaId === "default" && !r.fallback) {
      await conv.configure({ tools: null, instructions: null, model: base }, BACKGROUND_CONTEXT);
      return;
    }
    const allowed = allowedToolNames(r.effective);
    const byName = new Map<string, ToolRegistration>();
    for (const { tool } of registry.snapshot().tools()) if (!byName.has(tool.name)) byName.set(tool.name, tool);
    const regs = [...allowed].flatMap((n) => {
      const t = byName.get(n);
      return t ? [t] : [];
    });
    await conv.configure({ tools: regs, model: wantModel ? wantModel.ref : base }, BACKGROUND_CONTEXT);

    // Read it back: the guard hook must still be there, and nothing outside the persona's set may be offered.
    const agent = await conv.agent(BACKGROUND_CONTEXT);
    const guard = agent.extensions.find((e) => e.name === this.#d.guardExtension);
    const offered = [...agent.tools, ...agent.callable, ...agent.deferred].map((t) => t.name);
    const stray = offered.filter((n) => !allowed.has(n));
    if (!guard || (guard.hooks ?? []).length === 0 || stray.length > 0) {
      await conv.configure({ tools: null, instructions: null, model: base }, BACKGROUND_CONTEXT).catch(() => undefined);
      this.#d.logger?.error("personas.apply_readback_failed", { persona: r.personaId, guardPresent: Boolean(guard), stray: stray.slice(0, 5) });
      throw new SettingsError("persona_invalid", "the persona could not be applied safely (the approval hook or the tool list did not hold); nothing was changed");
    }
  }
}

function signature(r: Resolved): string {
  return JSON.stringify([r.personaId, r.fallback, [...allowedToolNames(r.effective)].sort(), r.effective.modelPreset]);
}
