/**
 * The real browser backend (REQ-0014 T3): Playwright driving a persistent, isolated Chromium profile. This file and the other
 * files of this folder are the only importers of `playwright-core` (boundary check). `playwright-core` is imported
 * dynamically AFTER PLAYWRIGHT_BROWSERS_PATH is set, because its registry folder is fixed when it first loads.
 *
 * Launch hardening: never `--no-sandbox` (Playwright adds it unless `chromiumSandbox: true`), never a debugging port, never a
 * `channel` or `executablePath` (the installed Chrome/Edge and their profiles are never touched), no downloads, no service
 * workers, no permissions, all traffic through the runner's egress proxy.
 */
import { statSync } from "node:fs";
import type { BrowserContext, Page } from "playwright-core";
import type { BrowserKey } from "../../../jobs/browserContracts.js";
import type { BrowserSettings } from "../../../settings/browser.js";
import type { BrowserBackend, BrowserSession, ElementFacts, LaunchOptions, PageSnapshot } from "./backend.js";
import { hostMatches } from "./classify.js";
import { FACTS_SCRIPT, SNAPSHOT_SCRIPT } from "./snapshot.js";

export interface PlaywrightBackendOptions {
  /** Domain lists for the request guard, read per request (cached for a short time). */
  settings: () => BrowserSettings;
}

const REF = /^e\d{1,5}$/;
const SETTINGS_TTL_MS = 2000;
const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;

function clip(s: string, n: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, n);
}

/** Why a request must be aborted, or undefined. Pure; the proxy is the real network guard, this is the owner's list. */
export function guardReason(url: string, isNavigation: boolean, s: Pick<BrowserSettings, "allowedDomains" | "blockedDomains">): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return isNavigation ? "not a valid URL" : undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return isNavigation ? `${u.protocol} pages are not allowed` : undefined;
  if (hostMatches(u.hostname, s.blockedDomains)) return `${u.hostname} is on the blocked list`;
  if (isNavigation && s.allowedDomains.length > 0 && !hostMatches(u.hostname, s.allowedDomains)) return `${u.hostname} is not on the allowed list`;
  return undefined;
}

export class PlaywrightBackend implements BrowserBackend {
  constructor(private readonly o: PlaywrightBackendOptions) {}

  async launch(l: LaunchOptions): Promise<BrowserSession> {
    process.env["PLAYWRIGHT_BROWSERS_PATH"] = l.browsersDir;
    const { chromium } = await import("playwright-core");
    const context = await chromium.launchPersistentContext(l.profileDir, {
      headless: l.headless,
      chromiumSandbox: true,
      proxy: { server: l.proxy.server, username: l.proxy.username, password: l.proxy.password },
      viewport: l.viewport,
      acceptDownloads: false,
      serviceWorkers: "block",
      bypassCSP: false,
      permissions: [],
      args: ["--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-extensions"],
    });
    try {
      return await this.wrap(context);
    } catch (e) {
      await context.close().catch(() => undefined);
      throw e;
    }
  }

