// Chat (S35, WR3): header, message log, composer pill, approval cards. The thread list and the usage meter live in the details pane (details.js).
// The stream is followed with fetch + Last-Event-ID, so a reload or a dropped connection resumes the same answer: on a failure while the thread is
// still running the view waits 1 s, 2 s, 4 s and follows again from the last event id (the live text is kept, never rebuilt twice).
// The live bubble shows typing dots until the first delta, then Markdown at most every 100 ms: finished blocks are appended once, and only the
// last open block is rendered again (plain text when that block passes 20,000 chars). The finished answer is drawn again from the thread.
import { avatarEl, badgeEl } from "./bots.js";
import { renderDetails } from "./details.js";
import { clear, h, icon } from "./dom.js";
import { blockCutter } from "./markdown-parse.js";
import { markdownBlocks, renderMarkdown } from "./markdown.js";
import { shortTime } from "./time.js";

const GAP_MS = 30 * 60_000;
const PAINT_MS = 100;
const PLAIN_OVER = 20_000;
const RESUME_MS = [1000, 2000, 4000];
const canCopy = () => typeof navigator !== "undefined" && !!navigator && !!navigator.clipboard && typeof navigator.clipboard.writeText === "function";

const toolRow = (tools) => (tools && tools.length > 0 ? h("div", { class: "toolrow" }, tools.map((t) => h("span", { class: `chip chip-${t.status}` }, `${t.name}: ${t.status}`))) : null);

/** "7:34 PM" today, else "Yesterday 7:34 PM". */
function sepLabel(ms) {
  const clock = shortTime(ms, ms);
  const day = shortTime(ms, Date.now());
  return day === clock ? clock : `${day} ${clock}`;
}

