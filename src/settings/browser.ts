/** REQ-0014 browser settings (security.json `browser` section). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./jsonschema.js";
import { SECURITY_SCHEMA } from "./schema.js";

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
export function readBrowserSettings(settingsDir: string): BrowserSettings {
  const file = join(settingsDir, "security.json");
  const doc: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error(`${file} is not a JSON object`);
  const section = (doc as Record<string, unknown>)["browser"];
  if (section === undefined) return structuredClone(DEFAULT_BROWSER_SETTINGS);
  const schema = SECURITY_SCHEMA.properties?.["browser"];
  const issues = schema ? validate(schema, section, "browser") : [{ path: "browser", message: "no schema" }];
  if (issues.length > 0) throw new Error(`${file} browser section is invalid: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
  const b = section as Partial<BrowserSettings>;
  return {
    acknowledged: b.acknowledged === true,
    allowedDomains: [...(b.allowedDomains ?? [])],
    blockedDomains: [...(b.blockedDomains ?? [])],
    askDomains: [...(b.askDomains ?? [])],
    extraRiskyWords: [...(b.extraRiskyWords ?? [])],
    maxScreenshotsPerJob: b.maxScreenshotsPerJob ?? DEFAULT_BROWSER_SETTINGS.maxScreenshotsPerJob,
  };
}
