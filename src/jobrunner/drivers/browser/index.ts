/** REQ-0014 browser engine driver. T1 stub: T3 replaces `createDriver` (may move the class into `driver.ts`), keeps these exports. */
import type { BrowserActionBody, BrowserActionReply } from "../../../jobs/browserContracts.js";
import type { EngineDriver } from "../../../jobs/contracts.js";
import type { BrowserSettings } from "../../../settings/browser.js";
import type { DriverFactoryContext } from "../../main.js";
import type { CoreEngineHost } from "../../manager.js";
import type { BrowserBackend } from "./backend.js";
import type { EgressOptions, EgressProxy } from "./egress.js";

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

export function createDriver(_ctx: DriverFactoryContext): BrowserEngineDriver {
  throw new Error("not implemented: T3");
}
