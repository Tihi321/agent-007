/**
 * Telegram personas (S19.3, S19.2, I26a, UI-20d): `/persona`, its `pe:` callbacks, and the admission hook that applies the chat's
 * persona before a message is submitted.
 *
 *  - `/persona` shows the valid personas labelled "(narrower)", "(equal)", "(broader)" or "(different)" relative to the current one,
 *    and the invalid ones with their reason, as an inline picker (`pe:s:<id>`). `/persona <id>` selects directly. `/persona delete <id>`
 *    removes a MODEL-authored persona (audited); a user-authored or built-in one is refused. A tap or command of the allowlisted user
 *    applies at once, even to a broader persona (their own authority), audited `source: "telegram"`.
 *  - `beforeSubmit` runs `PersonaApplier.ensureApplied` for every admitted message and every injected job result; if it throws, the
 *    message is NOT submitted (fail closed). The one-time fail-closed notice ("persona X is not usable, running read-only") is sent here.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Api, Bot, Context } from "grammy";
import type { Logger } from "../contracts.js";
import type { PersonaApplier } from "../personas/apply.js";
import type { PersonaResolver } from "../personas/resolver.js";
import { relationLabel, switchByUser, compareWithCurrent } from "../personas/switch.js";
import type { PersonaStore } from "../personas/store.js";
import { sha256Text } from "../settings/chain.js";
import type { Ceiling } from "../settings/ceiling.js";
import { SettingsError } from "../settings/contracts.js";
import type { SettingsAudit } from "../settings/contracts.js";
import type { BridgeExtension } from "./bot.js";

export type PersonaApi = Pick<Api, "sendMessage" | "editMessageText" | "answerCallbackQuery">;

export interface PersonaUiDeps {
  api: PersonaApi;
  allowedUserIds: readonly number[];
  logger: Logger;
  resolver: PersonaResolver;
  applier: PersonaApplier;
  audit: SettingsAudit;
  store: PersonaStore;
  ceiling: () => Ceiling;
  /** The chat's conversation (created when the chat has none yet). */
  ensureConversation: (chatId: number) => Promise<string>;
}

export const PERSONA_COMMANDS: readonly { command: string; description: string }[] = [{ command: "persona", description: "Show or switch the persona (a mode with fewer tools)" }];
const ID_RE = /^[a-z][a-z0-9-]{1,23}$/;

export class TelegramPersonaUi {
  readonly #d: PersonaUiDeps;

  constructor(deps: PersonaUiDeps) {
    this.#d = deps;
  }

  #picker(conversationId: string): { text: string; keyboard: { text: string; callback_data: string }[][] } {
    const current = this.#d.resolver.current(conversationId);
    const resolved = this.#d.resolver.resolve(conversationId);
    const lines = [`Persona now: ${current}${resolved.fallback ? ` (not usable; running ${resolved.personaId})` : ""}`, ""];
    const keyboard: { text: string; callback_data: string }[][] = [];
    for (const p of this.#d.resolver.list()) {
      if (p.valid) {
        const cmp = p.id === current ? undefined : compareWithCurrent(this.#d.resolver, conversationId, p.id);
        const label = p.id === current ? "(current)" : cmp ? relationLabel(cmp.relation) : "";
        lines.push(`- ${p.id} ${label}: ${p.description || p.name}`.trim());
        keyboard.push([{ text: `${p.name} ${label}`.trim(), callback_data: `pe:s:${p.id}` }]);
      } else lines.push(`- ${p.id}: not usable (${p.reasons.slice(0, 2).join("; ")})`);
    }
    keyboard.push([{ text: "Close", callback_data: "pe:x" }]);
    lines.push("", "Tap one to switch. This is your own choice, so it applies at once.");
    return { text: lines.join("\n"), keyboard };
  }

