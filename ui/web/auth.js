// Sign-in, owner claim and invitation screens (S35). Every failure is shown as the server's sentence; nothing here reveals which factor failed.
import { clear, field, h } from "./dom.js";
import { createPasskey, getPasskey, passkeysAvailable } from "./passkey.js";

const err = () => h("p", { class: "banner banner-error", role: "alert", hidden: true });
const show = (el, msg) => {
  el.textContent = msg;
  el.hidden = !msg;
};

function recoveryView(ctx, codes) {
  return h(
    "section",
    { class: "card narrow", "aria-labelledby": "rc-title" },
    h("h1", { id: "rc-title" }, "Save your recovery codes"),
    h("p", {}, "Each code works once if you lose your authenticator or passkey. They are shown only now."),
    h("pre", { class: "codes", "aria-label": "Recovery codes" }, codes.join("\n")),
    h("button", { class: "btn btn-primary", type: "button", onclick: () => ctx.go("#/bots") }, "I saved them"),
  );
}

export function renderSignIn(ctx) {
  const e = err();
  const login = h("input", { type: "text", name: "login", autocomplete: "username", spellcheck: "false", required: true });
  const pw = h("input", { type: "password", name: "password", autocomplete: "current-password" });
  const totp = h("input", { type: "text", name: "totp", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", spellcheck: "false" });
  const rec = h("input", { type: "text", name: "recovery", autocomplete: "off", spellcheck: "false" });
  const recField = field("Recovery code", rec, "Use this instead of the authenticator code.");
  recField.hidden = true;
  const totpField = field("Authenticator code", totp);
  const toggle = h("button", { class: "btn btn-small", type: "button", onclick: () => ((recField.hidden = !recField.hidden), (totpField.hidden = !recField.hidden)) }, "Use a recovery code");
  const done = (r) => {
    ctx.api.setCsrf(r.data.csrf);
    ctx.signedIn(r.data.user);
    ctx.go("#/bots");
  };
  const form = h(
    "form",
    {
      class: "card narrow",
      autocomplete: "off",
      onsubmit: async (ev) => {
        ev.preventDefault();
        show(e, "");
        const r = await ctx.api.call("/api/login/password", { login: login.value, password: pw.value, totpCode: totp.value, recoveryCode: rec.value });
        if (r.ok) return done(r);
        show(e, r.data.message || "Sign-in failed.");
      },
    },
    h("h1", {}, "Sign in"),
    field("Login (your Tailscale email)", login),
    field("Password", pw),
    totpField,
    recField,
    e,
    h("button", { class: "btn btn-primary", type: "submit" }, "Sign in"),
    toggle,
  );
  if (ctx.passkeys && passkeysAvailable()) {
    form.append(
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: async () => {
            show(e, "");
            try {
              const o = await ctx.api.call("/api/login/passkey/begin", { login: login.value });
              if (!o.ok) return show(e, o.data.message || "Passkeys are not available here.");
              const a = await getPasskey(o.data);
              const r = await ctx.api.call("/api/login/passkey/finish", { login: login.value, ...a });
              if (r.ok) return done(r);
              show(e, r.data.message || "Sign-in failed.");
            } catch {
              show(e, "Sign-in failed.");
            }
          },
        },
        "Sign in with a passkey",
      ),
    );
  }
  return form;
}

