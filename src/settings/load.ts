/**
 * The settings loader (S17.2, I25d, I29b, I29c). `loadEffectiveConfig` returns the Phase 1/2 `Config` shape, built from
 * `config.json` (bootstrap) plus `security.json`, so every consumer from S1 to S15 is unchanged, plus the settings state.
 *
 *  - `schemaVersion: 2` in `config.json`: MIGRATED mode. `security.json` is read ONCE at start into an immutable snapshot; its
 *    revision is `sha256(file)`. An invalid `security.json` refuses start (`ConfigError`).
 *  - no `schemaVersion` (or 1): LEGACY mode. `config.json` is read as before, so a Phase 1/2 install keeps working until the
 *    user runs `migrate-settings`; a note is returned (the host logs one `warn`).
 *  - `prefs.json` is untrusted input: re-read when it changes (`PrefsStore`), an invalid one falls back to the defaults.
 *
 * Pure subset: no adapter import at runtime.
 */
import { join } from "node:path";
import { ConfigError, defaultsFromEnv, parseConfig } from "../config/schema.js";
import type { Config, DefaultsEnv } from "../config/schema.js";
import type { Secrets } from "../config/secrets.js";
import { validateConfig } from "../config/validate.js";
import type { FsProbe } from "../config/validate.js";
import { readFileSync } from "node:fs";
import { validate } from "./jsonschema.js";
import { loadPrefsFile } from "./prefs.js";
import type { LoadedPrefs } from "./prefs.js";
import { BOOTSTRAP_SCHEMA, validateSecurityDoc } from "./schema.js";
import { mergeConfig } from "./split.js";
import { revisionOf, settingsPaths } from "./store.js";
import type { SettingsPaths } from "./store.js";

export type SettingsMode = "legacy" | "migrated";

export interface ComposedConfig {
  /** The Phase 1/2 shaped raw config (input of `parseConfig`). */
  raw: Record<string, unknown>;
  mode: SettingsMode;
  bootstrap: Record<string, unknown>;
  settingsDir?: string;
  security?: Record<string, unknown>;
  securityText?: string;
}

export interface ComposeOptions {
  readFile?: (path: string) => string;
  env?: DefaultsEnv;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses `config.json` text and, in migrated mode, reads and checks `security.json`. Throws `ConfigError`. */
export function composeRawConfig(configText: string, opts: ComposeOptions = {}): ComposedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch (e) {
    throw new ConfigError([`config file is not valid JSON: ${(e as Error).message}`]);
  }
  if (!isObj(parsed)) throw new ConfigError(["config: expected an object"]);
  const version = parsed["schemaVersion"];
  if (version === undefined || version === 1) return { raw: parsed, mode: "legacy", bootstrap: parsed };
  if (version !== 2) throw new ConfigError([`config.json schemaVersion ${JSON.stringify(version)} is not supported (expected 1 or 2)`]);

  const issues = validate(BOOTSTRAP_SCHEMA, parsed).map((i) => `config.${i.path}: ${i.message}`);
  if (issues.length > 0) throw new ConfigError(issues);
  const env = opts.env ?? defaultsFromEnv();
  const paths = isObj(parsed["paths"]) ? parsed["paths"] : {};
  const programData = typeof paths["programDataDir"] === "string" ? paths["programDataDir"] : join(env.programData, "agent-007");
  const settings = isObj(parsed["settings"]) ? parsed["settings"] : {};
  const settingsDir = typeof settings["dir"] === "string" ? settings["dir"] : join(programData, "settings");
  const securityFile = join(settingsDir, "security.json");
  let securityText: string;
  try {
    securityText = (opts.readFile ?? ((p: string) => readFileSync(p, "utf8")))(securityFile);
  } catch (e) {
    throw new ConfigError([`security.json cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"}): ${securityFile}`]);
  }
  let security: unknown;
  try {
    security = JSON.parse(securityText);
  } catch (e) {
    throw new ConfigError([`security.json is not valid JSON: ${(e as Error).message}`]);
  }
  const check = validateSecurityDoc(security, { env, skipFolderExists: true });
  if (!check.ok) throw new ConfigError(check.issues.map((i) => `security.json ${i}`));
  const sec = security as Record<string, unknown>;
  return { raw: mergeConfig(parsed, sec), mode: "migrated", bootstrap: parsed, settingsDir, security: sec, securityText };
}

export interface LoadedSettings {
  mode: SettingsMode;
  paths: SettingsPaths;
  /** The immutable `security.json` snapshot taken at start (migrated mode only). */
  security?: Readonly<Record<string, unknown>>;
  /** `sha256(security.json)` as read at start; the empty-text revision in legacy mode. */
  securityRevision: string;
  prefs: LoadedPrefs;
  /** One-line notes for the log (legacy mode, an invalid prefs file). */
  notes: string[];
}

export interface EffectiveConfig {
  config: Config;
  warnings: string[];
  settings: LoadedSettings;
}

export interface LoadEffectiveOptions {
  configPath: string;
  secrets: Pick<Secrets, "lmStudioApiToken" | "strataApiKey" | "mcpTokens">;
  env?: DefaultsEnv;
  readFile?: (path: string) => string;
  fs?: FsProbe;
}

export function loadEffectiveConfig(opts: LoadEffectiveOptions): EffectiveConfig {
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const env = opts.env ?? defaultsFromEnv();
  const composed = composeRawConfig(read(opts.configPath), { readFile: read, env });
  const config = parseConfig(composed.raw, env);
  const warnings = validateConfig(config, opts.secrets, opts.fs ? { fs: opts.fs } : {});
  const paths = settingsPaths(config.paths.programDataDir, config.paths.dataDir, composed.settingsDir);
  const prefs = loadPrefsFile(paths.prefsFile);
  const notes: string[] = [];
  if (composed.mode === "legacy") notes.push("settings: legacy mode (config.json has no schemaVersion 2); run migrate-settings to split security.json and prefs.json");
  if (prefs.warning) notes.push(prefs.warning);
  return {
    config,
    warnings,
    settings: {
      mode: composed.mode,
      paths,
      ...(composed.security ? { security: Object.freeze(structuredClone(composed.security)) } : {}),
      securityRevision: revisionOf(composed.securityText),
      prefs,
      notes,
    },
  };
}
