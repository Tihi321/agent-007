/**
 * Streaming edits (S4.3). One `watchEvents` stream per conversation drives ONE placeholder message per run: it is
 * created on the first content (answer text or a tool starting) and edited at most every `editIntervalMs`
 * (1.5 s by default). Tool progress shows as lines such as "running read_file...". The placeholder is plain text.
 *
 * The final answer is not taken from the stream: the delivery loop reads the committed answer entry, sends it in
 * chunks, and `claim()`s the placeholder so chunk 1 replaces it by an edit instead of a second message.
 * Streaming is a nicety: any failure here is logged and never blocks delivery.
 */
import type { Api } from "grammy";
import type { Logger } from "../contracts.js";
import { errorFields } from "../logging/redact.js";
import type { Redactor } from "../logging/redact.js";
import { BACKGROUND_CONTEXT, watchEvents } from "../pi/adapter.js";
import type { Harness } from "../pi/adapter.js";
import { tailText } from "./chunk.js";
import { toConversationId } from "./conversations.js";
import { isNotModified } from "./delivery.js";
import type { PlaceholderClaims } from "./delivery.js";

type EventStream = Awaited<ReturnType<typeof watchEvents>>;
type EventBatch = Parameters<Parameters<EventStream["start"]>[0]>[0];
type AgentEvent = EventBatch[number];

export interface ToolLine {
  id: string;
  name: string;
  status: "running" | "done" | "stopped";
}

export interface StreamState {
  /** Text blocks of the assistant message being generated, by content index. */
  blocks: Map<number, string>;
  tools: ToolLine[];
}

export function newStreamState(): StreamState {
  return { blocks: new Map(), tools: [] };
}

function blockText(block: unknown): string {
  const b = block as { type?: string; text?: string } | undefined;
  return b?.type === "text" && typeof b.text === "string" ? b.text : "";
}

function setBlocksFromMessage(state: StreamState, message: unknown): void {
  state.blocks.clear();
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") state.blocks.set(0, content);
  else if (Array.isArray(content)) content.forEach((b, i) => state.blocks.set(i, blockText(b)));
}

/** Folds one agent event into the view state. Pure; unknown events are ignored. */
export function applyEvent(state: StreamState, event: AgentEvent): void {
  switch (event.type) {
    case "snapshot": {
      state.blocks.clear();
      state.tools = [];
      if (event.generation?.message) setBlocksFromMessage(state, event.generation.message);
      return;
    }
    case "run_start":
      state.blocks.clear();
      state.tools = [];
      return;
    case "message_start":
      if ((event.message as { role?: string }).role === "assistant") state.blocks.clear();
      return;
    case "message_update": {
      for (const c of event.changes) {
        if (c.type === "text_start") state.blocks.set(c.contentIndex, blockText(c.block));
        else if (c.type === "text_delta") state.blocks.set(c.contentIndex, (state.blocks.get(c.contentIndex) ?? "") + c.delta);
        else if (c.type === "block") {
          if ((c.block as { type?: string }).type === "text") state.blocks.set(c.contentIndex, blockText(c.block));
        } else if (c.type === "message") setBlocksFromMessage(state, c.message);
      }
      return;
    }
    case "tool_execution_start":
      if (event.parentToolCallId === undefined) state.tools.push({ id: event.toolCallId, name: event.toolName, status: "running" });
      return;
    case "tool_execution_end": {
      const t = state.tools.find((x) => x.id === event.toolCallId);
      if (t) t.status = event.entry ? "done" : "stopped";
      return;
    }
    default:
      return;
  }
}

/** The plain-text view: up to the last 3 tool lines, a blank line, then the answer text so far. */
export function renderStream(state: StreamState): string {
  const lines = state.tools.slice(-3).map((t) => (t.status === "running" ? `running ${t.name}…` : t.status === "done" ? `${t.name} done` : `${t.name} stopped`));
  const text = [...state.blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => t)
    .join("");
  const parts: string[] = [];
  if (lines.length > 0) parts.push(lines.join("\n"));
  if (text.trim() !== "") parts.push(tailText(text, 3800));
  return parts.join("\n\n");
}

interface Placeholder {
  messageId: number | undefined;
  inputs: Set<string>;
  lastText: string;
}

class ChatWatch {
  readonly state = newStreamState();
  inputs = new Set<string>();
  cur: Placeholder | undefined;
  readonly placeholders: Placeholder[] = [];
  readonly claimed = new Set<string>();
  lastEditAt = 0;
  timer: NodeJS.Timeout | undefined;
  chain: Promise<void> = Promise.resolve();
  stream: EventStream | undefined;
  closing = false;

  constructor(
    readonly chatId: number,
    readonly conversationId: string,
  ) {}
}

export interface StreamViewsOptions {
  harness: Harness;
  api: Pick<Api, "sendMessage" | "editMessageText" | "sendChatAction">;
  logger: Logger;
  redact?: Redactor | undefined;
  /** Minimum time between two edits of one placeholder. Default 1500 ms. */
  editIntervalMs?: number | undefined;
  now?: (() => number) | undefined;
}

export class StreamViews implements PlaceholderClaims {
  readonly #o: StreamViewsOptions;
  readonly #interval: number;
  readonly #now: () => number;
  readonly #watches = new Map<string, ChatWatch>();
  readonly #attaching = new Map<string, Promise<void>>();

  constructor(opts: StreamViewsOptions) {
    this.#o = opts;
    this.#interval = opts.editIntervalMs ?? 1500;
    this.#now = opts.now ?? Date.now;
  }

