/**
 * Approval UI (S4.5): the Telegram implementation of `ApprovalTransport`.
 *
 * One card per shell command: the full command as plain text (no parse mode, so nothing is interpreted), the
 * reason, cwd, the approval timeout and "Expires hh:mm", with Approve / Deny buttons (`callback_data`
 * `ap:<8 hex>:y|n`, 14 bytes). The id-to-request map lives in memory only: a button from before a restart answers
 * "Expired. A new request was sent." (the gate sends a new card after a restart). A callback counts only if its
 * sender is allowlisted AND is the chat the request was sent to. Every outcome (decision, timeout, kill switch,
 * /stop) edits the card to the result and removes the buttons. Commands over 3,500 characters are never shown and
 * are denied at once.
 */
import { randomBytes } from "node:crypto";
import type { Api, Context } from "grammy";
import type { ApprovalDecision, ApprovalDecisionBy, ApprovalRequest, ApprovalTransport, KillSwitch, Logger } from "../contracts.js";

export const MAX_COMMAND_CHARS = 3500;
const MAX_FIELD_CHARS = 200;

/** Over-long commands are denied "by `invalid`" (S4.5); `ApprovalDecisionBy` carries the member since S6. */
export const INVALID_BY: ApprovalDecisionBy = "invalid";

export type ApprovalApi = Pick<Api, "sendMessage" | "editMessageText" | "answerCallbackQuery" | "editMessageReplyMarkup">;

export interface ApprovalUiOptions {
  api: ApprovalApi;
  allowedUserIds: readonly number[];
  killSwitch?: KillSwitch | undefined;
  logger: Logger;
  now?: (() => number) | undefined;
  /** Test seam for the 8-character card id. */
  newId?: (() => string) | undefined;
}

type Outcome = "approved" | "denied" | "timeout" | "killswitch" | "stop" | "aborted";

interface Pending {
  id: string;
  req: ApprovalRequest;
  messageId: number;
  resolve: (d: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
  signal: AbortSignal;
  onAbort: () => void;
  done: boolean;
}

const CALLBACK_RE = /^ap:([0-9a-f]{8}):(y|n)$/;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** `HH:MM` in the host's local time. */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const MAX_PROVENANCE_ITEMS = 3;
const MAX_PROVENANCE_CHARS = 300;

/**
 * S26.2 (I35): the lines that tell the user a peer reply was part of the turn that produced this card, and quote it. The quote is the
 * peer's own text, flattened to one line and clipped; it is plain text (the card has no parse mode). Empty when there is none.
 */
export function provenanceLines(provenance: ApprovalRequest["provenance"]): string[] {
  if (!provenance || provenance.length === 0) return [];
  const lines: string[] = [];
  for (const p of provenance.slice(-MAX_PROVENANCE_ITEMS)) {
    const quote = clip(p.text.replace(/\s+/g, " ").trim(), MAX_PROVENANCE_CHARS);
    lines.push(`Peer input from bot ${p.from}, hop ${p.hop}: "${quote}"`);
  }
  lines.push("This came from another bot, not from you. Approve only if you want it.");
  return lines;
}

export function approvalCardText(req: ApprovalRequest): string {
  const peer = provenanceLines(req.provenance);
  return [
    "Approve shell command?",
    ...(peer.length > 0 ? ["", ...peer] : []),
    "",
    req.command,
    "",
    `Reason: ${clip(req.reason, MAX_FIELD_CHARS)}`,
    `Cwd: ${clip(req.cwd, MAX_FIELD_CHARS)}`,
    `Approval timeout: ${req.timeoutSec} s`,
    `Expires: ${formatClock(req.deadline)}`,
  ].join("\n");
}

const OUTCOME_TEXT: Record<Outcome, string> = {
  approved: "Approved. Running the command.",
  denied: "Denied.",
  timeout: "Expired (no answer in time). Denied.",
  killswitch: "Cancelled (kill switch).",
  stop: "Cancelled (/stop).",
  aborted: "Cancelled (kill switch).",
};

export class TelegramApprovalTransport implements ApprovalTransport {
  readonly #o: ApprovalUiOptions;
  readonly #now: () => number;
  readonly #pending = new Map<string, Pending>();

  constructor(opts: ApprovalUiOptions) {
    this.#o = opts;
    this.#now = opts.now ?? Date.now;
    opts.killSwitch?.onChange(() => {
      if (opts.killSwitch?.isOn()) void this.cancelAll("killswitch");
    });
  }

