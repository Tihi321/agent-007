// Chat: thread list, messages, composer, approval cards, usage meter (S35). The stream is followed with fetch + Last-Event-ID so a reload or
// a dropped connection resumes the same answer. Streaming text goes into one live region as plain text and is rendered as Markdown when
// the answer is complete. Tool calls show as chips; an ask-first tool shows an approval card (Approve, Deny, Why).
import { clear, h, when } from "./dom.js";
import { renderMarkdown } from "./markdown.js";

function chips(tools) {
  return (tools || []).map((t) => h("span", { class: `chip chip-${t.status}` }, `${t.name}: ${t.status}`));
}

function messageEl(m) {
  const body = m.role === "assistant" ? renderMarkdown(m.text || "") : h("p", { class: "plain" }, m.text);
  return h(
    "article",
    { class: `msg msg-${m.role}`, "aria-label": m.role === "user" ? "You" : "Bot" },
    h("div", { class: "msg-meta muted small" }, m.role === "user" ? "You" : "Bot", " · ", when(m.at)),
    m.notice ? h("p", { class: "banner banner-warn small" }, m.notice) : null,
    body,
    chips(m.tools),
    m.stopped ? h("p", { class: "muted small" }, "Stopped.") : null,
    m.error ? h("p", { class: "banner banner-error small", role: "alert" }, m.error) : null,
  );
}