  /** Starts watching a conversation (idempotent). Never throws: a failed attach only costs the live view. */
  watch(chatId: number, conversationId: string): Promise<void> {
    if (this.#watches.has(conversationId)) return Promise.resolve();
    const pending = this.#attaching.get(conversationId);
    if (pending) return pending;
    const p = this.#attach(chatId, conversationId)
      .catch((e) => this.#o.logger.warn("telegram.stream_attach_failed", { chatId, ...errorFields(e, this.#o.redact ?? ((s) => s)) }))
      .finally(() => this.#attaching.delete(conversationId));
    this.#attaching.set(conversationId, p);
    return p;
  }

  async unwatch(conversationId: string): Promise<void> {
    const w = this.#watches.get(conversationId);
    if (!w) return;
    this.#watches.delete(conversationId);
    w.closing = true;
    if (w.timer) clearTimeout(w.timer);
    await w.stream?.stop().catch(() => undefined);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#watches.keys()].map((id) => this.unwatch(id)));
  }

  /** Takes over the placeholder of the run that answers `submissionId`; the stream stops editing it. */
  async claim(chatId: number, submissionId: string): Promise<number | undefined> {
    for (const w of this.#watches.values()) {
      if (w.chatId !== chatId) continue;
      const ph = w.placeholders.find((p) => p.inputs.has(submissionId));
      if (!ph && !w.inputs.has(submissionId)) continue;
      w.claimed.add(submissionId);
      if (w.timer) {
        clearTimeout(w.timer);
        w.timer = undefined;
      }
      await w.chain;
      if (ph) {
        w.placeholders.splice(w.placeholders.indexOf(ph), 1);
        return ph.messageId;
      }
      return undefined;
    }
    return undefined;
  }

  async #attach(chatId: number, conversationId: string): Promise<void> {
    const w = new ChatWatch(chatId, conversationId);
    const stream = await watchEvents(this.#o.harness, toConversationId(conversationId), BACKGROUND_CONTEXT);
    w.stream = stream;
    this.#watches.set(conversationId, w);
    const snap = stream.snapshot;
    applyEvent(w.state, snap);
    if (snap.run) {
      w.inputs = new Set(snap.run.inputs.map(String));
      this.#schedule(w);
    }
    stream.start(async (events) => {
      try {
        for (const e of events) this.#onEvent(w, e);
      } catch (e) {
        this.#o.logger.warn("telegram.stream_event_failed", { chatId, ...errorFields(e, this.#o.redact ?? ((s) => s)) });
      }
    });
    void stream.closed.then(() => {
      if (!w.closing && this.#watches.get(conversationId) === w) {
        this.#watches.delete(conversationId);
        this.#o.logger.warn("telegram.stream_closed", { chatId });
      }
    });
  }

  #onEvent(w: ChatWatch, e: AgentEvent): void {
    if (e.type === "run_start") {
      w.inputs = new Set(e.inputs.map(String));
      w.cur = undefined;
      applyEvent(w.state, e);
      void this.#o.api.sendChatAction(w.chatId, "typing").catch(() => undefined);
      return;
    }
    if (e.type === "run_end") {
      this.#flushNow(w);
      return;
    }
    if (e.type === "snapshot") {
      if (e.run) w.inputs = new Set(e.run.inputs.map(String));
      applyEvent(w.state, e);
      this.#schedule(w);
      return;
    }
    applyEvent(w.state, e);
    if (e.type === "message_update" || e.type === "tool_execution_start" || e.type === "tool_execution_end") this.#schedule(w);
  }

  #schedule(w: ChatWatch): void {
    if (w.timer || w.closing) return;
    const wait = Math.max(0, w.lastEditAt + this.#interval - this.#now());
    w.timer = setTimeout(() => {
      w.timer = undefined;
      this.#enqueue(w);
    }, wait);
  }

  #flushNow(w: ChatWatch): void {
    if (w.timer) {
      clearTimeout(w.timer);
      w.timer = undefined;
    }
    this.#enqueue(w);
  }

  #enqueue(w: ChatWatch): void {
    w.chain = w.chain.then(() => this.#flush(w)).catch((e) => {
      this.#o.logger.warn("telegram.stream_flush_failed", { chatId: w.chatId, ...errorFields(e, this.#o.redact ?? ((s) => s)) });
    });
  }

  async #flush(w: ChatWatch): Promise<void> {
    if (w.closing) return;
    for (const id of w.inputs) if (w.claimed.has(id)) return;
    const text = renderStream(w.state);
    if (text === "") return;
    if (w.cur && w.cur.lastText === text) return;
    w.lastEditAt = this.#now();
    if (!w.cur) {
      const ph: Placeholder = { messageId: undefined, inputs: new Set(w.inputs), lastText: text };
      w.cur = ph;
      w.placeholders.push(ph);
      if (w.placeholders.length > 5) w.placeholders.shift();
      const sent = await this.#o.api.sendMessage(w.chatId, text, { link_preview_options: { is_disabled: true } });
      ph.messageId = sent.message_id;
      return;
    }
    const ph = w.cur;
    ph.lastText = text;
    if (ph.messageId === undefined) return;
    try {
      await this.#o.api.editMessageText(w.chatId, ph.messageId, text, { link_preview_options: { is_disabled: true } });
    } catch (e) {
      if (!isNotModified(e)) throw e;
    }
  }
}