  private async wrap(context: BrowserContext): Promise<BrowserSession> {
    let cached: { at: number; value: BrowserSettings } | undefined;
    const settings = (): BrowserSettings => {
      if (!cached || Date.now() - cached.at > SETTINGS_TTL_MS) cached = { at: Date.now(), value: this.o.settings() };
      return cached.value;
    };
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    await context.route("**/*", async (route, request) => {
      let reason: string | undefined;
      try {
        reason = guardReason(request.url(), request.isNavigationRequest(), settings());
      } catch {
        reason = "the browser settings could not be read"; // fail closed
      }
      if (reason !== undefined) await route.abort("blockedbyclient").catch(() => undefined);
      else await route.continue().catch(() => undefined);
    });

    const page: Page = context.pages()[0] ?? (await context.newPage());
    const notices: string[] = [];
    const popups: Page[] = [];
    let closing = false;
    let closeCb: (() => void) | undefined;
    const fireClose = (): void => {
      if (!closing) closeCb?.();
    };
    const watch = (p: Page): void => {
      p.on("dialog", (d) => {
        notices.push(`a ${d.type()} dialog was dismissed: ${clip(d.message(), 100)}`);
        void d.dismiss().catch(() => undefined);
      });
    };
    watch(page);
    page.on("crash", fireClose);
    page.on("close", fireClose);
    context.on("close", fireClose);
    context.on("page", (p) => {
      if (p === page) return;
      watch(p);
      popups.push(p);
    });

    const locator = (ref: string) => {
      if (!REF.test(ref)) throw new Error("invalid element ref");
      return page.locator(`[data-a7-ref="${ref}"]`).first();
    };
    const title = async (): Promise<string> => clip(await page.title().catch(() => ""), 200);
    /** A popup is closed; its URL is opened in the main page only if it passes the same guard as a goto. */
    const settle = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 250));
      while (popups.length > 0) {
        const p = popups.shift() as Page;
        await p.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);
        const url = p.url();
        await p.close().catch(() => undefined);
        let reason: string | undefined;
        try {
          reason = guardReason(url, true, settings());
        } catch {
          reason = "settings unreadable";
        }
        if (reason === undefined && /^https?:/i.test(url)) await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
        else notices.push("a popup window was blocked");
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);
    };

    const session: BrowserSession = {
      async goto(url) {
        const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("load", { timeout: 5000 }).catch(() => undefined);
        const status = resp?.status();
        return { url: page.url(), title: await title(), ...(status !== undefined ? { status } : {}) };
      },
      async back() {
        await page.goBack({ waitUntil: "domcontentloaded" });
        return { url: page.url(), title: await title() };
      },
      async snapshot(maxChars) {
        const snap = (await page.evaluate(SNAPSHOT_SCRIPT, maxChars)) as PageSnapshot;
        if (notices.length > 0) snap.text = `[notice: ${notices.splice(0).join("; ")}]\n${snap.text}`;
        return snap;
      },
      async facts(ref) {
        if (!REF.test(ref)) return undefined;
        const f = (await page.evaluate(FACTS_SCRIPT, ref)) as ElementFacts | null;
        return f ?? undefined;
      },
      async click(ref) {
        await locator(ref).click({ timeout: ACTION_TIMEOUT_MS });
        await settle();
      },
      async type(ref, text, clear) {
        const loc = locator(ref);
        await loc.focus();
        if (clear) await loc.fill("");
        await loc.pressSequentially(text, { delay: 5 });
      },
      async fill(ref, value) {
        const loc = locator(ref);
        const kind = await loc.evaluate((el: { tagName: string; type?: string }) => {
          const t = el.tagName.toLowerCase();
          if (t === "select") return "select";
          if (t === "input") {
            const ty = el.type;
            if (ty === "checkbox" || ty === "radio") return ty;
          }
          return "text";
        });
        if (kind === "select") {
          await loc.selectOption({ label: value }).catch(() => loc.selectOption({ value }));
        } else if (kind === "checkbox" || kind === "radio") {
          await loc.setChecked(kind === "radio" || /^(true|1|yes|on|checked)$/i.test(value));
        } else {
          await loc.fill(value);
        }
      },
      async press(key: BrowserKey, ref) {
        if (ref !== undefined) await locator(ref).press(key);
        else await page.keyboard.press(key);
        await settle();
      },
      async screenshot(file, fullPage) {
        await page.screenshot({
          path: file,
          type: "png",
          animations: "disabled",
          ...(fullPage ? { fullPage: true, clip: { x: 0, y: 0, width: 1280, height: 4000 } } : {}),
        });
        return { bytes: statSync(file).size };
      },
      url: () => page.url(),
      onClose(cb) {
        closeCb = cb;
      },
      async close() {
        closing = true;
        await context.close().catch(() => undefined);
      },
    };
    return session;
  }
}
