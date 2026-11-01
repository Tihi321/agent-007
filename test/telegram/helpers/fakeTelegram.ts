/**
 * A fake Telegram Bot API for tests: a real grammY `Bot` whose HTTP layer is replaced through
 * `bot.api.config.use(...)`. Nothing here ever contacts api.telegram.org.
 */
import { Bot, HttpError } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Logger } from "../../../src/contracts.js";

export const FAKE_TOKEN = "123456:FAKE-test-token_AAAA";
export const USER_ID = 4242;

export interface Call {
  method: string;
  payload: Record<string, unknown>;
  at: number;
  /** True when the fake made this call fail. */
  failed?: boolean;
}

export type Failure = { kind: "api"; error_code: number; description: string; retry_after?: number } | { kind: "network" };

export interface FakeTelegram {
  bot: Bot;
  calls: Call[];
  /** Calls of one method. */
  of(method: string): Call[];
  /** Text of every successful sendMessage, in order. */
  sentTexts(chatId?: number): string[];
  /** The next `times` calls of `method` fail (or every call, with `Infinity`). */
  failNext(method: string, failure: Failure, times?: number): void;
  clearFailures(method?: string): void;
  /** Current text of every message the fake has sent, by message id, with edits applied. */
  messageTexts(): { id: number; text: string }[];
  /** Updates returned by the next getUpdates calls (used by `bot.start()`). */
  queueUpdate(update: object): void;
}

export const BOT_INFO = {
  id: 123456,
  is_bot: true,
  first_name: "Fake",
  username: "fake_agent_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as unknown as UserFromGetMe;

export function createFakeTelegram(): FakeTelegram {
  const calls: Call[] = [];
  let nextMessageId = 1000;
  const failures = new Map<string, { failure: Failure; left: number }[]>();
  const updates: object[] = [];
  const texts = new Map<number, string>();

  const bot = new Bot(FAKE_TOKEN, { botInfo: BOT_INFO });
  bot.api.config.use(async (_prev, method, payload, signal) => {
    const body = (payload ?? {}) as Record<string, unknown>;
    const call: Call = { method, payload: body, at: Date.now() };
    if (method !== "getUpdates") calls.push(call);
    const queue = failures.get(method);
    const head = queue?.[0];
    if (head && head.left > 0) {
      head.left--;
      call.failed = true;
      if (head.left === 0) queue?.shift();
      if (head.failure.kind === "network") throw new HttpError("fake network failure", new Error("ECONNRESET"));
      const { error_code, description, retry_after } = head.failure;
      return { ok: false, error_code, description, ...(retry_after !== undefined ? { parameters: { retry_after } } : {}) } as never;
    }
    switch (method) {
      case "sendMessage":
      case "editMessageText": {
        const id = method === "sendMessage" ? nextMessageId++ : Number(body["message_id"]);
        texts.set(id, String(body["text"]));
        return { ok: true, result: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: Number(body["chat_id"]), type: "private" }, text: body["text"] } } as never;
      }
      case "getUpdates": {
        const batch = updates.splice(0, updates.length);
        if (batch.length === 0) {
          await new Promise<void>((r) => {
            const t = setTimeout(r, 15);
            signal?.addEventListener("abort", () => {
              clearTimeout(t);
              r();
            });
          });
        }
        return { ok: true, result: batch } as never;
      }
      case "getMe":
        return { ok: true, result: BOT_INFO } as never;
      default:
        return { ok: true, result: true } as never;
    }
  });

  return {
    bot,
    calls,
    of: (method) => calls.filter((c) => c.method === method),
    sentTexts: (chatId) =>
      calls
        
        .filter((c) => c.method === "sendMessage" && !c.failed && (chatId === undefined || c.payload["chat_id"] === chatId))
        .map((c) => String(c.payload["text"])),
    failNext(method, failure, times = 1) {
      const q = failures.get(method) ?? [];
      q.push({ failure, left: times });
      failures.set(method, q);
    },
    clearFailures(method) {
      if (method) failures.delete(method);
      else failures.clear();
    },
    messageTexts: () => [...texts.entries()].sort((a, b) => a[0] - b[0]).map(([id, text]) => ({ id, text })),
    queueUpdate: (u) => void updates.push(u),
  };
}

let updateCounter = 1;

export interface MsgOpts {
  chatId?: number;
  chatType?: "private" | "group" | "supergroup" | "channel";
  messageId?: number;
  date?: number;
}

/** A text message update; a leading `/word` gets a `bot_command` entity like Telegram sends. */
export function textUpdate(fromId: number, text: string, o: MsgOpts = {}): object {
  const cmd = /^\/\w+(@\w+)?/.exec(text);
  return {
    update_id: updateCounter++,
    message: {
      message_id: o.messageId ?? updateCounter + 500,
      date: o.date ?? Math.floor(Date.now() / 1000),
      chat: { id: o.chatId ?? fromId, type: o.chatType ?? "private" },
      from: { id: fromId, is_bot: false, first_name: "T" },
      text,
      ...(cmd ? { entities: [{ type: "bot_command", offset: 0, length: cmd[0].length }] } : {}),
    },
  };
}

/** A non-text message (a photo). */
export function photoUpdate(fromId: number, o: MsgOpts = {}): object {
  return {
    update_id: updateCounter++,
    message: {
      message_id: o.messageId ?? updateCounter + 500,
      date: o.date ?? Math.floor(Date.now() / 1000),
      chat: { id: o.chatId ?? fromId, type: o.chatType ?? "private" },
      from: { id: fromId, is_bot: false, first_name: "T" },
      photo: [{ file_id: "x", file_unique_id: "y", width: 1, height: 1 }],
    },
  };
}

export function callbackUpdate(fromId: number, data: string, o: { chatId?: number; messageId?: number; chatType?: "private" | "group" } = {}): object {
  return {
    update_id: updateCounter++,
    callback_query: {
      id: `cb${updateCounter}`,
      chat_instance: "ci",
      from: { id: fromId, is_bot: false, first_name: "T" },
      data,
      message: {
        message_id: o.messageId ?? 1000,
        date: Math.floor(Date.now() / 1000),
        chat: { id: o.chatId ?? fromId, type: o.chatType ?? "private" },
      },
    },
  };
}

export interface LogLine {
  level: string;
  event: string;
  fields: object | undefined;
}

export function memoryLogger(): Logger & { lines: LogLine[]; events(name: string): LogLine[] } {
  const lines: LogLine[] = [];
  const add = (level: string) => (event: string, fields?: object) => void lines.push({ level, event, fields });
  return { lines, events: (name) => lines.filter((l) => l.event === name), debug: add("debug"), info: add("info"), warn: add("warn"), error: add("error") };
}

export function fakeKillSwitch(initial = false) {
  const listeners: (() => void)[] = [];
  const turnedOnBy: string[] = [];
  let on = initial;
  return {
    isOn: () => on,
    turnOn: async (by: string) => {
      turnedOnBy.push(by);
      on = true;
      for (const l of listeners) l();
    },
    onChange: (cb: () => void) => void listeners.push(cb),
    turnedOnBy,
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls `cond` until true or `ms` elapse. */
export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}
