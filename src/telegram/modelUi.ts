/**
 * Telegram model picker (S22.2, I38, U51, UI-20c): `/model`, its `md:` callbacks, and the admission hook that makes the chat's
 * conversation follow the bot's active preset before a message is submitted. One per bot; register it with
 * `rt.bridge.extend(ui.extension())` (after the persona extension).
 *
 *  - `/model` lists the bot's `route.allowed` presets as an inline picker (`md:s:<presetId>`), each marked with what a tap would do:
 *    "(current)", "(applies at once)" or "(asks you first)". `/model <id>` picks directly.
 *  - A tap or command by the allowlisted user goes through `ModelSwitcher.switchByUser`: cloud -> local, local -> local and the same
 *    vendor apply at once (audited); local -> cloud and cloud -> another vendor produce ONE approval card and apply only after
 *    Approve. Nothing here can change `presets`, `route` or `fallback`: those are edited only in the settings UI.
 *  - A callback from anyone else, from a group chat, with malformed data or naming a preset that is not (or no longer) allowed is
 *    ignored (answered without any change). The callback data is at most `md:s:` plus a 24-character id (under 64 bytes).
 *  - `beforeSubmit` runs `ModelSwitcher.ensureApplied` for every admitted message; if it throws the message is NOT submitted (fail
 *    closed, like the persona hook).
 */
import type { Api, Bot, Context } from "grammy";
import type { Logger } from "../contracts.js";
import type { PresetConfig, ResolvedBot } from "../bots/schema.js";
import type { FallbackEngine } from "../models/fallback.js";
import { findPreset } from "../models/presets.js";
import { pickerEntries } from "../models/routes.js";
import type { Verdict } from "../models/routes.js";
import type { ModelSwitcher } from "../models/switch.js";
import type { Conversation } from "../pi/adapter.js";
import { SettingsError } from "../settings/contracts.js";
import type { BridgeExtension } from "./bot.js";

export type ModelApi = Pick<Api, "sendMessage" | "editMessageText" | "answerCallbackQuery">;

export interface ModelUiDeps {
  api: ModelApi;
  allowedUserIds: readonly number[];
  logger: Logger;
  switcher: ModelSwitcher;
  bot: Pick<ResolvedBot, "id" | "route">;
  presets: readonly PresetConfig[];
  /** The chat's conversation (created when the chat has none yet). */
  ensureConversation: (chatId: number) => Promise<string>;
  /** The live conversation, so a switch can follow at once. Absent: it follows on the next message. */
  conversation?: ((conversationId: string) => Promise<Conversation | undefined>) | undefined;
  /** For the `/status` lines (the "needs login" flag). */
  fallback?: FallbackEngine | undefined;
}

export const MODEL_COMMANDS: readonly { command: string; description: string }[] = [{ command: "model", description: "Show or switch the model this bot uses" }];
const ID_RE = /^[a-z][a-z0-9-]{0,23}$/;
const DATA_RE = /^md:s:([a-z][a-z0-9-]{0,23})$/;

const label = (v: Verdict): string => (v === "same" ? "(current)" : v === "auto" ? "(applies at once)" : v === "card" ? "(asks you first)" : "");

export class TelegramModelUi {
  readonly #d: ModelUiDeps;

  constructor(deps: ModelUiDeps) {
    this.#d = deps;
  }

  /** The picker text and keyboard. The "current" mark follows the preset the bot actually answers with (a fallback included). */
  picker(): { text: string; keyboard: { text: string; callback_data: string }[][] } {
    const sw = this.#d.switcher;
    const now = sw.effective();
    const entries = pickerEntries(this.#d.bot, this.#d.presets, now.id);
    const lines = [`Model now: ${now.label}${sw.fallbackActive ? ` (a fallback: ${sw.fallbackActive.reason})` : ""}`, ""];
    const keyboard: { text: string; callback_data: string }[][] = [];
    for (const e of entries) {
      const where = e.preset.privacy === "cloud" ? `cloud, ${e.vendor.replace("acp:", "")}` : "on this PC";
      lines.push(`- ${e.preset.label} [${where}] ${label(e.verdict)}`.trim());
      keyboard.push([{ text: `${e.preset.label} ${label(e.verdict)}`.trim(), callback_data: `md:s:${e.preset.id}` }]);
    }
    keyboard.push([{ text: "Close", callback_data: "md:x" }]);
    lines.push("", "Tap one to switch. Going to a cloud model asks you to approve first; going back to a local one applies at once. It applies from your next message.");
    return { text: lines.join("\n"), keyboard };
  }

  async #follow(conversationId: string): Promise<Conversation | undefined> {
    return this.#d.conversation ? await this.#d.conversation(conversationId).catch(() => undefined) : undefined;
  }

