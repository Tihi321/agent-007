/**
 * Telegram job UI (S14.3): the Telegram implementation of `JobApprovalTransport`.
 *
 * - **Approval card.** Template, params, cwd, engine, "uses cloud", the Flow estimate, the paid-models line and the
 *   autostart line, with Approve / Reject. The brief is shown in full: inside the card when it is short (at most 3,500
 *   characters and the card fits one message), otherwise in extra messages sent BEFORE the card. Approve only counts once the
 *   whole brief has been shown: the card is sent after the brief, and a tap on Approve before that is refused.
 * - **Short ids.** `callback_data` is `jb:<8 hex>:<action>` (14 bytes). The id map is in memory only: a button from before a
 *   restart answers "Expired. A new request was sent." and the Job task asks again with a new card.
 * - **Every callback** is answered (`answerCallbackQuery`), and counts only if its sender is on the allowlist AND is the chat
 *   the card was sent to; anyone else is ignored and logged. A timeout is a reject.
 * - **Progress** is one status message per job, edited in place. Edits are coalesced to at most one per `minEditIntervalMs`.
 * - **Permission prompts** inside a running job: tool, input (with "Show full input" when it was cut) and cwd, with
 *   Allow once / Deny. There is no "always".
 * - All text is plain (no parse mode), so nothing in a brief, an input or a job's output is interpreted.
 */
import { randomBytes } from "node:crypto";
import type { Api, Context } from "grammy";
import type { ChatLookup, Logger, PeerProvenance } from "../contracts.js";
import { INLINE_BRIEF_MAX_CHARS, cardLines } from "../jobs/approval.js";
import type {
  HubStartCard,
  JobApprovalCard,
  JobApprovalDecision,
  JobApprovalTransport,
  JobDone,
  JobProgressUpdate,
  PermissionDecision,
  PermissionRequest,
} from "../jobs/contracts.js";
import { chunkText, TELEGRAM_LIMIT } from "./chunk.js";
import { isNotModified } from "./delivery.js";
import { formatClock, provenanceLines } from "./approvalUi.js";

export type JobUiApi = Pick<Api, "sendMessage" | "editMessageText" | "answerCallbackQuery" | "editMessageReplyMarkup">;

export interface JobUiOptions {
  api: JobUiApi;
  allowedUserIds: readonly number[];
  chats: ChatLookup;
  logger: Logger;
  now?: (() => number) | undefined;
  /** Test seam for the 8-character card id. */
  newId?: (() => string) | undefined;
  /** Minimum time between two edits of one progress message. Default 1500 ms. */
  minEditIntervalMs?: number | undefined;
  /** Phase 4 (S26.2): peer replies the conversation's current turn received; the approval card quotes them. */
  provenanceFor?: ((conversationId: string) => readonly PeerProvenance[] | undefined) | undefined;
}

/** The Scriptorium start has its own warning (S10.4). */
export const SCRIPTORIUM_WARNING = "Scriptorium resumes its whole book factory and may spend on paid models.";
/** Permission inputs longer than this are cut on the card; "Show full input" sends the rest. */
export const MAX_INPUT_CHARS = 1200;
const BRIEF_CHUNK = 3800;
const CALLBACK_RE = /^jb:([0-9a-f]{8}):(y|n|a|d|i)$/;

type Kind = "job" | "hub" | "perm";
type Outcome = "approved" | "rejected" | "timeout" | "cancelled";

interface Pending {
  id: string;
  kind: Kind;
  chatId: number;
  /** The text of the card, kept for the final edit. */
  head: string;
  messageId: number | undefined;
  /** False until the whole brief has been sent (job cards only). */
  briefShown: boolean;
  /** The untruncated permission input, for "Show full input". */
  fullInput: string | undefined;
  settle: (o: Outcome, userId?: number) => void;
  timer: NodeJS.Timeout | undefined;
  signal: AbortSignal;
  done: boolean;
}

