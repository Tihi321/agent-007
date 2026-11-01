/**
 * Persona order (S17.5, I27d): `compare(from, to)` returns `equal`, `narrower`, `broader` or `incomparable` with the capability
 * lists that were `added` and `removed`. Sets compared: tools, per-server MCP tools, job templates. Memory: write
 * `shared` > `scope` > `none`; two different scopes are incomparable; `sharedRead` true > false. `maxJobsPerDay`: higher (or
 * absent) is broader. A model preset difference is NOT a broadening in Phase 3 (every preset is local and admin-listed);
 * `presetWidens` is the hook Phase 4's I38 uses for cloud presets.
 *
 * Pure subset.
 */
import type { EffectivePersona } from "./contracts.js";

export type Relation = "equal" | "narrower" | "broader" | "incomparable";

export interface Comparison {
  relation: Relation;
  added: string[];
  removed: string[];
}

export interface CompareOptions {
  presetWidens?: (from: string, to: string) => boolean;
}

const WRITE_RANK: Record<string, number> = { none: 0, scope: 1, shared: 2 };

function diffSets(from: readonly string[], to: readonly string[], label: string, added: string[], removed: string[]): void {
  for (const t of to) if (!from.includes(t)) added.push(`${label}${t}`);
  for (const t of from) if (!to.includes(t)) removed.push(`${label}${t}`);
}

export function compare(from: EffectivePersona, to: EffectivePersona, opts: CompareOptions = {}): Comparison {
  const added: string[] = [];
  const removed: string[] = [];
  diffSets(from.tools, to.tools, "tool: ", added, removed);
  const servers = new Set([...Object.keys(from.mcp), ...Object.keys(to.mcp)]);
  for (const s of [...servers].sort()) diffSets(from.mcp[s] ?? [], to.mcp[s] ?? [], `MCP tool: ${s}/`, added, removed);
  diffSets(from.jobTemplates, to.jobTemplates, "job template: ", added, removed);

  const fr = WRITE_RANK[from.memory.write] ?? 0;
  const tr = WRITE_RANK[to.memory.write] ?? 0;
  if (from.memory.write === "scope" && to.memory.write === "scope" && from.memory.scope !== to.memory.scope) {
    added.push(`memory: writes to scope ${to.memory.scope ?? "?"}`);
    removed.push(`memory: writes to scope ${from.memory.scope ?? "?"}`);
  } else if (tr > fr) added.push(`memory: write ${to.memory.write}`);
  else if (tr < fr) removed.push(`memory: write ${from.memory.write}`);
  if (to.memory.sharedRead && !from.memory.sharedRead) added.push("memory: reads the shared notes");
  if (!to.memory.sharedRead && from.memory.sharedRead) removed.push("memory: reads the shared notes");

  const fj = from.maxJobsPerDay ?? Number.POSITIVE_INFINITY;
  const tj = to.maxJobsPerDay ?? Number.POSITIVE_INFINITY;
  const show = (n: number): string => (Number.isFinite(n) ? String(n) : "no cap");
  if (tj > fj) added.push(`jobs per day: ${show(fj)} -> ${show(tj)}`);
  else if (tj < fj) removed.push(`jobs per day: ${show(fj)} -> ${show(tj)}`);

  if (from.modelPreset !== to.modelPreset && opts.presetWidens?.(from.modelPreset, to.modelPreset)) added.push(`model preset: ${to.modelPreset}`);

  const relation: Relation = added.length === 0 && removed.length === 0 ? "equal" : added.length === 0 ? "narrower" : removed.length === 0 ? "broader" : "incomparable";
  return { relation, added, removed };
}

/** A model-initiated switch applies at once for these relations; the others need a card. */
export function appliesWithoutCard(r: Relation): boolean {
  return r === "equal" || r === "narrower";
}
