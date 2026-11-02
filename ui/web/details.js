// The details pane of a bot (WR4): who the bot is, today's usage, this bot's chats (each with a More menu: pin, rename, export, delete) and its starters.
// Content for the shell's `aside.details` (the aside carries the "Bot details" label). `refresh()` reloads usage and chats; `setThread(id)` marks the open chat.
import { avatarEl, badgeEl, paidLines } from "./bots.js";
import { clear, h, icon } from "./dom.js";
import { shortTime } from "./time.js";

export function renderDetails(ctx, bot, o = {}) {
  const botId = o.botId || bot.id;
  let thread = o.thread || "";
  let menu = null; // { btn, slot } of the open More menu

  const meter = h("progress", { max: "1", value: "0", "aria-label": "Daily usage" });
  const meterText = h("span", { class: "muted small" });
  const list = h("ul", { class: "threadlist", role: "list" });
  const close = () => (o.onClose ? o.onClose() : ctx.closeDetails());
  const closeBtn = h("button", { class: "btn btn-icon", type: "button", onclick: close }, icon("close", "Close details"));

  const usage = async () => {
    const u = await ctx.api.call("/api/chat/usage", {});
    if (!u.ok) return;
    meter.setAttribute("max", String(u.data.maxTokensPerDay));
    meter.setAttribute("value", String(Math.min(u.data.tokensToday, u.data.maxTokensPerDay)));
    const paid = (u.data.paid || []).filter((p) => p.bot === botId && p.enabled).map((p) => `; ${p.label} (paid): ${p.dayTokens}/${p.perDay} today, ${p.monthTokens}/${p.perMonth} this month${p.headroom === 0 ? " (cap reached)" : ""}`).join("");
    meterText.textContent = `${u.data.chatsToday}/${u.data.maxChatsPerDay} messages, ${u.data.tokensToday}/${u.data.maxTokensPerDay} tokens today${paid}`;
  };

  // ----- the More menu: a popover of buttons; Escape closes it and focus goes back to the button -----
  function closeMenu(restore) {
    if (!menu) return;
    const m = menu;
    menu = null;
    clear(m.slot);
    m.btn.setAttribute("aria-expanded", "false");
    if (restore) m.btn.focus();
  }
  const changed = async () => {
    await Promise.all([loadThreads(), ctx.refreshBots()]);
  };
  const actions = (x) => [
    [x.pinned ? "Unpin" : "Pin", async () => (await ctx.api.call("/api/chat/thread/pin", { bot: botId, thread: x.id, pinned: !x.pinned }), changed())],
    [
      "Rename",
      async () => {
        const n = ctx.prompt("New name", x.title);
        if (n) {
          await ctx.api.call("/api/chat/thread/rename", { bot: botId, thread: x.id, title: n });
          changed();
        }
      },
    ],
    [
      "Export",
      async () => {
        const r = await ctx.api.call("/api/chat/thread/export", { bot: botId, thread: x.id, format: "md" });
        if (r.ok) ctx.download(r.data.name, r.data.body, r.data.type);
      },
    ],
    [
      "Delete",
      async () => {
        if (!ctx.confirm(`Delete "${x.title}"?`)) return;
        await ctx.api.call("/api/chat/thread/delete", { bot: botId, thread: x.id });
        if (x.id === thread) ctx.go(`#/chat/${botId}`);
        else changed();
      },
    ],
  ];
  function openMenu(x, btn, slot) {
    const was = menu && menu.btn === btn;
    closeMenu(false);
    if (was) return;
    menu = { btn, slot };
    btn.setAttribute("aria-expanded", "true");
    const items = actions(x).map(([text, fn]) =>
      h(
        "button",
        {
          type: "button",
          role: "menuitem",
          class: text === "Delete" ? "danger" : null,
          onclick: () => {
            closeMenu(false);
            fn();
          },
        },
        text,
      ),
    );
    clear(slot, h("div", { class: "popover thread-pop", role: "menu", "aria-label": `Actions for ${x.title}` }, items));
    items[0].focus();
  }

  // ----- this bot's chats -----
  const threadRow = (x) => {
    const slot = h("div", { class: "thread-slot" });
    const btn = h("button", { class: "btn btn-icon", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", onclick: () => openMenu(x, btn, slot) }, icon("more", `More actions for ${x.title}`));
    const cur = x.id === thread;
    return h(
      "li",
      {
        class: cur ? "threadrow is-current" : "threadrow",
        onkeydown: (ev) => {
          if (ev.key === "Escape" && menu) {
            ev.preventDefault();
            ev.stopPropagation();
            closeMenu(true);
          }
        },
      },
      h(
        "a",
        { class: "thread-open", href: `#/chat/${botId}/${x.id}`, "aria-current": cur ? "true" : null },
        h("span", { class: "thread-top" }, x.pinned ? [icon("pin", "Pinned"), " "] : null, h("span", { class: "thread-title" }, x.title), h("span", { class: "botrow-time" }, shortTime(x.updatedAt, Date.now()))),
        h("span", { class: "botrow-preview" }, x.preview),
      ),
      btn,
      slot,
    );
  };
  async function loadThreads() {
    const t = await ctx.api.call("/api/chat/threads", { bot: botId });
    menu = null;
    const items = t.ok ? (t.data.threads || []).filter((x) => x.botId === botId) : [];
    clear(list, items.length > 0 ? items.map(threadRow) : h("li", { class: "muted small" }, t.ok ? "No chats yet." : "Could not load the chats."));
  }

  const av = avatarEl(bot.avatar);
  av.className = av.className.replace("av-md", "av-lg");
  const root = h(
    "div",
    {
      class: "detailsbody",
      onclick: (ev) => {
        if (menu && !menu.btn.contains(ev.target) && !menu.slot.contains(ev.target)) closeMenu(false);
      },
      onkeydown: (ev) => {
        if (ev.key === "Escape" && !menu) {
          ev.preventDefault();
          close();
        }
      },
    },
    h("div", { class: "detailshead" }, h("h2", {}, "Details"), closeBtn),
    h("div", { class: "who" }, av, h("p", { class: "who-name" }, bot.name), bot.tagline ? h("p", { class: "muted" }, bot.tagline) : null, badgeEl(bot), bot.egressNote ? h("p", { class: "muted small" }, bot.egressNote) : null, paidLines(bot.paid)),
    h("section", { class: "dsec" }, h("h2", {}, "Usage"), meter, h("div", {}, meterText)),
    h("section", { class: "dsec" }, h("div", { class: "row" }, h("h2", {}, "Chats"), h("button", { class: "btn btn-small", type: "button", onclick: () => ctx.go(`#/chat/${botId}`) }, icon("plus"), "New chat")), list),
    (bot.starters || []).length > 0
      ? h("section", { class: "dsec" }, h("h2", {}, "Starters"), h("div", { class: "chips" }, bot.starters.map((s) => h("button", { class: "btn btn-small", type: "button", onclick: () => o.onStarter && o.onStarter(s) }, s))))
      : null,
    h("div", { class: "dsec" }, h("button", { class: "btn", type: "button", onclick: () => ctx.go(`#/bot/${botId}`) }, "Edit bot")),
  );
  root.refresh = () => Promise.all([usage(), loadThreads()]);
  root.setThread = (id) => {
    thread = id;
  };
  root.focusClose = () => closeBtn.focus();
  return root;
}
