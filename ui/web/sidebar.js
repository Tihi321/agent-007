// The sidebar (WR2): the user's bots with the last message and time of each, a search over bots and chats, a favourites row (mobile) and the
// user menu. It owns no h1. Data: /api/bots/list and /api/chat/threads (all threads; the newest per bot is the row's preview).
import { avatarEl } from "./bots.js";
import { clear, h, icon } from "./dom.js";
import { shortTime } from "./time.js";

const SKELETON_MS = 150;
const SEARCH_MS = 250;

export function renderSidebar(ctx) {
  let bots = [];
  let threads = [];
  let loaded = false;
  let showSkeleton = false;
  let error = "";
  let currentBot = "";
  let query = "";
  let hits = [];
  let searching = false;
  let seq = 0;
  let searchTimer = null;
  let skelTimer = null;
  let menuOpen = false;

  const list = h("ul", { class: "botlist", role: "list" });
  const favs = h("ul", { class: "favs", role: "list", "aria-label": "Favourites" });
  const chatHits = h("div", { class: "chathits" });
  const state = h("div", { class: "sidestate" });
  const input = h("input", { type: "search", name: "search", "aria-label": "Search", placeholder: "Search" });
  const search = h("div", { class: "search" }, icon("search"), input);

  // ----- user menu (links stay real <a>; the panel is hidden, not removed, so the links always exist) -----
  const user = ctx.user || { displayName: "", login: "", role: "user" };
  const who = user.displayName || user.login || "Account";
  const menuBtn = h(
    "button",
    {
      class: "usermenu-btn",
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      onclick: () => setMenu(!menuOpen),
    },
    h("span", { class: "avatar av-user av-md", "aria-hidden": "true" }, (who.trim()[0] || "?").toUpperCase()),
    h("span", { class: "usermenu-name" }, who),
    icon("chevron"),
  );
  const item = (hash, text) => h("a", { href: hash, role: "menuitem", class: "menuitem", onclick: () => setMenu(false) }, text);
  const panel = h(
    "div",
    { class: "popover usermenu-pop", role: "menu", "aria-label": "Account menu", hidden: true },
    item("#/account", "Account"),
    user.role === "owner" || user.role === "admin" ? item("#/admin", "Admin") : null,
    user.role === "owner" ? item("#/admin/models", "Models") : null,
    user.role === "owner" ? item("#/jobs", "Browser sessions") : null,
    h("button", { type: "button", role: "menuitem", onclick: () => ctx.logout() }, "Sign out"),
  );
  const menu = h("div", { class: "usermenu" }, menuBtn, panel);
  function setMenu(on, restoreFocus) {
    menuOpen = on;
    panel.hidden = !on;
    menuBtn.setAttribute("aria-expanded", on ? "true" : "false");
    if (restoreFocus) menuBtn.focus();
  }
  menu.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && menuOpen) {
      ev.preventDefault();
      setMenu(false, true);
    }
  });
  const offClick = ctx.onDocument ? ctx.onDocument("click", (ev) => menuOpen && !menu.contains(ev.target) && setMenu(false)) : null;

  // ----- data -----
  const latestOf = (id) => threads.filter((t) => t.botId === id).reduce((a, t) => (!a || t.updatedAt > a.updatedAt ? t : a), null);
  const ordered = () => {
    const rows = bots.map((b, i) => ({ b, last: latestOf(b.id), i }));
    return rows.sort((x, y) => (y.last ? y.last.updatedAt : -1) - (x.last ? x.last.updatedAt : -1) || x.i - y.i);
  };

  async function refresh() {
    if (!loaded && !skelTimer) {
      skelTimer = setTimeout(() => {
        skelTimer = null;
        if (!loaded) {
          showSkeleton = true;
          draw();
        }
      }, SKELETON_MS);
    }
    const [b, t] = await Promise.all([ctx.api.call("/api/bots/list", {}), ctx.api.call("/api/chat/threads", {})]);
    if (b.ok) {
      bots = b.data.bots || [];
      threads = t.ok ? t.data.threads || [] : threads;
      error = "";
    } else if (!loaded) error = (b.data && b.data.message) || "Could not load your bots.";
    loaded = true;
    showSkeleton = false;
    if (skelTimer) clearTimeout(skelTimer);
    skelTimer = null;
    draw();
  }

  async function runSearch() {
    const q = query.trim();
    const mine = ++seq;
    if (q.length < 2) {
      hits = [];
      searching = false;
      return draw();
    }
    searching = true;
    const r = await ctx.api.call("/api/chat/thread/search", { q });
    if (mine !== seq) return;
    searching = false;
    hits = r.ok ? r.data.threads || [] : [];
    draw();
  }

  input.addEventListener("input", () => {
    query = input.value;
    if (searchTimer) clearTimeout(searchTimer);
    if (query.trim().length < 2) {
      runSearch();
      return;
    }
    searching = true;
    searchTimer = setTimeout(runSearch, SEARCH_MS);
    draw();
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && input.value) {
      input.value = "";
      query = "";
      runSearch();
    }
  });

  // ----- drawing -----
  const botRow = ({ b, last }) => {
    const cur = b.id === currentBot;
    const href = last ? `#/chat/${b.id}/${last.id}` : `#/chat/${b.id}`;
    return h(
      "li",
      {},
      h(
        "a",
        { class: cur ? "botrow is-current" : "botrow", href, "aria-current": cur ? "page" : null },
        avatarEl(b.avatar),
        h(
          "span",
          { class: "botrow-text" },
          h("span", { class: "botrow-top" }, h("span", { class: "botrow-name" }, b.name), last ? h("span", { class: "botrow-time" }, shortTime(last.updatedAt, Date.now())) : null),
          h("span", { class: "botrow-preview" }, last ? last.preview || last.title : b.tagline || "No messages yet"),
        ),
      ),
    );
  };

  function draw() {
    const q = query.trim().toLowerCase();
    const rows = ordered().filter(({ b }) => !q || `${b.name} ${b.tagline || ""}`.toLowerCase().includes(q));
    const botName = (id) => (bots.find((b) => b.id === id) || { name: id }).name;
    clear(favs);
    if (loaded && !q && bots.length > 0) {
      const pinned = ordered().filter(({ last }) => last && last.pinned);
      const fav = (pinned.length ? pinned : ordered().filter(({ last }) => last).slice(0, 4)).slice(0, 8);
      clear(
        favs,
        fav.map(({ b, last }) => h("li", {}, h("a", { class: "fav", href: `#/chat/${b.id}/${last.id}` }, avatarEl(b.avatar), h("span", { class: "fav-name" }, b.name)))),
      );
    }
    if (!loaded) {
      clear(list, showSkeleton ? [0, 1, 2, 3, 4].map(() => h("li", { class: "skel skel-row", "aria-hidden": "true" })) : null);
    } else clear(list, rows.map(botRow));
    clear(
      chatHits,
      hits.length > 0
        ? [
            h("h2", { class: "sidehead-sub" }, "Chats"),
            h(
              "ul",
              { class: "botlist", role: "list" },
              hits.map((t) =>
                h("li", {}, h("a", { class: "botrow chathit", href: `#/chat/${t.botId}/${t.id}` }, h("span", { class: "botrow-text" }, h("span", { class: "botrow-top" }, h("span", { class: "botrow-name" }, t.title), h("span", { class: "botrow-time" }, botName(t.botId))), h("span", { class: "botrow-preview" }, t.preview)))),
              ),
            ),
          ]
        : null,
    );
    let note = null;
    if (error && !bots.length) note = h("div", { class: "banner banner-error", role: "alert" }, error, h("button", { class: "btn btn-small", type: "button", onclick: refresh }, "Retry"));
    else if (loaded && bots.length === 0) note = h("div", { class: "empty" }, h("p", {}, "Create your first bot"), h("button", { class: "btn btn-primary", type: "button", onclick: () => ctx.go("#/bot/new") }, "New bot"));
    else if (loaded && q && rows.length === 0 && hits.length === 0 && !searching) note = h("div", { class: "empty" }, h("p", {}, "No bots or chats match"));
    clear(state, note);
  }

  const root = h(
    "aside",
    { class: "sidebar", "aria-label": "Bots" },
    h("div", { class: "sidehead" }, h("a", { class: "brand", href: "#/bots" }, "agent-007"), h("button", { class: "btn btn-icon", type: "button", "aria-label": "New bot", onclick: () => ctx.go("#/bot/new") }, icon("plus"))),
    search,
    favs,
    h("nav", { "aria-label": "Bots list", class: "sidescroll" }, list, state, chatHits),
    menu,
  );
  root.update = (o) => {
    currentBot = (o && o.currentBot) || "";
    draw();
  };
  root.refresh = refresh;
  root.dispose = () => {
    if (typeof offClick === "function") offClick();
    if (searchTimer) clearTimeout(searchTimer);
    if (skelTimer) clearTimeout(skelTimer);
  };
  root.focusSearch = () => {
    input.focus();
    if (input.select) input.select();
  };
  draw();
  refresh();
  return root;
}
