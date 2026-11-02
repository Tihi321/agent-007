/**
 * Electron entry of the agent-007 desktop launcher (Windows, personal mode). Electron is the launcher only: the web gateway, the
 * Telegram agent and the job runner run as separate node.exe processes under `Supervisor`. See the ticket plan (T4, T7).
 */
import { app, clipboard, dialog, ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureJobrunner, hasTelegramPlaceholders, personalPaths, personalStatus, setupPersonal, updatePersonal } from "../setup/personal.js";
import type { PersonalAnswers } from "../setup/personal.js";
import {
  defaultHome,
  JOBRUNNER_IPC_PORT,
  JOBRUNNER_UI_PORT,
  portOverride,
  readLauncherSettings,
  resolveLayout,
  resolveRoot,
  servicePaths,
  setupDone,
  writeLauncherSettings,
  writeRootPointer,
} from "./paths.js";
import type { LauncherSettings } from "./paths.js";
import { probePort } from "./ports.js";
import { Supervisor } from "./supervisor.js";
import type { SupervisorState } from "./supervisor.js";
import { TrayController } from "./tray.js";
import type { SvcName, SvcView } from "./tray.js";
import { LauncherWindow } from "./window.js";

const SERVICES: readonly SvcName[] = ["gateway", "telegram", "jobrunner"];
const TERMS_URL = "https://www.anthropic.com/legal/consumer-terms";
const CLAIM_TTL_MS = 10 * 60 * 1000;
const QUIT_CAP_MS = 15_000;

const here = dirname(fileURLToPath(import.meta.url));
const layout = resolveLayout({ desktopDir: here, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
const sp = servicePaths(layout);

// The pointer file and Electron's own data always live in the default location.
app.setName("agent-007");
app.setPath("userData", join(defaultHome(), "launcher", "electron"));

let root = resolveRoot().root;
let settings: LauncherSettings = readLauncherSettings(root);
let pendingRoot: string | undefined; // a folder the user picked in the dialog, not yet used
let quitting = false;
let lastClaim: { code: string; expiresAt: number } | undefined;

const views: Record<SvcName, SvcView> = { gateway: { state: "off" }, telegram: { state: "off" }, jobrunner: { state: "off" } };
let sups: Partial<Record<SvcName, Supervisor>> = {};

function gatewayPort(): number {
  return portOverride() ?? settings.port;
}

// ---- launcher log (never a secret, never a claim code or sign-in link) ----
function log(message: string): void {
  try {
    const file = join(root, "logs", "launcher.log");
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > 2 * 1024 * 1024) renameSync(file, `${file}.1`);
    } catch {
      /* no log yet */
    }
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* logging must never crash the launcher */
  }
  if (!app.isPackaged) process.stdout.write(`${message}\n`);
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith("ELECTRON_") && v !== undefined) env[k] = v;
  return env;
}

