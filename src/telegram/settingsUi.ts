/**
 * Telegram settings (S18.4, I26, I26a, I27a, UI-12): the Telegram side of the proposal flow, and `/settings`, `/proposals`,
 * `/applysettings`.
 *
 *  - **Cards.** `TelegramSettingsUi` implements `ProposalTransport`. A card is plain text (no parse mode): "Settings change
 *    requested by the model", the path and class, `now -> proposed`, the model's reason as a quoted, truncated, UNTRUSTED line,
 *    "Expires hh:mm", and Approve / Reject (`st:<id>:y|n`; persona drafts also Edit, `st:<id>:e`). A callback counts only if its
 *    sender is allowlisted AND the tap comes from that user's own private chat; after a decision, a timeout or a restart-time
 *    expiry the message is edited to the outcome and the buttons removed. The id is persisted with the proposal, so a button
 *    still works after a restart, and a stale one answers "expired".
 *  - **`/settings`** is the user's OWN authority (I26a): inline keyboards for the rows with `telegram: true` (tone, verbosity,
 *    language, default persona), fixed choices only, applied at once and audited `source: "telegram"`. Security settings are not
 *    buttons: the screen says to use the local settings UI. A test enumerates every callback code.
 *  - **`/proposals`** lists pending proposals with Cancel. **`/applysettings`** validates the new `security.json`, refuses if it is
 *    invalid, else asks ONCE to confirm and exits the agent gracefully with code 4 so Task Scheduler restarts it. There is no
 *    command that edits a security setting or re-enables shell.
 */
import type { Api, Bot, Context } from "grammy";
import type { Logger, PeerProvenance } from "../contracts.js";
import type { AllowRow } from "../settings/allowlist.js";
import { telegramRows } from "../settings/allowlist.js";
import type { CardLocator, ProposalCard, ProposalTransport } from "../settings/contracts.js";
import type { DecideResult, ProposalEngine } from "../settings/proposals.js";
import { formatClock, provenanceLines } from "./approvalUi.js";
import { chunkText } from "./chunk.js";
import type { BridgeExtension } from "./bot.js";

export type SettingsApi = Pick<Api, "sendMessage" | "editMessageText" | "answerCallbackQuery">;

export interface SettingsUiOptions {
  api: SettingsApi;
  allowedUserIds: readonly number[];
  logger: Logger;
  /** Phase 4 (S26.2): peer replies the chat's current turn received; a proposal card quotes them. */
  provenanceForChat?: ((chatId: number) => readonly PeerProvenance[] | undefined) | undefined;
}

/** What `/settings`, `/proposals` and `/applysettings` need from the host (bound after the engine exists). */
export interface SettingsUiBinding {
  engine: ProposalEngine;
  rows?: readonly AllowRow[];
  /** The current value of a preference path, for the menu. */
  valueOf(path: string): string;
  /** Valid persona ids (the choices of `defaultPersona`). */
  personaIds(): string[];
  /** One status line (running and file revision). */
  statusLine(): string;
  /** Is the `security.json` on disk valid? Used by `/applysettings`. `null`: this install is not migrated. */
  validateSecurity(): { ok: boolean; problems: string[] } | null;
  /** Exits the agent gracefully with this code. */
  requestRestart(code: number): void;
  conversationOf?: ((chatId: number) => string | undefined) | undefined;
  /** Puts a system-made message into a conversation (an Edit on a persona draft tells the model the user wants changes). */
  injectMessage?: ((conversationId: string, text: string, requestId: string) => Promise<unknown>) | undefined;
}

const MAX_REASON_CHARS = 200;
const CARD_RE = /^st:([A-Za-z0-9]{8}):(y|n|e|c)$/;
const SETTINGS_PREFIXES = ["st:", "se:"] as const;
export const SETTINGS_COMMANDS: readonly { command: string; description: string }[] = [
  { command: "settings", description: "Change tone, verbosity, language or the default persona" },
  { command: "proposals", description: "Pending settings proposals from the model" },
  { command: "applysettings", description: "Restart the agent to use new security settings" },
];

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** One line of untrusted text for a card: control characters out, whitespace collapsed, truncated. */
export function quotedReason(reason: string): string {
  // eslint-disable-next-line no-control-regex
  const one = reason.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return one === "" ? "(none given)" : `"${clip(one, MAX_REASON_CHARS)}"`;
}

export function cardHead(card: Pick<ProposalCard, "title" | "lines">): string {
  return [card.title, "", ...card.lines].join("\n");
}