export async function renderChat(ctx, botId, threadId) {
  const g = await ctx.api.call("/api/bots/get", { id: botId });
  const here = `#/chat/${botId}${threadId ? `/${threadId}` : ""}`;
  if (!g.ok) return h("div", { class: "banner banner-error", role: "alert" }, g.data.message || "No such bot.", h("button", { class: "btn btn-small", type: "button", onclick: () => ctx.go(here) }, "Retry"));
  const bot = g.data.bot;
  const delays = ctx.resumeDelays || RESUME_MS;
  let thread = threadId || "";
  let last = 0;
  let text = "";
  let abort = null;
  let running = false;
  let following = false;
  let disposed = false;
  let paintTimer = null;
  let lastPaint = 0;
  let wake = null;
  let sleepTimer = null;
  // Live render state: text.slice(0, doneLen) is already in liveDone as finished blocks; liveTail holds the open block.
  let cutAt = blockCutter();
  let doneLen = 0;
  const liveDone = h("div", { class: "md" });
  const liveTail = h("div", { class: "md" });

  const typing = h("span", { class: "typing", "aria-hidden": "true" }, h("span"), h("span"), h("span"));
  const liveBody = h("div", { class: "live-body" });
  const liveTools = h("div", { class: "toolrow" });
  const live = h("div", { class: "msg msg-assistant live", hidden: true, "aria-busy": "false" }, h("div", { class: "bubble" }, typing, liveBody), liveTools);
  const cards = h("div", { class: "cards-approval" });
  const log = h("div", { class: "log", role: "log", "aria-live": "polite", "aria-relevant": "additions text", tabindex: "0" });
  const status = h("div", { class: "status muted small", "aria-live": "polite" });
  const input = h("textarea", { name: "message", "aria-label": "Message", rows: "1", maxlength: "8000", placeholder: `Message ${bot.name}` });
  const sendBtn = h("button", { class: "btn btn-primary btn-icon send", type: "submit", disabled: true }, icon("send", "Send"));
  const stopBtn = h("button", { class: "btn btn-primary btn-icon send", type: "button", hidden: true }, icon("stop", "Stop"));

  const setStatus = (msg, retry) => clear(status, msg ? h("span", {}, msg) : null, retry ? h("button", { class: "btn btn-small", type: "button", onclick: retry }, icon("retry"), "Retry") : null);
  const grow = () => {
    const rows = input.value.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 70)), 0);
    input.setAttribute("rows", String(Math.min(8, Math.max(1, rows))));
    sendBtn.disabled = input.value.trim() === "";
  };
  const setRunning = (on) => {
    running = on;
    sendBtn.hidden = on;
    stopBtn.hidden = !on;
    live.hidden = !on && text === "";
    live.setAttribute("aria-busy", on ? "true" : "false");
  };
  const resetLive = () => {
    text = "";
    if (paintTimer) clearTimeout(paintTimer);
    paintTimer = null;
    cutAt = blockCutter();
    doneLen = 0;
    clear(liveDone);
    clear(liveTail);
    clear(liveBody);
    clear(liveTools);
    typing.hidden = false;
    live.hidden = true;
  };
  // Live Markdown at most every 100 ms: new finished blocks are appended, the open block is drawn again; an open block past 20,000 chars is plain text.
  const paint = () => {
    paintTimer = null;
    lastPaint = Date.now();
    const stick = !(log.scrollHeight - log.scrollTop - log.clientHeight > 48);
    typing.hidden = text !== "";
    if (text === "") clear(liveBody);
    else {
      const cut = cutAt(text);
      if (cut > doneLen) {
        liveDone.append(...markdownBlocks(text.slice(doneLen, cut)));
        doneLen = cut;
      }
      const open = text.slice(doneLen);
      clear(liveTail, open.length > PLAIN_OVER ? h("p", { class: "plain" }, open) : markdownBlocks(open));
      if (liveBody.childNodes.length === 0) clear(liveBody, liveDone, liveTail);
    }
    if (stick) log.scrollTop = log.scrollHeight;
  };
  const schedulePaint = () => {
    if (!paintTimer) paintTimer = setTimeout(paint, Math.max(0, PAINT_MS - (Date.now() - lastPaint)));
  };

  // ----- messages -----
  const regenerate = async () => {
    const r = await ctx.api.call("/api/chat/regenerate", { bot: botId, thread });
    if (!r.ok) return setStatus(r.data.message || "Could not regenerate.");
    setStatus("");
    const t = await ctx.api.call("/api/chat/thread/get", { bot: botId, thread });
    if (t.ok) drawMessages(t.data.thread.messages);
    follow();
  };
  const messageEl = (m, isLast) => {
    const mine = m.role === "user";
    const actions = [];
    if (!mine) {
      if (canCopy()) {
        const label = h("span", {}, "Copy");
        actions.push(h("button", { class: "btn btn-small btn-ghost", type: "button", onclick: () => navigator.clipboard.writeText(m.text || "").then(() => clear(label, "Copied"), () => {}) }, icon("copy"), label));
      }
      if (isLast) actions.push(h("button", { class: "btn btn-small btn-ghost", type: "button", onclick: regenerate }, icon("retry"), "Regenerate"));
    }
    return h(
      "article",
      { class: `msg msg-${m.role}${isLast ? " msg-last" : ""}`, "aria-label": mine ? "You" : "Bot" },
      m.notice ? h("p", { class: "sysline" }, m.notice) : null,
      h("div", { class: "bubble" }, mine ? h("p", { class: "plain" }, m.text) : renderMarkdown(m.text || "")),
      toolRow(m.tools),
      m.stopped ? h("p", { class: "sysline" }, "Stopped.") : null,
      m.error ? h("p", { class: "msg-error", role: "alert" }, m.error, isLast ? h("button", { class: "btn btn-small", type: "button", onclick: regenerate }, icon("retry"), "Retry") : null) : null,
      actions.length > 0 ? h("div", { class: "msg-actions" }, actions) : null,
    );
  };
  function drawMessages(msgs) {
    let prev = 0;
    const items = [];
    msgs.forEach((m, i) => {
      if (!prev || m.at - prev > GAP_MS) items.push(h("p", { class: "daysep" }, sepLabel(m.at)));
      prev = m.at;
      items.push(messageEl(m, i === msgs.length - 1));
    });
    clear(log, items, live, cards);
    log.scrollTop = log.scrollHeight;
  }
  const useStarter = (s) => {
    input.value = s;
    grow();
    input.focus();
  };
  const showEmpty = () => {
    const av = avatarEl(bot.avatar, "lg");
    clear(
      log,
      h("div", { class: "empty" }, av, h("p", { class: "empty-title" }, `Start a chat with ${bot.name}.`), bot.tagline ? h("p", { class: "muted" }, bot.tagline) : null, h("div", { class: "chips" }, (bot.starters || []).map((s) => h("button", { class: "btn btn-small", type: "button", onclick: () => useStarter(s) }, s)))),
      live,
      cards,
    );
  };
  const showThread = async () => {
    if (!thread) return showEmpty();
    const skel = setTimeout(() => clear(log, [0, 1, 2].map(() => h("div", { class: "skel skel-msg", "aria-hidden": "true" }))), 150);
    const t = await ctx.api.call("/api/chat/thread/get", { bot: botId, thread });
    clearTimeout(skel);
    if (disposed) return;
    if (!t.ok) return clear(log, h("div", { class: "banner banner-error", role: "alert" }, t.data.message || "That chat is gone.", h("button", { class: "btn btn-small", type: "button", onclick: showThread }, "Retry")));
    drawMessages(t.data.thread.messages);
    if (t.data.running && !following) follow();
  };

  // ----- approvals -----
  const approvalCard = (card) => {
    const wrap = h("div", {});
    const why = h("p", { class: "help", hidden: true }, card.why);
    const decide = async (d) => {
      const r = await ctx.api.call("/api/chat/approval", { token: card.token, decision: d });
      clear(wrap, h("p", { class: "sysline" }, r.ok ? (d === "approve" ? "Approved." : "Denied.") : "That request is no longer open."));
    };
    clear(
      wrap,
      h(
        "div",
        { class: "card actioncard", role: "group", "aria-label": "Approval needed" },
        h("div", { class: "row" }, h("strong", {}, "Approval needed"), h("span", { class: "pill-warn" }, "Waiting for you")),
        h("p", {}, card.summary),
        why,
        h("div", { class: "row actions" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => decide("approve") }, "Approve"), h("button", { class: "btn", type: "button", onclick: () => decide("deny") }, "Deny"), h("button", { class: "btn btn-ghost", type: "button", onclick: () => (why.hidden = !why.hidden) }, "Why")),
      ),
    );
    return wrap;
  };

  // ----- streaming -----
  const onEvent = (ev) => {
    last = ev.id;
    const d = ev.data;
    if (ev.type === "queued") setStatus("Waiting for the model…");
    else if (ev.type === "delta") {
      if (text === "") setStatus("");
      text += d.text;
      schedulePaint();
    } else if (ev.type === "notice" || ev.type === "question") setStatus(d.text);
    else if (ev.type === "tool") liveTools.append(h("span", { class: `chip chip-${d.status}` }, `${d.name}: ${d.status}`));
    else if (ev.type === "approval") cards.append(approvalCard(d.card));
  };
  const sleep = (ms) =>
    new Promise((res) => {
      wake = res;
      sleepTimer = setTimeout(res, ms);
    });
  async function follow(resume) {
    if (!thread || following) return;
    following = true;
    if (!resume) {
      last = 0;
      resetLive();
      clear(cards);
    }
    setRunning(true);
    setStatus(resume ? "" : "Waiting for the model…");
    paint();
    let ok = false;
    for (let tries = 0; ; ) {
      abort = new AbortController();
      const r = await ctx.api.stream(botId, thread, { last, signal: abort.signal, onEvent });
      if (disposed) return;
      if (r.ok) {
        ok = true;
        break;
      }
      // A failed stream does not reset `last`: the next try replays only what came after it. If the run is over, show the result instead.
      const t = await ctx.api.call("/api/chat/thread/get", { bot: botId, thread });
      if (disposed) return;
      if (t.ok && !t.data.running) {
        ok = true;
        break;
      }
      if (tries >= delays.length) break;
      setStatus("Connection lost. Reconnecting…");
      await sleep(delays[tries++]);
      if (disposed) return;
    }
    following = false;
    if (paintTimer) clearTimeout(paintTimer);
    paint();
    setRunning(false);
    if (!ok) return setStatus("Connection lost.", () => follow(true));
    setStatus("");
    resetLive();
    await showThread();
    await Promise.all([details.refresh(), ctx.refreshBots()]);
  }
  const send = async () => {
    const body = input.value.trim();
    if (!body || running) return;
    const r = await ctx.api.call("/api/chat/send", { bot: botId, text: body, ...(thread ? { thread } : {}) });
    if (!r.ok) return setStatus(r.data.message || "Could not send.");
    input.value = "";
    grow();
    setStatus("");
    if (!thread) {
      thread = r.data.threadId;
      ctx.replace(`#/chat/${botId}/${thread}`);
      details.setThread(thread);
    }
    const t = await ctx.api.call("/api/chat/thread/get", { bot: botId, thread });
    if (t.ok) drawMessages(t.data.thread.messages);
    follow();
  };
  const stop = () => ctx.api.call("/api/chat/stop", { thread });
  stopBtn.addEventListener("click", stop);
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      send();
    } else if (ev.key === "Escape" && running) {
      ev.preventDefault();
      stop();
    }
  });

  // ----- details pane -----
  const wide = () => typeof matchMedia !== "function" || matchMedia("(min-width: 1100px)").matches;
  const toggle = h("button", { class: "btn btn-icon", type: "button", "aria-expanded": "false", onclick: () => setDetails(!ctx.detailsOpen(), true) }, icon("details", "Details"));
  function setDetails(on, focus) {
    if (on) ctx.openDetails(details);
    else ctx.closeDetails();
    toggle.setAttribute("aria-expanded", on ? "true" : "false");
    if (focus) (on ? details.focusClose : () => toggle.focus())();
  }
  const details = renderDetails(ctx, bot, { botId, thread, onClose: () => setDetails(false, true), onStarter: useStarter });

  const av = avatarEl(bot.avatar, "sm");
  const root = h(
    "section",
    { class: "chatview", "aria-labelledby": "chat-title" },
    h("header", { class: "chathead" }, h("a", { class: "btn btn-icon chat-back", href: "#/bots" }, icon("back", "Back to bots")), av, h("h1", { id: "chat-title" }, bot.name), badgeEl(bot), toggle),
    log,
    status,
    h("div", { class: "composer-wrap" }, h("form", { class: "composer", onsubmit: (ev) => (ev.preventDefault(), send()) }, input, sendBtn, stopBtn)),
  );
  root.afterMount = () => {
    if (wide()) setDetails(true, false);
  };
  root.dispose = () => {
    disposed = true;
    if (abort) abort.abort();
    if (paintTimer) clearTimeout(paintTimer);
    if (sleepTimer) clearTimeout(sleepTimer);
    if (wake) wake();
  };
  await Promise.all([showThread(), details.refresh()]);
  return root;
}