/** Runs a node script to completion (owner-code, settings-link). Resolves with exit code and stdout; never logs the output. */
function runNode(script: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(layout.nodeExe, [script, ...args], { cwd: layout.appDir, env: cleanEnv(), windowsHide: true, timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- window, tray, state ----
const win = new LauncherWindow({
  htmlPath: join(layout.uiDir, "setup.html"),
  preloadPath: join(here, "preload.cjs"),
  iconPath: join(layout.assetsDir, "icon.png"),
  onConsole: (level, message, source) => log(`[page ${level}] ${message} (${source})`),
});
let tray: TrayController | undefined;

const loginItemPath = (): string => process.env["PORTABLE_EXECUTABLE_FILE"] ?? process.execPath;

/** What the page may see. No secret value, only booleans. */
function buildState(): Record<string, unknown> {
  const done = setupDone(root);
  const resolved = resolveRoot();
  const status = done ? personalStatus(root) : { hasProxyKey: false, claudeTermsAccepted: false };
  return {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    portable: Boolean(process.env["PORTABLE_EXECUTABLE_FILE"]),
    setupDone: done,
    root,
    defaultRoot: defaultHome(),
    rootSource: resolved.source,
    pickedRoot: pendingRoot ?? null,
    pickedRootConfigured: pendingRoot ? setupDone(pendingRoot) : false,
    port: gatewayPort(),
    toggles: { telegram: settings.telegram, jobrunner: settings.jobrunner, launchAtLogin: settings.launchAtLogin },
    loginItemPath: loginItemPath(),
    hasProxyKey: status.hasProxyKey,
    claudeTerms: status.claudeTermsAccepted,
    telegramReady: done ? !hasTelegramPlaceholders(root) : false,
    claimPending: Boolean(lastClaim && lastClaim.expiresAt > Date.now()),
    jobrunnerPorts: [JOBRUNNER_IPC_PORT, JOBRUNNER_UI_PORT],
    services: { gateway: views.gateway, telegram: views.telegram, jobrunner: views.jobrunner },
  };
}

function pushState(): void {
  tray?.update({
    port: gatewayPort(),
    setupDone: setupDone(root),
    gateway: views.gateway,
    telegram: views.telegram,
    jobrunner: views.jobrunner,
    launchAtLogin: settings.launchAtLogin,
  });
  win.send("launcher:state", buildState());
}

function setView(name: SvcName, v: SvcView): void {
  views[name] = v;
  pushState();
}

function saveSettings(): void {
  writeLauncherSettings(root, settings);
}

function applyLoginItem(on: boolean): void {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: on, path: loginItemPath(), args: ["--hidden"] });
  } catch (e) {
    log(`could not update launch at login: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---- services ----
function superviseState(name: SvcName): (s: SupervisorState) => void {
  return (s) => {
    if (quitting) return;
    if (s.state === "starting") setView(name, { state: "starting" });
    else if (s.state === "running") {
      if (name === "gateway") watchGatewayReady(false);
      else setView(name, { state: "running" });
    } else if (s.state === "stopped") setView(name, { state: "off" });
    else {
      log(`${name}: error: ${s.reason}${s.lastStderrLine ? ` | ${s.lastStderrLine}` : ""}`);
      setView(name, { state: "error", reason: s.reason, ...(name === "gateway" && s.reason === "already running elsewhere" ? { elsewhere: true } : {}) });
    }
  };
}

function supervisorFor(name: SvcName): Supervisor {
  const existing = sups[name];
  if (existing) return existing;
  const p = personalPaths(root);
  const common = { cwd: layout.appDir, nodeExe: layout.nodeExe, logFile: join(root, "logs", `${name}.log`), onState: superviseState(name) };
  let sup: Supervisor;
  if (name === "gateway") {
    sup = new Supervisor({ ...common, name, script: sp.web, args: ["--config", p.configPath, "--secrets", p.secretsPath, "--mode", "local", "--port", String(gatewayPort())] });
  } else if (name === "telegram") {
    sup = new Supervisor({ ...common, name, script: sp.agent, args: ["--config", p.configPath, "--secrets", p.secretsPath, "--personal"] });
  } else {
    sup = new Supervisor({ ...common, name, script: sp.jobrunner, args: ["--config", join(root, "jobrunner", "jobrunner.json")] });
  }
  sups[name] = sup;
  return sup;
}

let readyWatching = false;
let openOnReady = false;

/** The supervisor says the process exists; the gateway is ready when its port answers as an agent-007 gateway. */
function watchGatewayReady(open: boolean): void {
  openOnReady = openOnReady || open;
  if (readyWatching) return;
  readyWatching = true;
  void (async () => {
    try {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !quitting) {
        if (views.gateway.state === "error" || views.gateway.state === "off") return;
        if ((await probePort(gatewayPort(), "127.0.0.1", 1000)) === "agent007") {
          const open = openOnReady;
          openOnReady = false;
          setView("gateway", { state: "running" });
          await onGatewayReady(open);
          return;
        }
        await delay(400);
      }
      if (!quitting && views.gateway.state === "starting") setView("gateway", { state: "error", reason: "did not start in time" });
    } finally {
      readyWatching = false;
    }
  })();
}

type ClaimResult = { kind: "code"; code: string } | { kind: "owner" } | { kind: "error"; message: string };

async function issueClaim(): Promise<ClaimResult> {
  const r = await runNode(sp.webCli, ["owner-code", "--data-dir", personalPaths(root).dataDir]);
  if (r.code === 0) {
    const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const code = lines[1];
    if (code && /^[A-Za-z0-9_-]{8,}$/.test(code)) {
      lastClaim = { code, expiresAt: Date.now() + CLAIM_TTL_MS };
      return { kind: "code", code };
    }
    return { kind: "error", message: "could not read the claim code" };
  }
  if (/owner already exists/i.test(r.stdout)) return { kind: "owner" };
  return { kind: "error", message: "could not create a claim code" };
}

function sendClaim(result: ClaimResult): void {
  if (result.kind === "code") win.send("launcher:claimCode", { code: result.code, expiresAt: lastClaim?.expiresAt ?? 0 });
  else win.send("launcher:claimCode", { code: null, ownerExists: result.kind === "owner", message: result.kind === "error" ? result.message : "" });
}

/** Gateway is up: show the claim code (window only) while there is no owner, else open the browser unless started hidden. */
async function onGatewayReady(open: boolean): Promise<void> {
  const claim = await issueClaim();
  if (claim.kind === "code") {
    win.show();
    sendClaim(claim);
    pushState();
    log("gateway ready; no owner yet, claim code shown in the window");
    return;
  }
  if (claim.kind === "error") log(`gateway ready; ${claim.message}`);
  else log("gateway ready");
  if (open) void shell.openExternal(`http://localhost:${gatewayPort()}`);
}

async function portsBlocked(ports: readonly number[]): Promise<number | undefined> {
  for (const p of ports) if ((await probePort(p)) !== "free") return p;
  return undefined;
}

async function startService(name: SvcName, open = true): Promise<void> {
  if (quitting) return;
  const cur = views[name].state;
  if (cur === "starting" || cur === "running") return;
  if (!setupDone(root)) return;
  if (name === "gateway") {
    setView("gateway", { state: "starting" });
    const state = await probePort(gatewayPort());
    if (state === "agent007") {
      setView("gateway", { state: "error", reason: "already running elsewhere", elsewhere: true });
      return;
    }
    if (state === "other") {
      setView("gateway", { state: "error", reason: `Port ${gatewayPort()} in use` });
      return;
    }
    openOnReady = open;
    supervisorFor("gateway").start();
    return;
  }
  if (name === "telegram") {
    if (hasTelegramPlaceholders(root)) {
      setView("telegram", { state: "error", reason: "Telegram token or user id not set" });
      return;
    }
    supervisorFor("telegram").start();
    return;
  }
  // job runner
  setView("jobrunner", { state: "starting" });
  try {
    ensureJobrunner(root, { resourcesDir: layout.appDir });
  } catch (e) {
    log(`job runner setup failed: ${e instanceof Error ? e.message : String(e)}`);
    setView("jobrunner", { state: "error", reason: "could not prepare the job runner files" });
    return;
  }
  const blocked = await portsBlocked([JOBRUNNER_IPC_PORT, JOBRUNNER_UI_PORT]);
  if (blocked !== undefined) {
    setView("jobrunner", { state: "error", reason: `Port ${blocked} in use` });
    return;
  }
  supervisorFor("jobrunner").start();
}

async function stopService(name: SvcName): Promise<void> {
  const sup = sups[name];
  if (sup) await sup.stop(10_000);
  else if (!quitting) setView(name, { state: "off" });
}

async function restartService(name: SvcName): Promise<void> {
  await stopService(name);
  if (name === "jobrunner" && !settings.jobrunner) return; // the toggle is off: the job runner must not start
  await startService(name);
}

function bootServices(open: boolean): void {
  void startService("gateway", open);
  if (settings.telegram) void startService("telegram");
  if (settings.jobrunner) void startService("jobrunner");
}

// ---- dialogs ----
async function confirmJobrunner(): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    title: "Turn on the job runner?",
    message: "Turn on the job runner?",
    detail:
      "In personal mode the agent runs as you. Jobs it starts are not isolated from your account, and the agent can in principle change the settings the job runner trusts.\n\n" +
      "The isolation of the hardened install (I17) is gone, and the protection of the settings files (I25) rests on the path policy only. " +
      "Turn this on only if you accept that. If you need isolation, use the hardened install.",
    buttons: ["Turn on", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const parent = win.browserWindow;
  const r = parent && parent.isVisible() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return r.response === 0;
}

async function say(message: string, detail: string): Promise<void> {
  const options: Electron.MessageBoxOptions = { type: "info", title: "agent-007", message, detail, buttons: ["OK"] };
  const parent = win.browserWindow;
  if (parent && parent.isVisible()) await dialog.showMessageBox(parent, options);
  else await dialog.showMessageBox(options);
}

// ---- toggles ----
interface Result {
  ok: boolean;
  message?: string;
  cancelled?: boolean;
}

async function applyToggles(t: { telegram?: boolean; jobrunner?: boolean; launchAtLogin?: boolean }): Promise<Result> {
  if (!setupDone(root)) return { ok: false, message: "Finish the setup first." };
  if (t.telegram !== undefined && t.telegram !== settings.telegram) {
    if (t.telegram) {
      if (hasTelegramPlaceholders(root)) {
        await say("Telegram is not set up", "The bot token or your Telegram user id is still a placeholder. Enter both in the settings window (Telegram section), save, and then turn Telegram on.");
        return { ok: false, message: "Enter the Telegram bot token and your user id first." };
      }
      settings = { ...settings, telegram: true };
      saveSettings();
      void startService("telegram");
    } else {
      settings = { ...settings, telegram: false };
      saveSettings();
      await stopService("telegram");
    }
  }
  if (t.jobrunner !== undefined && t.jobrunner !== settings.jobrunner) {
    if (t.jobrunner) {
      if (!(await confirmJobrunner())) {
        pushState();
        return { ok: false, cancelled: true, message: "The job runner stays off." };
      }
      settings = { ...settings, jobrunner: true };
      saveSettings();
      void startService("jobrunner");
    } else {
      settings = { ...settings, jobrunner: false };
      saveSettings();
      await stopService("jobrunner");
    }
  }
  if (t.launchAtLogin !== undefined && t.launchAtLogin !== settings.launchAtLogin) {
    settings = { ...settings, launchAtLogin: t.launchAtLogin };
    saveSettings();
    applyLoginItem(t.launchAtLogin);
  }
  pushState();
  return { ok: true };
}

async function openJobrunnerUi(): Promise<void> {
  const r = await runNode(sp.jobrunner, ["settings-link", "--config", join(root, "jobrunner", "jobrunner.json")]);
  const link = r.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("http://"));
  if (r.code !== 0 || !link) {
    log("job runner: could not get a settings link");
    return;
  }
  try {
    const u = new URL(link);
    if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) await shell.openExternal(u.href);
  } catch {
    log("job runner: the settings link was not a loopback URL; not opened");
  }
}

