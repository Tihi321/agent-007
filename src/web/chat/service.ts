/**
 * Chat orchestration for the web gateway (S34). One `ChatService` serves every user; every method takes the acting `userId` FROM THE
 * SESSION and builds that user's stores from it, so no id from the client can select another user's data (I47).
 *
 * A turn: quota check, user message saved, a run is created with an in-memory event log (numbered, so an SSE client can resume with
 * `Last-Event-ID`), a scheduler slot is taken (one running turn per user), the engine streams, the assistant message is saved with its usage,
 * the day's quota is updated, and one audit line records lengths and hashes, never text (I54).
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isPaidPreset } from "../../bots/schema.js";
import type { PresetConfig, TermsAccepted } from "../../bots/schema.js";
import type { WebAudit } from "../audit.js";
import { bodyDigest } from "../crypto.js";
import { recordFor } from "../schemas.js";
import type { Caps, UsersFile } from "../schemas.js";
import type { JsonStore } from "../store.js";
import { SchedulerAbortedError, SchedulerBusyError, TurnScheduler } from "../runtime/scheduler.js";
import { buildUserToolbox } from "../runtime/tools.js";
import { PaidRoutes } from "../runtime/paidRoutes.js";
import { resolveTurnRoute, whyNot } from "../runtime/route.js";
import type { ResolvedTurn, TurnRouteContext } from "../runtime/route.js";
import { UserBotError, UserBotRegistry, UserBotStore } from "../runtime/userBots.js";
import type { UserBotConfig } from "../runtime/userBots.js";
import { webPaths } from "../paths.js";
import { ApprovalBroker } from "./approvals.js";
import type { ApprovalCard } from "./approvals.js";
import { buildUserSystemPrompt } from "./engine.js";
import type { ChatEngine, HistoryItem } from "./engine.js";
import { QuotaError, QuotaStore } from "./quota.js";
import { MAX_MESSAGE_CHARS, ThreadError, ThreadStore } from "./threads.js";
import type { ChatMessage, ToolNote } from "./threads.js";

export type RunEvent =
  | { type: "start"; thread: string; message: number }
  | { type: "queued" }
  | { type: "delta"; text: string }
  | { type: "notice"; text: string }
  | { type: "tool"; name: string; status: "running" | "ok" | "error" | "denied"; summary?: string }
  | { type: "approval"; card: ApprovalCard }
  | { type: "question"; text: string }
  | { type: "done"; stopReason: "stop" | "aborted" | "error"; usage: { input: number; output: number }; error?: string };

export interface SeqEvent {
  seq: number;
  ev: RunEvent;
}

export class ChatError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ChatError";
    this.status = status;
  }
}

/** Tools that wait for the user's tap before they run. */
export const ASK_FIRST_TOOLS: readonly string[] = ["write_file"];
const HISTORY_MAX_CHARS = 24_000;

export class TurnRun {
  readonly events: SeqEvent[] = [];
  readonly listeners = new Set<(e: SeqEvent) => void>();
  readonly abort = new AbortController();
  done = false;
  constructor(
    readonly userId: string,
    readonly botId: string,
    readonly threadId: string,
  ) {}
  push(ev: RunEvent): void {
    const e = { seq: this.events.length + 1, ev };
    this.events.push(e);
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* a broken stream never stops the turn */
      }
    }
  }
}

export interface ChatServiceDeps {
  dataDir: string;
  audit: WebAudit;
  users: JsonStore<UsersFile>;
  presets: () => readonly PresetConfig[];
  terms: () => TermsAccepted;
  scheduler: TurnScheduler;
  engine: ChatEngine;
  registry?: UserBotRegistry;
  approvals?: ApprovalBroker;
  /** M2: the owner's paid-route grants and the usage ledger. */
  paid?: PaidRoutes;
  now?: () => number;
  /** How long a finished run stays available for a late SSE client. */
  keepRunMs?: number;
}

export class ChatService {
  readonly #d: ChatServiceDeps;
  readonly #now: () => number;
  readonly #runs = new Map<string, TurnRun>();
  readonly registry: UserBotRegistry;
  readonly approvals: ApprovalBroker;
  readonly paid: PaidRoutes;