interface ProgressMsg {
  chatId: number;
  messageId: number | undefined;
  lastText: string;
  latest: string;
  lastEditAt: number;
  timer: NodeJS.Timeout | undefined;
  chain: Promise<void>;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function minutes(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

/** The text of a job approval card. `briefInline` false: the brief was sent in full above. */
export function jobCardText(card: JobApprovalCard, briefInline: boolean, provenance?: readonly PeerProvenance[]): string {
  const brief = card.brief.trim() === "" ? "(none)" : card.brief;
  const peer = provenanceLines(provenance);
  return [
    "Approve this job?",
    ...(peer.length > 0 ? ["", ...peer] : []),
    "",
    ...cardLines(card),
    "",
    briefInline ? `Brief:\n${brief}` : `Brief: shown in full above (${card.brief.length} characters).`,
    "",
    `Expires: ${formatClock(card.deadline)}`,
  ].join("\n");
}

/** Whether the brief fits inside the card (short, and the whole card fits one message). */
export function briefFitsInCard(card: JobApprovalCard): boolean {
  return card.brief.length <= INLINE_BRIEF_MAX_CHARS && jobCardText(card, true).length <= TELEGRAM_LIMIT;
}

export function finalText(done: JobDone): string {
  const lines = [`Job ${done.jobId} ${done.state}.`];
  const facts: string[] = [];
  if (done.durationMs > 0) facts.push(`Time: ${minutes(done.durationMs)}`);
  if (done.costUsd !== undefined) facts.push(`Cost: $${done.costUsd.toFixed(2)}`);
  if (done.exitCode !== undefined && done.exitCode !== 0) facts.push(`Exit code: ${done.exitCode}`);
  if (facts.length > 0) lines.push(facts.join(". ") + ".");
  if (done.flow) {
    lines.push(`Flow credits: approved ${done.flow.approved}, charged ${done.flow.charged}${done.flow.reported !== undefined ? `, reported spent ${done.flow.reported}` : ", reported spend not available"}.`);
  }
  lines.push("", done.summary.trim() === "" ? "(no summary)" : done.summary);
  if (done.artifacts.length > 0) lines.push("", "Artifacts:", ...done.artifacts.map((a) => `- ${a}`));
  if (done.error) lines.push("", `Error: ${done.error}`);
  return lines.join("\n");
}

export class TelegramJobUi implements JobApprovalTransport {
  readonly #o: JobUiOptions;
  readonly #now: () => number;
  readonly #minEdit: number;
  readonly #pending = new Map<string, Pending>();
  readonly #progress = new Map<string, ProgressMsg>();

  constructor(opts: JobUiOptions) {
    this.#o = opts;
    this.#now = opts.now ?? Date.now;
    this.#minEdit = opts.minEditIntervalMs ?? 1500;
  }

  /** Cards waiting for an answer, for one chat or all. */
  pendingCount(chatId?: number): number {
    let n = 0;
    for (const p of this.#pending.values()) if (!p.done && (chatId === undefined || p.chatId === chatId)) n++;
    return n;
  }

  // ---- job approval --------------------------------------------------------------------------------------------

  async requestJobApproval(card: JobApprovalCard, signal: AbortSignal): Promise<JobApprovalDecision> {
    const chatId = this.#chat(card.conversationId);
    const decision = (approved: boolean, by: JobApprovalDecision["by"], userId?: number): JobApprovalDecision => ({
      approved,
      by,
      ...(userId !== undefined ? { userId } : {}),
      at: this.#now(),
      ...(approved && card.flowEstimateCredits !== undefined ? { approvedCredits: card.flowEstimateCredits } : {}),
    });
    if (signal.aborted) return decision(false, signal.reason === "stop" ? "stop" : "timeout");
    if (card.deadline <= this.#now()) return decision(false, "restart-expired");

    const inline = briefFitsInCard(card);
    return this.#ask({
      kind: "job",
      chatId,
      signal,
      deadline: card.deadline,
      head: `Job ${card.jobId} (${card.template.id})`,
      briefShown: inline,
      send: async (entry) => {
        if (!inline) {
          // The whole brief goes out first, one message per part, in order. The card follows only when every part was sent.
          const parts = chunkText(card.brief, BRIEF_CHUNK).filter((c) => c.trim() !== "");
          for (let i = 0; i < parts.length; i++) {
            await this.#o.api.sendMessage(chatId, `Brief for job ${card.jobId} (part ${i + 1} of ${parts.length}):\n${parts[i]}`, { link_preview_options: { is_disabled: true } });
          }
          entry.briefShown = true;
        }
        const sent = await this.#o.api.sendMessage(chatId, jobCardText(card, inline, this.#o.provenanceFor?.(card.conversationId)), {
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: `jb:${entry.id}:y` }, { text: "Reject", callback_data: `jb:${entry.id}:n` }]] },
        });
        return sent.message_id;
      },
      result: (o, userId) => decision(o === "approved", o === "approved" || o === "rejected" ? "user" : o === "timeout" ? "timeout" : "stop", o === "approved" || o === "rejected" ? userId : undefined),
      outcomeText: (o) => ({ approved: "Approved. Starting the job.", rejected: "Rejected. The job was not started.", timeout: "Expired (no answer in time). The job was not started.", cancelled: "Cancelled. The job was not started." })[o],
    });
  }

  async requestHubStartApproval(card: HubStartCard, signal: AbortSignal): Promise<JobApprovalDecision> {
    const chatId = this.#chat(card.conversationId);
    const decision = (approved: boolean, by: JobApprovalDecision["by"], userId?: number): JobApprovalDecision => ({ approved, by, ...(userId !== undefined ? { userId } : {}), at: this.#now() });
    if (signal.aborted) return decision(false, signal.reason === "stop" ? "stop" : "timeout");
    if (card.deadline <= this.#now()) return decision(false, "restart-expired");
    const warning = card.warning ?? (card.scriptorium ? SCRIPTORIUM_WARNING : undefined);
    const peer = provenanceLines(this.#o.provenanceFor?.(card.conversationId));
    const text = [`Start creative-hub service "${card.service}"?`, ...(peer.length > 0 ? ["", ...peer] : []), ...(warning ? ["", warning] : []), "", `Approval timeout: ${card.timeoutSec} s (no answer means reject).`, `Expires: ${formatClock(card.deadline)}`].join("\n");
    return this.#ask({
      kind: "hub",
      chatId,
      signal,
      deadline: card.deadline,
      head: `Start ${card.service}`,
      briefShown: true,
      send: async (entry) =>
        (
          await this.#o.api.sendMessage(chatId, text, {
            link_preview_options: { is_disabled: true },
            reply_markup: { inline_keyboard: [[{ text: "Start it", callback_data: `jb:${entry.id}:y` }, { text: "Reject", callback_data: `jb:${entry.id}:n` }]] },
          })
        ).message_id,
      result: (o, userId) => decision(o === "approved", o === "approved" || o === "rejected" ? "user" : o === "timeout" ? "timeout" : "stop", o === "approved" || o === "rejected" ? userId : undefined),
      outcomeText: (o) => ({ approved: "Approved. Starting the service.", rejected: "Rejected. Nothing was started.", timeout: "Expired (no answer in time). Nothing was started.", cancelled: "Cancelled. Nothing was started." })[o],
    });
  }

  // ---- permission prompts ---------------------------------------------------------------------------------------------

  async requestPermission(req: PermissionRequest, conversationId: string, signal: AbortSignal): Promise<PermissionDecision> {
    const chatId = this.#chat(conversationId);
    const deny = (by: PermissionDecision["by"], message?: string): PermissionDecision => ({ requestId: req.requestId, jobId: req.jobId, answer: "deny", by, at: this.#now(), ...(message ? { message } : {}) });
    const deadline = req.requestedAt + req.timeoutSec * 1000;
    if (signal.aborted) return deny(signal.reason === "stop" ? "stop" : "cancel");
    if (deadline <= this.#now()) return deny("timeout");

    let full: string;
    try {
      full = typeof req.input === "string" ? req.input : JSON.stringify(req.input, null, 2);
    } catch {
      full = "(input could not be shown)";
    }
    const truncated = full.length > MAX_INPUT_CHARS;
    const text = [
      `Allow this tool use in job ${req.jobId}?`,
      "",
      `Tool: ${clip(req.tool, 200)}`,
      `Input: ${truncated ? `${full.slice(0, MAX_INPUT_CHARS)}…\n(cut, tap Show full input)` : full}`,
      `Cwd: ${clip(req.cwd, 200)}`,
      ...(req.summary ? [`Summary: ${clip(req.summary, 300)}`] : []),
      `Expires: ${formatClock(deadline)}`,
    ].join("\n");
    return this.#ask({
      kind: "perm",
      chatId,
      signal,
      deadline,
      head: `Permission for ${req.tool} in job ${req.jobId}`,
      briefShown: true,
      fullInput: truncated ? full : undefined,
      send: async (entry) =>
        (
          await this.#o.api.sendMessage(chatId, text, {
            link_preview_options: { is_disabled: true },
            reply_markup: {
              inline_keyboard: [
                [{ text: "Allow once", callback_data: `jb:${entry.id}:a` }, { text: "Deny", callback_data: `jb:${entry.id}:d` }],
                ...(truncated ? [[{ text: "Show full input", callback_data: `jb:${entry.id}:i` }]] : []),
              ],
            },
          })
        ).message_id,
      result: (o, userId, reason) => {
        if (o === "approved") return { requestId: req.requestId, jobId: req.jobId, answer: "allow_once", by: "user", ...(userId !== undefined ? { userId } : {}), at: this.#now() };
        if (o === "rejected") return { ...deny("user"), ...(userId !== undefined ? { userId } : {}) };
        return deny(o === "timeout" ? "timeout" : reason === "stop" ? "stop" : reason === "dispose" ? "restart" : "cancel");
      },
      outcomeText: (o) => ({ approved: "Allowed once.", rejected: "Denied.", timeout: "Expired (no answer in time). Denied.", cancelled: "Cancelled. Denied." })[o],
    });
  }

  // ---- one card ---------------------------------------------------------------------------------------------------------

  #ask<T>(spec: {
    kind: Kind;
    chatId: number;
    signal: AbortSignal;
    deadline: number;
    head: string;
    briefShown: boolean;
    fullInput?: string | undefined;
    send: (entry: Pending) => Promise<number>;
    result: (outcome: Outcome, userId: number | undefined, reason: string | undefined) => T;
    outcomeText: (o: Outcome) => string;
  }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.#freshId();
      const entry: Pending = {
        id,
        kind: spec.kind,
        chatId: spec.chatId,
        head: spec.head,
        messageId: undefined,
        briefShown: spec.briefShown,
        fullInput: spec.fullInput,
        timer: undefined,
        signal: spec.signal,
        done: false,
        settle: (outcome, userId) => {
          if (entry.done) return;
          entry.done = true;
          this.#pending.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
          spec.signal.removeEventListener("abort", onAbort);
          resolve(spec.result(outcome, userId, typeof spec.signal.reason === "string" ? spec.signal.reason : undefined));
          const edit = `${spec.outcomeText(outcome)}\n\n${entry.head}`;
          if (entry.messageId !== undefined) {
            void this.#o.api
              .editMessageText(entry.chatId, entry.messageId, edit, { link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } })
              .catch((e: unknown) => this.#o.logger.warn("telegram.job_card_edit_failed", { id, error: (e as Error).name }));
          }
        },
      };
      // The deadline is the card's own timer; any abort of the caller's signal is a cancel (restart, /stop, cancel_job).
      const onAbort = (): void => entry.settle("cancelled");
      this.#pending.set(id, entry);
      spec.send(entry).then(
        (messageId) => {
          entry.messageId = messageId;
          if (entry.done) {
            // settled while the card was being sent (an abort): strip the buttons now
            void this.#o.api.editMessageText(entry.chatId, messageId, `${spec.outcomeText("cancelled")}\n\n${entry.head}`, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
            return;
          }
          const wait = Math.min(2 ** 31 - 1, Math.max(0, spec.deadline - this.#now()));
          entry.timer = setTimeout(() => entry.settle("timeout"), wait);
          entry.timer.unref?.();
          spec.signal.addEventListener("abort", onAbort, { once: true });
          if (spec.signal.aborted) onAbort();
        },
        (e: unknown) => {
          // Fail closed: no card, no approval. The caller (the Job task) asks again later.
          entry.done = true;
          this.#pending.delete(id);
          this.#o.logger.error("telegram.job_card_send_failed", { kind: spec.kind, error: (e as Error).name });
          reject(e);
        },
      );
    });
  }

  /** Resolves every open card of a chat as cancelled (`/stop`). Returns how many. */
  cancelChat(chatId: number): number {
    const ids = [...this.#pending.values()].filter((p) => p.chatId === chatId).map((p) => p.id);
    for (const id of ids) this.#pending.get(id)?.settle("cancelled");
    return ids.length;
  }

  // ---- callbacks ----------------------------------------------------------------------------------------------------------

  /** Register with `bot.on("callback_query:data", ...)`. Ignores data that is not a job button. */
  async handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data;
    if (data === undefined || !data.startsWith("jb:")) return;
    const log = this.#o.logger;
    const from = ctx.from?.id;
    if (from === undefined || !this.#o.allowedUserIds.includes(from)) {
      log.warn("telegram.job_foreign_callback", { fromId: from });
      return;
    }
    const m = CALLBACK_RE.exec(data);
    if (!m) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }
    const id = m[1] as string;
    const action = m[2] as string;
    const entry = this.#pending.get(id);
    if (!entry || entry.done) {
      await ctx.answerCallbackQuery({ text: "Expired. A new request was sent." }).catch(() => undefined);
      const msg = ctx.callbackQuery?.message;
      if (msg) await this.#o.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      return;
    }
    const chatOfMessage = ctx.callbackQuery?.message?.chat.id;
    if (from !== entry.chatId || chatOfMessage !== entry.chatId) {
      log.warn("telegram.job_wrong_chat", { fromId: from, id });
      return;
    }
    const allowed = entry.kind === "perm" ? ["a", "d", "i"] : ["y", "n"];
    if (!allowed.includes(action)) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }
    if (action === "i") {
      await ctx.answerCallbackQuery({ text: "Sending the full input" }).catch(() => undefined);
      const parts = chunkText(entry.fullInput ?? "(no more input)", BRIEF_CHUNK).filter((c) => c.trim() !== "");
      for (let i = 0; i < parts.length; i++) {
        await this.#o.api.sendMessage(entry.chatId, `Full input (part ${i + 1} of ${parts.length}):\n${parts[i]}`, { link_preview_options: { is_disabled: true } }).catch((e: unknown) => log.warn("telegram.job_input_send_failed", { error: (e as Error).name }));
      }
      return;
    }
    const approve = action === "y" || action === "a";
    if (approve && !entry.briefShown) {
      // Approve counts only after the whole brief has been shown.
      await ctx.answerCallbackQuery({ text: "Read the whole brief first." }).catch(() => undefined);
      return;
    }
    await ctx.answerCallbackQuery({ text: approve ? "Approved" : "Rejected" }).catch(() => undefined);
    entry.settle(approve ? "approved" : "rejected", from);
  }

  // ---- progress and the final message ----------------------------------------------------------------------------------------

  async postProgress(update: JobProgressUpdate): Promise<void> {
    const chatId = this.#chatOrUndefined(update.conversationId);
    if (chatId === undefined) return;
    let pm = this.#progress.get(update.jobId);
    if (!pm) {
      pm = { chatId, messageId: undefined, lastText: "", latest: "", lastEditAt: Number.NEGATIVE_INFINITY, timer: undefined, chain: Promise.resolve() };
      this.#progress.set(update.jobId, pm);
    }
    pm.latest = clip(update.text, TELEGRAM_LIMIT - 16);
    const p = pm;
    const wait = p.lastEditAt + this.#minEdit - this.#now();
    if (p.messageId === undefined || wait <= 0) {
      p.chain = p.chain.then(() => this.#flushProgress(p));
      return p.chain;
    }
    // Inside the minimum gap: keep only the newest text and edit once the gap has passed.
    if (!p.timer) {
      p.timer = setTimeout(() => {
        p.timer = undefined;
        p.chain = p.chain.then(() => this.#flushProgress(p)).catch(() => undefined);
      }, wait);
      p.timer.unref?.();
    }
  }

  async #flushProgress(pm: ProgressMsg): Promise<void> {
    if (pm.latest === pm.lastText) return;
    const text = pm.latest;
    try {
      if (pm.messageId === undefined) {
        const sent = await this.#o.api.sendMessage(pm.chatId, text, { link_preview_options: { is_disabled: true } });
        pm.messageId = sent.message_id;
      } else {
        await this.#o.api.editMessageText(pm.chatId, pm.messageId, text, { link_preview_options: { is_disabled: true } });
      }
      pm.lastText = text;
      pm.lastEditAt = this.#now();
    } catch (e) {
      if (isNotModified(e)) {
        pm.lastText = text;
        return;
      }
      throw e;
    }
  }

  async postFinal(done: JobDone, conversationId: string): Promise<void> {
    const chatId = this.#chatOrUndefined(conversationId);
    const pm = this.#progress.get(done.jobId);
    if (pm) {
      if (pm.timer) clearTimeout(pm.timer);
      pm.timer = undefined;
      await pm.chain.catch(() => undefined);
      await this.#flushProgress(pm).catch(() => undefined);
      this.#progress.delete(done.jobId);
    }
    if (chatId === undefined) return;
    const parts = chunkText(finalText(done), TELEGRAM_LIMIT - 64).filter((c) => c.trim() !== "");
    for (let i = 0; i < parts.length; i++) {
      await this.#o.api.sendMessage(chatId, parts.length > 1 ? `(${i + 1}/${parts.length}) ${parts[i]}` : (parts[i] as string), { link_preview_options: { is_disabled: true } });
    }
  }

  // ---- helpers ------------------------------------------------------------------------------------------------------------------

  #chatOrUndefined(conversationId: string): number | undefined {
    return this.#o.chats.chatForConversation(conversationId);
  }

  #chat(conversationId: string): number {
    const chat = this.#chatOrUndefined(conversationId);
    if (chat === undefined) throw new Error("no Telegram chat is linked to this conversation");
    return chat;
  }

  #freshId(): string {
    for (let i = 0; i < 10; i++) {
      const id = this.#o.newId ? this.#o.newId() : randomBytes(4).toString("hex");
      if (!this.#pending.has(id)) return id;
    }
    throw new Error("could not allocate a job card id");
  }
}

