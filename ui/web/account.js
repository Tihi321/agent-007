// Account: devices and sessions, passkeys, recovery codes, export and delete my data (S35). Sensitive steps ask for a fresh authenticator
// code or passkey first (step-up), as the server requires.
import { clear, field, h, when } from "./dom.js";
import { createPasskey, passkeysAvailable } from "./passkey.js";

/** Runs `fn` (an API call); if the server wants a fresh confirmation, asks for a code, confirms, and retries once. */
export async function withStepUp(ctx, fn, host) {
  let r = await fn();
  if (r.status !== 401 || r.data.error !== "step_up_required") return r;
  const code = ctx.prompt("Confirm it is you: enter your 6-digit authenticator code", "");
  if (!code) return r;
  const s = await ctx.api.call("/api/stepup", { totpCode: code });
  if (!s.ok) {
    if (host) clear(host, h("p", { class: "banner banner-error", role: "alert" }, s.data.message || "That confirmation did not work."));
    return s;
  }
  r = await fn();
  return r;
}

export async function renderAccount(ctx) {
  const out = h("div", { "aria-live": "polite" });
  const sessions = h("ul", { class: "plainlist", role: "list" });
  const loadSessions = async () => {
    const r = await ctx.api.call("/api/account/sessions", {});
    clear(
      sessions,
      (r.ok ? r.data.sessions : []).map((s) =>
        h(
          "li",
          { class: "row" },
          h("span", {}, s.current ? "This device" : "Another device", " · last used ", when(s.lastSeen)),
          s.current ? null : h("button", { class: "btn btn-small", type: "button", onclick: async () => (await ctx.api.call("/api/account/sessions/revoke", { ref: s.ref }), loadSessions()) }, "Sign out"),
        ),
      ),
    );
  };
  await loadSessions();
  const root = h(
    "section",
    { "aria-labelledby": "acct-title" },
    h("h1", { id: "acct-title" }, "Account"),
    h("h2", {}, "Devices and sessions"),
    sessions,
    h("button", { class: "btn", type: "button", onclick: async () => { await ctx.api.call("/api/account/signout-everywhere", {}); ctx.signedOut(); } }, "Sign out everywhere"),
    h("h2", {}, "Sign-in methods"),
    passkeysAvailable()
      ? h("button", { class: "btn", type: "button", onclick: async () => {
          const r = await withStepUp(ctx, () => ctx.api.call("/api/account/passkey/begin", {}), out);
          if (!r.ok) return clear(out, h("p", { class: "banner banner-error", role: "alert" }, r.data.message || "Passkeys are not available on this address."));
          try {
            const att = await createPasskey(r.data);
            const f = await ctx.api.call("/api/account/passkey/finish", { ...att, label: "passkey" });
            clear(out, h("p", { class: f.ok ? "banner banner-ok" : "banner banner-error" }, f.ok ? "Passkey added." : f.data.message || "Could not add it."));
          } catch {
            clear(out, h("p", { class: "banner banner-error", role: "alert" }, "The passkey could not be created."));
          }
        } }, "Add a passkey")
      : h("p", { class: "muted" }, "Passkeys need this page opened at the ts.net address (or http://localhost on the PC)."),
    h("button", { class: "btn", type: "button", onclick: async () => {
      const r = await withStepUp(ctx, () => ctx.api.call("/api/account/recovery/regenerate", {}), out);
      clear(out, r.ok ? h("div", {}, h("p", {}, "New recovery codes (the old ones no longer work):"), h("pre", { class: "codes" }, r.data.recoveryCodes.join("\n"))) : h("p", { class: "banner banner-error", role: "alert" }, r.data.message || "Could not create new codes."));
    } }, "New recovery codes"),
    h("h2", {}, "Your data"),
    h("p", { class: "muted" }, "The owner cannot read your chats. Export is the only way they leave your account."),
    h("button", { class: "btn", type: "button", onclick: async () => {
      const r = await withStepUp(ctx, () => ctx.api.call("/api/account/export", {}), out);
      if (r.ok) ctx.download("agent-007-export.json", JSON.stringify(r.data, null, 2), "application/json");
      else clear(out, h("p", { class: "banner banner-error", role: "alert" }, r.data.message || "Export failed."));
    } }, "Export my data"),
    (() => {
      const confirm = h("input", { type: "text", name: "confirm", autocomplete: "off" });
      return h("div", { class: "card" }, h("h3", {}, "Delete my data"), h("p", {}, "Removes your bots, chats and uploads. Your account stays."), field("Type your login to confirm", confirm), h("button", { class: "btn btn-danger", type: "button", onclick: async () => {
        const r = await withStepUp(ctx, () => ctx.api.call("/api/account/delete-data", { confirm: confirm.value }), out);
        clear(out, h("p", { class: r.ok ? "banner banner-ok" : "banner banner-error", role: r.ok ? null : "alert" }, r.ok ? "Your data was deleted." : r.data.message || "Could not delete."));
      } }, "Delete my data"));
    })(),
    out,
  );
  return root;
}