  constructor(d: ChatServiceDeps) {
    this.#d = d;
    this.#now = d.now ?? Date.now;
    this.registry = d.registry ?? new UserBotRegistry();
    this.approvals = d.approvals ?? new ApprovalBroker(d.audit, { now: this.#now });
    this.paid = d.paid ?? new PaidRoutes({ dataDir: d.dataDir, webDir: webPaths(d.dataDir).webDir, audit: d.audit, now: this.#now });
  }

  /** What a turn of this bot may use NOW (M1): the current caps, terms and paid grants, never the ones the bot was saved under. */
  #routeContext(userId: string, botId: string, caps: Caps): TurnRouteContext {
    return {
      caps,
      presets: this.#d.presets(),
      terms: this.#d.terms(),
      paidHeadroom: (presetId) => {
        const s = this.paid.status(userId, botId, presetId);
        return s.enabled ? s.headroom : -1;
      },
    };
  }

  isPaid(presetId: string): boolean {
    const p = this.#d.presets().find((x) => x.id === presetId);
    return p !== undefined && isPaidPreset(p);
  }

  /** Resolves the turn's route; a refusal is audited and thrown as a 403 with a plain message. */
  #routeOrRefuse(userId: string, botId: string, cfg: UserBotConfig, caps: Caps): void {
    const r = resolveTurnRoute(cfg, this.#routeContext(userId, botId, caps));
    this.#auditDrops(userId, botId, r);
    if (!r.ok) throw new ChatError(403, r.message);
  }

  #auditDrops(userId: string, botId: string, r: ResolvedTurn): void {
    for (const d of r.dropped) {
      if (d.why === "paid_cap") this.#d.audit.write({ kind: "paid_cap_hit", user: userId, detail: { bot: botId, preset: d.preset, which: "turn_start" } });
      else this.#d.audit.write({ kind: "route_changed", user: userId, detail: { bot: botId, preset: d.preset, why: d.why } });
    }
    if (r.ok && r.droppedTools.length > 0) this.#d.audit.write({ kind: "route_changed", user: userId, detail: { bot: botId, tools_dropped: r.droppedTools.length } });
  }

  #user(userId: string): { caps: Caps; login: string } {
    const u = recordFor(this.#d.users.read().users, userId);
    if (!u || u.status !== "active") throw new ChatError(403, "Not allowed.");
    return { caps: u.caps, login: u.login };
  }

  bots(userId: string): UserBotStore {
    return new UserBotStore({ dataDir: this.#d.dataDir, userId, caps: () => this.#user(userId).caps, presets: this.#d.presets, terms: this.#d.terms, audit: this.#d.audit, now: this.#now });
  }
  threads(userId: string): ThreadStore {
    return new ThreadStore(this.#d.dataDir, userId, this.#now);
  }
  quota(userId: string): QuotaStore {
    return new QuotaStore(this.#d.dataDir, userId, this.#now);
  }

  #key = (userId: string, threadId: string): string => `${userId}/${threadId}`;

  /** The run of a thread of THIS user, active or recently finished. */
  run(userId: string, threadId: string): TurnRun | undefined {
    return this.#runs.get(this.#key(userId, threadId));
  }

  usage(userId: string): { chatsToday: number; tokensToday: number; maxChatsPerDay: number; maxTokensPerDay: number } {
    const { caps } = this.#user(userId);
    const s = this.quota(userId).state();
    return { chatsToday: s.chats, tokensToday: s.tokens, maxChatsPerDay: caps.maxChatsPerDay, maxTokensPerDay: caps.maxTokensPerDay };
  }

  /** Starts a turn. Returns at once; the work continues in the background and is followed through `run()` (SSE). */
  async send(userId: string, req: { botId: unknown; threadId?: unknown; text: unknown }): Promise<{ threadId: string; messageId: number }> {
    const { caps } = this.#user(userId);
    const botId = typeof req.botId === "string" ? req.botId : "";
    const text = typeof req.text === "string" ? req.text.trim() : "";
    if (text === "" || text.length > MAX_MESSAGE_CHARS) throw new ChatError(400, `Write a message of 1 to ${MAX_MESSAGE_CHARS} characters.`);
    const cfg = this.bots(userId).get(botId);
    if (!cfg) throw new ChatError(404, "No such bot.");
    this.#routeOrRefuse(userId, botId, cfg, caps); // M1/M2: refused before anything is stored
    const threads = this.threads(userId);
    let threadId = typeof req.threadId === "string" && req.threadId !== "" ? req.threadId : undefined;
    if (threadId === undefined) threadId = threads.create(botId).id;
    else threads.get(botId, threadId); // 404 for a thread that is not this user's
    if (this.#runs.get(this.#key(userId, threadId)) && !this.#runs.get(this.#key(userId, threadId))?.done) throw new ChatError(409, "The bot is still answering. Wait or press stop.");
    try {
      this.quota(userId).check(caps);
    } catch (e) {
      if (e instanceof QuotaError) {
        this.#d.audit.write({ kind: "quota_hit", user: userId, detail: { which: e.which } });
        throw new ChatError(429, e.message);
      }
      throw e;
    }
    const { message } = threads.append(botId, threadId, { role: "user", text });
    this.quota(userId).record({ chats: 1 });
    const run = this.#startRun(userId, botId, threadId, cfg, text);
    run.push({ type: "start", thread: threadId, message: message.id });
    return { threadId, messageId: message.id };
  }

  async regenerate(userId: string, req: { botId: unknown; threadId: unknown }): Promise<{ threadId: string }> {
    this.#user(userId);
    const botId = String(req.botId);
    const threadId = String(req.threadId);
    const cfg = this.bots(userId).get(botId);
    if (!cfg) throw new ChatError(404, "No such bot.");
    const existing = this.#runs.get(this.#key(userId, threadId));
    if (existing && !existing.done) throw new ChatError(409, "The bot is still answering.");
    const threads = this.threads(userId);
    const th = threads.dropLastAssistant(botId, threadId);
    const lastUser = [...th.messages].reverse().find((m) => m.role === "user");
    if (!lastUser || th.messages[th.messages.length - 1]?.role !== "user") throw new ChatError(400, "There is nothing to regenerate.");
    const { caps } = this.#user(userId);
    try {
      this.quota(userId).check(caps);
    } catch (e) {
      if (e instanceof QuotaError) {
        this.#d.audit.write({ kind: "quota_hit", user: userId, detail: { which: e.which } });
        throw new ChatError(429, e.message);
      }
      throw e;
    }
    this.#routeOrRefuse(userId, botId, cfg, caps);
    const run = this.#startRun(userId, botId, threadId, cfg, lastUser.text);
    run.push({ type: "start", thread: threadId, message: lastUser.id });
    return { threadId };
  }

  stop(userId: string, threadId: unknown): boolean {
    this.#user(userId);
    const run = typeof threadId === "string" ? this.#runs.get(this.#key(userId, threadId)) : undefined;
    if (!run || run.done) return false;
    run.abort.abort();
    return true;
  }

  /** Stops every running turn of a user (sign-out everywhere, disable, delete) and drops their runtime bots. Returns the turns stopped. */
  stopAllFor(userId: string): number {
    let n = 0;
    for (const run of this.#runs.values())
      if (run.userId === userId && !run.done) {
        run.abort.abort();
        n++;
      }
    this.registry.unregisterUser(userId);
    return n;
  }

  /** Stops every running turn of every user (kill switch, lockdown) (L3). Returns the turns stopped. */
  stopAll(): number {
    let n = 0;
    for (const run of this.#runs.values())
      if (!run.done) {
        run.abort.abort();
        n++;
      }
    for (const b of this.registry.all()) this.registry.unregister(b.runtimeId);
    return n;
  }

  #startRun(userId: string, botId: string, threadId: string, cfg: UserBotConfig, userText: string): TurnRun {
    const run = new TurnRun(userId, botId, threadId);
    this.#runs.set(this.#key(userId, threadId), run);
    void this.#execute(run, cfg, userText).finally(() => {
      run.done = true;
      const t = setTimeout(() => {
        if (this.#runs.get(this.#key(userId, threadId)) === run) this.#runs.delete(this.#key(userId, threadId));
      }, this.#d.keepRunMs ?? 120_000);
      t.unref?.();
    });
    return run;
  }

  async #execute(run: TurnRun, cfg: UserBotConfig, userText: string): Promise<void> {
    const tagline = cfg.tagline;
    const { userId, botId, threadId } = run;
    const threads = this.threads(userId);
    let caps: Caps;
    try {
      caps = this.#user(userId).caps;
    } catch {
      run.push({ type: "done", stopReason: "error", usage: { input: 0, output: 0 }, error: "Your account is not active." });
      return;
    }
    let text = "";
    const tools: ToolNote[] = [];
    let notice: string | undefined;
    let usage = { input: 0, output: 0 };
    let stopReason: "stop" | "aborted" | "error" = "stop";
    let error: string | undefined;
    let servedBy: string | undefined;
    let lease: Awaited<ReturnType<TurnScheduler["acquire"]>> | undefined;
    try {
      const waiting = setTimeout(() => run.push({ type: "queued" }), 400);
      try {
        lease = await this.#d.scheduler.acquire({ key: `user:${userId}`, cls: "web", signal: run.abort.signal });
      } finally {
        clearTimeout(waiting);
      }
      // M1/M2: the caps may have changed while the turn waited for the model slot: resolve the route again, with the caps of NOW
      caps = this.#user(userId).caps;
      const resolved = resolveTurnRoute(cfg, this.#routeContext(userId, botId, caps));
      if (!resolved.ok) {
        this.#auditDrops(userId, botId, resolved);
        throw new ChatError(403, resolved.message);
      }
      const bot = this.registry.registerUserBot(this.#d.dataDir, userId, botId, cfg, resolved);
      if (resolved.notice) {
        notice = resolved.notice;
        run.push({ type: "notice", text: resolved.notice });
      }
      const th = threads.get(botId, threadId);
      const msgs = th.messages.slice(0, -1).filter((m) => m.role === "user" || m.text !== "");
      const history: HistoryItem[] = [];
      let size = 0;
      for (const m of [...msgs].reverse()) {
        size += m.text.length;
        if (size > HISTORY_MAX_CHARS) break;
        history.unshift({ role: m.role, text: m.text });
      }
      // the last message of the thread is the user's text for this turn: the engine receives it separately
      const box = buildUserToolbox(bot, caps); // caps.tools: a tool taken away since the bot was saved does not exist (M1)
      const callTool = async (name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; question?: string }> => {
        run.push({ type: "tool", name, status: "running" });
        if (ASK_FIRST_TOOLS.includes(name) && box.names().includes(name)) {
          const summary = `${name}: ${String(args["path"] ?? "").slice(0, 120)}`;
          const ok = await this.approvals.request(userId, threadId, { tool: name, summary, why: "The bot wants to change a file in its own workspace." }, (card) => run.push({ type: "approval", card }), run.abort.signal);
          if (!ok) {
            tools.push({ name, status: "denied" });
            run.push({ type: "tool", name, status: "denied" });
            return { ok: false, text: "The user denied this action. Do not try again; tell the user it was not done." };
          }
        }
        const r = box.call(name, args);
        if (!r.ok && r.text.startsWith("no such tool")) this.#d.audit.write({ kind: "tool_denied", user: userId, detail: { tool: name.slice(0, 40), reason: "not in registry" } });
        tools.push({ name, status: r.ok ? "ok" : "error" });
        run.push({ type: "tool", name, status: r.ok ? "ok" : "error" });
        if (r.question) run.push({ type: "question", text: r.question });
        return r;
      };
      const result = await this.#d.engine.runTurn({
        bot,
        system: buildUserSystemPrompt(bot, tagline),
        history,
        userText,
        signal: run.abort.signal,
        tools: box.tools,
        allow: (presetId) => {
          try {
            return whyNot(presetId, this.#routeContext(userId, botId, this.#user(userId).caps)) === undefined;
          } catch {
            return false; // the account was disabled meanwhile
          }
        },
        budget: (presetId) => (this.isPaid(presetId) ? Math.max(0, this.paid.status(userId, botId, presetId).headroom) : undefined),
        emit: (ev) => {
          if (ev.type === "delta") {
            text += ev.text;
            run.push({ type: "delta", text: ev.text });
          } else {
            notice = ev.text;
            run.push({ type: "notice", text: ev.text });
          }
        },
        callTool,
      });
      stopReason = run.abort.signal.aborted ? "aborted" : result.stopReason;
      usage = result.usage;
      error = result.error;
      servedBy = result.servedBy;
    } catch (e) {
      if (e instanceof SchedulerAbortedError) stopReason = "aborted";
      else if (e instanceof ChatError) {
        stopReason = "error";
        error = e.message;
      }
      else if (e instanceof SchedulerBusyError) {
        stopReason = "error";
        error = "The model is busy right now. Try again in a minute.";
      } else {
        stopReason = run.abort.signal.aborted ? "aborted" : "error";
        error = "Something went wrong while answering.";
      }
    } finally {
      lease?.release();
    }
    const tokens = usage.input + usage.output || Math.ceil((userText.length + text.length) / 4);
    if (servedBy !== undefined && this.isPaid(servedBy)) {
      try {
        this.paid.record(userId, botId, servedBy, tokens); // M2: every paid turn is counted and audited
      } catch {
        /* the ledger write failed: the chat_turn audit line still has the tokens */
      }
    }
    try {
      const msg: Omit<ChatMessage, "id" | "at"> = { role: "assistant", text, ...(tools.length ? { tools } : {}), usage, ...(stopReason === "aborted" ? { stopped: true } : {}), ...(error ? { error } : {}), ...(notice ? { notice } : {}) };
      if (text !== "" || error || stopReason === "aborted") threads.append(botId, threadId, msg);
      this.quota(userId).record({ tokens });
    } catch {
      /* the thread may have been deleted while the bot was answering */
    }
    this.#d.audit.write({ kind: "chat_turn", user: userId, detail: { bot: botId, thread: threadId, stop: stopReason, in: usage.input, out: usage.output, ...Object.fromEntries(Object.entries(bodyDigest(userText)).map(([k, v]) => [`q_${k}`, v])), a_len: Buffer.byteLength(text) } });
    run.push({ type: "done", stopReason, usage, ...(error ? { error } : {}) });
  }

  /** Waits for a run to finish (tests). */
  async settle(userId: string, threadId: string, timeoutMs = 5000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = this.run(userId, threadId);
      if (!r || r.done) return;
      await sleep(5);
    }
  }
}

export { QuotaError, ThreadError, UserBotError };
export const newRunId = (): string => randomBytes(6).toString("hex");
