/**
 * Config loader (S1.2): reads config.json, applies the schema defaults, then the semantic refusals.
 * The loader REFUSES TO START (throws `ConfigError`) on: an empty allowlist, a non-loopback baseUrl in any
 * runner block, an unknown `model.runner`, a missing block for the selected runner, `runner: "lmstudio"` without
 * `lmStudioApiToken`, a duplicate alias, an allowed path that does not exist. A missing deny path only warns.
 * `runner: "strata"` without `strataApiKey` only warns (a keyless Strata is allowed for tests).
 * Phase 2 (S9.4) refusals: a non-loopback `mcp.servers[].url`, a non-loopback `secondOpinion.baseUrl` (checked even
 * while it is disabled), a duplicate MCP server id. Warnings: an unknown `flow.serverId`, an `mcpTokens` entry for an
 * unknown server.
 */

import type { RunnerProviderInput } from "../pi/adapter.js";
import { describeRunnerAuth } from "../pi/adapter.js";
import { normalizeWin } from "./paths.js";
import { ConfigError } from "./schema.js";
import { loadEffectiveConfig } from "../settings/load.js";
import type { LoadedSettings } from "../settings/load.js";
import type { Config, DefaultsEnv, RunnerName } from "./schema.js";
import type { FsProbe } from "./validate.js";
export { realFs, validateConfig } from "./validate.js";
export type { FsProbe, ValidationOptions } from "./validate.js";
import type { Secrets } from "./secrets.js";

export interface LoadConfigOptions {
  configPath: string;
  secrets: Pick<Secrets, "lmStudioApiToken" | "strataApiKey" | "mcpTokens">;
  env?: DefaultsEnv;
  readFile?: (path: string) => string;
  fs?: FsProbe;
}

export interface LoadedConfig {
  config: Config;
  warnings: string[];
  /** Phase 3: legacy or migrated mode, the settings folders, the `security.json` snapshot and revision, prefs. */
  settings: LoadedSettings;
}

/** Delegates to the settings loader (S17.2): legacy `config.json`, or `config.json` v2 plus `security.json`. */
export function loadConfig(opts: LoadConfigOptions): LoadedConfig {
  const eff = loadEffectiveConfig({
    configPath: opts.configPath,
    secrets: opts.secrets,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.readFile ? { readFile: opts.readFile } : {}),
    ...(opts.fs ? { fs: opts.fs } : {}),
  });
  return { config: eff.config, warnings: eff.warnings, settings: eff.settings };
}

export interface RunnerSelection {
  runner: RunnerName;
  /** What the adapter needs to build the provider (I13). Carries the key as `apiKey` when one is configured. */
  provider: RunnerProviderInput;
  authMode: "api-key" | "none";
  warnings: string[];
}

/** Picks the selected runner's block and the matching secret. Never reads pi-ai types beyond the adapter's. */
export function selectRunner(config: Config, secrets: Pick<Secrets, "lmStudioApiToken" | "strataApiKey">): RunnerSelection {
  const runner = config.model.runner;
  const block = config.model.runners[runner];
  if (!block) throw new ConfigError([`model.runners.${runner}: no block for the selected runner`]);
  const apiKey = runner === "lmstudio" ? secrets.lmStudioApiToken : secrets.strataApiKey;
  const warnings: string[] = [];
  if (runner === "lmstudio" && !apiKey) throw new ConfigError(['model.runner is "lmstudio" but secrets has no lmStudioApiToken']);
  if (runner === "strata" && !apiKey) warnings.push("Strata without an API key: any local process can use the model");
  const provider: RunnerProviderInput = {
    id: runner,
    baseUrl: block.baseUrl,
    modelId: block.modelId,
    contextWindow: block.contextWindow,
    maxTokens: block.maxTokens,
    ...(apiKey ? { apiKey } : {}),
    ...(block.compat ? { compat: block.compat } : {}),
  };
  return { runner, provider, authMode: describeRunnerAuth(apiKey), warnings };
}

/** Handy for tests and S7: the normalised form used to compare two config paths. */
export function samePath(a: string, b: string): boolean {
  return normalizeWin(a) === normalizeWin(b);
}
