/**
 * S15 wiring details that need no job runner process: the combined `beforeTool`, an install with no `ipcHmacKey` (a Phase 1
 * config keeps working, jobs stay offline), the second-opinion switch that is NOT built, and the production job runner finding
 * the Claude driver by the `createDriver` convention.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { composeBeforeTool } from "../../src/agent/hooks.js";
import { IpcKey } from "../../src/ipc/hmac.js";
import { startJobRunner } from "../../src/jobrunner/main.js";
import { parseJobRunnerConfig } from "../../src/jobrunner/limits.js";
import { createMemoryLogger } from "../../src/logging/logger.js";
import { E2e, readLogs } from "./rig.js";
import { freePort } from "./phase2-rig.js";

test("composeBeforeTool: the first guard that blocks decides, a call no guard blocks goes on, and the guards see the same call", async () => {
  const seen: string[] = [];
  const guard = (name: string, blockTool?: string) => async (call: { name: string }) => {
    seen.push(`${name}:${call.name}`);
    return call.name === blockTool ? { block: `blocked by ${name}` } : undefined;
  };
  const combined = composeBeforeTool(guard("flow", "mcp__flow-music-mcp__x") as never, guard("gate", "shell") as never) as unknown as (call: { name: string }, api: unknown, ctx: unknown) => Promise<{ block: string } | undefined>;
  assert.deepEqual(await combined({ name: "mcp__flow-music-mcp__x" }, {}, {}), { block: "blocked by flow" });
  assert.deepEqual(seen, ["flow:mcp__flow-music-mcp__x"], "a block stops the chain");
  seen.length = 0;
  assert.deepEqual(await combined({ name: "shell" }, {}, {}), { block: "blocked by gate" });
  assert.deepEqual(seen, ["flow:shell", "gate:shell"]);
  seen.length = 0;
  assert.equal(await combined({ name: "list_dir" }, {}, {}), undefined);
  assert.deepEqual(seen, ["flow:list_dir", "gate:list_dir"]);
});

test("phase2: an install with no ipcHmacKey still runs (jobs stay offline, the client is never started) and says so", async () => {
  const rig = await E2e.open();
  try {
    assert.equal(rig.agent.phase2.ipcEnabled, false);
    assert.equal(rig.agent.phase2.client.state, "offline");
    assert.ok(readLogs(rig.dirs).some((l) => l["event"] === "phase2.no_ipc_key"), "a warning names the missing key");
    await rig.say("/status", 1);
    const status = await rig.seen((t) => /Job runner:/.test(t), "/status");
    assert.match(status, /job runner offline/);
    assert.match(status, /MCP servers: none configured/);
    await rig.say("hello", 2);
    await rig.seen((t) => t === "echo: hello", "an ordinary answer");
  } finally {
    await rig.close();
    rmSync(rig.dirs.root, { recursive: true, force: true });
  }
});

test("phase2: secondOpinion.enabled=true is ignored (S15.3 is not built): a warning, and no ask_second_opinion tool", async () => {
  const rig = await E2e.open({ config: { phase2: { secondOpinion: { enabled: true, modelId: "some-model" } } } });
  try {
    assert.equal(rig.agent.config.secondOpinion.enabled, true);
    assert.ok(readLogs(rig.dirs).some((l) => l["event"] === "phase2.second_opinion_not_built"));
    const names = rig.agent.registry.snapshot().tools().map((t) => (t.tool as { name: string }).name);
    assert.equal(names.includes("ask_second_opinion"), false);
  } finally {
    await rig.close();
    rmSync(rig.dirs.root, { recursive: true, force: true });
  }
});

test("job runner: with no drivers given it finds the Claude driver through createDriver (the dsh engine stays off)", async () => {
  const root = mkdtempSync(join(tmpdir(), "a7-jr-conv-"));
  try {
    const port = await freePort();
    const hub = join(root, "hub");
    const dataDir = join(root, "data");
    const configDir = join(root, "cfg");
    for (const d of [hub, dataDir, join(configDir, "templates")]) mkdirSync(d, { recursive: true });
    const config = parseJobRunnerConfig({
      ipcPort: port,
      paths: { dataDir, configDir, templatesDir: join(configDir, "templates") },
      cwdAllowlist: [hub],
      denyPaths: [join(root, "pix")],
      engines: { claude: { enabled: true }, dsh: { enabled: false }, hub: { enabled: true } },
      hub: { dir: hub, services: [], pwsh: "pwsh-not-used" },
    });
    writeFileSync(join(dataDir, "secrets.json"), "{}");
    const key = IpcKey.generate();
    const logger = createMemoryLogger();
    const runner = await startJobRunner({ config, secrets: { ipcKey: key, redactValues: [] }, logger });
    try {
      const status = runner.manager.status({});
      assert.equal(status.engines.claude?.enabled, true, "the claude engine is on");
      assert.equal(status.engines.dsh?.enabled, false, "the dsh engine is off");
      assert.ok(logger.lines.some((l) => l.event === "jobrunner.driver_loaded" && (l.fields as { engine?: string } | undefined)?.engine === "claude"));
    } finally {
      await runner.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
