/**
 * The ceiling and persona validation (S17.5, I27c). The ceiling is what `security.json` and the code allow. A persona is VALID
 * only if every list is a subset of the ceiling, its preset is a security preset and its budgets are at or below the ceiling.
 * An invalid persona is NOT clipped: it is unselectable and shows its reasons. `effective()` intersects, so even a persona that
 * slipped past validation can never exceed the ceiling.
 *
 * `Ceiling` is generic on purpose: Phase 4 reuses `validateAgainstCeiling` and `compare` with a per-bot ceiling (I43).
 * Pure subset.
 */
import { KNOWN_TOOLS, MACRO_TOOLS } from "./catalog.js";
import type { EffectivePersona, Persona } from "./contracts.js";
import { PERSONA_ID_PATTERN } from "./contracts.js";

export interface Ceiling {
  tools: readonly string[];
  /** MCP server id to the tools the admin allowed on it. */
  mcp: Readonly<Record<string, readonly string[]>>;
  jobTemplates: readonly string[];
  presets: readonly string[];
  defaultPreset: string;
  /** Shared memory write is allowed (always true in Phase 3). */
  sharedMemoryWrite: boolean;
  /** `Infinity` when there is no cap. */
  maxJobsPerDay: number;
}

/** The parts of `security.json` the ceiling reads. */
export interface SecurityLike {
  shell?: { enabled?: boolean };
  mcp?: { servers?: { id: string; allowTools: string[]; macros: string[] }[] };
  presets?: { id: string }[];
  model?: { defaultPreset?: string; runner?: string };
  budgets?: { maxJobsPerDay?: number };
}

export interface CeilingCatalogs {
  /** Job template ids the agent sees. */
  templates: readonly string[];
  /** Known tool names; defaults to `KNOWN_TOOLS`. */
  knownTools?: readonly string[];
}

export function ceilingFor(security: SecurityLike, catalogs: CeilingCatalogs): Ceiling {
  const known = catalogs.knownTools ?? KNOWN_TOOLS;
  const servers = security.mcp?.servers ?? [];
  const enabledMacros = new Set(servers.flatMap((s) => s.macros));
  const shellOn = security.shell?.enabled !== false;
  const tools = known.filter((t) => (t === "shell" ? shellOn : true) && (MACRO_TOOLS.includes(t) ? enabledMacros.has(t) : true));
  const mcp: Record<string, string[]> = {};
  for (const s of servers) mcp[s.id] = [...s.allowTools];
  const presets = (security.presets ?? []).map((p) => p.id);
  const defaultPreset = security.model?.defaultPreset ?? presets[0] ?? security.model?.runner ?? "lmstudio";
  const cap = security.budgets?.maxJobsPerDay;
  return {
    tools,
    mcp,
    jobTemplates: [...catalogs.templates],
    presets: presets.length > 0 ? presets : [defaultPreset],
    defaultPreset,
    sharedMemoryWrite: true,
    maxJobsPerDay: typeof cap === "number" ? cap : Number.POSITIVE_INFINITY,
  };
}

export interface PersonaValidation {
  ok: boolean;
  reasons: string[];
}

export function validateAgainstCeiling(p: Persona, c: Ceiling, known: readonly string[] = KNOWN_TOOLS): PersonaValidation {
  const reasons: string[] = [];
  for (const t of p.toolAllow) {
    if (!known.includes(t)) reasons.push(`tool "${t}" is not a known tool`);
    else if (!c.tools.includes(t)) reasons.push(`tool "${t}" is outside what the security settings allow${t === "shell" ? " (shell is turned off)" : ""}`);
  }
  for (const [server, tools] of Object.entries(p.mcpAllow)) {
    const allowed = Object.prototype.hasOwnProperty.call(c.mcp, server) ? c.mcp[server] : undefined;
    if (allowed === undefined) {
      reasons.push(`MCP server "${server}" is not configured`);
      continue;
    }
    for (const t of tools) if (!allowed.includes(t)) reasons.push(`MCP tool "${server}/${t}" is not allowed on that server`);
  }
  for (const t of p.jobTemplates) if (!c.jobTemplates.includes(t)) reasons.push(`job template "${t}" is not available`);
  if (!c.presets.includes(p.modelPreset)) reasons.push(`model preset "${p.modelPreset}" is not one of the security presets`);
  if (p.memory.write === "shared" && !c.sharedMemoryWrite) reasons.push("shared memory writes are not allowed");
  if (p.memory.write === "scope" && !PERSONA_ID_PATTERN.test(p.memory.scope ?? p.id)) reasons.push("memory scope is not a valid name");
  const mj = p.budgets.maxJobsPerDay;
  if (mj !== undefined && mj > c.maxJobsPerDay) reasons.push(`maxJobsPerDay ${mj} is above the allowed ${c.maxJobsPerDay}`);
  return { ok: reasons.length === 0, reasons };
}

/** The persona with every list intersected with the ceiling; budgets take the minimum. Never wider than `c`. */
export function effective(p: Persona, c: Ceiling): EffectivePersona {
  const mcp: Record<string, string[]> = {};
  for (const [server, tools] of Object.entries(p.mcpAllow)) {
    if (!Object.prototype.hasOwnProperty.call(c.mcp, server)) continue;
    const allowed = c.mcp[server] ?? [];
    mcp[server] = tools.filter((t) => allowed.includes(t));
  }
  const cap = Math.min(p.budgets.maxJobsPerDay ?? Number.POSITIVE_INFINITY, c.maxJobsPerDay);
  return {
    id: p.id,
    tools: c.tools.filter((t) => p.toolAllow.includes(t)),
    mcp,
    jobTemplates: c.jobTemplates.filter((t) => p.jobTemplates.includes(t)),
    modelPreset: c.presets.includes(p.modelPreset) ? p.modelPreset : c.defaultPreset,
    memory: { write: p.memory.write, ...(p.memory.write === "scope" ? { scope: p.memory.scope ?? p.id } : {}), sharedRead: p.memory.sharedRead },
    maxJobsPerDay: Number.isFinite(cap) ? cap : undefined,
    prompt: p.prompt,
  };
}

/** The `default` persona: the whole ceiling (Phase 1/2 behaviour). `configure()` is not called for it. */
export function defaultEffective(c: Ceiling): EffectivePersona {
  const mcp: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(c.mcp)) mcp[k] = [...v];
  return {
    id: "default",
    tools: [...c.tools],
    mcp,
    jobTemplates: [...c.jobTemplates],
    modelPreset: c.defaultPreset,
    memory: { write: "shared", sharedRead: true },
    maxJobsPerDay: Number.isFinite(c.maxJobsPerDay) ? c.maxJobsPerDay : undefined,
    prompt: "",
  };
}
