// The web app shell (S35, WR2): hash router, the sign-in gate, the sidebar of bots, the details slot, the offline banner. No framework. `start(env)` takes its environment as an argument so
// tests run it against a fake document and a fake gateway; the browser entry at the bottom calls it with the real one.
import { renderAccount } from "./account.js";
import { renderAdmin } from "./admin.js";
import { renderClaim, renderInvite, renderSignIn } from "./auth.js";
import { createApi } from "./api.js";
import { renderBotEditor, renderBots } from "./bots.js";
import { renderChat } from "./chat.js";
import { clear, h, icon } from "./dom.js";
import { renderModels } from "./models.js";
import { renderSidebar } from "./sidebar.js";

export function start(env) {
  const { root, location } = env;
  const state = { user: null, claimed: true, local: false, passkeys: false };
  let current = null;
  let sidebar = null;
  let mode = "auth";
  let detailsOpen = false;
  let retryTimer = null;
  let retryStep = 0;
  const api = createApi({ fetch: env.fetch, onUnauthorized: () => ctx.signedOut() });
  // Every answer passes here: status 0 (no connection) shows the offline banner; the next answer from the server clears it.
  for (const verb of ["call", "get"]) {
    const raw = api[verb];
    api[verb] = async (...a) => {
      const r = await raw.apply(api, a);
      if (r.status === 0) goOffline();
      else if (offline.childNodes.length > 0) goOnline();
      return r;
    };
  }
  const main = h("main", { id: "main", tabindex: "-1" });
  const details = h("aside", { class: "details", "aria-label": "Bot details", hidden: true });
  const shell = h("div", { class: "shell shell-auth" });
  const offline = h("div", { class: "offline", role: "status" });
  const back = h("a", { class: "mobile-back", href: "#/bots" }, icon("back"), "Bots");
  clear(root, h("a", { class: "skip", href: "#main" }, "Skip to content"), offline, shell);

  const RETRY_MS = [3000, 5000, 10000];
  function goOffline() {
    if (offline.childNodes.length === 0) {
      retryStep = 0;
      clear(offline, h("span", {}, "Cannot reach agent-007. Retrying…"), h("button", { class: "btn btn-small", type: "button", onclick: () => probe(true) }, "Retry"));
    }
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        probe(false);
      }, RETRY_MS[Math.min(retryStep++, RETRY_MS.length - 1)]);
    }
  }
  function goOnline() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    clear(offline);
  }
  async function probe(manual) {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    const r = await api.get("/api/me", { quiet: true });
    if (r.status === 0) return;
    if (manual) route();
    else if (sidebar) sidebar.refresh();
  }

  const ctx = {
    api,
    passkeys: false,
    role: "user",
    user: null,
    go: (hash) => {
      // Leave /claim and /invite for the app root so a reload lands in the app, not on those pages.
      if (location.pathname !== "/") location.replace("/" + hash);
      else if (location.hash === hash) route();
      else location.hash = hash;
    },
    replace: (hash) => env.replaceHash(hash),
    mount: (el) => {
      if (current && current.dispose) current.dispose();
      current = el;
      ctx.closeDetails();
      clear(main, el);
      if (env.focusMain) main.focus();
      if (el.afterMount) el.afterMount();
    },
    signedIn: (user) => {
      state.user = user;
      state.claimed = true;
      ctx.role = user.role;
      ctx.user = user;
      drawShell();
    },
    refreshBots: () => (sidebar ? sidebar.refresh() : Promise.resolve()),
    openDetails: (el) => {
      detailsOpen = true;
      details.hidden = false;
      clear(details, el);
      setShell();
    },
    detailsOpen: () => detailsOpen,
    closeDetails: () => {
      if (!detailsOpen) return;
      detailsOpen = false;
      details.hidden = true;
      clear(details);
      setShell();
    },
    logout: async () => {
      await api.call("/api/logout", {});
      ctx.signedOut();
    },
    onDocument: env.onDocument,
    prompt: env.prompt,
    confirm: env.confirm,
    download: env.download,
    signedOut: () => {
      state.user = null;
      ctx.user = null;
      api.setCsrf("");
      drawShell();
      ctx.go("#/signin");
    },
  };

  function setShell() {
    shell.className = `shell shell-${state.user ? mode : "auth"}${detailsOpen ? " details-open" : ""}`;
  }
  // Signed in: sidebar, centre, details. Signed out: only the centre (the auth card), with no navigation.
  function drawShell() {
    if (state.user) {
      if (!sidebar) sidebar = renderSidebar(ctx);
      clear(shell, sidebar, h("div", { class: "centre" }, back, main), details);
    } else {
      sidebar = null;
      clear(shell, h("div", { class: "centre" }, main));
    }
    setShell();
  }
  drawShell();

  env.onDocument?.("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === "k" && sidebar) {
      ev.preventDefault();
      sidebar.focusSearch();
    }
  });

  async function route() {
    const hash = location.hash || "#/";
    const path = location.pathname;
    const parts = hash.replace(/^#\/?/, "").split("/");
    // Restore the session first: a reload on /claim or /invite must not hide a live session behind those forms.
    if (!state.user) {
      const me = await api.get("/api/me", { quiet: true });
      if (me.ok) {
        api.setCsrf(me.data.csrf);
        ctx.signedIn(me.data.user);
      }
    }
    // The claim form exists only while no owner exists; otherwise go to the app (signed in) or the sign-in page.
    if (path === "/claim") {
      if (!state.user && (!state.claimed || state.resetPending)) return ctx.mount(renderClaim(ctx));
      return location.replace(state.user ? "/#/" : "/#/signin");
    }
    if (path === "/invite" && !state.user) return ctx.mount(renderInvite(ctx, /code=([\w-]+)/.exec(hash + (location.search || ""))?.[1] || ""));
    if (!state.user) {
      if (!state.claimed && state.local) return ctx.mount(renderClaim(ctx));
      return ctx.mount(renderSignIn(ctx));
    }
    mode = parts[0] === "chat" ? "chat" : !parts[0] || parts[0] === "bots" ? "list" : "page";
    setShell();
    if (sidebar) sidebar.update({ currentBot: (parts[0] === "chat" || parts[0] === "bot") && parts[1] !== "new" ? parts[1] || "" : "" });
    switch (parts[0]) {
      case "account":
        return ctx.mount(await renderAccount(ctx));
      case "admin":
        if (parts[1] === "models" && state.user.role === "owner") return ctx.mount(await renderModels(ctx));
        return ctx.mount(await renderAdmin(ctx));
      case "bot":
        return ctx.mount(await renderBotEditor(ctx, parts[1] === "new" ? "" : parts[1]));
      case "chat":
        return ctx.mount(await renderChat(ctx, parts[1], parts[2]));
      default:
        return ctx.mount(await renderBots(ctx));
    }
  }

  return (async () => {
    const s = await api.state();
    if (s) {
      state.claimed = s.claimed;
      state.local = s.local;
      state.resetPending = s.resetPending === true;
      ctx.passkeys = s.passkeys;
    }
    env.onHashChange?.(route);
    await route();
    return { ctx, state, route };
  })();
}

if (typeof window !== "undefined" && typeof document !== "undefined" && !window.__A7_TEST__) {
  start({
    root: document.body,
    location: window.location,
    replaceHash: (hash) => history.replaceState(null, "", hash),
    onHashChange: (fn) => window.addEventListener("hashchange", fn),
    prompt: (m, d) => window.prompt(m, d),
    confirm: (m) => window.confirm(m),
    download: (name, text, type) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: type || "text/plain" }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    focusMain: true,
    onDocument: (type, fn) => document.addEventListener(type, fn),
  });
}
