// agent-007 settings UI: sign-in, navigation, the generated security forms and the save protocol (I25d).
// No framework and no dependency. All text is set with textContent. The CSRF token lives in memory only.
import { defaultValue, h, renderForm } from "./forms.js";
import { issuesBanner, renderAudit, renderPersonas, renderStatus, renderTemplates } from "./views.js";

const $ = (id) => document.getElementById(id);
let csrf = "";
let schema = null;
let started = false;

export const api = {
  absent: "",
  async request(method, path, body) {
    const headers = { Accept: "application/json" };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["X-CSRF-Token"] = csrf;
    }
    let res;
    try {
      res = await fetch(path, { method, headers, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined, credentials: "same-origin", cache: "no-store" });
    } catch {
      return { ok: false, status: 0, body: { error: "network", message: "Could not reach the settings server. Is the job runner running?" } };
    }
    let parsed = {};
    try {
      parsed = await res.json();
    } catch {
      parsed = { message: `The server answered ${res.status}.` };
    }
    if (res.status === 401 && path !== "/api/login") showLogin("Your session ended. Sign in again with a new link.");
    return { ok: res.ok, status: res.status, body: parsed };
  },
  get: (path) => api.request("GET", path),
  post: (path, body) => api.request("POST", path, body),
};

export function toast(message, kind) {
  const t = h("div", { class: `toast${kind === "ok" ? " toast-ok" : kind === "error" ? " toast-error" : ""}` }, message);
  $("toasts").append(t);
  setTimeout(() => t.remove(), kind === "error" ? 10000 : 5000);
}

// ---- theme ----
const THEMES = ["auto", "light", "dark"];
function applyTheme(mode) {
  if (mode === "light" || mode === "dark") document.documentElement.setAttribute("data-theme", mode);
  else document.documentElement.removeAttribute("data-theme");
  $("theme-toggle").textContent = `Theme: ${mode}`;
}
function initTheme() {
  let mode = "auto";
  try {
    mode = localStorage.getItem("a7-theme") || "auto";
  } catch {
    mode = "auto";
  }
  if (!THEMES.includes(mode)) mode = "auto";
  applyTheme(mode);
  $("theme-toggle").addEventListener("click", () => {
    mode = THEMES[(THEMES.indexOf(mode) + 1) % THEMES.length];
    applyTheme(mode);
    try {
      localStorage.setItem("a7-theme", mode);
    } catch {
      /* private mode: the choice just is not remembered */
    }
  });
}

// ---- login ----
function showLogin(message) {
  $("app").hidden = true;
  $("login").hidden = false;
  csrf = "";
  const err = $("login-error");
  err.hidden = !message;
  err.textContent = message || "";
  $("login-code").focus();
}

async function login(code) {
  const r = await api.post("/api/login", { code });
  if (!r.ok) {
    showLogin(r.body.message || "Sign-in failed.");
    return;
  }
  csrf = r.body.csrf;
  $("login-code").value = "";
  $("login").hidden = true;
  $("app").hidden = false;
  await start();
}

// ---- app ----
async function start() {
  const r = await api.get("/api/schema");
  if (!r.ok) {
    showLogin(r.body.message || "Could not load the settings.");
    return;
  }
  schema = r.body;
  api.absent = schema.absentRevision;
  buildNav();
  if (!started) {
    started = true;
    window.addEventListener("hashchange", route);
  }
  await refreshChip();
  await route();
}

async function refreshChip() {
  const s = await api.get("/api/status");
  const chip = $("status-chip");
  if (s.ok && s.body.restartRequired) {
    chip.hidden = false;
    chip.className = "badge badge-warn";
    chip.textContent = "Restart required: /applysettings";
  } else chip.hidden = true;
}

const EXTRA = [
  ["templates", "Job templates", "Jobs"],
  ["personas", "Personas", "Personas and proposals"],
];

