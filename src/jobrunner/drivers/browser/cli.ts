/**
 * Runner CLI subcommands (REQ-0014 T3), run by the MAIN user in a terminal (or the desktop tray item):
 *   browser-install                      download Chromium into the runner-owned folder, after a y/N question on the terminal
 *   browser-login [--url <https url>]    open the isolated profile HEADED so the user logs in by hand (no classifier)
 * Both take `--config <jobrunner.json>`. Exit codes: 0 ok, 1 error, 2 config / not ready, 3 profile busy.
 * Never reachable by the model: not an IPC op, not a Telegram command.
 */
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { readBrowserSettings } from "../../../settings/browser.js";
import type { BrowserSettings } from "../../../settings/browser.js";
import { DEFAULT_PROGRAM_DATA_JOBRUNNER } from "../../limits.js";
import type { JobRunnerConfig } from "../../limits.js";
import type { BrowserBackend } from "./backend.js";
import { startEgressProxy } from "./egress.js";
import type { EgressOptions, EgressProxy } from "./egress.js";
import type { ChromiumInstaller } from "./index.js";
import { APPROX_DOWNLOAD_SIZE, createChromiumInstaller, readPlaywrightInfo, resolveBrowserPaths } from "./install.js";
import type { PlaywrightInfo } from "./install.js";
import { acquireProfileLock, ProfileBusyError } from "./lock.js";
import { PlaywrightBackend } from "./playwright.js";

export type BrowserCliSub = "browser-install" | "browser-login";
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_CONFIG = 2;
export const EXIT_BUSY = 3;

/** Test seams. Everything is optional; production passes only (sub, argv). */
export interface BrowserCliDeps {
  out?: (line: string) => void;
  loadConfig?: (path: string) => JobRunnerConfig | Promise<JobRunnerConfig>;
  isTTY?: boolean;
  ask?: (question: string) => Promise<string>;
  installer?: ChromiumInstaller;
  info?: PlaywrightInfo;
  settings?: () => BrowserSettings;
  backend?: BrowserBackend;
  egress?: (o: EgressOptions) => Promise<EgressProxy>;
  /** Resolves when the login window closes; default waits for the session's close event or SIGINT. */
  waitForExit?: (onClose: (cb: () => void) => void) => Promise<void>;
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function terminalAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => (rl.close(), res(a))));
}

/**
 * Entry point for main.ts: `runBrowserCli("browser-install" | "browser-login", argv.slice(1))`.
 * Resolves with the process exit code; it never calls `process.exit`.
 */
export async function runBrowserCli(sub: BrowserCliSub, argv: readonly string[], deps: BrowserCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(l + "\n"));
  const configPath = resolve(argValue(argv, "--config") ?? join(DEFAULT_PROGRAM_DATA_JOBRUNNER, "jobrunner.json"));
  let config: JobRunnerConfig;
  try {
    const load = deps.loadConfig ?? (async (p: string) => (await import("../../main.js")).loadJobRunnerConfig(p));
    config = await load(configPath);
  } catch (e) {
    out(`${sub}: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_CONFIG;
  }
  const paths = resolveBrowserPaths(config.paths.dataDir, config.engines.browser);
  const installer = deps.installer ?? createChromiumInstaller({ browsersDir: paths.browsersDir, ...(deps.info ? { info: deps.info } : {}) });
  try {
    const info = deps.info ?? readPlaywrightInfo();
    if (sub === "browser-install") return await install(out, deps, installer, info, paths.browsersDir);
    return await login(out, argv, deps, config, installer, paths);
  } catch (e) {
    out(`${sub}: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_ERROR;
  }
}

async function install(out: (l: string) => void, deps: BrowserCliDeps, installer: ChromiumInstaller, info: PlaywrightInfo, dir: string): Promise<number> {
  if (installer.status().installed) {
    out(`Chromium ${info.chromiumRevision} is already installed in ${dir}.`);
    return EXIT_OK;
  }
  const tty = deps.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!tty) {
    out("browser-install asks for confirmation on the terminal; run it in an interactive terminal.");
    return EXIT_CONFIG;
  }
  out(`This downloads Chromium ${info.chromiumRevision} (playwright-core ${info.version}) from Playwright's download CDN. It is the only download the project makes at run time.`);
  const answer = await (deps.ask ?? terminalAsk)(`Download Chromium ${info.chromiumRevision} (${APPROX_DOWNLOAD_SIZE}) into ${dir}? [y/N] `);
  if (!/^y(es)?$/i.test(answer.trim())) {
    out("Cancelled. Nothing was downloaded.");
    return EXIT_CONFIG;
  }
  out("Downloading...");
  await installer.install(new AbortController().signal);
  out("Chromium is installed.");
  return EXIT_OK;
}

async function login(
  out: (l: string) => void,
  argv: readonly string[],
  deps: BrowserCliDeps,
  config: JobRunnerConfig,
  installer: ChromiumInstaller,
  paths: ReturnType<typeof resolveBrowserPaths>,
): Promise<number> {
  const url = argValue(argv, "--url");
  if (url !== undefined) {
    let ok = false;
    try {
      ok = new URL(url).protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) {
      out("browser-login: --url must be an https URL.");
      return EXIT_CONFIG;
    }
  }
  const settings = deps.settings ?? ((): BrowserSettings => readBrowserSettings(config.paths.settingsDir));
  let acknowledged = false;
  try {
    acknowledged = settings().acknowledged === true;
  } catch (e) {
    out(`browser-login: the browser settings could not be read: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_CONFIG;
  }
  if (!acknowledged) {
    out("browser-login: tick the acknowledgment in the settings UI (Browser form) first.");
    return EXIT_CONFIG;
  }
  if (!installer.status().installed) {
    out("browser-login: Chromium is not installed. Run browser-install first.");
    return EXIT_CONFIG;
  }
  let lock;
  try {
    lock = acquireProfileLock(paths.lockFile);
  } catch (e) {
    if (e instanceof ProfileBusyError) {
      out("browser-login: a browser job is running; wait for it or cancel it.");
      return EXIT_BUSY;
    }
    throw e;
  }
  let proxy: EgressProxy | undefined;
  let session: Awaited<ReturnType<BrowserBackend["launch"]>> | undefined;
  try {
    proxy = await (deps.egress ?? startEgressProxy)({});
    const backend = deps.backend ?? new PlaywrightBackend({ settings });
    session = await backend.launch({
      profileDir: paths.profileDir,
      headless: false,
      browsersDir: paths.browsersDir,
      proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
      viewport: { width: 1280, height: 800 },
    });
    if (url !== undefined) await session.goto(url).catch((e: unknown) => out(`The page could not be opened: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`));
    out("The browser is open. Log in by hand, then close the window to finish. The agent never sees what you type.");
    const s = session;
    const wait =
      deps.waitForExit ??
      ((onClose: (cb: () => void) => void) =>
        new Promise<void>((res) => {
          onClose(res);
          process.once("SIGINT", () => res());
        }));
    await wait((cb) => s.onClose(cb));
    return EXIT_OK;
  } finally {
    await session?.close().catch(() => undefined);
    await proxy?.close().catch(() => undefined);
    lock.release();
  }
}
