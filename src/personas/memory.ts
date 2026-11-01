/**
 * Memory scope (S19.5, I27c). A persona with `memory.write: "scope"` writes `memory\MEMORY.<scope>.md` (the scope defaults to the
 * persona id and matches `[a-z][a-z0-9-]{1,23}`; the path is built here, never by joining model text); with `"shared"` it writes
 * `MEMORY.md` as before; with `"none"` `remember` is blocked. `sharedRead` decides whether the shared file is in the prompt. The
 * scope files sit in the agent data root, so the path policy (group (b)) keeps `read_file` away from them.
 */
import { dirname, join } from "node:path";
import { PERSONA_ID_PATTERN } from "../settings/contracts.js";
import type { MemoryTarget } from "../tools/memory.js";
import type { PersonaResolver } from "./resolver.js";

/** `<dir of MEMORY.md>\MEMORY.<scope>.md`. Throws for a scope that is not a plain name. */
export function scopeFile(memoryFile: string, scope: string): string {
  if (!PERSONA_ID_PATTERN.test(scope)) throw new Error("memory scope is not a valid name");
  return join(dirname(memoryFile), `MEMORY.${scope}.md`);
}

/** What the `remember` tool uses to find its file for a conversation (the default persona: the shared file, as in Phase 1). */
export function createMemoryTargetResolver(resolver: PersonaResolver, memoryFile: string): (conversationId: string) => MemoryTarget {
  return (conversationId) => {
    const v = resolver.memoryFor(conversationId);
    if (v.write === "none") return { write: "none", file: memoryFile };
    if (v.write === "scope" && v.scope) return { write: "scope", file: scopeFile(memoryFile, v.scope), scope: v.scope };
    return { write: "shared", file: memoryFile };
  };
}

/** What the `memory` prompt section uses: whether the shared notes are shown and which scope file is shown first. */
export function createMemoryPromptView(resolver: PersonaResolver, memoryFile: string): (conversationId: string) => { sharedRead: boolean; scope?: string; scopeFile?: string } {
  return (conversationId) => {
    const v = resolver.memoryFor(conversationId);
    if (v.write === "scope" && v.scope) return { sharedRead: v.sharedRead, scope: v.scope, scopeFile: scopeFile(memoryFile, v.scope) };
    return { sharedRead: v.sharedRead };
  };
}
