/** REQ-0014 browser engine driver. The types below are the contract with T4 (unchanged from T1); the class is in `driver.ts`. */
import type { BrowserActionBody, BrowserActionReply } from "../../../jobs/browserContracts.js";
import type { EngineDriver } from "../../../jobs/contracts.js";
import { readBrowserSettings } from "../../../settings/browser.js";
import type { BrowserSettings } from "../../../settings/browser.js";
import type { DriverFactoryContext } from "../../main.js";
import type { CoreEngineHost } from "../../manager.js";
import type { BrowserBackend } from "./backend.js";
import { BrowserDriver } from "./driver.js";
import { startEgressProxy } from "./egress.js";
import type { EgressOptions, EgressProxy } from "./egress.js";
import { createChromiumInstaller, resolveBrowserPaths } from "./install.js";
import { PlaywrightBackend } from "./playwright.js";

export interface BrowserEngineDriver extends EngineDriver {
  readonly engine: "browser";
  act(jobId: string, body: BrowserActionBody, host: CoreEngineHost): Promise<BrowserActionReply>;
}

/** install.ts (T3). */
export interface ChromiumInstaller {
  status(): { installed: boolean; executable?: string };
  install(signal: AbortSignal): Promise<void>;
}

export interface BrowserDriverDeps {
  backend: BrowserBackend;
  paths: { profileDir: string; artifactsDir: string; browsersDir: string; lockFile: string };
  headless: boolean;
  idleMin: number;
  /** read at each action (T5 readBrowserSettings) */
  settings: () => BrowserSettings;
  installer: ChromiumInstaller;
  egress: (o: EgressOptions) => Promise<EgressProxy>;
  now?: () => number;
}

/** Builds the browser driver. Loads nothing heavy: `playwright-core` is imported at the first launch. */
export function createDriver(ctx: DriverFactoryContext): BrowserEngineDriver {
  const cfg = ctx.config.engines.browser;
  const paths = resolveBrowserPaths(ctx.dataDir, cfg);
  const settings = (): BrowserSettings => readBrowserSettings(ctx.config.paths.settingsDir);
  return new BrowserDriver(
    {
      backend: new PlaywrightBackend({ settings }),
      paths,
      headless: cfg.headless ?? true,
      idleMin: cfg.idleMin ?? 10,
      settings,
      installer: createChromiumInstaller({ browsersDir: paths.browsersDir }),
      egress: (o) => startEgressProxy(o),
    },
    { logger: ctx.logger, redact: ctx.redact },
  );
}
