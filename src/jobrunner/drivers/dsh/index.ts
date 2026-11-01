/** DeepSeek Harness driver (S13). The only importer of the ACP SDK (with `test/jobrunner/dsh/**`). */
export { DshDriver, CONTINUE_PROMPT } from "./driver.js";
export { evaluateGate, evidenceProblems, parseEvidence, FileEvidenceStore, MemoryEvidenceStore } from "./gate.js";
export type { GateInput, GateVerdict } from "./gate.js";
export { runDshProbe, tasklistWatch, PROBE_PROMPT } from "./probe.js";
export type { RunProbeOptions, ProcessWatch, ProcessWatchFactory } from "./probe.js";
export { buildChildEnv, buildLaunch, resolveDshPath, readDshVersion, DshNotFoundError, DEEPSEEK_KEY_ENV } from "./launch.js";
export { DshRefusedError, DshStartError, DshUnsupportedError } from "./types.js";
export type {
  DshDriverOptions,
  DshEvidenceStore,
  DshLaunch,
  DshMcpServer,
  DshProbeEvidence,
  LaunchFn,
  ProcessCheckResult,
  ShellState,
} from "./types.js";

import { join } from "node:path";
import type { EngineDriver } from "../../../jobs/contracts.js";
import type { DriverFactoryContext } from "../../main.js";
import { DshDriver } from "./driver.js";
import { FileEvidenceStore } from "./gate.js";
import { resolveDshPath } from "./launch.js";

/**
 * Builds the DeepSeek Harness driver for the job runner (S15 integration carve-out). It throws `DshNotFoundError` when
 * `dsh` is not installed (the loader then reports the engine as off). The U39 gate stays closed until the live probe wrote
 * evidence to `<dataDir>/dsh-probe.json` AND `engines.dsh.verified` is true in `jobrunner.json`. The key comes only from
 * the job runner's secrets and goes only into the child's environment.
 * Not wired: `resolveMcpServers` (the job runner has no MCP server urls), so a dsh template that names MCP servers is refused.
 */
export function createDriver(ctx: DriverFactoryContext): EngineDriver {
  const dshPath = resolveDshPath();
  return new DshDriver({
    dshPath,
    verified: ctx.config.engines.dsh.verified === true,
    evidence: new FileEvidenceStore(join(ctx.dataDir, "dsh-probe.json")),
    logger: ctx.logger,
    ...(ctx.secrets.deepseekApiKey !== undefined ? { deepseekApiKey: ctx.secrets.deepseekApiKey } : {}),
    approvalTimeoutSec: ctx.config.limits.permissionTimeoutSec,
  });
}
