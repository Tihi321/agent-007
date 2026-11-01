/**
 * Semantic validation of a parsed `Config` (moved out of `load.ts` in Phase 3, S17, so the job runner's settings UI can run
 * the same refusals without importing the adapter). Pure: `node:fs` only. `load.ts` re-exports everything here, so the
 * Phase 1/2 import paths still work.
 *
 * The loader REFUSES TO START (throws `ConfigError`) on: an empty allowlist, a non-loopback baseUrl in any runner block, an
 * unknown `model.runner`, a missing block for the selected runner, `runner: "lmstudio"` without `lmStudioApiToken`, a
 * duplicate alias, an allowed path that does not exist. A missing deny path only warns. `runner: "strata"` without
 * `strataApiKey` only warns (a keyless Strata is allowed for tests). Phase 2 (S9.4) refusals: a non-loopback
 * `mcp.servers[].url`, a non-loopback `secondOpinion.baseUrl` (checked even while it is disabled), a duplicate MCP server id.
 */
import { existsSync, statSync } from "node:fs";
import { isLoopbackUrl } from "./paths.js";
import { ConfigError } from "./schema.js";
import type { Config, RunnerBlock } from "./schema.js";
import type { Secrets } from "./secrets.js";

export interface FsProbe {
  /** True if the path exists and is a directory. */
  isDirectory(path: string): boolean;
  exists(path: string): boolean;
}

export const realFs: FsProbe = {
  exists: (p) => existsSync(p),
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

export interface ValidationOptions {
  fs?: FsProbe;
}

/** Semantic validation. Throws `ConfigError` with every refusal; returns the warnings. */
export function validateConfig(config: Config, secrets: Pick<Secrets, "lmStudioApiToken" | "strataApiKey" | "mcpTokens">, opts: ValidationOptions = {}): string[] {
  const fs = opts.fs ?? realFs;
  const issues: string[] = [];
  const warnings: string[] = [];

  if (config.folders.allow.length === 0) issues.push("folders.allow is empty: at least one allowed folder is required");

  const aliases = new Set<string>();
  for (const f of config.folders.allow) {
    const a = f.alias.toLowerCase();
    if (aliases.has(a)) issues.push(`folders.allow: duplicate alias "${f.alias}"`);
    aliases.add(a);
    if (!fs.isDirectory(f.path)) issues.push(`folders.allow: path for alias "${f.alias}" does not exist or is not a folder: ${f.path}`);
  }
  for (const d of config.folders.deny) {
    if (!fs.exists(d)) warnings.push(`folders.deny: path does not exist (kept as a deny anyway): ${d}`);
  }

  for (const [name, block] of Object.entries(config.model.runners) as [string, RunnerBlock][]) {
    if (!isLoopbackUrl(block.baseUrl)) issues.push(`model.runners.${name}.baseUrl must be loopback (127.0.0.1 or localhost): ${block.baseUrl}`);
  }
  const selected = config.model.runners[config.model.runner];
  if (!selected) issues.push(`model.runners.${config.model.runner}: no block for the selected runner "${config.model.runner}"`);

  if (config.model.runner === "lmstudio" && !secrets.lmStudioApiToken) {
    issues.push('model.runner is "lmstudio" but secrets has no lmStudioApiToken');
  }
  if (config.model.runner === "strata" && !secrets.strataApiKey) {
    warnings.push("Strata without an API key: any local process can use the model");
  }

  // Phase 2: MCP servers, second opinion
  const serverIds = new Set<string>();
  config.mcp.servers.forEach((srv, i) => {
    const key = srv.id.toLowerCase();
    if (serverIds.has(key)) issues.push(`mcp.servers[${i}]: duplicate server id "${srv.id}"`);
    serverIds.add(key);
    if (!isLoopbackHttpUrl(srv.url)) issues.push(`mcp.servers[${i}].url must be an http(s) URL on loopback (127.0.0.1 or localhost): ${srv.url}`);
  });
  if (!isLoopbackHttpUrl(config.secondOpinion.baseUrl)) issues.push(`secondOpinion.baseUrl must be an http(s) URL on loopback (127.0.0.1 or localhost): ${config.secondOpinion.baseUrl}`);
  if (config.mcp.servers.length > 0 && !serverIds.has(config.flow.serverId.toLowerCase())) {
    warnings.push(`flow.serverId "${config.flow.serverId}" is not in mcp.servers: the Flow guard has no server to watch`);
  }
  for (const id of Object.keys(secrets.mcpTokens ?? {})) {
    if (!serverIds.has(id.toLowerCase())) warnings.push(`secrets.mcpTokens has an entry for "${id}", which is not in mcp.servers`);
  }

  if (issues.length > 0) throw new ConfigError(issues);
  return warnings;
}

export function isLoopbackHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && isLoopbackUrl(url);
  } catch {
    return false;
  }
}
