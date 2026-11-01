/**
 * Switching (S19.3, I26a, I27d, UI-20d). The user's OWN `/persona` tap or command applies at once, even to a broader persona, and is
 * audited `source: "telegram"`. A model-initiated switch is `switch_persona` (S17.7): equal or narrower applies at once, broader or
 * incomparable needs one card. This module has the user's side and the picker labels.
 */
import { sha256Text } from "../settings/chain.js";
import { compare } from "../settings/compare.js";
import type { Comparison, Relation } from "../settings/compare.js";
import { SettingsError } from "../settings/contracts.js";
import type { PersonaRuntime, SettingsAudit } from "../settings/contracts.js";

export function relationLabel(r: Relation): string {
  return r === "equal" ? "(equal)" : r === "narrower" ? "(narrower)" : r === "broader" ? "(broader)" : "(different)";
}

/** How `to` compares with the persona now in force in a conversation. */
export function compareWithCurrent(runtime: PersonaRuntime, conversationId: string, to: string): Comparison | undefined {
  const from = runtime.effective(conversationId) ?? runtime.effectiveOf(runtime.current(conversationId));
  const target = runtime.effectiveOf(to);
  return from && target ? compare(from, target) : undefined;
}

export interface UserSwitch {
  runtime: PersonaRuntime;
  audit: SettingsAudit;
  conversationId: string;
  userId: number;
  personaId: string;
}

/** The user's own switch: applies at once and writes one audit line. Throws `unknown_persona` or `persona_invalid`. */
export async function switchByUser(s: UserSwitch): Promise<{ relation: Relation; text: string }> {
  const target = s.runtime.list().find((p) => p.id === s.personaId);
  if (!target) throw new SettingsError("unknown_persona", `there is no persona called "${s.personaId.slice(0, 40)}"`);
  if (!target.valid) throw new SettingsError("persona_invalid", `that persona is not usable: ${target.reasons.join("; ")}`);
  const fromId = s.runtime.current(s.conversationId);
  const cmp = compareWithCurrent(s.runtime, s.conversationId, s.personaId);
  if (fromId === s.personaId) return { relation: "equal", text: `Already using the ${s.personaId} persona.` };
  await s.runtime.apply(s.conversationId, s.personaId);
  s.audit.append({
    source: "telegram",
    kind: "switch",
    persona: s.personaId,
    conversationId: s.conversationId,
    target: { file: "personas/active", path: s.conversationId },
    diff: [{ path: "activePersona", op: "replace", before: fromId, after: s.personaId }],
    decision: "applied",
    approver: { kind: "tg", userId: s.userId },
    baseRevision: sha256Text(`persona:${fromId}`),
    afterRevision: sha256Text(`persona:${s.personaId}`),
    ...(cmp ? { note: cmp.relation } : {}),
  });
  return { relation: cmp?.relation ?? "equal", text: `Now using the ${target.name} persona${cmp ? ` ${relationLabel(cmp.relation)}` : ""}. It applies from your next message.` };
}