/** Start from the tray: the job runner warning shows every time the toggle goes from off to on. */
async function trayStart(s: SvcName): Promise<void> {
  if (s === "gateway" || settings[s]) await startService(s);
  else await applyToggles(s === "telegram" ? { telegram: true } : { jobrunner: true });
}

async function trayStop(s: SvcName): Promise<void> {
  if (s === "gateway" || !settings[s]) await stopService(s);
  else await applyToggles(s === "telegram" ? { telegram: false } : { jobrunner: false });
}

function openGateway(): void {
  void shell.openExternal(`http://localhost:${gatewayPort()}`);
}

function showClaimCode(): void {
  win.show();
  void issueClaim().then((c) => {
    sendClaim(c);
    pushState();
  });
}

function openFolder(target: "logs" | "data"): void {
  const dir = target === "logs" ? join(root, "logs") : root;
  mkdirSync(dir, { recursive: true });
  void shell.openPath(dir);
}

// ---- answers from the page ----
function parseAnswers(raw: unknown): PersonalAnswers {
  const out: PersonalAnswers = {};
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r["proxyApiKey"] === "string" && r["proxyApiKey"].trim() !== "") out.proxyApiKey = r["proxyApiKey"].trim();
  if (typeof r["acceptClaudeTerms"] === "boolean") out.acceptClaudeTerms = r["acceptClaudeTerms"];
  const t = r["telegram"];
  if (typeof t === "object" && t !== null) {
    const tt = t as Record<string, unknown>;
    const token = typeof tt["botToken"] === "string" ? tt["botToken"].trim() : "";
    const id = Number(typeof tt["allowedUserId"] === "string" ? tt["allowedUserId"].trim() : tt["allowedUserId"]);
    if (token !== "" || (tt["allowedUserId"] !== undefined && tt["allowedUserId"] !== "")) {
      if (token === "") throw new Error("Enter the Telegram bot token as well as the user id.");
      if (!Number.isInteger(id) || id <= 0) throw new Error("The Telegram user id must be a positive whole number.");
      out.telegram = { botToken: token, allowedUserId: id };
    }
  }
  return out;
}

