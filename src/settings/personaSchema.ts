/**
 * The persona schema and parser (S17.5, I27c). A persona is
 * `{id, name, description?, prompt, toolAllow[], mcpAllow{server: tool[]}, jobTemplates[], modelPreset,
 *   memory {write, scope?, sharedRead}, budgets {maxJobsPerDay?}}` with EVERY list explicit. Persona text is plain text, at most
 * 4,000 characters, control characters stripped. A persona never grants anything: enforcement is in code (S19.2).
 *
 * Pure: no adapter import.
 */
import { MAX_PERSONAS, PERSONA_ID_PATTERN } from "./contracts.js";
import type { Persona } from "./contracts.js";
import { validate } from "./jsonschema.js";
import type { Schema } from "./jsonschema.js";

export const PERSONA_PROMPT_MAX = 4000;
export { MAX_PERSONAS, PERSONA_ID_PATTERN };
export const BUILTIN_PERSONA_IDS: readonly string[] = ["default", "readonly"];

const nameList = (label: string): Schema => ({
  type: "array",
  items: { type: "string", pattern: "^[A-Za-z0-9_-]{1,100}$", maxLength: 100 },
  maxItems: 100,
  "x-ui": { widget: "tags", label },
});

export const PERSONA_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "prompt", "toolAllow", "mcpAllow", "jobTemplates", "modelPreset", "memory", "budgets"],
  properties: {
    id: { type: "string", pattern: PERSONA_ID_PATTERN.source, "x-ui": { widget: "text", label: "Id", help: "Lowercase letters, digits and dashes. Cannot be changed later." } },
    name: { type: "string", minLength: 1, maxLength: 60, "x-ui": { widget: "text", label: "Name" } },
    description: { type: "string", maxLength: 200, "x-ui": { widget: "text", label: "Description" } },
    prompt: { type: "string", maxLength: PERSONA_PROMPT_MAX, "x-ui": { widget: "textarea", label: "Prompt", help: "Plain text added to the system prompt. It cannot grant any permission." } },
    toolAllow: nameList("Allowed tools"),
    mcpAllow: { type: "object", additionalProperties: nameList("Tools"), "x-ui": { widget: "readonly", label: "Allowed MCP tools per server" } },
    jobTemplates: nameList("Allowed job templates"),
    modelPreset: { type: "string", pattern: "^[a-z][a-z0-9-]{0,23}$", "x-ui": { widget: "text", label: "Model preset" } },
    memory: {
      type: "object",
      additionalProperties: false,
      required: ["write", "sharedRead"],
      properties: {
        write: { type: "string", enum: ["shared", "scope", "none"], "x-ui": { widget: "select", label: "Memory writes" } },
        scope: { type: "string", pattern: PERSONA_ID_PATTERN.source, "x-ui": { widget: "text", label: "Memory scope" } },
        sharedRead: { type: "boolean", "x-ui": { widget: "toggle", label: "Read shared memory" } },
      },
    },
    budgets: {
      type: "object",
      additionalProperties: false,
      properties: { maxJobsPerDay: { type: "integer", minimum: 0, maximum: 10000, "x-ui": { widget: "number", label: "Jobs per day" } } },
    },
  },
};

/** Plain text: control characters (except newline and tab) stripped, CRLF normalised. */
export function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export interface ParsedPersona {
  persona?: Persona;
  issues: string[];
}

/** Validates the JSON shape and returns a normalised copy (text cleaned; no unknown keys can survive validation). */
export function parsePersona(raw: unknown): ParsedPersona {
  const issues = validate(PERSONA_SCHEMA, raw).map((i) => `${i.path}: ${i.message}`);
  if (issues.length > 0) return { issues };
  const r = raw as Persona;
  const persona: Persona = {
    id: r.id,
    name: cleanText(r.name).trim(),
    ...(r.description !== undefined ? { description: cleanText(r.description).trim() } : {}),
    prompt: cleanText(r.prompt),
    toolAllow: [...new Set(r.toolAllow)],
    mcpAllow: Object.fromEntries(Object.entries(r.mcpAllow).map(([k, v]) => [k, [...new Set(v)]])),
    jobTemplates: [...new Set(r.jobTemplates)],
    modelPreset: r.modelPreset,
    memory: { write: r.memory.write, sharedRead: r.memory.sharedRead, ...(r.memory.scope !== undefined ? { scope: r.memory.scope } : {}) },
    budgets: r.budgets.maxJobsPerDay !== undefined ? { maxJobsPerDay: r.budgets.maxJobsPerDay } : {},
  };
  if (persona.name === "") issues.push("name: must not be empty after cleaning");
  if (persona.memory.write !== "scope" && persona.memory.scope !== undefined) issues.push("memory.scope: only allowed with write: scope");
  return issues.length > 0 ? { issues } : { persona, issues: [] };
}

/** The memory scope a persona writes to (defaults to its id). */
export function memoryScopeOf(p: Pick<Persona, "id" | "memory">): string {
  return p.memory.scope ?? p.id;
}
