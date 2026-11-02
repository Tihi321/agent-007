import { BrowserWindow, session } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface LauncherWindowOptions {
  htmlPath: string;
  preloadPath: string;
  iconPath?: string;
  onConsole?: (level: string, message: string, source: string) => void;
}

/** The launcher's own page (first-run setup and settings). Created lazily; closing hides it (the app lives in the tray). */
export class LauncherWindow {
  private window?: BrowserWindow;
  private quitting = false;
  readonly url: string;

  constructor(private readonly options: LauncherWindowOptions) {
    this.url = pathToFileURL(options.htmlPath).href;
  }

  /** True when a frame URL is the launcher page (query and hash ignored). */
  isOwnUrl(frameUrl: string | undefined | null): boolean {
    if (!frameUrl) return false;
    try {
      const parsed = new URL(frameUrl);
      if (parsed.protocol !== "file:") return false;
      return path.resolve(fileURLToPath(parsed)).toLowerCase() === path.resolve(this.options.htmlPath).toLowerCase();
    } catch {
      return false;
    }
  }

  markQuitting(): void {
    this.quitting = true;
  }

  get webContents(): Electron.WebContents | undefined {
    return this.window && !this.window.isDestroyed() ? this.window.webContents : undefined;
  }

  get browserWindow(): BrowserWindow | undefined {
    return this.window && !this.window.isDestroyed() ? this.window : undefined;
  }

  ensure(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = new BrowserWindow({
      width: 760,
      height: 820,
      minWidth: 560,
      minHeight: 480,
      show: false,
      title: "agent-007",
      autoHideMenuBar: true,
      ...(this.options.iconPath ? { icon: this.options.iconPath } : {}),
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: this.options.preloadPath, spellcheck: false },
    });
    window.removeMenu();
    window.on("close", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!this.isOwnUrl(url)) event.preventDefault();
    });
    window.webContents.on("console-message", (event) => this.options.onConsole?.(String(event.level), event.message, `${event.sourceId}:${event.lineNumber}`));
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    void window.loadURL(this.url);
    this.window = window;
    return window;
  }

  show(): void {
    const window = this.ensure();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  send(channel: string, payload: unknown): void {
    const contents = this.webContents;
    if (!contents) return;
    if (contents.isLoading()) contents.once("did-finish-load", () => contents.send(channel, payload));
    else contents.send(channel, payload);
  }
}
