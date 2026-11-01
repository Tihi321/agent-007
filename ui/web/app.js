// The web app shell (S35): hash router, the sign-in gate, the navigation. No framework. `start(env)` takes its environment as an argument so
// tests run it against a fake document and a fake gateway; the browser entry at the bottom calls it with the real one.
import { renderAccount } from "./account.js";
import { renderAdmin } from "./admin.js";
import { renderClaim, renderInvite, renderSignIn } from "./auth.js";
import { createApi } from "./api.js";
import { renderBotEditor, renderBots } from "./bots.js";
import { renderChat } from "./chat.js";
import { clear, h } from "./dom.js";

export function start(env) {
  const { root, location } = env;
  const state = { user: null, claimed: true, local: false, passkeys: false };
  let current = null;
  const api = createApi({ fetch: env.fetch, onUnauthorized: () => ctx.signedOut() });
  const main = h("main", { id: "main", tabindex: "-1" });
  const nav = h("nav", { "aria-label": "Main", class: "nav" });
  const header = h("header", { class: "topbar" }, h("span", { class: "brand" }, "agent-007"), nav);
  clear(root, h("a", { class: "skip", href: "#main" }, "Skip to content"), header, main);

  const ctx = {
    api,
    passkeys: false,
    role: "user",
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
      clear(main, el);
      if (env.focusMain) main.focus();
    },
    signedIn: (user) => {
      state.user = user;
      state.claimed = true;
      ctx.role = user.role;
      drawNav();
    },
    prompt: env.prompt,
    confirm: env.confirm,
    download: env.download,
    signedOut: () => {
      state.user = null;
      api.setCsrf("");
      drawNav();
      ctx.go("#/signin");
    },
  };

  function drawNav() {
    const link = (hash, text) => h("a", { href: hash, class: "navlink" }, text);
    clear(
      nav,
      state.user
        ? [link("#/bots", "Bots"), link("#/account", "Account"), state.user.role === "owner" || state.user.role === "admin" ? link("#/admin", "Admin") : null, h("button", { class: "btn btn-small", type: "button", onclick: async () => { await api.call("/api/logout", {}); ctx.signedOut(); } }, "Sign out")]
        : null,
    );
  }

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
    switch (parts[0]) {
      case "account":
        return ctx.mount(await renderAccount(ctx));
      case "admin":
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
  });
}