  /** Cards waiting for an answer, for one chat or all. */
  pendingCount(chatId?: number): number {
    let n = 0;
    for (const p of this.#pending.values()) if (chatId === undefined || p.req.chatId === chatId) n++;
    return n;
  }

  async request(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const log = this.#o.logger;
    const decision = (approved: boolean, by: ApprovalDecisionBy, userId?: number): ApprovalDecision => ({
      approved,
      by,
      ...(userId !== undefined ? { userId } : {}),
      at: this.#now(),
    });
    if (signal.aborted) return decision(false, signal.reason === "stop" ? "stop" : "killswitch");
    if (req.deadline <= this.#now()) return decision(false, "restart-expired");
    if (req.command.length > MAX_COMMAND_CHARS) {
      log.warn("telegram.approval_too_long", { key: req.key, chars: req.command.length });
      await this.#o.api
        .sendMessage(req.chatId, `A shell command of ${req.command.length} characters was too long to review here and was denied.`)
        .catch(() => undefined);
      return decision(false, INVALID_BY);
    }

    const id = this.#freshId();
    let sent: { message_id: number };
    try {
      sent = await this.#o.api.sendMessage(req.chatId, approvalCardText(req), {
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Approve", callback_data: `ap:${id}:y` },
              { text: "Deny", callback_data: `ap:${id}:n` },
            ],
          ],
        },
      });
    } catch (e) {
      // Fail closed: no card, no approval.
      log.error("telegram.approval_send_failed", { key: req.key, error: (e as Error).name });
      return decision(false, "timeout");
    }

    return new Promise<ApprovalDecision>((resolve) => {
      const stopLike = (): boolean => signal.reason === "stop";
      const onAbort = () => void this.#settle(id, stopLike() ? "stop" : "aborted", decision(false, stopLike() ? "stop" : "killswitch"));
      const wait = Math.min(2 ** 31 - 1, Math.max(0, req.deadline - this.#now()));
      const timer = setTimeout(() => void this.#settle(id, "timeout", decision(false, "timeout")), wait);
      const entry: Pending = { id, req, messageId: sent.message_id, resolve, timer, signal, onAbort, done: false };
      this.#pending.set(id, entry);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  /** Resolves every open card of a chat as denied (`/stop`). Returns how many were cancelled. */
  async cancelChat(chatId: number, by: "stop" | "killswitch"): Promise<number> {
    const ids = [...this.#pending.values()].filter((p) => p.req.chatId === chatId).map((p) => p.id);
    await Promise.all(ids.map((id) => this.#settle(id, by, { approved: false, by, at: this.#now() })));
    return ids.length;
  }

  /** Resolves every open card as denied (kill switch). */
  async cancelAll(by: "stop" | "killswitch"): Promise<number> {
    const ids = [...this.#pending.keys()];
    await Promise.all(ids.map((id) => this.#settle(id, by, { approved: false, by, at: this.#now() })));
    return ids.length;
  }

  /** Register with `bot.on("callback_query:data", ...)`. Ignores data that is not an approval button. */
  async handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data;
    if (data === undefined || !data.startsWith("ap:")) return;
    const log = this.#o.logger;
    const from = ctx.from?.id;
    if (from === undefined || !this.#o.allowedUserIds.includes(from)) {
      log.warn("telegram.approval_foreign_callback", { fromId: from });
      return;
    }
    const m = CALLBACK_RE.exec(data);
    if (!m) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }
    const id = m[1] as string;
    const entry = this.#pending.get(id);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: "Expired. A new request was sent." }).catch(() => undefined);
      const msg = ctx.callbackQuery?.message;
      if (msg) await this.#o.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      return;
    }
    const chatOfMessage = ctx.callbackQuery?.message?.chat.id;
    if (from !== entry.req.chatId || chatOfMessage !== entry.req.chatId) {
      log.warn("telegram.approval_wrong_chat", { fromId: from, key: entry.req.key });
      return;
    }
    const approved = m[2] === "y";
    await ctx.answerCallbackQuery({ text: approved ? "Approved" : "Denied" }).catch(() => undefined);
    await this.#settle(id, approved ? "approved" : "denied", { approved, by: "user", userId: from, at: this.#now() });
  }

  #freshId(): string {
    for (let i = 0; i < 10; i++) {
      const id = this.#o.newId ? this.#o.newId() : randomBytes(4).toString("hex");
      if (!this.#pending.has(id)) return id;
    }
    throw new Error("could not allocate an approval card id");
  }

  async #settle(id: string, outcome: Outcome, decision: ApprovalDecision): Promise<void> {
    const entry = this.#pending.get(id);
    if (!entry || entry.done) return;
    entry.done = true;
    this.#pending.delete(id);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.onAbort);
    entry.resolve(decision);
    const text = `${OUTCOME_TEXT[outcome]}\n\n${entry.req.command}`;
    try {
      await this.#o.api.editMessageText(entry.req.chatId, entry.messageId, text, {
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      });
    } catch (e) {
      this.#o.logger.warn("telegram.approval_edit_failed", { key: entry.req.key, error: (e as Error).name });
    }
  }
}