export function cardText(card: ProposalCard, provenance?: readonly PeerProvenance[]): string {
  const peer = provenanceLines(provenance);
  return [cardHead(card), ...(peer.length > 0 ? ["", ...peer] : []), "", `Reason (written by the model, not checked): ${quotedReason(card.reason)}`, `Expires: ${formatClock(card.deadline)}`].join("\n");
}

export function cardKeyboard(card: ProposalCard): { text: string; callback_data: string }[][] {
  const row: { text: string; callback_data: string }[] = [];
  for (const b of card.buttons) {
    if (b === "approve") row.push({ text: "Approve", callback_data: `st:${card.proposalId}:y` });
    if (b === "reject") row.push({ text: "Reject", callback_data: `st:${card.proposalId}:n` });
    if (b === "edit") row.push({ text: "Edit", callback_data: `st:${card.proposalId}:e` });
  }
  return [row];
}

type Decider = (d: { proposalId: string; decision: "approve" | "reject" | "edit"; userId: number; chatId: number; messageId?: number }) => unknown;

export class TelegramSettingsUi implements ProposalTransport {
  readonly #o: SettingsUiOptions;
  #decider: Decider | undefined;
  #bound: SettingsUiBinding | undefined;
  /** Cards whose full text (a long persona prompt) was not shown yet: Approve is refused until it was. */
  readonly #unshown = new Set<string>();
  readonly #cards = new Map<string, { chatId: number; messageId: number; head: string }>();

  constructor(opts: SettingsUiOptions) {
    this.#o = opts;
  }

  bind(b: SettingsUiBinding): void {
    this.#bound = b;
  }

  // ---- ProposalTransport ----------------------------------------------------------------------------------------

  onDecision(cb: Decider): void {
    this.#decider = cb;
  }