/** Shared by the claim and the invitation: shows the authenticator secret, collects password and code (or a passkey). */
function enrolForm(ctx, o) {
  const e = err();
  const name = h("input", { type: "text", name: "displayName", autocomplete: "name", required: true });
  const pw = h("input", { type: "password", name: "password", autocomplete: "new-password" });
  const totp = h("input", { type: "text", name: "totp", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6" });
  const extra = o.extraFields || [];
  const finish = async (body) => {
    show(e, "");
    const r = await ctx.api.call(o.finishPath, { ...o.finishBase, displayName: name.value, ...body });
    if (!r.ok) return show(e, r.data.message || "That did not work.");
    ctx.api.setCsrf(r.data.csrf);
    ctx.signedIn(r.data.user);
    ctx.mount(recoveryView(ctx, r.data.recoveryCodes || []));
  };
  const el = h(
    "form",
    {
      class: "card narrow",
      autocomplete: "off",
      onsubmit: (ev) => {
        ev.preventDefault();
        finish({ password: pw.value, totpCode: totp.value, ...Object.fromEntries(extra.map(([k, c]) => [k, c.value])) });
      },
    },
    h("h1", {}, o.title),
    h("p", {}, "Add this key to an authenticator app (Aegis, Google Authenticator, 1Password), then type the 6-digit code it shows."),
    h("p", {}, "Key: ", h("code", { class: "secret" }, o.totp.secret)),
    h("p", { class: "help" }, "Or open this in your authenticator: ", h("code", { class: "small" }, o.totp.uri)),
    field("Display name", name),
    ...extra.map(([k, c, label]) => field(label, c)),
    field("Password (at least 12 characters)", pw),
    field("Authenticator code", totp),
    e,
    h("button", { class: "btn btn-primary", type: "submit" }, "Create the account"),
  );
  if (o.passkey && passkeysAvailable()) {
    el.append(
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: async () => {
            try {
              finish({ passkey: await createPasskey(o.passkey), ...Object.fromEntries(extra.map(([k, c]) => [k, c.value])) });
            } catch {
              show(e, "The passkey could not be created.");
            }
          },
        },
        "Use a passkey instead",
      ),
    );
  }
  return el;
}

export function renderClaim(ctx) {
  const e = err();
  const code = h("input", { type: "password", name: "code", autocomplete: "off", spellcheck: "false", required: true });
  const login = h("input", { type: "text", name: "login", autocomplete: "username", spellcheck: "false", required: true });
  const start = h(
    "form",
    {
      class: "card narrow",
      onsubmit: async (ev) => {
        ev.preventDefault();
        show(e, "");
        const r = await ctx.api.call("/api/claim/begin", { code: code.value });
        if (!r.ok) return show(e, r.data.message || "That code did not work.");
        ctx.mount(enrolForm(ctx, { title: "Create the owner account", totp: r.data.totp, passkey: r.data.passkey, finishPath: "/api/claim/finish", finishBase: { claimId: r.data.claimId }, extraFields: [["login", login, "Your Tailscale login (an email address)"]] }));
      },
    },
    h("h1", {}, "Claim this agent"),
    h("p", {}, "On this PC run ", h("code", {}, "yarn web-owner-code --data-dir <the agent data folder>"), " and enter the code it prints. This works only in a browser on the PC itself."),
    field("One-time code", code),
    e,
    h("button", { class: "btn btn-primary", type: "submit" }, "Continue"),
  );
  return start;
}

export function renderInvite(ctx, presetCode = "") {
  const e = err();
  const code = h("input", { type: "password", name: "code", autocomplete: "off", spellcheck: "false", required: true, value: presetCode });
  return h(
    "form",
    {
      class: "card narrow",
      onsubmit: async (ev) => {
        ev.preventDefault();
        show(e, "");
        const r = await ctx.api.call("/api/invite/begin", { code: code.value });
        if (!r.ok) return show(e, r.data.message || "That invitation is not valid.");
        ctx.mount(enrolForm(ctx, { title: "Accept the invitation", totp: r.data.totp, passkey: r.data.passkey, finishPath: "/api/invite/finish", finishBase: { token: r.data.token, code: code.value } }));
      },
    },
    h("h1", {}, "Accept your invitation"),
    h("p", {}, "Open this page from your own device on the tailnet and enter the code the owner gave you."),
    field("Invitation code", code),
    e,
    h("button", { class: "btn btn-primary", type: "submit" }, "Continue"),
  );
}

export { clear };
