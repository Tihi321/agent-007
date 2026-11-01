/**
 * The built-in personas and the S17 stub runtime (S17.7, S19.1).
 *
 *  - `default`: the whole ceiling (Phase 1/2 behaviour; `configure()` is never called for it).
 *  - `readonly`: `READONLY_TOOLS`, no MCP, no job templates, memory `{write: "none", sharedRead: true}`.
 *
 * `createStubPersonaRuntime` knows only these two and answers `personas_not_active` for `apply`, until S19's real runtime
 * replaces it. S19 imports `readonlyPersona` from here (S19 does not edit `src/settings/**`).
 *
 * Pure subset.
 */
import { READONLY_TOOLS } from "./catalog.js";
import { defaultEffective, effective } from "./ceiling.js";
import type { Ceiling } from "./ceiling.js";
import { SettingsError } from "./contracts.js";
import type { EffectivePersona, Persona, PersonaRuntime, PersonaSummary } from "./contracts.js";

export const READONLY_PERSONA_PROMPT = "You are in read-only mode. You can look things up and answer questions, but you cannot change anything: no commands, no files, no jobs, no saved notes.";

export function readonlyPersona(): Persona {
  return {
    id: "readonly",
    name: "Read-only",
    description: "Look things up and answer; change nothing.",
    prompt: READONLY_PERSONA_PROMPT,
    toolAllow: [...READONLY_TOOLS],
    mcpAllow: {},
    jobTemplates: [],
    modelPreset: "",
    memory: { write: "none", sharedRead: true },
    budgets: { maxJobsPerDay: 0 },
  };
}

/** The effective form of `readonly` under a ceiling (its preset is the ceiling's default preset). */
export function readonlyEffective(c: Ceiling): EffectivePersona {
  return effective({ ...readonlyPersona(), modelPreset: c.defaultPreset }, c);
}

export function summarize(e: EffectivePersona): string {
  const mcp = Object.values(e.mcp).reduce((n, t) => n + t.length, 0);
  const memory = e.memory.write === "none" ? "no memory writes" : e.memory.write === "scope" ? `memory scope ${e.memory.scope ?? e.id}` : "shared memory writes";
  return `${e.tools.length} tools${e.tools.includes("shell") ? " (incl. shell)" : ""}, ${mcp} MCP tools, ${e.jobTemplates.length} job templates, ${memory}`;
}

export function createStubPersonaRuntime(ceiling: () => Ceiling): PersonaRuntime {
  const summaries = (): PersonaSummary[] => {
    const c = ceiling();
    return [
      { id: "default", name: "Default", description: "Everything the settings allow.", source: "builtin", valid: true, reasons: [], summary: summarize(defaultEffective(c)) },
      { id: "readonly", name: "Read-only", description: "Look things up and answer; change nothing.", source: "builtin", valid: true, reasons: [], summary: summarize(readonlyEffective(c)) },
    ];
  };
  const effectiveOf = (id: string): EffectivePersona | undefined => (id === "default" ? defaultEffective(ceiling()) : id === "readonly" ? readonlyEffective(ceiling()) : undefined);
  return {
    list: summaries,
    current: () => "default",
    effective: () => defaultEffective(ceiling()),
    effectiveOf,
    apply: async () => {
      throw new SettingsError("personas_not_active", "personas are not active on this install yet");
    },
  };
}
