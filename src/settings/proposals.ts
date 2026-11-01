/**
 * The proposal engine (S17.6, I27a, I29, I29d). The model never changes a setting: it PROPOSES. `propose_*` do not block; a
 * proposal is either applied at once (`auto`: only a `cosmetic` row with `autoApplyCosmetic` on, or a row's own `classify`) or
 * becomes a durable `SettingsProposals` entry plus a card (`ProposalTransport.present`). The decision arrives later through
 * `decide`, which re-validates everything: the deadline, the user (allowlisted AND the chat's own), the path and value, and the
 * target's `baseRevision` (a stale one applies nothing).
 *
 * What it writes: `prefs.json` and (through the persona kind, S19.4) `prefs\personas\*.json`. There is NO code path here to
 * `security.json` or `settings\personas\`: a security path is `not_writable` before any card and costs one `invalid` audit line.
 *
 * Limits (security.json `proposals`): 1 pending proposal per chat, 5 per hour; a rejected-before-card proposal writes one audit
 * line (`decision: "invalid"`), at most 20 per hour, then one counter line.
 *
 * Kinds are handlers (`registerKind`): `setting` and `switch` are here, `persona` is added by S19.4, Phase 4 adds more rows.
 */
import { BACKGROUND_CONTEXT, defineDoc } from "../pi/adapter.js";
import type { Harness } from "../pi/adapter.js";
import type { Logger } from "../contracts.js";
import { applyToCopy, checkValue, classify, findRow, getAt, parseSettingPath } from "./allowlist.js";
import type { AllowRow } from "./allowlist.js";
import { sha256Text } from "./chain.js";
import { SettingsError } from "./contracts.js";
import type { AuditDecision, AuditSource, CardLocator, DiffEntry, PersonaRuntime, ProposalCard, ProposalKind, ProposalStatus, ProposalTransport, SettingsAudit } from "./contracts.js";
import type { PrefsStore } from "./prefs.js";
import { parsePrefsText } from "./prefs.js";
import { diffValues, replaceAudited, serialize, updateAudited } from "./store.js";

// ---- the durable doc ----------------------------------------------------------------------------------------------

export type ProposalRecord = {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  chatId: number;
  conversationId: string;
  title: string;
  target: { file: string; path: string };
  /** JSON text of the `DiffEntry[]` (the Session document type only allows plain JSON, so structured fields are text). */
  diff: string;
  lines: string[];
  reason: string;
  baseRevision: string;
  createdAt: number;
  deadline: number;
  messageId: number | null;
  buttons: string[];
  /** Kind-specific data (the setting path and value; the persona draft). */
  payload: string;
  decidedAt: number | null;
};

type ProposalsValue = { items: Record<string, ProposalRecord> };

