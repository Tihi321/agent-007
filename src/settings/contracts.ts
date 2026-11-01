/**
 * Phase 3 shared contracts (S17). Pure types and a few constants; imports nothing, so the job runner, the migration script and
 * the Telegram code can all build against it (S18 implements `ProposalTransport`, S19 implements `PersonaRuntime`).
 *
 * Callback ids are at most 64 bytes: `st:<8-char id>:y|n|e` (proposals), `se:<code>` (settings menu), `pe:<code>` (personas).
 * `md:` is left to Phase 4 (S22).
 */

// ---- errors -----------------------------------------------------------------------------------------

export type SettingsErrorCode =
  | "not_writable"
  | "invalid_value"
  | "secret_shaped"
  | "rate_limited"
  | "too_many_pending"
  | "stale_base"
  | "persona_invalid"
  | "unknown_persona"
  | "personas_not_active"
  | "audit_failed"
  | "apply_failed"
  | "expired"
  | "not_found"
  | "not_allowed";

export class SettingsError extends Error {
  readonly code: SettingsErrorCode;
  constructor(code: SettingsErrorCode, message: string) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
  }
}

// ---- audit ------------------------------------------------------------------------------------------

export type AuditWriter = "agent" | "jobrunner";
export type AuditSource = "propose" | "ui" | "telegram" | "auto" | "migrate" | "system";
export type AuditKind = "setting" | "persona" | "switch" | "template" | "security";
export type AuditDecision = "approved" | "rejected" | "expired" | "invalid" | "auto" | "applied" | "apply_failed" | "loaded" | "external_edit";

export interface DiffEntry {
  path: string;
  op: "add" | "remove" | "replace";
  before?: unknown;
  after?: unknown;
}

export interface AuditApprover {
  kind: "tg" | "ui";
  userId?: number;
  /** A hash of the session, never the cookie. */
  sessionHash?: string;
}

/** What a caller gives the audit writer; the writer adds `v`, `ts`, `writer`, `wseq`, `prev` and `h`. */
export interface AuditEntryInput {
  source: AuditSource;
  kind: AuditKind;
  persona?: string;
  conversationId?: string;
  target: { file: string; path: string };
  diff: DiffEntry[];
  decision: AuditDecision;
  approver?: AuditApprover;
  messageId?: number;
  proposalId?: string;
  baseRevision: string;
  afterRevision: string;
  /** A short fixed reason text (never a value). */
  note?: string;
}

export interface AuditLine extends AuditEntryInput {
  v: 1;
  ts: string;
  writer: AuditWriter;
  wseq: number;
  prev: string;
  h: string;
}

/** `append` throws when the line could not be written ("no audit, no change"). */
export interface SettingsAudit {
  append(entry: AuditEntryInput): AuditLine;
}

// ---- proposals --------------------------------------------------------------------------------------

export type ProposalKind = "setting" | "persona" | "switch";
export type ProposalStatus = "pending" | "approved" | "rejected" | "expired" | "stale" | "cancelled" | "superseded" | "failed";

export interface ProposalCard {
  proposalId: string;
  kind: ProposalKind;
  chatId: number;
  /** First line, for example "Settings change requested by the model". */
  title: string;
  /** Plain lines: path and class, `now -> proposed`, added capabilities. */
  lines: string[];
  /** The model's reason: shown as a quoted, truncated, untrusted line. */
  reason: string;
  deadline: number;
  /** Offered buttons. `edit` is for persona drafts (S19.4). */
  buttons: ("approve" | "reject" | "edit")[];
  /** For a long persona prompt: sent in full before the card, and Approve counts only after it was shown (S19.4). */
  preface?: string;
}

/** Implemented by `src/telegram/settingsUi.ts` (S18.4); faked in the S17 tests. */
export interface CardLocator {
  chatId: number;
  /** The Telegram message id of the card, when it is known (it is persisted with the proposal, so it survives a restart). */
  messageId: number | null;
  /** The card text without the outcome (title and lines), so the edit after a restart can rebuild the message. */
  head: string;
}

export interface ProposalTransport {
  present(card: ProposalCard): Promise<{ messageId: number }>;
  /** Edits the card to its outcome and removes the buttons. `loc` comes from the persisted proposal, so it works after a restart. */
  update(proposalId: string, outcomeText: string, loc?: CardLocator): Promise<void>;
  /**
   * The transport calls this when the allowlisted user taps a button. The engine re-checks everything and returns its decision
   * (the transport uses it to answer the tap, for example "expired").
   */
  onDecision(cb: (d: { proposalId: string; decision: "approve" | "reject" | "edit"; userId: number; chatId: number; messageId?: number }) => unknown): void;
}

// ---- personas ---------------------------------------------------------------------------------------

export interface PersonaMemory {
  write: "shared" | "scope" | "none";
  /** Only with `write: "scope"`; defaults to the persona id. */
  scope?: string;
  sharedRead: boolean;
}

export interface Persona {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  toolAllow: string[];
  mcpAllow: Record<string, string[]>;
  jobTemplates: string[];
  modelPreset: string;
  memory: PersonaMemory;
  budgets: { maxJobsPerDay?: number };
}

/** What a persona resolves to once intersected with the ceiling. */
export interface EffectivePersona {
  id: string;
  tools: string[];
  mcp: Record<string, string[]>;
  jobTemplates: string[];
  modelPreset: string;
  memory: PersonaMemory;
  maxJobsPerDay: number | undefined;
  /** Prompt text (empty for `default`). */
  prompt: string;
}

export interface PersonaSummary {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "user" | "model";
  valid: boolean;
  reasons: string[];
  /** A one-line capability summary, never the prompt text. */
  summary: string;
}

/** Real implementation in S19.1; a stub (`personas_not_active` for `apply`) in S17. */
export interface PersonaRuntime {
  list(): PersonaSummary[];
  current(conversationId: string): string;
  effective(conversationId: string): EffectivePersona | undefined;
  /** The effective capabilities of a persona id (not necessarily the current one), or `undefined` when it is unknown or invalid. */
  effectiveOf(personaId: string): EffectivePersona | undefined;
  apply(conversationId: string, personaId: string): Promise<void>;
}

// ---- classes ----------------------------------------------------------------------------------------

export type RowClass = "cosmetic" | "pref" | "user-only";
export type Classification = "auto" | "card" | "reject";

export const CALLBACK_PREFIXES = { proposal: "st:", settings: "se:", persona: "pe:" } as const;
export const SETTINGS_SCHEMA_VERSION = 2;
export const PERSONA_ID_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;
export const MAX_PERSONAS = 12;
