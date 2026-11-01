/**
 * Admission records and at-least-once delivery of answers (S4.3).
 *
 * Flow: the bridge submits the user's text (`requestId` = `tg:<chatId>:<message_id>`), then `admit()` writes a
 * durable `PendingDelivery` item keyed by that requestId. A background loop waits for the submission to settle and
 * sends the answer in chunks of at most 4096 characters, saving `sentChunks` after each one. After a restart,
 * `deliverPending()` resumes every item that is not `delivered`. A Telegram redelivery of the same update finds the
 * existing submission (requestId dedup, U8) and the existing item, so nothing is answered twice. A crash between
 * two chunks can repeat one chunk (at-least-once).
 */
import { GrammyError, HttpError } from "grammy";
import type { Api } from "grammy";
import type { Logger } from "../contracts.js";
import { errorFields } from "../logging/redact.js";
import type { Redactor } from "../logging/redact.js";
import { BACKGROUND_CONTEXT, defineDoc } from "../pi/adapter.js";
import type { Conversation, Harness, SettledSubmissionRecord, Submission } from "../pi/adapter.js";
import { sendableChunks } from "./chunk.js";
import { toConversationId } from "./conversations.js";

export type PendingItem = {
  requestId: string;
  submissionId: string;
  conversationId: string;
  chatId: number;
  /** Chunks already sent. */
  sentChunks: number;
  delivered: boolean;
  createdAt: number;
};

export type PendingValue = { items: Record<string, PendingItem> };

export const pendingDoc = defineDoc<PendingValue>({
  kind: "a7.telegram.pending",
  version: 1,
  scope: "session",
  initial: () => ({ items: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 25,
});

/** Delivered items are kept (for requestId dedup bookkeeping) for 7 days, at most 500 of them. */
const KEEP_DELIVERED_MS = 7 * 24 * 3600 * 1000;
const KEEP_DELIVERED_MAX = 500;

export function requestIdFor(chatId: number, messageId: number): string {
  return `tg:${chatId}:${messageId}`;
}

// ---- Telegram retry ----------------------------------------------------------------------------

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseDelayMs: 1000, maxDelayMs: 60_000 };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A Telegram error that retrying cannot fix (bad request, bot blocked, chat gone, bad token). */
export function isPermanentTelegramError(e: unknown): boolean {
  return e instanceof GrammyError && [400, 401, 403, 404].includes(e.error_code);
}

/** `editMessageText` with the same text: Telegram answers 400 "message is not modified". */
export function isNotModified(e: unknown): boolean {
  return e instanceof GrammyError && e.error_code === 400 && /not modified/i.test(e.description);
}

/** Runs `fn`, retrying 429 (honouring `retry_after`), 5xx and network errors with backoff. */
export async function withTelegramRetry<T>(fn: () => Promise<T>, policy: RetryPolicy = DEFAULT_RETRY): Promise<T> {
  const sleep = policy.sleep ?? realSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (isPermanentTelegramError(e)) throw e;
      if (attempt === policy.attempts) break;
      let delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      if (e instanceof GrammyError && e.error_code === 429) {
        const ra = e.parameters.retry_after;
        if (typeof ra === "number") delay = Math.min(policy.maxDelayMs, Math.max(delay, ra * 1000));
      } else if (!(e instanceof HttpError) && !(e instanceof GrammyError && e.error_code >= 500)) {
        throw e;
      }
      await sleep(delay);
    }
  }
  throw lastError;
}

// ---- Answer text -------------------------------------------------------------------------------