  async #command(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (chatId === undefined || userId === undefined || !this.#d.allowedUserIds.includes(userId)) return;
    const arg = (typeof ctx.match === "string" ? ctx.match : "").trim();
    const conv = await this.#d.ensureConversation(chatId);
    if (arg === "") {
      const m = this.#picker(conv);
      await this.#d.api.sendMessage(chatId, m.text, { reply_markup: { inline_keyboard: m.keyboard } });
      return;
    }
    const del = /^delete\s+(\S+)$/i.exec(arg);
    if (del) {
      await ctx.reply(await this.#delete(del[1] as string, userId, conv));
      return;
    }
    if (!ID_RE.test(arg)) {
      await ctx.reply("Use /persona to pick from the list, /persona <id> to switch, or /persona delete <id> for a persona the assistant drafted.");
      return;
    }
    try {
      await ctx.reply((await switchByUser({ runtime: this.#d.resolver, audit: this.#d.audit, conversationId: conv, userId, personaId: arg })).text);
    } catch (e) {
      await ctx.reply(e instanceof SettingsError ? e.message : "Could not switch the persona.");
    }
  }

  async #delete(id: string, userId: number, conversationId: string): Promise<string> {
    if (!ID_RE.test(id)) return "That is not a persona id.";
    if (id === "default" || id === "readonly") return `${id} is built in and cannot be deleted.`;
    if (this.#d.store.isUserAuthored(id)) return `${id} was written by you in the settings UI. Delete it there.`;
    const f = this.#d.store.files().find((x) => x.source === "model" && x.id === id);
    if (!f) return `There is no model-drafted persona called ${id}.`;
    const file = join(this.#d.store.modelDir, `${id}.json`);
    try {
      this.#d.audit.append({
        source: "telegram",
        kind: "persona",
        persona: id,
        conversationId,
        target: { file: `prefs/personas/${id}.json`, path: "(document)" },
        diff: [{ path: "(persona)", op: "remove", before: id }],
        decision: "applied",
        approver: { kind: "tg", userId },
        baseRevision: f.revision,
        afterRevision: sha256Text(""),
      });
    } catch {
      return "The audit log could not be written, so nothing was deleted.";
    }
    rmSync(file, { force: true });
    await this.#d.resolver.forget(id);
    return `Deleted the persona ${id}.`;
  }

  async handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const answer = (text?: string, alert = false): Promise<unknown> => ctx.answerCallbackQuery(text ? { text: text.slice(0, 190), show_alert: alert } : {}).catch(() => undefined);
    if (userId === undefined || chatId === undefined || !this.#d.allowedUserIds.includes(userId) || chatId !== userId) {
      this.#d.logger.warn("telegram.persona_callback_ignored", {});
      return void (await answer());
    }
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (data === "pe:x") {
      if (messageId !== undefined) await this.#d.api.editMessageText(chatId, messageId, "Persona picker closed.", { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      return void (await answer());
    }
    const m = /^pe:s:([a-z][a-z0-9-]{1,23})$/.exec(data);
    if (!m) return void (await answer());
    try {
      const conv = await this.#d.ensureConversation(chatId);
      const r = await switchByUser({ runtime: this.#d.resolver, audit: this.#d.audit, conversationId: conv, userId, personaId: m[1] as string });
      if (messageId !== undefined) {
        const p = this.#picker(conv);
        await this.#d.api.editMessageText(chatId, messageId, `${r.text}\n\n${p.text}`, { reply_markup: { inline_keyboard: p.keyboard } }).catch(() => undefined);
      }
      await answer(r.text);
    } catch (e) {
      await answer(e instanceof SettingsError ? e.message : "Could not switch the persona.", true);
    }
  }

  extension(): BridgeExtension {
    return {
      prefixes: ["pe:"],
      callback: (ctx) => this.handleCallback(ctx),
      commandList: PERSONA_COMMANDS,
      registerCommands: (bot: Bot) => {
        bot.command("persona", (ctx) => this.#command(ctx));
      },
      beforeSubmit: async ({ conversation, conversationId, chatId }) => {
        const r = await this.#d.applier.ensureApplied(conversationId, conversation);
        if (r.notice) await this.#d.api.sendMessage(chatId, r.notice).catch(() => undefined);
      },
    };
  }
}