function buildNav() {
  const nav = $("nav");
  nav.replaceChildren();
  const link = (hash, text) => h("a", { href: `#/${hash}` }, text);
  nav.append(link("overview", "Overview"));
  const groups = new Map();
  for (const f of schema.forms) {
    const g = f.group || "Settings";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(link(`form/${f.id}`, f.title));
  }
  for (const [id, title, g] of EXTRA) {
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(link(id, title));
  }
  for (const [g, links] of groups) {
    nav.append(h("h2", {}, g));
    for (const l of links) nav.append(l);
  }
  nav.append(h("h2", {}, "Review"));
  nav.append(link("audit", "Audit log"));
}

function setCurrent() {
  const here = location.hash || "#/overview";
  for (const a of $("nav").querySelectorAll("a")) {
    if (a.getAttribute("href") === here) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

async function route() {
  if ($("app").hidden || !schema) return;
  const hash = (location.hash || "#/overview").slice(2);
  const main = $("main");
  main.replaceChildren(h("p", { class: "muted" }, "Loading..."));
  setCurrent();
  const page = (title, lede, body) => {
    main.replaceChildren(h("h1", {}, title), lede ? h("p", { class: "lede" }, lede) : null, body);
    main.focus();
  };
  const reload = () => route();
  try {
    await render(hash, page, reload);
  } catch (e) {
    page("Something went wrong", "", h("p", { class: "banner banner-error" }, "This page could not be shown. Reload it, or sign in again. (" + String(e && e.message ? e.message : e) + ")"));
  }
}

async function render(hash, page, reload) {
  if (hash === "overview") page("Overview", "What the agent runs, and what needs your attention.", await renderStatus(api));
  else if (hash === "audit") page("Audit log", "Every settings change, from the UI, Telegram and the model. Lines are hash-chained and can be checked with verify-audit.", await renderAudit(api));
  else if (hash === "templates") page("Job templates", "The jobs the agent may hand to Claude Code.", await renderTemplates(api, toast));
  else if (hash === "personas") page("Personas", "Modes with a narrower tool set.", await renderPersonas(api, toast, reload));
  else if (hash.startsWith("form/")) {
    const form = schema.forms.find((f) => f.id === hash.slice(5));
    if (!form) page("Not found", "", h("p", {}, "There is no such form."));
    else page(form.title, form.description, await securityForm(form, reload));
  } else page("Not found", "", h("p", {}, "There is no such page."));
}

async function securityForm(form, reload) {
  const isRunner = form.target === "jobrunner";
  const loaded = await api.get(isRunner ? "/api/jobrunner" : "/api/security");
  if (!loaded.ok) return h("p", { class: "banner banner-error" }, loaded.body.message || "Could not load these settings.");
  let revision = loaded.body.revision;
  const doc = loaded.body.doc;
  const value = {};
  if (isRunner) value.limits = doc.limits;
  // A section the file does not have yet shows the descriptor's defaults, so the form is never blank.
  else for (const s of form.section) value[s] = doc[s] !== undefined ? doc[s] : defaultValue(form.schema.properties[s]);

  const root = h("form", { class: "settings-form", autocomplete: "off" });
  for (const w of form.warnings || []) root.append(h("p", { class: "banner banner-warn" }, w));
  const messages = h("div", { "aria-live": "polite" });
  const save = h("button", { type: "submit", class: "btn btn-primary", disabled: true }, "Save changes");
  const reset = h("button", { type: "button", class: "btn", disabled: true }, "Discard changes");
  const rf = renderForm(form.schema, value, { onChange: () => { const d = rf.dirty(); save.disabled = !d; reset.disabled = !d; } });
  const ack = form.ack ? h("input", { type: "checkbox", id: "ack-box" }) : null;
  const panel = h("div", {});
  root.append(rf.element);
  if (ack) root.append(h("div", { class: "field" }, h("label", { class: "check", for: "ack-box" }, ack, h("span", {}, form.ack.text))));
  root.append(messages, panel, h("div", { class: "actions sticky-actions" }, save, reset));
  reset.addEventListener("click", reload);

  const showErrors = (res) => {
    messages.replaceChildren();
    const unplaced = rf.setErrors(res.body.issues || []);
    const lines = [...unplaced];
    if (lines.length > 0 || res.body.message) messages.append(issuesBanner(res.body.message || "Not saved.", lines));
  };

  const doSave = async () => {
    panel.replaceChildren();
    const v = rf.get();
    const body = isRunner ? { limits: v.limits, baseRevision: revision } : { formId: form.id, sections: v, baseRevision: revision, ...(ack ? { ack: ack.checked } : {}) };
    save.disabled = true;
    const res = await api.post(isRunner ? "/api/jobrunner/save" : "/api/security/save", body);
    if (res.ok) {
      revision = res.body.revision;
      rf.markClean();
      reset.disabled = true;
      rf.setErrors([]);
      messages.replaceChildren(h("p", { class: "banner banner-ok", role: "status" }, res.body.message || "Saved."));
      toast("Saved.", "ok");
      await refreshChip();
    } else if (res.status === 409) {
      messages.replaceChildren(h("div", { class: "banner banner-warn", role: "alert" }, h("p", {}, res.body.message), (() => {
        const b = h("button", { type: "button", class: "btn" }, "Reload the current settings");
        b.addEventListener("click", reload);
        return b;
      })()));
      save.disabled = false;
    } else {
      showErrors(res);
      save.disabled = false;
    }
  };

  root.addEventListener("submit", async (e) => {
    e.preventDefault();
    messages.replaceChildren();
    panel.replaceChildren();
    if (isRunner) return doSave();
    if (ack && !ack.checked) {
      messages.replaceChildren(issuesBanner("Tick the acknowledgment first.", [form.ack.text]));
      ack.focus();
      return;
    }
    const pre = await api.post("/api/security/preview", { sections: rf.get() });
    if (!pre.ok) return showErrors(pre);
    const p = pre.body;
    if (!p.valid) {
      const unplaced = rf.setErrors(p.issues);
      messages.replaceChildren(issuesBanner("These settings are not valid yet.", unplaced));
      return;
    }
    rf.setErrors([]);
    const notes = [...p.folderWarnings, ...p.invalidPersonas.map((x) => `The persona "${x.id}" would stop being usable: ${x.reasons.join("; ")}`), ...p.warnings];
    const confirm = h("button", { type: "button", class: "btn btn-primary" }, "Confirm and save");
    const cancel = h("button", { type: "button", class: "btn" }, "Keep editing");
    confirm.addEventListener("click", doSave);
    cancel.addEventListener("click", () => { panel.replaceChildren(); save.disabled = !rf.dirty(); });
    panel.replaceChildren(h("div", { class: "banner banner-info", role: "region", "aria-label": "Impact of this change" },
      h("strong", {}, "Before you save"),
      notes.length > 0 ? h("ul", {}, notes.map((n) => h("li", {}, n))) : h("p", {}, "Nothing else is affected."),
      h("p", { class: "small" }, "The agent uses a saved change after it restarts (send /applysettings in Telegram). This is only a preview: it does not block the save."),
      h("div", { class: "actions" }, confirm, cancel)));
    confirm.focus();
  });
  return root;
}

function boot() {
  initTheme();
  $("logout").addEventListener("click", async () => {
    await api.post("/api/logout", {});
    location.reload();
  });
  $("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = $("login-code").value.trim();
    if (code) void login(code);
  });
  const m = /(?:^#|&)code=([^&]+)/.exec(location.hash);
  if (m) {
    const code = decodeURIComponent(m[1]);
    history.replaceState(null, "", location.pathname + location.search); // the code leaves the address bar at once
    void login(code);
  } else showLogin("");
}

boot();
