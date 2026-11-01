/**
 * Telegram bridge (S4): grammY long polling (no webhook, no inbound port), numeric-id allowlist first, durable
 * admission, streaming, delivery after restarts, commands, approval cards and the offline notice.
 *
 * Wiring order for the host (S6):
 *   1. `createTelegramBridge(...)`  -> `approvalTransport`, `notifier`, `chatLookup` are usable at once (the `a7`
 *      extension needs them before the Harness exists; `chatLookup` answers once `attach` has loaded the chat map).
 *   2. `Harness.open(...)`, `harness.resume()`, then `await bridge.attach(harness)`.
 *   3. `await bridge.start()` delivers pending answers, then starts the long poll.
 *   4. `await bridge.stop()` on shutdown.
 */
import { Bot, GrammyError } from "grammy";
import type { Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { ApprovalTransport, ChatLookup, KillSwitch, Logger, Notifier } from "../contracts.js";
import type { RunnerName } from "../config/schema.js";
import { errorFields } from "../logging/redact.js";
import type { Redactor } from "../logging/redact.js";
import { BACKGROUND_CONTEXT } from "../pi/adapter.js";
import type { Conversation, Harness, Submission } from "../pi/adapter.js";
import { TelegramApprovalTransport } from "./approvalUi.js";
import { createAllowlist } from "./allowlist.js";
import type { Allowlist } from "./allowlist.js";
import { sendableChunks } from "./chunk.js";
import { COMMAND_LIST, registerCommands, withTimeout } from "./commands.js";
import { ChatConversations } from "./conversations.js";
import { DeliveryManager, requestIdFor, withTelegramRetry } from "./delivery.js";
import type { RetryPolicy } from "./delivery.js";
import { OfflineNotifier } from "./offline.js";
import type { HealthLike } from "./offline.js";
import { StreamViews } from "./stream.js";

/**
 * A second poller on the same token (Telegram answers `getUpdates` with 409). Phase 4 (S20.2): the bot manager reports it as
 * "token in use elsewhere" and leaves the other bots running.
 */
export class TokenInUseError extends Error {
  constructor() {
    super("token in use elsewhere: another process is polling this bot token (Telegram error 409)");
    this.name = "TokenInUseError";
  }
}

/** True for the 409 conflict of a second poller (grammY rethrows it out of `bot.start()`). */
export function isTokenInUse(e: unknown): boolean {
  return e instanceof TokenInUseError || (e instanceof GrammyError && e.error_code === 409);
}

export interface PollingFailure {
  kind: "token_in_use" | "other";
  error: unknown;
}

export interface TelegramBridgeOptions {
  /** Bot token from the secrets file. Not needed when `bot` is injected (tests). */
  token?: string | undefined;
  /** Test seam: a Bot whose `api.config.use(...)` transformer is a fake Telegram API. */
  bot?: Bot | undefined;
  /** Test seam: skips the `getMe` call. */
  botInfo?: UserFromGetMe | undefined;
  allowedUserIds: readonly number[];
  logger: Logger;
  redact?: Redactor | undefined;
  runner: { name: RunnerName; modelId: string };
  /** The model new conversations are created with (`provider` is the runner name). */
  modelRef: { provider: string; modelId: string };
  health?: HealthLike | undefined;
  killSwitch: KillSwitch;
  /** The kill-switch flag file, named in the /killshell reply. */
  killFlagPath: string;
  /** `shell.enabled` from config. */
  shellEnabled: boolean;
  startedAt?: number | undefined;
  now?: (() => number) | undefined;
  /** Updates older than this are dropped (Telegram keeps them 24 h). Default 24 h. */
  maxUpdateAgeMs?: number | undefined;
  editIntervalMs?: number | undefined;
  retry?: RetryPolicy | undefined;
  redeliverDelayMs?: number | undefined;
  stopWaitMs?: number | undefined;
  allowlistLogIntervalMs?: number | undefined;
  /** Phase 4 (S20.2): called when the long poll ends with an error after it had started (a 409 is `token_in_use`). */
  onPollingFailed?: ((failure: PollingFailure) => void) | undefined;
}

/**
 * What Phase 2 and 3 add to the bridge without changing its Phase 1 behaviour: job card callbacks (`jb:`), settings cards and
 * the settings menu (`st:`, `se:`), personas (`pe:`), extra `/status` lines, extra commands, and the cancel of cards on
 * `/stop` and `/new`. `extend` may be called several times; all registrations must be made BEFORE `attach` when they carry
 * `registerCommands`. Callback routing is by prefix: `ap:` is the shell approval; an extension with `prefixes` gets the buttons
 * whose data starts with one of them; an extension without `prefixes` (the Phase 2 job UI) gets every other button; a button
 * nobody claims is ignored with a log line (`md:` is Phase 4's).
 */
export interface BridgeExtension {
  /** The callback-data prefixes this extension owns (for example `["st:", "se:"]`). */
  prefixes?: readonly string[] | undefined;
  /** Gets a callback button it owns. */
  callback?: ((ctx: Context) => Promise<void>) | undefined;
  /**
   * Runs before a message (or an injected job result) is submitted to the chat's conversation. A throw means the message is NOT
   * submitted (fail closed): the persona is applied here. It may return a one-time notice that is sent to the chat first.
   */
  beforeSubmit?: ((info: { conversation: Conversation; conversationId: string; chatId: number; /** True for a system-made message (a job result); absent or false for the user's own. */ injected?: boolean }) => Promise<{ notice?: string } | void>) | undefined;
  /**
   * Phase 4 (S26.1): runs once after the submit call returned (`submission` set) or threw (`error` set), for every extension whose
   * `beforeSubmit` ran. It lets a hook that started something in `beforeSubmit` (a gate priority hint) end it. Must not throw.
   */
  afterSubmit?: ((info: { conversationId: string; chatId: number; injected: boolean; submission?: Submission; error?: unknown }) => void) | undefined;
  /** Extra commands (registered after the built-in ones and before the unknown-command catch-all). */
  registerCommands?: ((bot: Bot) => void) | undefined;
  /** Shown in the Telegram command menu (`setMyCommands`) after the built-in commands. */
  commandList?: readonly { command: string; description: string }[] | undefined;
  statusLines?: (() => Promise<readonly string[]> | readonly string[]) | undefined;
  /** Cancels the job cards of a chat (`/stop`, `/new`). Returns how many. */
  cancelChat?: ((chatId: number) => number) | undefined;
  pendingCount?: ((chatId?: number) => number) | undefined;
}

export interface TelegramBridge {
  readonly bot: Bot;
  readonly allowlist: Allowlist;
  readonly approvalTransport: ApprovalTransport;
  readonly notifier: Notifier;
  readonly chatLookup: ChatLookup;
  /** Valid after `attach`. */
  readonly delivery: () => DeliveryManager | undefined;
  /** Phase 2 hooks (see `BridgeExtension`). */
  extend(ext: BridgeExtension): void;
  /**
   * Puts a system-made message into a chat's current conversation as if the user had written it, and delivers the model's answer
   * (used to hand a finished job's wrapped result back to the model). Idempotent on `requestId`: a repeat returns false.
   */
  injectInput(conversationId: string, text: string, requestId: string): Promise<boolean>;
  /** The chat's current conversation id, when it has one (valid after `attach`). */
  conversationOf(chatId: number): string | undefined;
  /** The chat's current conversation id; creates the conversation when the chat has none (valid after `attach`). */
  ensureConversation(chatId: number): Promise<string>;
  /** Opens the durable chat map and builds admission, delivery and streaming over `harness`. */
  attach(harness: Harness): Promise<void>;
  /** Delivers pending answers, then starts long polling. Resolves once polling runs. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

const DAY_MS = 24 * 3600 * 1000;
const BOT_COMMAND_AT_START = (ctx: Context): boolean => ctx.message?.entities?.some((e) => e.type === "bot_command" && e.offset === 0) ?? false;

export function createTelegramBridge(opts: TelegramBridgeOptions): TelegramBridge {
  const logger = opts.logger;
  const redact: Redactor = opts.redact ?? ((s) => s);
  const now = opts.now ?? Date.now;
  const startedAt = opts.startedAt ?? now();
  if (!opts.bot && !opts.token) throw new Error("telegram: a bot token is required");
  const bot = opts.bot ?? new Bot(opts.token as string, opts.botInfo ? { botInfo: opts.botInfo } : {});
  const api = bot.api;
  let lastError: string | undefined;
  const recordError = (e: unknown): void => {
    lastError = `${new Date(now()).toISOString()} ${errorFields(e, redact).error}`.slice(0, 300);
  };

  // 1. The allowlist is the FIRST middleware.
  const allowlist = createAllowlist(opts.allowedUserIds, logger, {
    now,
    ...(opts.allowlistLogIntervalMs !== undefined ? { logIntervalMs: opts.allowlistLogIntervalMs } : {}),
  });
  bot.use(allowlist.middleware);
  bot.catch((err) => {
    recordError(err.error);
    logger.error("telegram.handler_error", { updateId: err.ctx.update.update_id, ...errorFields(err.error, redact) });
  });

  // Approval cards exist before the Harness does.
  const approvals = new TelegramApprovalTransport({ api, allowedUserIds: opts.allowedUserIds, killSwitch: opts.killSwitch, logger, now });
  const bridgeExts: BridgeExtension[] = [];
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("ap:")) return approvals.handleCallback(ctx);
    const owner = bridgeExts.find((e) => e.callback && e.prefixes?.some((p) => data.startsWith(p)));
    if (owner?.callback) return owner.callback(ctx);
    const generic = bridgeExts.find((e) => e.callback && e.prefixes === undefined);
    if (generic?.callback) return generic.callback(ctx);
    logger.info("telegram.unknown_callback", { prefix: data.slice(0, 3) });
    await ctx.answerCallbackQuery().catch(() => undefined);
  });

  interface Attached {
    harness: Harness;
    conversations: ChatConversations;
    streams: StreamViews;
    delivery: DeliveryManager;
  }
  let attached: Attached | undefined;
  let offline: OfflineNotifier | undefined;
  let pollingDone: Promise<void> | undefined;
  let stopped = false;

  const chatLookup: ChatLookup = { chatForConversation: (id) => attached?.conversations.chatForConversation(id) };

  const notifier: Notifier = {
    async notify(conversationId, text) {
      const chatId = chatLookup.chatForConversation(conversationId);
      if (chatId === undefined) {
        logger.warn("telegram.notify_no_chat", { conversationId });
        return;
      }
      try {
        for (const chunk of sendableChunks(text)) {
          await withTelegramRetry(() => api.sendMessage(chatId, chunk, { link_preview_options: { is_disabled: true } }), opts.retry);
        }
      } catch (e) {
        recordError(e);
        logger.warn("telegram.notify_failed", { conversationId, ...errorFields(e, redact) });
      }
    },
  };

  const maxAge = opts.maxUpdateAgeMs ?? DAY_MS;

  /** Submits `text` to the chat's current conversation and registers its answer for delivery. False for a known requestId. */
  async function submitInput(a: Attached, chatId: number, text: string, requestId: string, injected = false): Promise<boolean> {
    if (await a.delivery.known(requestId)) return false; // Telegram redelivered an update we already admitted
    const conv = await a.conversations.current(chatId);
    const started: BridgeExtension[] = [];
    const finish = (extra: { submission?: Submission; error?: unknown }): void => {
      for (const e of started) {
        try {
          e.afterSubmit?.({ conversationId: String(conv.id), chatId, injected, ...extra });
        } catch {
          /* an observer never changes the submit */
        }
      }
    };
    let submission: Submission;
    try {
      for (const e of bridgeExts) {
        if (!e.beforeSubmit) continue;
        started.push(e);
        const r = await e.beforeSubmit({ conversation: conv, conversationId: String(conv.id), chatId, injected }); // a throw refuses the message
        if (r && r.notice) await api.sendMessage(chatId, r.notice, { link_preview_options: { is_disabled: true } }).catch(() => undefined);
      }
      await a.streams.watch(chatId, String(conv.id));
      submission = await conv.submit({ type: "input", content: text, whenBusy: "followUp", requestId }, BACKGROUND_CONTEXT);
    } catch (e) {
      finish({ error: e });
      throw e;
    }
    finish({ submission });
    await a.delivery.admit({ requestId, submissionId: String(submission.id), conversationId: String(conv.id), chatId });
    offline?.noteMessage(chatId);
    return true;
  }

  async function admit(ctx: Context, a: Attached, text: string): Promise<void> {
    const chatId = ctx.chat?.id;
    const messageId = ctx.message?.message_id;
    if (chatId === undefined || messageId === undefined) return;
    const requestId = requestIdFor(chatId, messageId);
    try {
      await submitInput(a, chatId, text, requestId);
    } catch (e) {
      recordError(e);
      logger.error("telegram.admission_failed", { chatId, ...errorFields(e, redact) });
      await ctx.reply("Sorry, I could not queue that message. Please send it again.").catch(() => undefined);
    }
  }

  return {
    bot,
    allowlist,
    approvalTransport: approvals,
    notifier,
    chatLookup,
    delivery: () => attached?.delivery,

    extend(ext: BridgeExtension): void {
      bridgeExts.push(ext);
    },

    conversationOf(chatId: number): string | undefined {
      return attached?.conversations.currentConversationId(chatId);
    },

    async ensureConversation(chatId: number): Promise<string> {
      const a = attached;
      if (!a) throw new Error("telegram bridge: call attach(harness) before ensureConversation()");
      return String((await a.conversations.current(chatId)).id);
    },

    async injectInput(conversationId: string, text: string, requestId: string): Promise<boolean> {
      const a = attached;
      if (!a) throw new Error("telegram bridge: call attach(harness) before injectInput()");
      const chatId = chatLookup.chatForConversation(conversationId);
      if (chatId === undefined) {
        logger.warn("telegram.inject_no_chat", { conversationId });
        return false;
      }
      return submitInput(a, chatId, text, requestId, true);
    },

    async attach(harness: Harness): Promise<void> {
      if (attached) throw new Error("telegram bridge is already attached");
      const conversations = new ChatConversations({ harness, modelRef: opts.modelRef, logger });
      await conversations.load();
      const streams = new StreamViews({ harness, api, logger, redact, editIntervalMs: opts.editIntervalMs, now });
      const delivery = new DeliveryManager({
        harness,
        api,
        claims: streams,
        logger,
        redact,
        retry: opts.retry,
        redeliverDelayMs: opts.redeliverDelayMs,
        now,
        onError: recordError,
      });
      attached = { harness, conversations, streams, delivery };
      const a = attached;
      if (opts.health) {
        offline = new OfflineNotifier({ api, health: opts.health, runner: opts.runner.name, inFlightChats: () => delivery.inFlightChats(), logger });
      }

      registerCommands(bot, {
        conversations: {
          async startNew(chatId) {
            const oldId = conversations.currentConversationId(chatId);
            await approvals.cancelChat(chatId, "stop");
            for (const e of bridgeExts) e.cancelChat?.(chatId);
            await withTimeout(conversations.abort(chatId), opts.stopWaitMs ?? 10_000);
            const conv = await conversations.startNew(chatId);
            if (oldId !== undefined) await streams.unwatch(oldId);
            await streams.watch(chatId, String(conv.id));
            return conv;
          },
          abort: (chatId) => conversations.abort(chatId),
        },
        approvals: {
          cancelChat: async (chatId, by) => (await approvals.cancelChat(chatId, by)) + bridgeExts.reduce((n, e) => n + (e.cancelChat?.(chatId) ?? 0), 0),
          cancelAll: (by) => approvals.cancelAll(by),
          pendingCount: (chatId) => approvals.pendingCount(chatId) + bridgeExts.reduce((n, e) => n + (e.pendingCount?.(chatId) ?? 0), 0),
        },
        extraStatus: async () => {
          const out: string[] = [];
          for (const e of bridgeExts) out.push(...((await e.statusLines?.()) ?? []));
          return out;
        },
        killSwitch: opts.killSwitch,
        killFlagPath: opts.killFlagPath,
        health: opts.health,
        runner: opts.runner,
        shellEnabled: opts.shellEnabled,
        delivery,
        startedAt,
        now,
        lastError: () => lastError,
        stopWaitMs: opts.stopWaitMs,
      });

      for (const e of bridgeExts) e.registerCommands?.(bot);

      bot.on("message:text", async (ctx) => {
        const date = ctx.message.date * 1000;
        if (now() - date > maxAge) {
          logger.info("telegram.stale_update_dropped", { updateId: ctx.update.update_id });
          return;
        }
        if (BOT_COMMAND_AT_START(ctx)) {
          await ctx.reply("Unknown command. Send /help for the list.");
          return;
        }
        await admit(ctx, a, ctx.message.text);
      });
      bot.on("message", async (ctx) => {
        await ctx.reply("Only text is supported for now.");
      });
    },

    async start(): Promise<void> {
      const a = attached;
      if (!a) throw new Error("telegram bridge: call attach(harness) before start()");
      stopped = false;
      const pending = await a.delivery.deliverPending();
      logger.info("telegram.pending_delivery", { pending });
      for (const chatId of a.conversations.chatIds()) {
        const id = a.conversations.currentConversationId(chatId);
        if (id !== undefined) void a.streams.watch(chatId, id);
      }
      await api.setMyCommands([...COMMAND_LIST, ...bridgeExts.flatMap((e) => e.commandList ?? [])].map((c) => ({ ...c }))).catch((e) => logger.warn("telegram.set_commands_failed", errorFields(e, redact)));
      await new Promise<void>((resolve, reject) => {
        let started = false;
        pollingDone = bot
          .start({
            allowed_updates: ["message", "callback_query"],
            onStart: () => {
              started = true;
              logger.info("telegram.polling_started");
              resolve();
            },
          })
          .catch((e: unknown) => {
            if (!started) reject(isTokenInUse(e) ? new TokenInUseError() : e);
            else if (!stopped) {
              recordError(e);
              const inUse = isTokenInUse(e);
              logger.error(inUse ? "telegram.token_in_use" : "telegram.polling_failed", errorFields(e, redact));
              try {
                opts.onPollingFailed?.({ kind: inUse ? "token_in_use" : "other", error: e });
              } catch {
                /* the manager's callback must never break the bridge */
              }
            }
          });
      });
    },

    async stop(): Promise<void> {
      stopped = true;
      try {
        await bot.stop();
      } catch {
        /* not running */
      }
      await pollingDone;
      if (attached) {
        attached.delivery.stop();
        await attached.streams.close();
      }
    },
  };
}
