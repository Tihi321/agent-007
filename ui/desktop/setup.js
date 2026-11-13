// Launcher page: first-run setup and settings. Plain DOM, no framework. Talks to the main process through window.launcherApi
// (see src/desktop/preload.cts). Secret values only go from here to the main process; they never come back.
"use strict";

const api = window.launcherApi;
const $ = (id) => document.getElementById(id);
const TERMS_URL = "https://www.anthropic.com/legal/consumer-terms";
const TITLES = { gateway: "Gateway", telegram: "Telegram agent", jobrunner: "Job runner" };

let state = null;
let usePicked = false;
let termsLoaded = false;

function setText(id, text) {
  $(id).textContent = text;
}

function showMsg(id, text, bad) {
  const el = $(id);
  el.textContent = text || "";
  el.className = `small ${bad ? "bad" : "ok"}`;
}

// The note under a service name: the error reason, or the job runner's isolation warning while it is on.
function describeNote(name, v) {
  if (name === "jobrunner" && (v.state === "running" || v.state === "starting")) return "On (not isolated)";
  if (v.state === "error") return v.reason || "";
  return "";
}

function renderServices(services) {
  const list = $("services");
  list.replaceChildren();
  for (const name of ["gateway", "telegram", "jobrunner"]) {
    const v = services[name];
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "name";
    const title = document.createElement("span");
    title.className = "svc-title";
    title.textContent = TITLES[name];
    label.append(title);
    const note = describeNote(name, v);
    if (note) {
      const sub = document.createElement("span");
      sub.className = "svc-note";
      sub.textContent = note;
      label.append(sub);
    }
    const pill = document.createElement("span");
    pill.className = `pill ${v.state}`;
    const dot = document.createElement("span");
    dot.className = "dot";
    pill.append(dot, document.createTextNode(v.state));
    li.append(label, pill);
    if (v.state === "error") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn small-btn";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => void api.retry(name));
      li.append(retry);
    }
    list.append(li);
  }
}

function render(s) {
  state = s;
  $("first-run").hidden = s.setupDone;
  $("dashboard").hidden = !s.setupDone;
  if (!s.setupDone) {
    const folder = s.pickedRoot || s.defaultRoot;
    setText("folder-path", folder);
    $("answers").hidden = Boolean(s.pickedRoot && s.pickedRootConfigured);
    setText(
      "folder-note",
      s.pickedRoot && s.pickedRootConfigured
        ? "This folder already holds a setup. It is used as it is: nothing in it is changed."
        : s.pickedRoot
          ? "A new setup is created in this folder."
          : "A new setup is created here. Pick another folder if you already have one.",
    );
    usePicked = Boolean(s.pickedRoot);
    return;
  }
  renderServices(s.services);
  $("open-gateway").disabled = s.services.gateway.state !== "running";
  $("new-claim").disabled = s.services.gateway.state !== "running";
  $("tg-toggle").checked = s.toggles.telegram;
  $("jr-toggle").checked = s.toggles.jobrunner;
  $("login-toggle").checked = s.toggles.launchAtLogin;
  setText("tg-hint", s.telegramReady ? "" : "Enter the bot token and your user id below first.");
  setText(
    "login-hint",
    (s.portable ? "Portable exe path that is registered: " : "Registered path: ") + s.loginItemPath + (s.portable ? ". If you move the exe, turn this off and on again." : "") + (s.isPackaged ? "" : " (not registered when run from source)"),
  );
  setText("key-state", s.hasProxyKey ? "a key is stored" : "no key stored");
  // the tick is loaded from the state once; later pushes must not clobber an unsaved tick (it starts unticked)
  if (!termsLoaded) $("u-terms").checked = s.claudeTerms;
  termsLoaded = true;
  setText("root-path", s.root);
  setText("data-note", "The agent is never allowed to write to this folder. The same folder is used by the installer and the portable exe.");
}

async function refresh() {
  render(await api.getState());
}

function readAnswers(prefix) {
  const out = {};
  const key = $(`${prefix}proxy-key`).value.trim();
  if (key) out.proxyApiKey = key;
  out.acceptClaudeTerms = $(prefix === "" ? "terms" : "u-terms").checked;
  const token = $(`${prefix}tg-token`).value.trim();
  const user = $(`${prefix}tg-user`).value.trim();
  if (token || user) out.telegram = { botToken: token, allowedUserId: user };
  return out;
}

function clearSecrets(prefix) {
  for (const id of [`${prefix}proxy-key`, `${prefix}tg-token`, `${prefix}tg-user`]) $(id).value = "";
}

$("terms-link").addEventListener("click", (e) => {
  e.preventDefault();
  void api.openExternal(TERMS_URL);
});

$("pick-folder").addEventListener("click", async () => {
  const r = await api.pickFolder();
  if (r && r.ok) await refresh();
});

$("finish").addEventListener("click", async () => {
  const err = $("setup-error");
  err.hidden = true;
  $("finish").disabled = true;
  try {
    const answers = usePicked && state.pickedRootConfigured ? {} : readAnswers("");
    const r = await api.runSetup({ ...answers, useRoot: usePicked });
    if (!r.ok) {
      err.textContent = r.message || "Setup failed.";
      err.hidden = false;
      return;
    }
    clearSecrets("");
    await refresh();
  } finally {
    $("finish").disabled = false;
  }
});

// Show only what matches the claim state: the code and its intro when there is a code, otherwise just the message.
function showClaimState(hasCode, ownerExists) {
  $("claim-intro").hidden = !hasCode;
  $("claim-code-wrap").hidden = !hasCode;
  $("copy-claim").hidden = !hasCode;
  $("claim-actions").hidden = ownerExists;
}

api.onClaimCode((c) => {
  const box = $("claim");
  if (c && c.code) {
    box.hidden = false;
    showClaimState(true, false);
    setText("claim-code", c.code);
    setText("claim-msg", "");
  } else if (c && c.ownerExists) {
    box.hidden = false;
    showClaimState(false, true);
    setText("claim-code", "");
    setText("claim-msg", "An owner already exists, so no claim code is needed. Use Open agent-007 to sign in.");
  } else if (c && c.message) {
    box.hidden = false;
    showClaimState(false, false);
    setText("claim-code", "");
    setText("claim-msg", c.message);
  }
});

$("copy-claim").addEventListener("click", async () => {
  const r = await api.copyClaimCode();
  setText("claim-msg", r.ok ? "Copied." : r.message || "");
});
$("open-claim").addEventListener("click", () => void api.openClaimPage());
$("open-gateway").addEventListener("click", () => void api.openGateway());
$("new-claim").addEventListener("click", () => void api.showClaimCode());
$("open-logs").addEventListener("click", () => void api.openPath("logs"));
$("open-data").addEventListener("click", () => void api.openPath("data"));

async function toggle(name, checkboxId) {
  const box = $(checkboxId);
  const r = await api.setToggles({ [name]: box.checked });
  showMsg("toggle-msg", r.ok ? "" : r.message || "", !r.ok);
  await refresh();
}
$("tg-toggle").addEventListener("change", () => void toggle("telegram", "tg-toggle"));
$("jr-toggle").addEventListener("change", () => void toggle("jobrunner", "jr-toggle"));
$("login-toggle").addEventListener("change", () => void toggle("launchAtLogin", "login-toggle"));

$("save-secrets").addEventListener("click", async () => {
  const r = await api.updateSecrets(readAnswers("u-"));
  if (r.ok) clearSecrets("u-");
  showMsg("secrets-msg", r.ok ? "Saved." : r.message || "Could not save.", !r.ok);
  await refresh();
});

api.onState((s) => render(s));
void refresh();
