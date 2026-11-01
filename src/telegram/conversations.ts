/**
 * Chat to conversation (S4.2). A durable `ChatMap` document maps each Telegram chat id to its Pi conversation id.
 * A miss creates the conversation and writes the map in ONE commit (`init` of `createConversation`), so there is
 * never a conversation without a map entry. `extensions` is never set (spec footgun 30): conversations use the
 * host default registry, so `/new` conversations are gated like the first one.
 *
 * `owners` keeps every conversation id ever created for a chat, so `ChatLookup` still answers for an old
 * conversation (a late approval or `remember` notice) after `/new` or a restart.
 */
import type { ChatLookup, Logger } from "../contracts.js";
import { BACKGROUND_CONTEXT, defineDoc } from "../pi/adapter.js";
import type { Conversation, Harness } from "../pi/adapter.js";

export type ConversationId = Conversation["id"];

/** Ids are branded numbers in Pi; the docs store them as decimal strings. */
export function toConversationId(id: string): ConversationId {
  return Number(id) as ConversationId;
}

export type ChatMapValue = {
  /** chatId (decimal string) to the CURRENT conversation id. */
  chats: Record<string, string>;
  /** conversation id to chat id, for every conversation ever created. */
  owners: Record<string, number>;
};

/** `checkpointWhen` is required in 1.4.0. The plan said `() => false`; a periodic base keeps cold loads short. */
export const chatMapDoc = defineDoc<ChatMapValue>({
  kind: "a7.telegram.chatmap",
  version: 1,
  scope: "session",
  initial: () => ({ chats: {}, owners: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 25,
});

export interface ModelRefLike {
  provider: string;
  modelId: string;
}

export interface ChatConversationsOptions {
  harness: Harness;
  modelRef: ModelRefLike;
  logger?: Logger;
}

export class ChatConversations implements ChatLookup {
  readonly #harness: Harness;
  readonly #modelRef: ModelRefLike;
  readonly #logger: Logger | undefined;
  readonly #current = new Map<number, string>();
  readonly #owners = new Map<string, number>();
  readonly #locks = new Map<number, Promise<unknown>>();

  constructor(opts: ChatConversationsOptions) {
    this.#harness = opts.harness;
    this.#modelRef = opts.modelRef;
    this.#logger = opts.logger;
  }

  /** Reads the durable map into memory. Call once after opening the Harness. */
  async load(): Promise<void> {
    const snap = await this.#harness.snapshot(chatMapDoc, BACKGROUND_CONTEXT);
    this.#current.clear();
    this.#owners.clear();
    if (!snap) return;
    for (const [chat, conv] of Object.entries(snap.chats)) this.#current.set(Number(chat), conv);
    for (const [conv, chat] of Object.entries(snap.owners)) this.#owners.set(conv, chat);
  }

  chatForConversation(conversationId: string): number | undefined {
    return this.#owners.get(conversationId);
  }

  /** Chats that currently have a conversation. */
  chatIds(): number[] {
    return [...this.#current.keys()];
  }

  currentConversationId(chatId: number): string | undefined {
    return this.#current.get(chatId);
  }

  /** The chat's current conversation, created on a miss. */
  current(chatId: number): Promise<Conversation> {
    return this.#serial(chatId, async () => {
      const id = this.#current.get(chatId);
      if (id !== undefined) {
        const existing = await this.#harness.conversation(toConversationId(id), BACKGROUND_CONTEXT);
        if (existing) return existing;
        this.#logger?.warn("telegram.conversation_missing", { chatId, conversationId: id });
      }
      return this.#create(chatId);
    });
  }

  /** `/new`: a new conversation replaces the mapping. */
  startNew(chatId: number): Promise<Conversation> {
    return this.#serial(chatId, () => this.#create(chatId));
  }

  /** Aborts the chat's current conversation (queued inputs withdrawn, live work signalled). No-op without one. */
  async abort(chatId: number): Promise<void> {
    const id = this.#current.get(chatId);
    if (id === undefined) return;
    const conv = await this.#harness.conversation(toConversationId(id), BACKGROUND_CONTEXT);
    if (conv) await conv.abort(BACKGROUND_CONTEXT);
  }

  #serial<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(chatId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.#locks.set(chatId, tail);
    void tail.then(() => {
      if (this.#locks.get(chatId) === tail) this.#locks.delete(chatId);
    });
    return run;
  }

  async #create(chatId: number): Promise<Conversation> {
    const key = String(chatId);
    const conv = await this.#harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: this.#modelRef },
        init: async (tx, conversationId) => {
          const doc = await tx.doc(chatMapDoc);
          doc.chats[key] = String(conversationId);
          doc.owners[String(conversationId)] = chatId;
        },
      },
      BACKGROUND_CONTEXT,
    );
    this.#current.set(chatId, String(conv.id));
    this.#owners.set(String(conv.id), chatId);
    this.#logger?.info("telegram.conversation_created", { chatId, conversationId: String(conv.id) });
    return conv;
  }
}
