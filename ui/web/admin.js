// Admin (owner and admin): users, invitations, caps, audit, lockdown (S35). Invitation codes are shown once. Chat text is nowhere in this
// screen: the audit holds lengths and hashes only.
import { withStepUp } from "./account.js";
import { clear, field, h, when } from "./dom.js";

export async function renderAdmin(ctx) {
  const out = h("div", { "aria-live": "polite" });
  const usersEl = h("ul", { class: "cards", role: "list" });
  const invitesEl = h("ul", { class: "plainlist", role: "list" });
  const auditEl = h("pre", { class: "audit", tabindex: "0" });
  const note = (ok, msg) => clear(out, h("p", { class: ok ? "banner banner-ok" : "banner banner-error", role: ok ? null : "alert" }, msg));
  const act = async (path, body, okMsg) => {
    const r = await withStepUp(ctx, () => ctx.api.call(path, body), out);
    note(r.ok, r.ok ? okMsg : r.data.message || "That did not work.");
    if (r.ok) load();
    return r;
  };
  const load = async () => {
    const u = await ctx.api.call("/api/admin/users", {});
    clear(
      usersEl,
      (u.ok ? u.data.users : []).map((x) =>
        h(
          "li",
          { class: "card" },
          h("strong", {}, x.displayName), " ", h("span", { class: "muted" }, x.login), " ", h("span", { class: "badge" }, x.role), " ", h("span", { class: x.status === "active" ? "badge" : "badge badge-cloud" }, x.status),
          h("p", { class: "muted small" }, `Bots ${x.caps.maxBots}, messages/day ${x.caps.maxChatsPerDay}, tokens/day ${x.caps.maxTokensPerDay}, models: ${x.caps.presets.join(", ") || "none"}`),
          x.role === "owner"
            ? null
            : h(
                "div",
                { class: "row" },
                x.status === "active"
                  ? h("button", { class: "btn btn-small", type: "button", onclick: () => act("/api/admin/users/disable", { id: x.id }, "Disabled. Their sessions ended.") }, "Disable")
                  : h("button", { class: "btn btn-small", type: "button", onclick: () => act("/api/admin/users/enable", { id: x.id }, "Enabled.") }, "Enable"),
                h("button", { class: "btn btn-small", type: "button", onclick: () => {
                  const n = ctx.prompt("Max bots", String(x.caps.maxBots));
                  if (n) act("/api/admin/users/caps", { id: x.id, caps: { ...x.caps, maxBots: Number(n) } }, "Limits changed. Their sessions were restarted.");
                } }, "Change bot limit"),
                ctx.role === "owner" ? h("button", { class: "btn btn-small btn-danger", type: "button", onclick: () => {
                  const c = ctx.prompt(`Type ${x.login} to delete this user and all their data`, "");
                  if (c) act("/api/admin/users/delete", { id: x.id, confirm: c }, "Deleted.");
                } }, "Delete") : null,
              ),
        ),
      ),
    );
    const i = await ctx.api.call("/api/admin/invites", {});
    clear(invitesEl, (i.ok ? i.data.invites : []).map((x) => h("li", { class: "row" }, h("span", {}, `${x.role} · ${x.state}${x.pin ? ` · ${x.pin}` : ""} · expires ${when(x.expiresAt)}`), x.state === "pending" ? h("button", { class: "btn btn-small", type: "button", onclick: () => act("/api/admin/invites/revoke", { id: x.id }, "Revoked.") }, "Revoke") : null)));
    if (ctx.role === "owner") {
      const a = await ctx.api.call("/api/admin/audit", {});
      auditEl.textContent = a.ok ? a.data.events.slice(-80).map((e) => `${e.ts} ${e.kind}${e.user ? " " + e.user.slice(0, 8) : ""} ${e.detail ? JSON.stringify(e.detail) : ""}`).join("\n") : "";
    }
  };
  await load();
  const pin = h("input", { type: "text", name: "pin", autocomplete: "off", placeholder: "alice@example.com" });
  const role = h("select", { name: "role" }, h("option", { value: "user" }, "User"), ctx.role === "owner" ? h("option", { value: "admin" }, "Admin") : null);
  const invite = h(
    "form",
    {
      class: "card",
      onsubmit: async (ev) => {
        ev.preventDefault();
        const r = await withStepUp(ctx, () => ctx.api.call("/api/admin/invites/create", { role: role.value, ...(pin.value.trim() ? { tailscaleLoginPin: pin.value.trim() } : {}) }), out);
        if (!r.ok) return note(false, r.data.message || "Could not create the invitation.");
        clear(out, h("div", { class: "banner banner-ok" }, h("p", {}, "Send this link to the person yourself. It is shown only now and works once, for 24 hours. Without a pinned login, the first tailnet login that opens it becomes the only one that can use it:"), h("pre", { class: "codes" }, `${globalThis.location?.origin ?? ""}/invite?code=${r.data.code}`)));
        load();
      },
    },
    h("h2", {}, "Invite someone"),
    field("Their Tailscale login (recommended)", pin, "The invitation then works only from that login."),
    field("Role", role),
    h("button", { class: "btn btn-primary", type: "submit" }, "Create invitation"),
  );
  const lock = ctx.role === "owner"
    ? h("button", { class: "btn btn-danger", type: "button", onclick: async () => {
        if (!ctx.confirm("End every web session, including yours?")) return;
        const r = await withStepUp(ctx, () => ctx.api.call("/api/admin/lockdown", {}), out);
        if (r.ok) ctx.signedOut();
      } }, "Lockdown: sign everyone out")
    : null;
  return h("section", { "aria-labelledby": "admin-title" }, h("h1", { id: "admin-title" }, "Admin"), out, h("h2", {}, "People"), usersEl, invite, h("h2", {}, "Invitations"), invitesEl, ctx.role === "owner" ? h("h2", {}, "Audit (no message text)") : null, ctx.role === "owner" ? auditEl : null, lock);
}
