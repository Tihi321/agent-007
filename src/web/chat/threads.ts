/**
 * Threads and messages of ONE user (S34). Stored server-side under `users\<userId>\threads\<botId>\<threadId>.json`, so a reload or
 * another device loses nothing. The store is built from the session's userId; every method takes a bot id and a thread id that are
 * validated against strict patterns and resolved through `userPaths`, so a path parameter cannot leave the user's folder (I47, I52).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { newThreadId, isThreadId, isWebBotId } from "../ids.js";
import { userPaths } from "../paths.js";
import { atomicWriteJson } from "../store.js";

export interface ToolNote {
  name: string;
  status: "ok" | "error" | "denied";
  summary?: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  at: number;
  tools?: ToolNote[];
  usage?: { input: number; output: number };
  stopped?: boolean;
  error?: string;
  /** Said once when the bot fell back to another model. */
  notice?: string;
}

export interface Thread {
  id: string;
  botId: string;
  title: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface ThreadSummary {
  id: string;
  botId: string;
  title: string;
  pinned: boolean;
  updatedAt: number;
  preview: string;
  messages: number;
}

export class ThreadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ThreadError";
    this.status = status;
  }
}

export const MAX_MESSAGE_CHARS = 8000;
const MAX_MESSAGES_PER_THREAD = 2000;
const plain = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

export class ThreadStore {
  readonly #dataDir: string;
  readonly #userId: string;
  readonly #now: () => number;

  constructor(dataDir: string, userId: string, now: () => number = Date.now) {
    this.#dataDir = dataDir;
    this.#userId = userId;
    this.#now = now;
  }

  #file(botId: string, threadId: string): string {
    if (!isWebBotId(botId) || !isThreadId(threadId)) throw new ThreadError(404, "No such thread.");
    return userPaths(this.#dataDir, this.#userId).threadFile(botId, threadId);
  }

  create(botId: string, title = "New chat"): Thread {
    if (!isWebBotId(botId)) throw new ThreadError(404, "No such bot.");
    const t = this.#now();
    const th: Thread = { id: newThreadId(), botId, title: plain(title, 60) || "New chat", pinned: false, createdAt: t, updatedAt: t, messages: [] };
    this.save(th);
    return th;
  }

  save(th: Thread): void {
    const f = this.#file(th.botId, th.id);
    mkdirSync(userPaths(this.#dataDir, this.#userId).threadsDir + "\\" + th.botId, { recursive: true });
    atomicWriteJson(f, th);
  }

  get(botId: string, threadId: string): Thread {
    const f = this.#file(botId, threadId);
    if (!existsSync(f)) throw new ThreadError(404, "No such thread.");
    try {
      const th = JSON.parse(readFileSync(f, "utf8")) as Thread;
      if (th.id !== threadId || th.botId !== botId) throw new Error("mismatch");
      return th;
    } catch {
      throw new ThreadError(500, "That thread could not be read.");
    }
  }

  list(botId?: string): ThreadSummary[] {
    const dir = userPaths(this.#dataDir, this.#userId).threadsDir;
    if (!existsSync(dir)) return [];
    const bots = botId !== undefined ? (isWebBotId(botId) ? [botId] : []) : readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && isWebBotId(e.name)).map((e) => e.name);
    const out: ThreadSummary[] = [];
    for (const b of bots) {
      const bd = dir + "\\" + b;
      if (!existsSync(bd)) continue;
      for (const f of readdirSync(bd)) {
        const id = f.replace(/\.json$/, "");
        if (!isThreadId(id)) continue;
        try {
          const th = this.get(b, id);
          const last = th.messages[th.messages.length - 1];
          out.push({ id, botId: b, title: th.title, pinned: th.pinned, updatedAt: th.updatedAt, preview: last ? plain(last.text, 80) : "", messages: th.messages.length });
        } catch {
          /* a damaged thread is skipped, not fatal */
        }
      }
    }
    return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }

  append(botId: string, threadId: string, msg: Omit<ChatMessage, "id" | "at">): { thread: Thread; message: ChatMessage } {
    const th = this.get(botId, threadId);
    if (th.messages.length >= MAX_MESSAGES_PER_THREAD) throw new ThreadError(409, "This chat is full. Start a new one.");
    const message: ChatMessage = { ...msg, text: msg.text.slice(0, 200_000), id: (th.messages[th.messages.length - 1]?.id ?? 0) + 1, at: this.#now() };
    th.messages.push(message);
    th.updatedAt = message.at;
    if (th.title === "New chat" && msg.role === "user") th.title = plain(msg.text, 40) || th.title;
    this.save(th);
    return { thread: th, message };
  }

  /** Replace the last assistant message (regenerate) or drop it. */
  dropLastAssistant(botId: string, threadId: string): Thread {
    const th = this.get(botId, threadId);
    if (th.messages[th.messages.length - 1]?.role === "assistant") th.messages.pop();
    th.updatedAt = this.#now();
    this.save(th);
    return th;
  }

  rename(botId: string, threadId: string, title: unknown): void {
    const th = this.get(botId, threadId);
    const t = typeof title === "string" ? plain(title, 60) : "";
    if (t === "") throw new ThreadError(400, "Give the chat a name.");
    th.title = t;
    this.save(th);
  }

  pin(botId: string, threadId: string, pinned: unknown): void {
    const th = this.get(botId, threadId);
    th.pinned = pinned === true;
    this.save(th);
  }

  delete(botId: string, threadId: string): void {
    const f = this.#file(botId, threadId);
    if (!existsSync(f)) throw new ThreadError(404, "No such thread.");
    rmSync(f, { force: true });
  }

  search(q: unknown): ThreadSummary[] {
    const needle = typeof q === "string" ? q.trim().toLowerCase() : "";
    if (needle.length < 2 || needle.length > 100) return [];
    return this.list().filter((s) => {
      if (s.title.toLowerCase().includes(needle)) return true;
      return this.get(s.botId, s.id).messages.some((m) => m.text.toLowerCase().includes(needle));
    });
  }

  /** The user's own export of one thread (privacy: this is the only way the text leaves the user's account). */
  exportThread(botId: string, threadId: string, format: unknown): { type: string; body: string; name: string } {
    const th = this.get(botId, threadId);
    if (format === "json") return { type: "application/json", body: JSON.stringify(th, null, 2), name: `${th.id}.json` };
    const md = [`# ${th.title}`, "", ...th.messages.map((m) => `**${m.role === "user" ? "You" : "Bot"}** (${new Date(m.at).toISOString()})\n\n${m.text}\n`)].join("\n");
    return { type: "text/markdown", body: md, name: `${th.id}.md` };
  }
}