function messagesText(entry: { model?: readonly unknown[] | undefined }): string {
  const parts: string[] = [];
  for (const m of entry.model ?? []) {
    const msg = m as { role?: string; content?: unknown };
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") parts.push(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const b of msg.content as { type?: string; text?: string }[]) if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}

/** The assistant text of one committed entry, searched newest first (the answer is near the tail). */
export async function readAnswerText(conversation: Conversation, answerId: string): Promise<string> {
  let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
  for (let page = 0; page < 40; page++) {
    const res = await conversation.entries({ order: "descending" }, 50, cursor, BACKGROUND_CONTEXT);
    const hit = res.items.find((e) => String(e.id) === answerId);
    if (hit) return messagesText(hit);
    if (!res.next) break;
    cursor = res.next;
  }
  return "";
}

/** What to tell the user about a submission that ended without an answer; `undefined` = say nothing. */
export function unansweredNotice(reason: string): string | undefined {
  if (reason === "aborted") return undefined; // the user stopped it and was already told
  if (reason === "model_error") return "The model returned an error, so I could not answer that. Send the message again to retry.";
  return `I could not answer that (${reason}).`;
}

// ---- Delivery manager --------------------------------------------------------------------------

export interface PlaceholderClaims {
  /** Takes over the streaming placeholder message of the run that answers `submissionId`, if there is one. */
  claim(chatId: number, submissionId: string): Promise<number | undefined>;
}

export interface DeliveryOptions {
  harness: Harness;
  api: Pick<Api, "sendMessage" | "editMessageText">;
  claims?: PlaceholderClaims | undefined;
  logger: Logger;
  redact?: Redactor | undefined;
  retry?: RetryPolicy | undefined;
  /** Delay before a failed delivery is tried again. Default 30 s. */
  redeliverDelayMs?: number | undefined;
  now?: (() => number) | undefined;
  /** Called with every delivery error (for `/status` "last error"). */
  onError?: ((e: unknown) => void) | undefined;
}

export interface AdmitArgs {
  requestId: string;
  submissionId: string;
  conversationId: string;
  chatId: number;
}

export class DeliveryManager {
  readonly #o: DeliveryOptions;
  readonly #now: () => number;
  readonly #running = new Map<string, { chatId: number; promise: Promise<void> }>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #stopped = false;

  constructor(opts: DeliveryOptions) {
    this.#o = opts;
    this.#now = opts.now ?? Date.now;
  }

  /** Writes the pending item (once per requestId) and starts delivering. Returns true if the item is new. */
  async admit(args: AdmitArgs): Promise<boolean> {
    const createdAt = this.#now();
    const created = await this.#o.harness.commit(async (tx) => {
      const doc = await tx.doc(pendingDoc);
      if (doc.items[args.requestId]) return false;
      this.#prune(doc.items, createdAt);
      doc.items[args.requestId] = { ...args, sentChunks: 0, delivered: false, createdAt };
      return true;
    }, BACKGROUND_CONTEXT);
    if (created) this.#kick(args.requestId, args.chatId);
    return created;
  }

  /** True if a delivery item for this requestId exists (delivered or not). A redelivered Telegram update must not submit again. */
  async known(requestId: string): Promise<boolean> {
    return (await this.#read(requestId)) !== undefined;
  }

  /** After `resume()`: delivers every item that is not delivered. Returns how many were started. */
  async deliverPending(): Promise<number> {
    const snap = await this.#o.harness.snapshot(pendingDoc, BACKGROUND_CONTEXT);
    let n = 0;
    for (const item of Object.values(snap?.items ?? {})) {
      if (item.delivered) continue;
      this.#kick(item.requestId, item.chatId);
      n++;
    }
    return n;
  }

  /** Deliveries not finished yet, for one chat or all. */
  inFlight(chatId?: number): number {
    let n = 0;
    for (const r of this.#running.values()) if (chatId === undefined || r.chatId === chatId) n++;
    return n;
  }

  inFlightChats(): number[] {
    return [...new Set([...this.#running.values()].map((r) => r.chatId))];
  }

  /** Resolves when no delivery is running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running.values()].map((r) => r.promise));
  }

  stop(): void {
    this.#stopped = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }

  #prune(items: Record<string, PendingItem>, now: number): void {
    const delivered = Object.values(items).filter((i) => i.delivered);
    for (const i of delivered) if (now - i.createdAt > KEEP_DELIVERED_MS) delete items[i.requestId];
    const rest = delivered.filter((i) => items[i.requestId]).sort((a, b) => a.createdAt - b.createdAt);
    for (let k = 0; k < rest.length - KEEP_DELIVERED_MAX; k++) delete items[(rest[k] as PendingItem).requestId];
  }

  #kick(requestId: string, chatId: number): void {
    if (this.#stopped || this.#running.has(requestId)) return;
    const promise = this.#run(requestId).finally(() => {
      this.#running.delete(requestId);
    });
    this.#running.set(requestId, { chatId, promise });
  }

  async #run(requestId: string): Promise<void> {
    const log = this.#o.logger;
    const redact = this.#o.redact ?? ((s: string) => s);
    try {
      await this.#deliver(requestId);
    } catch (e) {
      if (this.#stopped) return;
      log.error("telegram.delivery_failed", { requestId, ...errorFields(e, redact) });
      this.#o.onError?.(e);
      if (isPermanentTelegramError(e)) {
        await this.#patch(requestId, { delivered: true }).catch(() => undefined);
        return;
      }
      const snap = await this.#o.harness.snapshot(pendingDoc, BACKGROUND_CONTEXT).catch(() => undefined);
      const chatId = snap?.items[requestId]?.chatId;
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        if (chatId !== undefined) this.#kick(requestId, chatId);
      }, this.#o.redeliverDelayMs ?? 30_000);
      timer.unref();
      this.#timers.add(timer);
    }
  }

  async #read(requestId: string): Promise<PendingItem | undefined> {
    const snap = await this.#o.harness.snapshot(pendingDoc, BACKGROUND_CONTEXT);
    return snap?.items[requestId];
  }

  async #patch(requestId: string, patch: Partial<Pick<PendingItem, "sentChunks" | "delivered">>): Promise<void> {
    await this.#o.harness.commit(async (tx) => {
      const doc = await tx.doc(pendingDoc);
      const item = doc.items[requestId];
      if (!item) return;
      if (patch.sentChunks !== undefined) item.sentChunks = patch.sentChunks;
      if (patch.delivered !== undefined) item.delivered = patch.delivered;
    }, BACKGROUND_CONTEXT);
  }

  async #deliver(requestId: string): Promise<void> {
    const item = await this.#read(requestId);
    if (!item || item.delivered) return;
    const submission: Submission | undefined = await this.#o.harness.submission(Number(item.submissionId) as Submission["id"], BACKGROUND_CONTEXT);
    if (!submission) {
      this.#o.logger.warn("telegram.submission_missing", { requestId });
      await this.#patch(requestId, { delivered: true });
      return;
    }
    const settled: SettledSubmissionRecord = await submission.wait(BACKGROUND_CONTEXT);
    if (this.#stopped) return;

    let text: string | undefined;
    if (settled.type === "input" && settled.status === "done") {
      const conv = await this.#o.harness.conversation(toConversationId(item.conversationId), BACKGROUND_CONTEXT);
      text = conv ? await readAnswerText(conv, String(settled.answer)) : "";
      if (text.trim() === "") text = "(The model returned an empty answer.)";
    } else if (settled.status === "unanswered") {
      text = unansweredNotice(settled.reason);
    }

    const chunks = text === undefined ? [] : sendableChunks(text);
    let placeholder: number | undefined;
    if (item.sentChunks === 0) placeholder = await this.#o.claims?.claim(item.chatId, item.submissionId);
    for (let i = item.sentChunks; i < chunks.length; i++) {
      const chunk = chunks[i] as string;
      if (i === 0 && placeholder !== undefined) {
        const edited = await this.#edit(item.chatId, placeholder, chunk);
        if (!edited) await this.#send(item.chatId, chunk);
      } else {
        await this.#send(item.chatId, chunk);
      }
      await this.#patch(requestId, { sentChunks: i + 1 });
    }
    await this.#patch(requestId, { delivered: true });
    this.#o.logger.info("telegram.delivered", { requestId, chunks: chunks.length, status: settled.status });
  }

  async #send(chatId: number, text: string): Promise<void> {
    await withTelegramRetry(() => this.#o.api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } }), this.#o.retry);
  }

  /** Edits the placeholder into the first chunk; false when it cannot be edited (the caller then sends instead). */
  async #edit(chatId: number, messageId: number, text: string): Promise<boolean> {
    try {
      await withTelegramRetry(() => this.#o.api.editMessageText(chatId, messageId, text, { link_preview_options: { is_disabled: true } }), this.#o.retry);
      return true;
    } catch (e) {
      if (isNotModified(e)) return true;
      this.#o.logger.warn("telegram.placeholder_edit_failed", { chatId });
      return false;
    }
  }
}
