/**
 * The built-in personas (S19.1): `default` (the whole ceiling; `configure()` is not called for it) and `readonly` (the read tools,
 * no MCP, no job templates, memory `{write: "none", sharedRead: true}`). They live in code, cannot be edited and cannot be shadowed.
 * The definitions are shared with the S17 stub runtime (`src/settings/builtins.ts`).
 */
export { READONLY_PERSONA_PROMPT, readonlyEffective, readonlyPersona, summarize } from "../settings/builtins.js";
export { READONLY_TOOLS } from "../settings/catalog.js";
export { BUILTIN_PERSONA_IDS } from "../settings/personaSchema.js";
