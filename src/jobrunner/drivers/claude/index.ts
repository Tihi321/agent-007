export * from "./argv.js";
export * from "./parser.js";
export * from "./preflight.js";
export * from "./versionGuard.js";
export { GUARD_PARSER_FIXTURES } from "./guardFixtures.js";
export * from "./permissionBroker.js";
export * from "./driver.js";
export { writeMcpConfig, mcpConfigPathFor, killProcessTree, EventChannel } from "./process.js";
export type { McpConfigFile, McpConfigInput } from "./process.js";

import type { EngineDriver } from "../../../jobs/contracts.js";
import type { DriverFactoryContext } from "../../main.js";
import { ClaudeDriver } from "./driver.js";
import type { ClaudeDriverOptions } from "./driver.js";
import { PermissionBroker } from "./permissionBroker.js";
import { GUARD_PARSER_FIXTURES } from "./guardFixtures.js";
import { ClaudeVersionGuard } from "./versionGuard.js";
import { join } from "node:path";

/** The harmless read-only smoke template (S12.2). A held version still lets it run; its success approves the version. */
export const CLAUDE_PROBE_TEMPLATE_IDS = ["list-runs"] as const;

/**
 * Builds the Claude driver for the job runner (S15 integration carve-out; S11's `loadConventionDrivers` calls
 * `createDriver`). One `PermissionBroker` serves every job; it is handed to the IPC server through
 * `ctx.registerPermissionBroker` so the per-job helper keys are accepted and its `permission_request`s are answered.
 *
 * The deny rules come from the job runner's own `denyPaths` (UI-2 paths plus the agent folders it lists). `over` is for tests
 * (a fake `claude`) and for a future config knob; production passes nothing, so the command is `claude` on the main user's
 * PATH (a real executable: `claude.exe`).
 *
 * The S12.5 version guard is on: a `claude --version` string not seen before holds every job except the probe template until
 * the parser smoke (fixtures in guardFixtures.ts) and one probe job have passed. State is kept in `<dataDir>/claude-version-guard.json`.
 * `engines.claude.path` in jobrunner.json (an absolute .exe) replaces the PATH lookup.
 */
export function createClaudeDriver(ctx: Omit<DriverFactoryContext, "engine">, over: Partial<ClaudeDriverOptions> = {}): ClaudeDriver {
  const broker = over.broker ?? new PermissionBroker();
  ctx.registerPermissionBroker?.(broker);
  const cfgPath = ctx.config.engines.claude.path;
  return new ClaudeDriver({
    ...(cfgPath !== undefined ? { command: cfgPath } : {}),
    guard: new ClaudeVersionGuard({ file: join(ctx.dataDir, "claude-version-guard.json") }),
    parserFixtures: GUARD_PARSER_FIXTURES,
    probeTemplateIds: CLAUDE_PROBE_TEMPLATE_IDS,
    dataDir: ctx.dataDir,
    ipcPort: ctx.config.ipcPort,
    broker,
    denyPaths: ctx.denyPaths ?? ctx.config.denyPaths,
    flowServerId: ctx.config.flow.serverId,
    permissionTimeoutSec: ctx.config.limits.permissionTimeoutSec,
    logger: ctx.logger,
    ...over,
  });
}

export function createDriver(ctx: DriverFactoryContext): EngineDriver {
  return createClaudeDriver(ctx);
}
