/**
 * The persona resolver (S19.1, I27c, I27d): implements `PersonaRuntime`. A durable `PersonaMap` document maps each chat to its
 * persona id (`/new` keeps it; a new chat starts with `prefs.defaultPersona`) and counts the jobs a persona started today.
 *
 * FAIL CLOSED: if the active persona is invalid (a security narrowing made it exceed the ceiling, or a forged file) the next turn
 * runs as `readonly`, the chat gets ONE notice naming the persona and the reason, and it never falls back to `default`.
 * Persona text and files are untrusted input; every effective set is intersected with the ceiling (`effective()`).
 */
import type { ChatLookup, Logger } from "../contracts.js";
import { BACKGROUND_CONTEXT, defineDoc } from "../pi/adapter.js";
import type { Harness } from "../pi/adapter.js";
import { readonlyEffective, summarize } from "../settings/builtins.js";
import { defaultEffective, effective } from "../settings/ceiling.js";
import type { Ceiling } from "../settings/ceiling.js";
import { SettingsError } from "../settings/contracts.js";
import type { EffectivePersona, PersonaRuntime, PersonaSummary } from "../settings/contracts.js";
import { memoryScopeOf } from "../settings/personaSchema.js";
import type { PrefsStore } from "../settings/prefs.js";
import type { PersonaStore } from "./store.js";

type MapValue = { chats: Record<string, string>; jobs: { day: string; counts: Record<string, number> } };