  async #switch(presetId: string, userId: number, chatId: number): Promise<string> {
    const conversationId = await this.#d.ensureConversation(chatId);
    const conversation = await this.#follow(conversationId);
    const out = await this.#d.switcher.switchByUser({ presetId, userId, chatId, conversationId, ...(conversation ? { conversation } : {}) });
    return out.text;
  }

  async #command(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (chatId === undefined || userId === undefined || !this.#d.allowedUserIds.includes(userId)) return;
    const arg = (typeof ctx.match === "string" ? ctx.match : "").trim();
    if (arg === "") {
      const m = this.picker();
      await this.#d.api.sendMessage(chatId, m.text, { reply_markup: { inline_keyboard: m.keyboard } });
      return;
    }
    if (!ID_RE.test(arg)) {
      await ctx.reply("Use /model to pick from the list, or /model <id>.");
      return;
    }
    try {
      await ctx.reply(await this.#switch(arg, userId, chatId));
    } catch (e) {
      await ctx.reply(e instanceof SettingsError ? e.message : "Could not switch the model.");
    }
  }

  async handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const answer = (text?: string, alert = false): Promise<unknown> => ctx.answerCallbackQuery(text ? { text: text.slice(0, 190), show_alert: alert } : {}).catch(() => undefined);
    if (userId === undefined || chatId === undefined || !this.#d.allowedUserIds.includes(userId) || chatId !== userId) {
      this.#d.logger.warn("telegram.model_callback_ignored", {});
      return void (await answer());
    }
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (data === "md:x") {
      if (messageId !== undefined) await this.#d.api.editMessageText(chatId, messageId, "Model picker closed.", { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      return void (await answer());
    }
    const m = DATA_RE.exec(data);
    if (!m) return void (await answer());
    const id = m[1] as string;
    // a button of an old picker for a preset that is gone or not allowed any more: nothing happens
    if (!this.#d.bot.route.allowed.includes(id) || !findPreset(this.#d.presets, id)) return void (await answer("That model is not available any more.", true));
    try {
      const text = await this.#switch(id, userId, chatId);
      if (messageId !== undefined) {
        const p = this.picker();
        await this.#d.api.editMessageText(chatId, messageId, `${text}\n\n${p.text}`, { reply_markup: { inline_keyboard: p.keyboard } }).catch(() => undefined);
      }
      await answer(text);
    } catch (e) {
      await answer(e instanceof SettingsError ? e.message : "Could not switch the model.", true);
    }
  }

  statusLines(): string[] {
    const sw = this.#d.switcher;
    const now = sw.effective();
    const out = [`model: ${now.label}${sw.fallbackActive ? ` (fallback: ${sw.fallbackActive.reason})` : ""}`];
    const login = this.#d.fallback?.needsLogin() ?? [];
    if (login.length > 0) out.push(`needs login: ${login.join(", ")}`);
    return out;
  }

  extension(): BridgeExtension {
    return {
      prefixes: ["md:"],
      callback: (ctx) => this.handleCallback(ctx),
      commandList: MODEL_COMMANDS,
      registerCommands: (bot: Bot) => {
        bot.command("model", (ctx) => this.#command(ctx));
      },
      statusLines: () => this.statusLines(),
      beforeSubmit: async ({ conversation, conversationId, chatId }) => {
        const r = await this.#d.switcher.ensureApplied(conversationId, conversation);
        if (r.notice) await this.#d.api.sendMessage(chatId, r.notice).catch(() => undefined);
      },
    };
  }
}
