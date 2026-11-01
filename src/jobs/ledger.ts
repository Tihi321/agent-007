/**
 * The Flow ledger (S14.4, D11). A durable Session document with one entry per approved Flow job: the number of credits the
 * user approved on the card (the "approved number"), what the job runner reported charged inside the job, and what the
 * agent's own Flow tool calls charged. There is no default entry and no default budget: a Flow call with no open entry for
 * its conversation is always blocked (see flowGuard.ts).
 *
 * The functions here are pure edits of a `LedgerDoc` value. Callers run them inside a Pi commit on the draft
 * (`tx.doc(flowLedgerDoc)`), so a check and its charge are one atomic write, and read them from `snapshot()`.
 */
import { defineDoc } from "../pi/adapter.js";

export type LedgerEntry = {
  jobId: string;
  conversationId: string;
  templateId: string;
  /** Credits the user approved for this job. */
  approved: number;
  /** Sum of the `max_credits` of the Flow calls the job runner allowed inside the job (its own `flow_call` events). */
  jobCharged: number;
  /** Sum of the `max_credits` of the agent's own Flow tool calls, charged before the call. */
  directCharged: number;
  /** Credits the Flow server reported as spent, when it reports them (null: not reported). */
  reported: number | null;
  /** False once the job is over: no more calls are allowed against it. */
  open: boolean;
  approvedAt: number;
  /** Local date (YYYY-MM-DD) of the approval, for the daily totals. */
  day: string;
  userId: number;
};

export type LedgerCall = { jobId: string; maxCredits: number; at: number };

export type LedgerDoc = {
  entries: Record<string, LedgerEntry>;
  /** Direct calls by `<conversationId>/<callId>`: a call is charged once, whatever reruns. */
  calls: Record<string, LedgerCall>;
};

export const flowLedgerDoc = defineDoc<LedgerDoc>({
  kind: "a7.flow.ledger",
  version: 1,
  scope: "session",
  initial: () => ({ entries: {}, calls: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 25,
});

export function emptyLedger(): LedgerDoc {
  return { entries: {}, calls: {} };
}

/** Local calendar date, like the job runner's daily cap. */
export function dayKey(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A credit amount the guard accepts: a finite number above zero. */
export function isCredits(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

export function entryRemaining(e: LedgerEntry): number {
  return Math.max(0, e.approved - e.jobCharged - e.directCharged);
}

export interface OpenEntryInput {
  jobId: string;
  conversationId: string;
  templateId: string;
  approved: number;
  userId: number;
  at: number;
}

/** Opens the entry for an approved Flow job. Idempotent: an existing entry is kept as it is (a rerun never raises it). */
export function openEntry(doc: LedgerDoc, input: OpenEntryInput): LedgerEntry {
  const existing = doc.entries[input.jobId];
  if (existing) return existing;
  if (!isCredits(input.approved)) throw new RangeError("a Flow job needs an approved number of credits above zero");
  const entry: LedgerEntry = {
    jobId: input.jobId,
    conversationId: input.conversationId,
    templateId: input.templateId,
    approved: input.approved,
    jobCharged: 0,
    directCharged: 0,
    reported: null,
    open: true,
    approvedAt: input.at,
    day: dayKey(input.at),
    userId: input.userId,
  };
  doc.entries[input.jobId] = entry;
  return entry;
}

/** The job runner's `flow_call` event carries its running total; the ledger keeps the highest value seen. */
export function recordJobCharge(doc: LedgerDoc, jobId: string, chargedTotal: number): void {
  const e = doc.entries[jobId];
  if (!e || !Number.isFinite(chargedTotal)) return;
  if (chargedTotal > e.jobCharged) e.jobCharged = chargedTotal;
}

export function recordReported(doc: LedgerDoc, jobId: string, reported: number): void {
  const e = doc.entries[jobId];
  if (!e || !Number.isFinite(reported) || reported < 0) return;
  e.reported = reported;
}

export function closeEntry(doc: LedgerDoc, jobId: string): void {
  const e = doc.entries[jobId];
  if (e) e.open = false;
}

export type BudgetVerdict = { ok: true; jobId: string; remaining: number } | { ok: false; reason: "no_entry" | "over_budget"; text: string };

/**
 * Which approved job a direct Flow call draws on: the open entries of its conversation, oldest first; the first one whose
 * remaining credits cover `maxCredits`. No open entry means blocked; there is no default and no small-call exception.
 */
export function findBudget(doc: LedgerDoc, conversationId: string, maxCredits: number): BudgetVerdict {
  const open = Object.values(doc.entries)
    .filter((e) => e.open && e.conversationId === conversationId)
    .sort((a, b) => a.approvedAt - b.approvedAt || a.jobId.localeCompare(b.jobId));
  if (open.length === 0) {
    return {
      ok: false,
      reason: "no_entry",
      text: "Blocked: there is no approved Flow job for this conversation, so no Flow credits may be spent. Flow credits are approved per job: dispatch a Flow job and let the user approve its estimate first.",
    };
  }
  for (const e of open) {
    const remaining = entryRemaining(e);
    if (maxCredits <= remaining) return { ok: true, jobId: e.jobId, remaining };
  }
  const best = Math.max(...open.map(entryRemaining));
  return {
    ok: false,
    reason: "over_budget",
    text: `Blocked: max_credits ${maxCredits} is more than the ${best} approved credits that remain for this conversation's Flow jobs. Lower max_credits, or ask the user to approve a new Flow job.`,
  };
}

export type ChargeResult = { ok: true; jobId: string; remaining: number; duplicate: boolean } | { ok: false; reason: "no_entry" | "over_budget"; text: string };

/** Check and charge in one edit (run it inside a commit): the call is charged before it runs, and only once per `callKey`. */
export function chargeDirect(doc: LedgerDoc, conversationId: string, callKey: string, maxCredits: number, at: number): ChargeResult {
  const prior = doc.calls[callKey];
  if (prior) {
    const e = doc.entries[prior.jobId];
    return { ok: true, jobId: prior.jobId, remaining: e ? entryRemaining(e) : 0, duplicate: true };
  }
  const v = findBudget(doc, conversationId, maxCredits);
  if (!v.ok) return v;
  const e = doc.entries[v.jobId];
  if (!e) return { ok: false, reason: "no_entry", text: "Blocked: the approved Flow job is gone." };
  e.directCharged += maxCredits;
  doc.calls[callKey] = { jobId: v.jobId, maxCredits, at };
  return { ok: true, jobId: v.jobId, remaining: entryRemaining(e), duplicate: false };
}

export interface DayTotals {
  day: string;
  jobs: number;
  approved: number;
  charged: number;
  reported: number;
}

/** Approved and charged credits of one local day, for `/status` (S15.2). */
export function totalsForDay(doc: LedgerDoc | undefined, day: string): DayTotals {
  const t: DayTotals = { day, jobs: 0, approved: 0, charged: 0, reported: 0 };
  for (const e of Object.values(doc?.entries ?? {})) {
    if (e.day !== day) continue;
    t.jobs++;
    t.approved += e.approved;
    t.charged += e.jobCharged + e.directCharged;
    t.reported += e.reported ?? 0;
  }
  return t;
}

/** A plain copy of a snapshot value (never undefined). */
export function readLedger(value: Readonly<LedgerDoc> | undefined): LedgerDoc {
  if (!value) return emptyLedger();
  return { entries: { ...value.entries }, calls: { ...value.calls } };
}
