/**
 * Model-drafted personas (S19.4, I27b, UI-20): the `persona` kind of the proposal engine, behind `propose_persona`.
 *
 *  - `prepare` validates the draft (schema, then the ceiling) BEFORE any card: a widening draft, a built-in id, a user-authored id,
 *    a malformed draft and a 13th persona are refused as typed errors and never reach the user.
 *  - The card shows the full diff (prompt, tools, MCP tools, job templates, model preset, memory, budgets) with Approve / Edit /
 *    Reject. A prompt that does not fit on the card is sent in FULL first (`preface`), and Approve is enabled only after it was
 *    shown (the Telegram UI enforces that). Edit supersedes the proposal (the card answers "expired" afterwards) and tells the model
 *    the user wants changes.
 *  - Approve writes `prefs\personas\<id>.json` (temp file, audit line, rename). The file written equals the draft exactly.
 *    Approval re-validates against the CURRENT ceiling and the file's `baseRevision` (a stale one applies nothing).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PERSONA_ID_PATTERN, MAX_PERSONAS, SettingsError } from "../settings/contracts.js";
import type { Persona } from "../settings/contracts.js";
import { validateAgainstCeiling } from "../settings/ceiling.js";
import type { Ceiling } from "../settings/ceiling.js";
import { BUILTIN_PERSONA_IDS, parsePersona } from "../settings/personaSchema.js";
import { diffValues, readTextIfExists, replaceAudited, revisionOf, serialize } from "../settings/store.js";
import { payloadOf } from "../settings/proposals.js";
import type { ApplyContext, KindHandler, Prepared } from "../settings/proposals.js";
import type { SettingsAudit } from "../settings/contracts.js";
import type { PersonaStore } from "./store.js";

/** A prompt longer than this does not go on the card: it is sent in full before the card. */
export const INLINE_PROMPT_MAX = 1200;

export interface PersonaKindDeps {
  store: PersonaStore;
  ceiling: () => Ceiling;
  audit: SettingsAudit;
  /** `isActive(personaId)`: unused by the kind itself; present so a caller can refuse to overwrite a persona in use later. */
  known?: readonly string[];
  onWritten?: (personaId: string) => void;
}

function list(items: readonly string[], max = 500): string {
  if (items.length === 0) return "none";
  const t = items.join(", ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function personaCardLines(p: Persona, current: boolean): string[] {
  const mcp = Object.entries(p.mcpAllow).map(([s, t]) => `${s}: ${list(t, 150)}`);
  const inline = p.prompt.length <= INLINE_PROMPT_MAX;
  return [
    `${current ? "Changed" : "New"} persona proposed by the model: ${p.name} (${p.id})`,
    `Description: ${p.description ?? "(none)"}`,
    `Model preset: ${p.modelPreset}`,
    `Tools (${p.toolAllow.length}): ${list(p.toolAllow)}`,
    `MCP tools: ${mcp.length > 0 ? mcp.join(" | ") : "none"}`,
    `Job templates: ${list(p.jobTemplates)}`,
    `Memory: ${p.memory.write === "none" ? "never writes" : p.memory.write === "scope" ? `writes to its own file (${p.memory.scope ?? p.id})` : "writes the shared notes"}; ${p.memory.sharedRead ? "reads" : "does not read"} the shared notes`,
    `Jobs per day: ${p.budgets.maxJobsPerDay ?? "the allowed maximum"}`,
    inline ? `Prompt (${p.prompt.length} characters):\n${p.prompt.length === 0 ? "(empty)" : p.prompt}` : `Prompt: ${p.prompt.length} characters, sent in full above this card.`,
  ];
}

export function createPersonaKind(deps: PersonaKindDeps): KindHandler {
  const fileOf = (id: string): string => join(deps.store.modelDir, `${id}.json`);

  /** Parses and checks a draft; every refusal is a typed `SettingsError`. */
  const check = (draft: unknown): Persona => {
    const parsed = parsePersona(draft);
    if (!parsed.persona) throw new SettingsError("invalid_value", `the persona draft is not valid: ${parsed.issues.slice(0, 4).join("; ")}`);
    const p = parsed.persona;
    if (!PERSONA_ID_PATTERN.test(p.id) || BUILTIN_PERSONA_IDS.includes(p.id)) throw new SettingsError("persona_invalid", `the id "${p.id}" is a built-in persona id`);
    if (deps.store.isUserAuthored(p.id)) throw new SettingsError("persona_invalid", `the id "${p.id}" belongs to a persona the user wrote; choose another id`);
    const v = validateAgainstCeiling(p, deps.ceiling(), deps.known);
    if (!v.ok) throw new SettingsError("persona_invalid", `a persona can only narrow what is allowed, and this draft does not: ${v.reasons.slice(0, 4).join("; ")}`);
    const others = deps.store.files().filter((f) => f.id !== p.id);
    if (others.length >= MAX_PERSONAS) throw new SettingsError("persona_invalid", `there are already ${MAX_PERSONAS} personas; ask the user to delete one`);
    return p;
  };

  return {
    kind: "persona",
    prepare(input): Prepared {
      const p = check(input["draft"]);
      const file = fileOf(p.id);
      const current = readTextIfExists(file);
      const prefaceNeeded = p.prompt.length > INLINE_PROMPT_MAX;
      return {
        title: "Persona proposed by the model",
        target: { file: `prefs/personas/${p.id}.json`, path: "(document)" },
        diff: diffValues(current === undefined ? undefined : (JSON.parse(current) as unknown), p),
        lines: personaCardLines(p, current !== undefined),
        baseRevision: revisionOf(current),
        payload: { persona: p },
        classification: "card",
        buttons: ["approve", "edit", "reject"],
        ...(prefaceNeeded ? { preface: p.prompt } : {}),
      };
    },
    async apply(rec, ctx: ApplyContext): Promise<string> {
      const p = check((payloadOf<{ persona: unknown }>(rec)).persona);
      const file = fileOf(p.id);
      mkdirSync(deps.store.modelDir, { recursive: true });
      await replaceAudited({
        file,
        newText: serialize(p),
        baseRevision: rec.baseRevision,
        audit: deps.audit,
        entry: {
          source: ctx.source,
          kind: "persona",
          persona: p.id,
          conversationId: ctx.conversationId,
          target: rec.target,
          diff: diffValues(undefined, p),
          decision: ctx.decision,
          ...(ctx.userId !== undefined ? { approver: { kind: "tg" as const, userId: ctx.userId } } : {}),
          ...(ctx.messageId !== undefined ? { messageId: ctx.messageId } : {}),
          ...(ctx.proposalId ? { proposalId: ctx.proposalId } : {}),
        },
      });
      deps.onWritten?.(p.id);
      return `The ${p.name} persona was saved. Switch to it with /persona.`;
    },
    async edit(rec): Promise<string> {
      const id = (payloadOf<{ persona?: { id?: string } }>(rec).persona?.id ?? "the draft").toString().slice(0, 30);
      return `[agent-007 notice, not written by the user] The user did not approve your persona draft "${id}" and wants it changed. Ask the user what to change, then call propose_persona again with a revised draft.`;
    },
  };
}
