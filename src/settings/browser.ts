/** REQ-0014 browser settings (security.json `browser` section). T1 stub: T5 replaces `readBrowserSettings`, keeps the types. */
export interface BrowserSettings {
  /** default false */
  acknowledged: boolean;
  /** empty = any public host; entries "example.com" or "*.example.com", max 200 */
  allowedDomains: string[];
  /** always refused, max 200 */
  blockedDomains: string[];
  /** every write action asks, max 200 */
  askDomains: string[];
  /** max 50, each 2..40 chars, letters/spaces only */
  extraRiskyWords: string[];
  /** 1..200, default 50 */
  maxScreenshotsPerJob: number;
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  acknowledged: false,
  allowedDomains: [],
  blockedDomains: [],
  askDomains: [],
  extraRiskyWords: [],
  maxScreenshotsPerJob: 50,
};

/** Reads <settingsDir>\security.json `browser`. Missing section = defaults. Unreadable or invalid file = throws. */
export function readBrowserSettings(_settingsDir: string): BrowserSettings {
  throw new Error("not implemented: T5");
}