const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : String(e) });

async function runSetup(raw: unknown): Promise<Result> {
  try {
    const useRoot = typeof raw === "object" && raw !== null && (raw as Record<string, unknown>)["useRoot"] === true && pendingRoot !== undefined;
    const target = useRoot ? (pendingRoot as string) : root;
    if (!setupDone(target)) setupPersonal({ root: target, resourcesDir: layout.appDir, answers: parseAnswers(raw) });
    if (useRoot) writeRootPointer(target);
    if (target !== root) {
      root = target;
      settings = readLauncherSettings(root);
      sups = {};
    }
    pendingRoot = undefined;
    log("setup done");
    pushState();
    bootServices(false);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---- app wiring ----
function setupIpc(): void {
  const handle = <R>(channel: string, run: (...args: unknown[]) => Promise<R> | R): void => {
    ipcMain.handle(`launcher:${channel}`, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const url = event.senderFrame?.url ?? "";
      if (!win.isOwnUrl(url)) {
        log(`rejected IPC ${channel} from '${url}'`);
        throw new Error("Forbidden");
      }
      return run(...args);
    });
  };
  handle("getState", () => buildState());
  handle("pickFolder", async () => {
    const options: Electron.OpenDialogOptions = { title: "Choose the agent-007 data folder", properties: ["openDirectory", "createDirectory"] };
    const parent = win.browserWindow;
    const r = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const picked = r.filePaths[0];
    if (r.canceled || !picked) return { ok: false };
    pendingRoot = picked;
    pushState();
    return { ok: true, path: picked, configured: setupDone(picked) };
  });
  handle("runSetup", (answers) => runSetup(answers));
  handle("updateSecrets", (answers): Result => {
    try {
      updatePersonal(root, parseAnswers(answers));
      pushState();
      return { ok: true };
    } catch (e) {
      return fail(e);
    }
  });
  handle("setToggles", (t) => {
    const r = (typeof t === "object" && t !== null ? t : {}) as Record<string, unknown>;
    const pick = (k: string): boolean | undefined => (typeof r[k] === "boolean" ? (r[k] as boolean) : undefined);
    const toggles: { telegram?: boolean; jobrunner?: boolean; launchAtLogin?: boolean } = {};
    for (const k of ["telegram", "jobrunner", "launchAtLogin"] as const) {
      const v = pick(k);
      if (v !== undefined) toggles[k] = v;
    }
    return applyToggles(toggles);
  });
  handle("showClaimCode", async (): Promise<Result> => {
    if (views.gateway.state !== "running") return { ok: false, message: "The gateway is not running." };
    sendClaim(await issueClaim());
    pushState();
    return { ok: true };
  });
  handle("copyClaimCode", (): Result => {
    if (!lastClaim || lastClaim.expiresAt <= Date.now()) return { ok: false, message: "No current claim code." };
    clipboard.writeText(lastClaim.code);
    return { ok: true };
  });
  handle("openClaimPage", (): Result => {
    void shell.openExternal(`http://localhost:${gatewayPort()}/claim`);
    return { ok: true };
  });
  handle("openGateway", (): Result => {
    openGateway();
    return { ok: true };
  });
  handle("openPath", (target): Result => {
    if (target !== "logs" && target !== "data") return { ok: false, message: "Invalid target" };
    openFolder(target);
    return { ok: true };
  });
  handle("openExternal", (url): Result => {
    if (url !== TERMS_URL) return { ok: false, message: "This link is not allowed." };
    void shell.openExternal(TERMS_URL);
    return { ok: true };
  });
  handle("retry", async (service): Promise<Result> => {
    if (service !== "gateway" && service !== "telegram" && service !== "jobrunner") return { ok: false, message: "Invalid service" };
    await restartService(service);
    return { ok: true };
  });
}

async function main(): Promise<void> {
  process.on("uncaughtException", (e) => log(`uncaught exception: ${e.stack ?? e.message}`));
  process.on("unhandledRejection", (r) => log(`unhandled rejection: ${r instanceof Error ? (r.stack ?? r.message) : String(r)}`));

  app.on("second-instance", () => {
    if (setupDone(root) && views.gateway.state === "running") openGateway();
    else win.show();
  });
  // The app lives in the tray: closing the window must not quit.
  app.on("window-all-closed", () => undefined);

  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    win.markQuitting();
    void (async () => {
      try {
        await Promise.race([Promise.all(SERVICES.map((n) => stopService(n).catch((e: unknown) => log(`stop ${n} failed: ${String(e)}`)))), delay(QUIT_CAP_MS)]);
      } finally {
        tray?.destroy();
        app.exit(0);
      }
    })();
  });

  await app.whenReady();
  tray = new TrayController({
    assetsDir: layout.assetsDir,
    openGateway,
    showClaimCode,
    openSettings: () => win.show(),
    start: (s) => void trayStart(s),
    stop: (s) => void trayStop(s),
    restart: (s) => void restartService(s),
    retry: (s) => void restartService(s),
    openJobrunnerUi: () => void openJobrunnerUi(),
    openLogs: () => openFolder("logs"),
    openData: () => openFolder("data"),
    setLaunchAtLogin: (on) => void applyToggles({ launchAtLogin: on }),
    quit: () => app.quit(),
  });
  setupIpc();
  pushState();

  const hidden = process.argv.includes("--hidden") || (process.platform !== "linux" && app.getLoginItemSettings().wasOpenedAtLogin);
  if (settings.launchAtLogin) applyLoginItem(true); // re-registers the path, which heals an entry left by a moved portable exe
  if (!setupDone(root)) win.show();
  else bootServices(!hidden);
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  main().catch((e) => {
    log(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    app.exit(1);
  });
}
