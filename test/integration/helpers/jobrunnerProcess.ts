/**
 * A REAL job runner process for the Phase 2 integration tests (S15). It runs the production `startJobRunner` (single
 * instance lock, journal, audit, templates, manager, the IPC server on loopback) with one change: the Claude driver is built
 * by the production `createClaudeDriver` around the fake `claude` script (`test/jobrunner/claude/fakeClaude.js`) instead of the
 * real binary. Never run by `yarn test` directly; `phase2-rig.ts` spawns it.
 *
 *   node jobrunnerProcess.js <jobrunner.json>
 *
 * Secrets: `<dataDir>/secrets.json` (the same loader as production). It sends `{type:"ready", port}` over the Node IPC channel
 * when it listens, and stops gracefully on `{type:"shutdown"}`.
 */
import { fileURLToPath } from "node:url";
import { ClaudeVersionGuard, createClaudeDriver } from "../../../src/jobrunner/drivers/claude/index.js";
import { loadJobRunnerConfig, loadJobRunnerSecrets, startJobRunner } from "../../../src/jobrunner/main.js";
import { join } from "node:path";

const FAKE_CLAUDE = fileURLToPath(new URL("../../jobrunner/claude/fakeClaude.js", import.meta.url));

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("usage: jobrunnerProcess <jobrunner.json>");
  const config = loadJobRunnerConfig(configPath);
  const secrets = loadJobRunnerSecrets(join(config.paths.dataDir, "secrets.json"));
  const runner = await startJobRunner({
    config,
    secrets,
    drivers: (ctx) => ({ claude: createClaudeDriver(ctx, { command: process.execPath, prefixArgs: [FAKE_CLAUDE], guard: new ClaudeVersionGuard({ approved: ["2.1.310 (Claude Code)"] }) }) }),
  });
  const stop = (): void => {
    void runner.stop().finally(() => process.exit(0));
  };
  process.on("message", (m) => {
    if (typeof m === "object" && m !== null && (m as { type?: unknown }).type === "shutdown") stop();
  });
  process.on("SIGTERM", stop);
  process.send?.({ type: "ready", port: runner.port });
}

main().catch((e: unknown) => {
  process.stderr.write(`jobrunnerProcess failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