export const personaMapDoc = defineDoc<MapValue>({
  kind: "a7.personas.map",
  version: 1,
  scope: "session",
  initial: () => ({ chats: {}, jobs: { day: "", counts: {} } }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 25,
});

export interface ResolverDeps {
  store: PersonaStore;
  ceiling: () => Ceiling;
  chats: ChatLookup;
  prefs: PrefsStore;
  getHarness: () => Harness | undefined;
  logger?: Logger | undefined;
  now?: () => number;
}

export interface Resolved {
  /** The persona that is in force (`readonly` when the requested one failed). */
  personaId: string;
  requested: string;
  name: string;
  effective: EffectivePersona;
  /** True when the requested persona is invalid and `readonly` is used instead. */
  fallback: boolean;
  reasons: string[];
}

export interface MemoryView {
  personaId: string;
  write: "shared" | "scope" | "none";
  scope?: string;
  sharedRead: boolean;
}

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class PersonaResolver implements PersonaRuntime {
  readonly #d: ResolverDeps;
  readonly #now: () => number;
  readonly #map = new Map<string, string>();
  #jobs: { day: string; counts: Record<string, number> } = { day: "", counts: {} };
  readonly #pendingNotices = new Map<string, string>();
  readonly #noticed = new Set<string>();
  #applier: ((conversationId: string) => Promise<void>) | undefined;

  constructor(deps: ResolverDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** Reads the durable map (after the Harness is open). */
  async load(): Promise<void> {
    const h = this.#d.getHarness();
    if (!h) return;
    const snap = await h.snapshot(personaMapDoc, BACKGROUND_CONTEXT);
    this.#map.clear();
    for (const [k, v] of Object.entries(snap?.chats ?? {})) this.#map.set(k, v);
    this.#jobs = snap?.jobs ? { day: snap.jobs.day, counts: { ...snap.jobs.counts } } : { day: "", counts: {} };
  }

  /** `apply.ts` registers how a persona reaches a conversation (`configure()`). */
  setApplier(fn: (conversationId: string) => Promise<void>): void {
    this.#applier = fn;
  }

  #key(conversationId: string): string {
    const chat = this.#d.chats.chatForConversation(conversationId);
    return chat === undefined ? `c:${conversationId}` : String(chat);
  }

  current(conversationId: string): string {
    return this.#map.get(this.#key(conversationId)) ?? this.#d.prefs.get().prefs.defaultPersona ?? "default";
  }

  #effectiveOfValid(id: string, c: Ceiling): { effective: EffectivePersona; name: string } | { reasons: string[] } {
    if (id === "default") return { effective: defaultEffective(c), name: "Default" };
    if (id === "readonly") return { effective: readonlyEffective(c), name: "Read-only" };
    const e = this.#d.store.get(id, c);
    if (e?.valid && e.persona) return { effective: effective(e.persona, c), name: e.persona.name };
    return { reasons: e ? e.reasons : ["the persona does not exist"] };
  }

  /** What is in force for a conversation. Queues the fail-closed notice (once) when the requested persona is unusable. */
  resolve(conversationId: string): Resolved {
    const c = this.#d.ceiling();
    const requested = this.current(conversationId);
    const key = this.#key(conversationId);
    const r = this.#effectiveOfValid(requested, c);
    if ("effective" in r) {
      for (const k of [...this.#noticed]) if (k.startsWith(`${key}|`)) this.#noticed.delete(k);
      return { personaId: requested, requested, name: r.name, effective: r.effective, fallback: false, reasons: [] };
    }
    const ro = readonlyEffective(c);
    const tag = `${key}|${requested}|${r.reasons.join(";")}`;
    if (!this.#noticed.has(tag)) {
      this.#noticed.add(tag);
      this.#pendingNotices.set(key, `The "${requested}" persona cannot be used right now (${r.reasons.slice(0, 3).join("; ")}), so I am running in the read-only persona. Use /persona to pick another.`);
      this.#d.logger?.warn("personas.fallback_readonly", { persona: requested, reasons: r.reasons.slice(0, 5) });
    }
    return { personaId: "readonly", requested, name: "Read-only", effective: ro, fallback: true, reasons: r.reasons };
  }

  /** The one-time notice for a conversation's chat (consumed). */
  noticeFor(conversationId: string): string | undefined {
    const key = this.#key(conversationId);
    const n = this.#pendingNotices.get(key);
    this.#pendingNotices.delete(key);
    return n;
  }

  effective(conversationId: string): EffectivePersona {
    return this.resolve(conversationId).effective;
  }

  effectiveOf(personaId: string): EffectivePersona | undefined {
    const r = this.#effectiveOfValid(personaId, this.#d.ceiling());
    return "effective" in r ? r.effective : undefined;
  }

  list(): PersonaSummary[] {
    const c = this.#d.ceiling();
    const out: PersonaSummary[] = [
      { id: "default", name: "Default", description: "Everything the settings allow.", source: "builtin", valid: true, reasons: [], summary: summarize(defaultEffective(c)) },
      { id: "readonly", name: "Read-only", description: "Look things up and answer; change nothing.", source: "builtin", valid: true, reasons: [], summary: summarize(readonlyEffective(c)) },
    ];
    for (const e of this.#d.store.entries(c)) {
      out.push({
        id: e.id,
        name: e.persona?.name ?? e.id,
        description: e.persona?.description ?? "",
        source: e.source,
        valid: e.valid,
        reasons: e.valid ? [] : e.reasons.length > 0 ? e.reasons : ["invalid"],
        summary: e.valid && e.persona ? summarize(effective(e.persona, c)) : "",
      });
    }
    return out;
  }

  async apply(conversationId: string, personaId: string): Promise<void> {
    const s = this.list().find((p) => p.id === personaId);
    if (!s) throw new SettingsError("unknown_persona", `there is no persona called "${personaId.slice(0, 40)}"`);
    if (!s.valid) throw new SettingsError("persona_invalid", `that persona is not usable: ${s.reasons.join("; ")}`);
    const key = this.#key(conversationId);
    this.#map.set(key, personaId);
    const h = this.#d.getHarness();
    if (h) {
      await h.commit(async (tx) => {
        const doc = await tx.doc(personaMapDoc);
        doc.chats[key] = personaId;
      }, BACKGROUND_CONTEXT);
    }
    if (this.#applier) await this.#applier(conversationId);
  }

  /** Forgets a chat's choice (a deleted persona): the chat goes back to the default persona of the prefs. */
  async forget(personaId: string): Promise<void> {
    const keys = [...this.#map.entries()].filter(([, v]) => v === personaId).map(([k]) => k);
    for (const k of keys) this.#map.delete(k);
    const h = this.#d.getHarness();
    if (h && keys.length > 0) {
      await h.commit(async (tx) => {
        const doc = await tx.doc(personaMapDoc);
        for (const k of keys) delete doc.chats[k];
      }, BACKGROUND_CONTEXT);
    }
  }

  memoryFor(conversationId: string): MemoryView {
    const r = this.resolve(conversationId);
    const m = r.effective.memory;
    return {
      personaId: r.personaId,
      write: m.write,
      ...(m.write === "scope" ? { scope: m.scope ?? memoryScopeOf({ id: r.personaId, memory: m }) } : {}),
      sharedRead: m.sharedRead,
    };
  }

  /**
   * One more job started by this conversation's persona today. `ok: false` when its `maxJobsPerDay` is used up. Counted per
   * persona and local day, durable, and reset at local midnight. The `default` persona is not counted (the job runner's own daily
   * cap governs it).
   */
  async countJob(conversationId: string): Promise<{ ok: boolean; used: number; max?: number }> {
    const r = this.resolve(conversationId);
    if (r.personaId === "default") return { ok: true, used: 0 };
    const max = r.effective.maxJobsPerDay;
    const day = localDay(this.#now());
    if (this.#jobs.day !== day) this.#jobs = { day, counts: {} };
    const used = this.#jobs.counts[r.personaId] ?? 0;
    if (max !== undefined && used >= max) return { ok: false, used, max };
    this.#jobs.counts[r.personaId] = used + 1;
    const h = this.#d.getHarness();
    if (h) {
      const snapshot = { day, counts: { ...this.#jobs.counts } };
      await h.commit(async (tx) => {
        const doc = await tx.doc(personaMapDoc);
        doc.jobs = snapshot;
      }, BACKGROUND_CONTEXT);
    }
    return { ok: true, used: used + 1, ...(max !== undefined ? { max } : {}) };
  }
}