  async present(card: ProposalCard): Promise<{ messageId: number }> {
    const api = this.#o.api;
    if (card.preface !== undefined && card.preface.trim() !== "") {
      this.#unshown.add(card.proposalId);
      const parts = chunkText(card.preface, 3800).filter((c) => c.trim() !== "");
      for (let i = 0; i < parts.length; i++) {
        await api.sendMessage(card.chatId, `Full text for proposal ${card.proposalId} (part ${i + 1} of ${parts.length}):\n${parts[i]}`, { link_preview_options: { is_disabled: true } });
      }
      this.#unshown.delete(card.proposalId);
    }
    const sent = await api.sendMessage(card.chatId, cardText(card, this.#o.provenanceForChat?.(card.chatId)), { link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: cardKeyboard(card) } });
    this.#cards.set(card.proposalId, { chatId: card.chatId, messageId: sent.message_id, head: cardHead(card) });
    return { messageId: sent.message_id };
  }

  async update(proposalId: string, outcomeText: string, loc?: CardLocator): Promise<void> {
    const known = this.#cards.get(proposalId);
    const chatId = loc?.chatId ?? known?.chatId;
    const messageId = loc?.messageId ?? known?.messageId;
    const head = loc?.head ?? known?.head ?? "Settings proposal";
    if (chatId === undefined || messageId === undefined || messageId === null) return;
    this.#cards.delete(proposalId);
    this.#unshown.delete(proposalId);
    try {
      await this.#o.api.editMessageText(chatId, messageId, clip(`${head}\n\n${outcomeText}`, 4000), { reply_markup: { inline_keyboard: [] } });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!/not modified/i.test(msg)) this.#o.logger.warn("telegram.settings_card_edit_failed", { error: msg.slice(0, 200) });
    }
  }

  // ---- callbacks ------------------------------------------------------------------------------------------------

  #allowed(ctx: Context): number | undefined {
    const from = ctx.from?.id;
    if (from === undefined || !this.#o.allowedUserIds.includes(from)) return undefined;
    if (ctx.chat?.id !== from) return undefined; // the tap must come from that user's own private chat
    return from;
  }

  async handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const userId = this.#allowed(ctx);
    if (userId === undefined) {
      this.#o.logger.warn("telegram.settings_callback_ignored", { reason: "not the allowlisted user's own chat" });
      await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }
    const chatId = ctx.chat?.id as number;
    const answer = (text?: string, alert = false): Promise<unknown> => ctx.answerCallbackQuery(text ? { text: clip(text, 190), show_alert: alert } : {}).catch(() => undefined);

    if (data.startsWith("st:")) {
      const m = CARD_RE.exec(data);
      if (!m) return void (await answer());
      const id = m[1] as string;
      const act = m[2] as string;
      if (act === "c") {
        const ok = await this.#bound?.engine.cancel(id, userId, chatId);
        return void (await answer(ok ? "Cancelled." : "That proposal is no longer pending."));
      }
      if ((act === "y" || act === "e") && this.#unshown.has(id)) return void (await answer("Read the full text above first; it is still being sent.", true));
      if (!this.#decider) return void (await answer("Not available right now."));
      const messageId = ctx.callbackQuery?.message?.message_id;
      const result = (await this.#decider({ proposalId: id, decision: act === "y" ? "approve" : act === "n" ? "reject" : "edit", userId, chatId, ...(messageId !== undefined ? { messageId } : {}) })) as DecideResult | undefined;
      if (result?.result === "edit") {
        await this.#bound?.injectMessage?.(result.conversationId, result.text, `persona-edit:${id}`).catch((e: unknown) => this.#o.logger.warn("telegram.settings_inject_failed", { error: String((e as Error)?.message ?? e).slice(0, 200) }));
      }
      return void (await answer(describeResult(result)));
    }
    if (data.startsWith("se:")) return this.#settingsCallback(ctx, data.slice(3), userId, chatId, answer);
    await answer();
  }

  // ---- /settings -------------------------------------------------------------------------------------------------

  #rows(): AllowRow[] {
    return telegramRows(this.#bound?.rows ?? this.#bound?.engine.rows ?? []);
  }

  choicesOf(row: AllowRow): string[] {
    if (row.choices === "personas") return this.#bound?.personaIds() ?? [];
    return [...(row.choices ?? [])];
  }

  menu(): { text: string; keyboard: { text: string; callback_data: string }[][] } {
    const b = this.#bound;
    const rows = this.#rows();
    const lines = ["Settings", "", ...rows.map((r) => `${r.label}: ${b?.valueOf(r.path) ?? "?"}`), "", "Security settings (allowed folders, users, shell, models) are changed only in the local settings UI on the PC, never here.", b?.statusLine() ?? ""].filter((l, i, a) => !(l === "" && a[i - 1] === ""));
    const buttons = rows.map((r, i) => ({ text: `${r.label}: ${b?.valueOf(r.path) ?? "?"}`, callback_data: `se:r${i}` }));
    const keyboard: { text: string; callback_data: string }[][] = [];
    for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
    keyboard.push([{ text: "Close", callback_data: "se:x" }]);
    return { text: lines.join("\n"), keyboard };
  }

  /** Every callback code reachable from `/settings` (a test enumerates them: each maps to a row with `telegram: true`). */
  reachableCallbacks(): { code: string; path?: string }[] {
    const out: { code: string; path?: string }[] = [{ code: "se:m" }, { code: "se:x" }];
    this.#rows().forEach((r, i) => {
      out.push({ code: `se:r${i}`, path: r.path });
      for (const c of this.choicesOf(r)) out.push({ code: `se:v${i}:${c}`, path: r.path });
    });
    return out;
  }

  async openMenu(chatId: number): Promise<void> {
    const m = this.menu();
    await this.#o.api.sendMessage(chatId, m.text, { reply_markup: { inline_keyboard: m.keyboard } });
  }

  async #settingsCallback(ctx: Context, code: string, userId: number, chatId: number, answer: (t?: string, alert?: boolean) => Promise<unknown>): Promise<void> {
    const b = this.#bound;
    const messageId = ctx.callbackQuery?.message?.message_id;
    const edit = async (text: string, keyboard: { text: string; callback_data: string }[][]): Promise<void> => {
      if (messageId === undefined) return;
      await this.#o.api.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: keyboard } }).catch((e) => {
        if (!/not modified/i.test(String((e as Error)?.message ?? e))) this.#o.logger.warn("telegram.settings_edit_failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
      });
    };
    if (!b) return void (await answer("Not available right now."));
    if (code === "x") {
      await this.#o.api.editMessageText(chatId, messageId ?? 0, "Settings closed.", { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      return void (await answer());
    }
    if (code === "m") {
      const m = this.menu();
      await edit(m.text, m.keyboard);
      return void (await answer());
    }
    if (code === "ay" || code === "an") return this.#applyConfirm(code === "ay", chatId, messageId, answer);
    let m = /^r(\d{1,2})$/.exec(code);
    if (m) {
      const row = this.#rows()[Number(m[1])];
      if (!row) return void (await answer("That setting is not available."));
      const current = b.valueOf(row.path);
      const kb = this.choicesOf(row).map((c) => [{ text: c === current ? `${c} (current)` : c, callback_data: `se:v${m?.[1]}:${c}` }]);
      kb.push([{ text: "Back", callback_data: "se:m" }]);
      await edit(`${row.label}: choose a value (now ${current})`, kb);
      return void (await answer());
    }
    m = /^v(\d{1,2}):([A-Za-z0-9-]{1,24})$/.exec(code);
    if (m) {
      const row = this.#rows()[Number(m[1])];
      if (!row) return void (await answer("That setting is not available."));
      const value = m[2] as string;
      if (!this.choicesOf(row).includes(value)) return void (await answer("That choice is not available.", true));
      try {
        const conv = b.conversationOf?.(chatId);
        const msg = await b.engine.applyDirect(row.path, value, { userId, chatId, ...(conv ? { conversationId: conv } : {}) });
        const menu = this.menu();
        await edit(`${msg}\n\n${menu.text}`, menu.keyboard);
        return void (await answer(msg));
      } catch (e) {
        return void (await answer(String((e as Error)?.message ?? "Could not change that setting."), true));
      }
    }
    await answer();
  }

  async #applyConfirm(yes: boolean, chatId: number, messageId: number | undefined, answer: (t?: string, alert?: boolean) => Promise<unknown>): Promise<void> {
    const b = this.#bound as SettingsUiBinding;
    if (!yes) {
      if (messageId !== undefined) await this.#o.api.editMessageText(chatId, messageId, "Restart cancelled.", { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      return void (await answer("Cancelled."));
    }
    const v = b.validateSecurity();
    if (!v || !v.ok) {
      if (messageId !== undefined) await this.#o.api.editMessageText(chatId, messageId, `Not restarting: the security settings file is not valid.\n${(v?.problems ?? ["not migrated"]).slice(0, 5).join("\n")}`, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      return void (await answer("The settings file is not valid.", true));
    }
    if (messageId !== undefined) await this.#o.api.editMessageText(chatId, messageId, "Restarting the agent now. Task Scheduler brings it back within a few minutes; I answer again after that.", { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    await answer("Restarting.");
    b.requestRestart(4);
  }

  // ---- bridge extension ------------------------------------------------------------------------------------------

  extension(): BridgeExtension {
    return {
      prefixes: SETTINGS_PREFIXES,
      callback: (ctx) => this.handleCallback(ctx),
      commandList: SETTINGS_COMMANDS,
      registerCommands: (bot: Bot) => {
        bot.command("settings", async (ctx) => {
          if (ctx.chat?.id === undefined) return;
          await this.openMenu(ctx.chat.id);
        });
        bot.command("proposals", async (ctx) => {
          const chatId = ctx.chat?.id;
          const b = this.#bound;
          if (chatId === undefined || !b) return;
          const pending = await b.engine.pending(chatId);
          if (pending.length === 0) {
            await ctx.reply("No settings proposals are waiting.");
            return;
          }
          for (const p of pending) {
            await this.#o.api.sendMessage(chatId, `${p.title}\n${p.lines.join("\n")}\nExpires: ${formatClock(p.deadline)}`, {
              reply_markup: { inline_keyboard: [[{ text: "Cancel this proposal", callback_data: `st:${p.id}:c` }]] },
            });
          }
        });
        bot.command("applysettings", async (ctx) => {
          const chatId = ctx.chat?.id;
          const b = this.#bound;
          if (chatId === undefined || !b) return;
          const v = b.validateSecurity();
          if (v === null) {
            await ctx.reply("This install has not been migrated (there is no security.json), so there is nothing to apply.");
            return;
          }
          if (!v.ok) {
            await ctx.reply(`The security settings file is not valid, so I did not restart.\n${v.problems.slice(0, 5).join("\n")}`);
            return;
          }
          await this.#o.api.sendMessage(chatId, `${b.statusLine()}\n\nRestart the agent now to use the new security settings? Pending approvals are cancelled and I am offline for a minute or two.`, {
            reply_markup: { inline_keyboard: [[{ text: "Restart now", callback_data: "se:ay" }, { text: "Cancel", callback_data: "se:an" }]] },
          });
        });
      },
    };
  }
}

function describeResult(r: DecideResult | undefined): string {
  if (!r) return "Done.";
  switch (r.result) {
    case "approved":
      return "Approved.";
    case "rejected":
      return "Rejected.";
    case "expired":
      return "Expired. Nothing was changed.";
    case "stale":
      return "Stale: the setting changed. Nothing was changed.";
    case "edit":
      return "Okay. Tell the assistant what to change.";
    case "failed":
      return `Could not apply: ${r.text}`;
    case "ignored":
      return r.reason === "not_pending" || r.reason === "unknown_proposal" ? "Expired. That card is no longer active." : "Ignored.";
  }
}
