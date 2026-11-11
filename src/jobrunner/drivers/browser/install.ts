/**
 * Chromium install (REQ-0014 T3). The one runtime download the project makes (owner-confirmed first). It runs the pinned
 * `playwright-core` CLI as a child of this process: `node cli.js install chromium` with PLAYWRIGHT_BROWSERS_PATH set to the
 * runner-owned folder. That command fetches both Chromium (headed, for browser-login) and the headless shell (for jobs).
 * `status()` never imports playwright-core: it checks the executables at the paths the registry uses.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ChromiumInstaller } from "./index.js";

export interface PlaywrightInfo {
  version: string;
  /** Chromium revision from `browsers.json`. */
  chromiumRevision: string;
  /** Absolute path of the package folder. */
  dir: string;
}

export function readPlaywrightInfo(): PlaywrightInfo {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("playwright-core/package.json");
  const dir = dirname(pkgPath);
  const version = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
  const browsers = JSON.parse(readFileSync(join(dir, "browsers.json"), "utf8")) as { browsers: Array<{ name: string; revision: string }> };
  const chromium = browsers.browsers.find((b) => b.name === "chromium");
  return { version, chromiumRevision: chromium?.revision ?? "unknown", dir };
}

export const APPROX_DOWNLOAD_SIZE = "about 150-300 MB";
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const STDERR_TAIL = 1500;

interface Layout {
  headed: string;
  headless: string;
}

/** Where `playwright-core` puts the executables (registry: `<dir>/<name with _>-<revision>/<folder>/<exe>`). */
export function executablePaths(browsersDir: string, revision: string, platform: NodeJS.Platform = process.platform): Layout | undefined {
  if (platform === "win32") {
    return {
      headed: join(browsersDir, `chromium-${revision}`, "chrome-win64", "chrome.exe"),
      headless: join(browsersDir, `chromium_headless_shell-${revision}`, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
    };
  }
  if (platform === "linux") {
    return {
      headed: join(browsersDir, `chromium-${revision}`, "chrome-linux64", "chrome"),
      headless: join(browsersDir, `chromium_headless_shell-${revision}`, "chrome-headless-shell-linux64", "chrome-headless-shell"),
    };
  }
  return undefined;
}

export interface InstallerOptions {
  browsersDir: string;
  /** Test seams. */
  info?: PlaywrightInfo;
  spawnFn?: typeof spawn;
  execPath?: string;
  timeoutMs?: number;
}

export function createChromiumInstaller(o: InstallerOptions): ChromiumInstaller {
  const info = (): PlaywrightInfo => (o.info ??= readPlaywrightInfo());
  const status = (): { installed: boolean; executable?: string } => {
    const p = executablePaths(o.browsersDir, info().chromiumRevision);
    if (!p) return { installed: false };
    return existsSync(p.headed) && existsSync(p.headless) ? { installed: true, executable: p.headed } : { installed: false };
  };
  return {
    status,
    install(signal: AbortSignal): Promise<void> {
      const pw = info();
      const run = (o.spawnFn ?? spawn)(o.execPath ?? process.execPath, [join(pw.dir, "cli.js"), "install", "chromium"], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: o.browsersDir },
      });
      return new Promise<void>((resolve, reject) => {
        let tail = "";
        let done = false;
        const finish = (err?: Error): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          if (err) reject(err);
          else if (!status().installed) reject(new Error(`the Chromium download finished but no browser was found in ${o.browsersDir}`));
          else resolve();
        };
        const kill = (): void => {
          try {
            run.kill();
          } catch {
            /* already gone */
          }
        };
        const onAbort = (): void => {
          kill();
          finish(new Error("the Chromium download was cancelled"));
        };
        const timer = setTimeout(() => {
          kill();
          finish(new Error(`the Chromium download timed out after ${Math.round((o.timeoutMs ?? INSTALL_TIMEOUT_MS) / 60_000)} min`));
        }, o.timeoutMs ?? INSTALL_TIMEOUT_MS);
        timer.unref();
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        run.stderr?.on("data", (b: Buffer) => {
          tail = (tail + b.toString("utf8")).slice(-STDERR_TAIL);
        });
        run.on("error", (e) => finish(new Error(`could not start the Chromium download: ${e.message}`)));
        run.on("close", (code) => {
          if (code === 0) finish();
          else finish(new Error(`the Chromium download failed (exit ${code}). ${tail.trim()}`.trim()));
        });
      });
    },
  };
}

export interface BrowserPaths {
  profileDir: string;
  artifactsDir: string;
  browsersDir: string;
  lockFile: string;
}

/** The runner-owned folders: `<dataDir>\browser\{profile,ms-playwright,shots}` unless `engines.browser` names others (T4). */
export function resolveBrowserPaths(dataDir: string, cfg: { profileDir?: string; artifactsDir?: string; browsersDir?: string }): BrowserPaths {
  const base = join(dataDir, "browser");
  return {
    profileDir: cfg.profileDir ?? join(base, "profile"),
    artifactsDir: cfg.artifactsDir ?? join(base, "shots"),
    browsersDir: cfg.browsersDir ?? join(base, "ms-playwright"),
    lockFile: join(base, "profile.lock"),
  };
}