export async function renderChat(ctx, botId, threadId) {
  const g = await ctx.api.call("/api/bots/get", { id: botId });
  if (!g.ok) return h("p", { class: "banner banner-error", role: "alert" }, g.data.message || "No such bot.");
  const bot = g.data.bot;
  let thread = threadId || "";
  let last = 0;
  let abort = null;
  const list = h("ul", { class: "threads", role: "list" });
  const log = h("div", { class: "log", role: "log", "aria-live": "polite", "aria-relevant": "additions text", tabindex: "0" });
  const live = h("div", { class: "msg msg-assistant live", hidden: true });
  const liveText = h("p", { class: "plain" });
  const liveTools = h("div", {});
  const cards = h("div", { class: "cards-approval" });
  live.append(liveText, liveTools);
  const status = h("p", { class: "muted small", "aria-live": "polite" });
  const meter = h("progress", { max: "1", value: "0", "aria-label": "Daily usage" });
  const meterText = h("span", { class: "muted small" });
  const input = h("textarea", { name: "message", "aria-label": "Message", rows: "2", maxlength: "8000", placeholder: "Write a message" });
  const sendBtn = h("button", { class: "btn btn-primary", type: "submit" }, "Send");
  const stopBtn = h("button", { class: "btn", type: "button", hidden: true }, "Stop");
  const regenBtn = h("button", { class: "btn btn-small", type: "button" }, "Regenerate");
  const search = h("input", { type: "search", "aria-label": "Search chats", placeholder: "Search chats" });

  const setRunning = (on) => {
    sendBtn.disabled = on;
    stopBtn.hidden = !on;
    regenBtn.disabled = on;
    live.hidden = !on;
    if (!on) {
      clear(liveText);
      clear(liveTools);
    }
  };
  const usage = async () => {
    const u = await ctx.api.call("/api/chat/usage", {});
    if (!u.ok) return;
    meter.setAttribute("max", String(u.data.maxTokensPerDay));
    meter.setAttribute("value", String(Math.min(u.data.tokensToday, u.data.maxTokensPerDay)));
    meterText.textContent = `${u.data.chatsToday}/${u.data.maxChatsPerDay} messages, ${u.data.tokensToday}/${u.data.maxTokensPerDay} tokens today`;
  };
  const showThread = async () => {
    if (!thread) return clear(log, h("p", { class: "muted" }, "Start a chat below."), (bot.starters || []).map((s) => h("button", { class: "btn btn-small", type: "button", onclick: () => ((input.value = s), input.focus()) }, s)));
    const t = await ctx.api.call("/api/chat/thread/get", { bot: botId, thread });
    if (!t.ok) return clear(log, h("p", { class: "banner banner-error", role: "alert" }, t.data.message || "That chat is gone."));
    clear(log, t.data.thread.messages.map(messageEl), live, cards);
    log.scrollTop = log.scrollHeight;
    if (t.data.running) follow();
  };
  const loadThreads = async () => {
    const t = search.value.trim().length >= 2 ? await ctx.api.call("/api/chat/thread/search", { q: search.value.trim() }) : await ctx.api.call("/api/chat/threads", { bot: botId });
    const items = t.ok ? t.data.threads.filter((x) => x.botId === botId) : [];
    clear(
      list,
      items.map((x) =>
        h(
          "li",
          { class: x.id === thread ? "thread current" : "thread" },
          h("button", { class: "btn thread-open", type: "button", "aria-current": x.id === thread ? "true" : null, onclick: () => ctx.go(`#/chat/${botId}/${x.id}`) }, x.pinned ? "[pinned] " : "", x.title, h("span", { class: "muted small" }, x.preview)),
          h(
            "span",
            { class: "row" },
            h("button", { class: "btn btn-small", type: "button", "aria-label": `Pin ${x.title}`, onclick: async () => (await ctx.api.call("/api/chat/thread/pin", { bot: botId, thread: x.id, pinned: !x.pinned }), loadThreads()) }, x.pinned ? "Unpin" : "Pin"),
            h("button", { class: "btn btn-small", type: "button", "aria-label": `Rename ${x.title}`, onclick: async () => { const n = ctx.prompt("New name", x.title); if (n) { await ctx.api.call("/api/chat/thread/rename", { bot: botId, thread: x.id, title: n }); loadThreads(); } } }, "Rename"),
            h("button", { class: "btn btn-small", type: "button", "aria-label": `Export ${x.title}`, onclick: async () => { const r = await ctx.api.call("/api/chat/thread/export", { bot: botId, thread: x.id, format: "md" }); if (r.ok) ctx.download(r.data.name, r.data.body, r.data.type); } }, "Export"),
            h("button", { class: "btn btn-small btn-danger", type: "button", "aria-label": `Delete ${x.title}`, onclick: async () => { if (!ctx.confirm(`Delete "${x.title}"?`)) return; await ctx.api.call("/api/chat/thread/delete", { bot: botId, thread: x.id }); if (x.id === thread) ctx.go(`#/chat/${botId}`); else loadThreads(); } }, "Delete"),
          ),
        ),
      ),
    );
  };
  const approvalCard = (card) => {
    const why = h("p", { class: "help", hidden: true }, card.why);
    const done = (txt) => clear(el, h("p", { class: "muted small" }, txt));
    const decide = async (d) => {
      const r = await ctx.api.call("/api/chat/approval", { token: card.token, decision: d });
      done(r.ok ? (d === "approve" ? "Approved." : "Denied.") : "That request is no longer open.");
    };
    const el = h("div", { class: "card approval", role: "group", "aria-label": "Approval needed" }, h("strong", {}, "Approval needed"), h("p", {}, card.summary), why, h("div", { class: "row" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => decide("approve") }, "Approve"), h("button", { class: "btn", type: "button", onclick: () => decide("deny") }, "Deny"), h("button", { class: "btn btn-small", type: "button", onclick: () => (why.hidden = !why.hidden) }, "Why")));
    return el;
  };
  const follow = async () => {
    if (!thread) return;
    setRunning(true);
    abort = new AbortController();
    let text = "";
    const r = await ctx.api.stream(botId, thread, {
      last,
      signal: abort.signal,
      onEvent: (ev) => {
        last = ev.id;
        const d = ev.data;
        if (ev.type === "queued") status.textContent = "Waiting for the model…";
        else if (ev.type === "delta") {
          status.textContent = "";
          text += d.text;
          liveText.textContent = text;
        } else if (ev.type === "notice") status.textContent = d.text;
        else if (ev.type === "tool") liveTools.append(h("span", { class: `chip chip-${d.status}` }, `${d.name}: ${d.status}`));
        else if (ev.type === "approval") cards.append(approvalCard(d.card));
        else if (ev.type === "question") status.textContent = d.text;
      },
    });
    last = 0;
    setRunning(false);
    if (r.ok) await showThread();
    await Promise.all([usage(), loadThreads()]);
  };
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    const r = await ctx.api.call("/api/chat/send", { bot: botId, text, ...(thread ? { thread } : {}) });
    if (!r.ok) {
      status.textContent = r.data.message || "Could not send.";
      return;
    }
    input.value = "";
    status.textContent = "";
    if (!thread) {
      thread = r.data.threadId;
      ctx.replace(`#/chat/${botId}/${thread}`);
    }
    last = 0;
    clear(log, (await ctx.api.call("/api/chat/thread/get", { bot: botId, thread })).data.thread.messages.map(messageEl), live, cards);
    follow();
  };
  stopBtn.addEventListener("click", async () => {
    await ctx.api.call("/api/chat/stop", { thread });
  });
  regenBtn.addEventListener("click", async () => {
    const r = await ctx.api.call("/api/chat/regenerate", { bot: botId, thread });
    if (!r.ok) {
      status.textContent = r.data.message || "Could not regenerate.";
      return;
    }
    last = 0;
    follow();
  });
  search.addEventListener("input", loadThreads);

  const newBtn = h("button", { class: "btn", type: "button", onclick: () => ctx.go(`#/chat/${botId}`) }, "New chat");
  const root = h(
    "section",
    { class: "chat", "aria-labelledby": "chat-title" },
    h("aside", { class: "sidebar", "aria-label": "Chats" }, newBtn, search, list),
    h(
      "div",
      { class: "pane" },
      h("header", { class: "row" }, h("h1", { id: "chat-title" }, bot.name), h("span", { class: bot.cloud ? "badge badge-cloud" : "badge" }, bot.cloud ? `${bot.presetLabel} (cloud)` : bot.presetLabel)),
      h("p", { class: "muted small" }, bot.egressNote),
      log,
      status,
      h(
        "form",
        {
          class: "composer",
          onsubmit: (ev) => {
            ev.preventDefault();
            send();
          },
        },
        input,
        h("div", { class: "row" }, sendBtn, stopBtn, regenBtn),
      ),
      h("div", { class: "row" }, meter, meterText),
    ),
  );
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      send();
    }
  });
  await Promise.all([showThread(), loadThreads(), usage()]);
  root.dispose = () => abort && abort.abort();
  return root;
}