export const settingsProposalsDoc = defineDoc<ProposalsValue>({
  kind: "a7.settings.proposals",
  version: 1,
  scope: "session",
  initial: () => ({ items: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 25,
});

/** Records older than this are dropped when a new one is written (the audit log keeps the history). */
const KEEP_MS = 7 * 24 * 3600 * 1000;

export function diffOf(rec: ProposalRecord): DiffEntry[] {
  try {
    return JSON.parse(rec.diff) as DiffEntry[];
  } catch {
    return [];
  }
}

export function payloadOf<T>(rec: ProposalRecord): T {
  return JSON.parse(rec.payload) as T;
}

function locOf(rec: ProposalRecord): CardLocator {
  return { chatId: rec.chatId, messageId: rec.messageId, head: [rec.title, "", ...rec.lines].join("\n") };
}

export interface ProposalStore {
  get(id: string): Promise<ProposalRecord | undefined>;
  list(): Promise<ProposalRecord[]>;
  put(rec: ProposalRecord): Promise<void>;
}

export function memoryProposalStore(): ProposalStore {
  const map = new Map<string, ProposalRecord>();
  return {
    get: async (id) => (map.has(id) ? structuredClone(map.get(id)) : undefined),
    list: async () => [...map.values()].map((r) => structuredClone(r)),
    put: async (rec) => void map.set(rec.id, structuredClone(rec)),
  };
}

/** Durable store: one Session document in the Harness. `harness()` is lazy because the engine is built before the Harness opens. */
export function harnessProposalStore(harness: () => Harness | undefined): ProposalStore {
  const h = (): Harness => {
    const x = harness();
    if (!x) throw new Error("settings proposals: the Harness is not open yet");
    return x;
  };
  return {
    async get(id) {
      const snap = await h().snapshot(settingsProposalsDoc, BACKGROUND_CONTEXT);
      const r = snap?.items[id];
      return r ? structuredClone(r) : undefined;
    },
    async list() {
      const snap = await h().snapshot(settingsProposalsDoc, BACKGROUND_CONTEXT);
      return Object.values(snap?.items ?? {}).map((r) => structuredClone(r));
    },
    async put(rec) {
      await h().commit(async (tx) => {
        const doc = await tx.doc(settingsProposalsDoc);
        const cutoff = rec.createdAt - KEEP_MS;
        for (const [k, v] of Object.entries(doc.items)) if (v.status !== "pending" && v.createdAt < cutoff) delete doc.items[k];
        doc.items[rec.id] = structuredClone(rec);
      }, BACKGROUND_CONTEXT);
    },
  };
}

// ---- kinds ----------------------------------------------------------------------------------------------------------

export interface ProposeContext {
  conversationId: string;
  chatId: number;
}

export interface Prepared {
  title: string;
  target: { file: string; path: string };
  diff: DiffEntry[];
  lines: string[];
  baseRevision: string;
  payload: unknown;
  /** `auto` applies at once; `card` asks. */
  classification: "auto" | "card";
  buttons?: ("approve" | "reject" | "edit")[];
  preface?: string;
}

export interface ApplyContext {
  source: AuditSource;
  decision: AuditDecision;
  userId?: number;
  messageId?: number;
  conversationId: string;
  proposalId?: string;
  persona?: string;
}

export interface KindHandler {
  kind: ProposalKind;
  /** Validates and plans. Throws `SettingsError` (nothing is stored; one `invalid` audit line is written). */
  prepare(input: Record<string, unknown>, ctx: ProposeContext): Promise<Prepared> | Prepared;
  /** Re-validates and applies. Throws `stale_base` or another `SettingsError`. Returns the outcome text for the card. */
  apply(rec: ProposalRecord, ctx: ApplyContext): Promise<string>;
  /** `edit` button (persona drafts): returns the text sent to the user. */
  edit?(rec: ProposalRecord): Promise<string>;
}

export interface ProposalLimits {
  timeoutSec: number;
  maxPending: number;
  perHour: number;
  autoApplyCosmetic: boolean;
}

export const DEFAULT_LIMITS: ProposalLimits = { timeoutSec: 600, maxPending: 1, perHour: 5, autoApplyCosmetic: false };
const HOUR = 3600 * 1000;
const MAX_INVALID_LINES_PER_HOUR = 20;

export interface ProposalEngineDeps {
  store: ProposalStore;
  audit: SettingsAudit;
  prefs: PrefsStore;
  prefsFile: string;
  rows?: readonly AllowRow[];
  allowedUserIds: readonly number[];
  limits: () => ProposalLimits;
  transport?: ProposalTransport | undefined;
  now?: () => number;
  newId?: () => string;
  logger?: Logger | undefined;
  currentPersona?: ((conversationId: string) => string | undefined) | undefined;
  /** Frozen while the hourly ACL check fails (S17.2): no proposal is accepted or applied. */
  frozen?: (() => boolean) | undefined;
  /** The personas that exist, for the `defaultPersona` choice check (the runtime fills this in). */
  personaIds?: (() => string[]) | undefined;
}

export type ProposeResult = { status: "pending"; proposalId: string; deadline: number } | { status: "applied"; summary: string };

export type DecideResult =
  | { result: "ignored"; reason: "unknown_proposal" | "foreign_user" | "foreign_chat" | "not_pending" }
  | { result: "approved"; text: string }
  | { result: "rejected" }
  | { result: "expired" }
  | { result: "stale" }
  | { result: "failed"; text: string }
  | { result: "edit"; text: string; conversationId: string };

export class ProposalEngine {
  readonly #d: ProposalEngineDeps;
  readonly #rows: readonly AllowRow[];
  readonly #kinds = new Map<ProposalKind, KindHandler>();
  readonly #now: () => number;
  #transport: ProposalTransport | undefined;
  #invalid = { hour: -1, written: 0, suppressed: 0, counterWritten: false };

  constructor(deps: ProposalEngineDeps) {
    this.#d = deps;
    this.#rows = deps.rows ?? [];
    this.#now = deps.now ?? Date.now;
    this.#transport = deps.transport;
    this.#kinds.set("setting", this.#settingKind());
    this.#wire();
  }

  get rows(): readonly AllowRow[] {
    return this.#rows;
  }

  registerKind(h: KindHandler): void {
    this.#kinds.set(h.kind, h);
  }

  setTransport(t: ProposalTransport): void {
    this.#transport = t;
    this.#wire();
  }

  #wire(): void {
    this.#transport?.onDecision((d) =>
      this.decide(d).catch((e) => {
        this.#d.logger?.warn("settings.decide_failed", { error: String((e as Error).message ?? e) });
        return { result: "failed", text: "error" } as DecideResult;
      }),
    );
  }

  #newId(): string {
    return (this.#d.newId ?? (() => sha256Text(`${this.#now()}:${Math.random()}`).slice(0, 8)))();
  }

  // ---- propose --------------------------------------------------------------------------------------------------

  async propose(kind: ProposalKind, input: Record<string, unknown>, ctx: ProposeContext): Promise<ProposeResult> {
    const handler = this.#kinds.get(kind);
    if (!handler) throw new SettingsError("not_found", `no proposals of kind ${kind}`);
    try {
      if (this.#d.frozen?.()) throw new SettingsError("not_allowed", "settings changes are frozen until the settings folder permissions are fixed");
      const prepared = await handler.prepare(input, ctx);
      const limits = this.#d.limits();
      const all = await this.#d.store.list();
      const now = this.#now();
      const mine = all.filter((r) => r.chatId === ctx.chatId);
      if (prepared.classification === "card") {
        if (mine.filter((r) => r.status === "pending" && r.deadline > now).length >= limits.maxPending) throw new SettingsError("too_many_pending", "there is already a settings proposal waiting for the user in this chat");
        if (mine.filter((r) => r.createdAt > now - HOUR).length >= limits.perHour) throw new SettingsError("rate_limited", `at most ${limits.perHour} settings proposals per hour`);
      }
      if (prepared.classification === "auto") {
        const rec = this.#record(kind, prepared, input, ctx, now, limits);
        const text = await handler.apply(rec, { source: "auto", decision: "auto", conversationId: ctx.conversationId, ...(this.#d.currentPersona?.(ctx.conversationId) ? { persona: this.#d.currentPersona(ctx.conversationId) as string } : {}) });
        return { status: "applied", summary: text };
      }
      const rec = this.#record(kind, prepared, input, ctx, now, limits);
      await this.#d.store.put(rec);
      const transport = this.#transport;
      if (!transport) {
        await this.#d.store.put({ ...rec, status: "failed", decidedAt: now });
        throw new SettingsError("not_allowed", "no way to ask the user is available right now");
      }
      try {
        const card: ProposalCard = {
          proposalId: rec.id,
          kind,
          chatId: ctx.chatId,
          title: prepared.title,
          lines: prepared.lines,
          reason: rec.reason,
          deadline: rec.deadline,
          buttons: prepared.buttons ?? ["approve", "reject"],
          ...(prepared.preface !== undefined ? { preface: prepared.preface } : {}),
        };
        const { messageId } = await transport.present(card);
        await this.#d.store.put({ ...rec, messageId });
      } catch (e) {
        await this.#d.store.put({ ...rec, status: "failed", decidedAt: this.#now() });
        throw new SettingsError("not_allowed", `the card could not be sent to the user (${(e as Error).message})`);
      }
      return { status: "pending", proposalId: rec.id, deadline: rec.deadline };
    } catch (e) {
      if (e instanceof SettingsError && e.code !== "audit_failed" && e.code !== "stale_base") this.#auditInvalid(kind, input, e);
      throw e;
    }
  }

  #record(kind: ProposalKind, p: Prepared, input: Record<string, unknown>, ctx: ProposeContext, now: number, limits: ProposalLimits): ProposalRecord {
    const reason = typeof input["reason"] === "string" ? input["reason"].replace(/\s+/g, " ").trim().slice(0, 300) : "";
    return {
      id: this.#newId(),
      kind,
      status: "pending",
      chatId: ctx.chatId,
      conversationId: ctx.conversationId,
      title: p.title,
      target: p.target,
      diff: JSON.stringify(p.diff),
      lines: p.lines,
      reason,
      baseRevision: p.baseRevision,
      createdAt: now,
      deadline: now + limits.timeoutSec * 1000,
      messageId: null,
      buttons: p.buttons ?? ["approve", "reject"],
      payload: JSON.stringify(p.payload ?? null),
      decidedAt: null,
    };
  }

  /** One `invalid` audit line per rejected-before-card proposal, at most 20 per hour, then one counter line. */
  #auditInvalid(kind: ProposalKind, input: Record<string, unknown>, e: SettingsError): void {
    const now = this.#now();
    const hour = Math.floor(now / HOUR);
    const w = this.#invalid;
    if (w.hour !== hour) {
      if (w.suppressed > 1) this.#writeInvalid(kind, input, `${w.suppressed} further invalid proposals in the previous hour were counted, not logged`);
      this.#invalid = { hour, written: 0, suppressed: 0, counterWritten: false };
    }
    const cur = this.#invalid;
    if (cur.written < MAX_INVALID_LINES_PER_HOUR) {
      cur.written++;
      this.#writeInvalid(kind, input, e.code);
    } else {
      cur.suppressed++;
      if (!cur.counterWritten) {
        cur.counterWritten = true;
        this.#writeInvalid(kind, input, `more than ${MAX_INVALID_LINES_PER_HOUR} invalid proposals this hour: the rest are counted, not logged`);
      }
    }
  }

  #writeInvalid(kind: ProposalKind, input: Record<string, unknown>, note: string): void {
    const rev = this.#d.prefs.get().revision;
    const path = kind === "setting" && typeof input["path"] === "string" ? input["path"] : kind === "persona" ? "(persona draft)" : kind === "switch" ? "(switch)" : "(unknown)";
    try {
      this.#d.audit.append({
        source: "propose",
        kind: kind === "switch" ? "switch" : kind === "persona" ? "persona" : "setting",
        target: { file: kind === "setting" ? "prefs.json" : kind, path },
        diff: [],
        decision: "invalid",
        baseRevision: rev,
        afterRevision: rev,
        note,
      });
    } catch (e) {
      this.#d.logger?.warn("settings.audit_invalid_failed", { error: String((e as Error).message) });
    }
  }

  // ---- decide ---------------------------------------------------------------------------------------------------

  async decide(d: { proposalId: string; decision: "approve" | "reject" | "edit"; userId: number; chatId: number; messageId?: number | undefined }): Promise<DecideResult> {
    const rec = await this.#d.store.get(d.proposalId);
    if (!rec) return { result: "ignored", reason: "unknown_proposal" };
    if (!this.#d.allowedUserIds.includes(d.userId)) return { result: "ignored", reason: "foreign_user" };
    if (d.chatId !== rec.chatId) return { result: "ignored", reason: "foreign_chat" }; // a tap from another chat
    if (rec.status !== "pending") return { result: "ignored", reason: "not_pending" };
    const handler = this.#kinds.get(rec.kind);
    const now = this.#now();
    const persona = this.#d.currentPersona?.(rec.conversationId);
    const base = (decision: AuditDecision, afterRevision: string, note?: string) => ({
      source: "propose" as const,
      kind: (rec.kind === "switch" ? "switch" : rec.kind === "persona" ? "persona" : "setting") as "switch" | "persona" | "setting",
      ...(persona ? { persona } : {}),
      conversationId: rec.conversationId,
      target: rec.target,
      diff: diffOf(rec),
      decision,
      approver: { kind: "tg" as const, userId: d.userId },
      ...(d.messageId !== undefined ? { messageId: d.messageId } : {}),
      proposalId: rec.id,
      baseRevision: rec.baseRevision,
      afterRevision,
      ...(note ? { note } : {}),
    });
    const finish = async (status: ProposalStatus, text: string): Promise<void> => {
      await this.#d.store.put({ ...rec, status, decidedAt: this.#now() });
      await this.#transport?.update(rec.id, text, locOf(rec)).catch((e) => this.#d.logger?.warn("settings.card_update_failed", { error: String((e as Error).message) }));
    };

    if (now > rec.deadline) {
      this.#auditSafe(base("expired", rec.baseRevision));
      await finish("expired", "Expired (no answer in time). Nothing was changed.");
      return { result: "expired" };
    }
    if (d.decision === "reject") {
      this.#auditSafe(base("rejected", rec.baseRevision));
      await finish("rejected", "Rejected. Nothing was changed.");
      return { result: "rejected" };
    }
    if (d.decision === "edit") {
      if (!handler?.edit) return { result: "ignored", reason: "not_pending" };
      const text = await handler.edit(rec);
      this.#auditSafe(base("rejected", rec.baseRevision, "superseded by an edit request"));
      await finish("superseded", "Superseded: you asked for changes. Send your changes to the assistant.");
      return { result: "edit", text, conversationId: rec.conversationId };
    }
    if (!handler) {
      await finish("failed", "Could not apply: unknown kind.");
      return { result: "failed", text: "unknown kind" };
    }
    if (this.#d.frozen?.()) {
      await finish("failed", "Not applied: settings changes are frozen until the settings folder permissions are fixed.");
      return { result: "failed", text: "frozen" };
    }
    try {
      const text = await handler.apply(rec, { source: "propose", decision: "approved", userId: d.userId, ...(d.messageId !== undefined ? { messageId: d.messageId } : {}), conversationId: rec.conversationId, proposalId: rec.id, ...(persona ? { persona } : {}) });
      await finish("approved", `Approved. ${text}`);
      return { result: "approved", text };
    } catch (e) {
      if (e instanceof SettingsError && e.code === "stale_base") {
        this.#auditSafe(base("invalid", rec.baseRevision, "stale: the setting changed since the card was sent"));
        await finish("stale", "Stale: the setting changed since this card was sent. Nothing was changed; ask again.");
        return { result: "stale" };
      }
      const msg = e instanceof SettingsError ? e.message : "an unexpected error";
      await finish("failed", `Could not apply: ${msg}`);
      return { result: "failed", text: msg };
    }
  }

  #auditSafe(entry: Parameters<SettingsAudit["append"]>[0]): void {
    try {
      this.#d.audit.append(entry);
    } catch (e) {
      this.#d.logger?.warn("settings.audit_failed", { error: String((e as Error).message) });
    }
  }

  // ---- housekeeping ---------------------------------------------------------------------------------------------

  /** Expires pending proposals past their deadline (start, then a timer). Returns how many. */
  async reap(): Promise<number> {
    const now = this.#now();
    let n = 0;
    for (const rec of await this.#d.store.list()) {
      if (rec.status !== "pending" || rec.deadline > now) continue;
      this.#auditSafe({
        source: "propose",
        kind: rec.kind === "switch" ? "switch" : rec.kind === "persona" ? "persona" : "setting",
        conversationId: rec.conversationId,
        target: rec.target,
        diff: diffOf(rec),
        decision: "expired",
        proposalId: rec.id,
        baseRevision: rec.baseRevision,
        afterRevision: rec.baseRevision,
      });
      await this.#d.store.put({ ...rec, status: "expired", decidedAt: now });
      await this.#transport?.update(rec.id, "Expired (no answer in time). Nothing was changed.", locOf(rec)).catch(() => undefined);
      n++;
    }
    return n;
  }

  async pending(chatId?: number): Promise<ProposalRecord[]> {
    const now = this.#now();
    return (await this.#d.store.list()).filter((r) => r.status === "pending" && r.deadline > now && (chatId === undefined || r.chatId === chatId));
  }

  /** `/proposals` cancel: the allowlisted user withdraws a pending proposal. */
  async cancel(proposalId: string, userId: number, chatId: number): Promise<boolean> {
    const rec = await this.#d.store.get(proposalId);
    if (!rec || rec.status !== "pending" || rec.chatId !== chatId || !this.#d.allowedUserIds.includes(userId)) return false;
    this.#auditSafe({
      source: "telegram",
      kind: rec.kind === "switch" ? "switch" : rec.kind === "persona" ? "persona" : "setting",
      conversationId: rec.conversationId,
      target: rec.target,
      diff: diffOf(rec),
      decision: "rejected",
      approver: { kind: "tg", userId },
      proposalId: rec.id,
      baseRevision: rec.baseRevision,
      afterRevision: rec.baseRevision,
      note: "cancelled by the user",
    });
    await this.#d.store.put({ ...rec, status: "cancelled", decidedAt: this.#now() });
    await this.#transport?.update(rec.id, "Cancelled. Nothing was changed.", locOf(rec)).catch(() => undefined);
    return true;
  }

  /**
   * The user's OWN change from `/settings` (I26a): applies at once, audited `source: "telegram"`. Only rows with `telegram: true`
   * (fixed choices; there is no free-text input) are reachable.
   */
  async applyDirect(path: string, value: unknown, who: { userId: number; chatId: number; conversationId?: string }): Promise<string> {
    if (!this.#d.allowedUserIds.includes(who.userId)) throw new SettingsError("not_allowed", "not allowed");
    if (this.#d.frozen?.()) throw new SettingsError("not_allowed", "settings changes are frozen until the settings folder permissions are fixed");
    const segs = parseSettingPath(path);
    const row = findRow(this.#rows, segs);
    if (!row || !row.telegram) throw new SettingsError("not_writable", "that setting cannot be changed from Telegram");
    checkValue(row, value);
    if (path === "defaultPersona" && this.#d.personaIds && !this.#d.personaIds().includes(String(value))) throw new SettingsError("unknown_persona", "that persona does not exist or is not valid");
    const changed = await updateAudited({
      file: this.#d.prefsFile,
      audit: this.#d.audit,
      compute: (text) => {
        const cur = parsePrefsText(text);
        const next = applyToCopy(cur.prefs as Record<string, unknown>, segs, value);
        const diff = diffValues(cur.prefs, next);
        if (diff.length === 0) return undefined;
        return {
          newText: serialize(next),
          entry: {
            source: "telegram",
            kind: "setting",
            target: { file: "prefs.json", path },
            diff,
            decision: "applied",
            approver: { kind: "tg", userId: who.userId },
            ...(who.conversationId ? { conversationId: who.conversationId } : {}),
          },
        };
      },
    });
    if (!changed) return "Already set; nothing to change.";
    this.#d.prefs.invalidate();
    return `${row.label} is now ${typeof value === "string" ? value : JSON.stringify(value)}.`;
  }

  // ---- the `setting` kind ---------------------------------------------------------------------------------------

  #settingKind(): KindHandler {
    const d = this.#d;
    return {
      kind: "setting",
      prepare: (input) => {
        const segs = parseSettingPath(input["path"]);
        const row = findRow(this.#rows, segs);
        if (!row || !row.proposable) throw new SettingsError("not_writable", "that setting cannot be changed by the model; security settings are edited only in the local settings UI");
        const value = input["value"];
        checkValue(row, value);
        const cur = d.prefs.get();
        const before = getAt(cur.prefs, segs);
        if (JSON.stringify(before) === JSON.stringify(value)) throw new SettingsError("invalid_value", "that setting already has this value");
        const next = applyToCopy(cur.prefs as Record<string, unknown>, segs, value);
        const cls = classify(row, before, value, { autoApplyCosmetic: d.limits().autoApplyCosmetic });
        if (cls === "reject") throw new SettingsError("not_writable", "that change is not allowed");
        const path = String(input["path"]);
        return {
          title: "Settings change requested by the model",
          target: { file: "prefs.json", path },
          diff: diffValues(cur.prefs, next),
          lines: [`Setting: ${row.label} (${path}, ${row.class})`, `Now: ${show(before)}`, `Proposed: ${show(value)}`],
          baseRevision: cur.revision,
          payload: { path, value },
          classification: cls,
        } satisfies Prepared;
      },
      apply: async (rec, ctx) => {
        const payload = payloadOf<{ path: string; value: unknown }>(rec);
        const segs = parseSettingPath(payload.path);
        const row = findRow(this.#rows, segs);
        if (!row || !row.proposable) throw new SettingsError("not_writable", "that setting cannot be changed by the model");
        checkValue(row, payload.value);
        const cur = d.prefs.get();
        if (cur.revision !== rec.baseRevision) throw new SettingsError("stale_base", "stale");
        const next = applyToCopy(cur.prefs as Record<string, unknown>, segs, payload.value);
        await replaceAudited({
          file: d.prefsFile,
          newText: serialize(next),
          baseRevision: rec.baseRevision,
          audit: d.audit,
          entry: {
            source: ctx.source,
            kind: "setting",
            ...(ctx.persona ? { persona: ctx.persona } : {}),
            conversationId: ctx.conversationId,
            target: rec.target,
            diff: diffValues(cur.prefs, next),
            decision: ctx.decision,
            ...(ctx.userId !== undefined ? { approver: { kind: "tg" as const, userId: ctx.userId } } : {}),
            ...(ctx.messageId !== undefined ? { messageId: ctx.messageId } : {}),
            ...(ctx.proposalId ? { proposalId: ctx.proposalId } : {}),
          },
        });
        d.prefs.invalidate();
        return `${row.label} is now ${show(payload.value)}. It takes effect from the next message.`;
      },
    };
  }

  /** The `switch` kind (S17.7): a broader or incomparable `switch_persona`, applied through the `PersonaRuntime` after Approve. */
  registerSwitchKind(runtime: PersonaRuntime): void {
    this.registerKind({
      kind: "switch",
      prepare: (input, ctx) => {
        const to = String(input["personaId"] ?? "");
        const from = runtime.current(ctx.conversationId);
        const added = Array.isArray(input["added"]) ? (input["added"] as unknown[]).map(String) : [];
        const sum = (p: string): string => `${p}`;
        return {
          title: "Persona switch requested by the model",
          target: { file: "personas/active", path: ctx.conversationId },
          diff: [{ path: "activePersona", op: "replace", before: from, after: to }],
          lines: [`Switch persona: ${sum(from)} -> ${sum(to)}`, "This persona can do more than the current one:", ...added.slice(0, 20).map((a) => `  + ${a}`)],
          baseRevision: sha256Text(`persona:${from}`),
          payload: { personaId: to, from },
          classification: "card",
        } satisfies Prepared;
      },
      apply: async (rec, ctx) => {
        const p = payloadOf<{ personaId: string; from: string }>(rec);
        if (sha256Text(`persona:${runtime.current(rec.conversationId)}`) !== rec.baseRevision) throw new SettingsError("stale_base", "stale");
        await runtime.apply(rec.conversationId, p.personaId);
        try {
          this.#d.audit.append({
            source: ctx.source,
            kind: "switch",
            conversationId: rec.conversationId,
            target: rec.target,
            diff: diffOf(rec),
            decision: ctx.decision,
            ...(ctx.userId !== undefined ? { approver: { kind: "tg" as const, userId: ctx.userId } } : {}),
            ...(ctx.messageId !== undefined ? { messageId: ctx.messageId } : {}),
            proposalId: rec.id,
            baseRevision: rec.baseRevision,
            afterRevision: sha256Text(`persona:${p.personaId}`),
          });
        } catch (e) {
          this.#d.logger?.warn("settings.audit_failed", { error: String((e as Error).message) });
        }
        return `Switched to the ${p.personaId} persona.`;
      },
    });
  }
}

function show(v: unknown): string {
  if (v === undefined) return "(not set)";
  const t = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

