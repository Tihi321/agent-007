/** createDriver wiring (gap fixes): the S12.5 guard is on, and engines.claude.path is the command. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createClaudeDriver, createDriver } from "../../../src/jobrunner/drivers/claude/index.js";
import { ClaudeVersionHeldError } from "../../../src/jobrunner/drivers/claude/versionGuard.js";
import { runParserSmoke } from "../../../src/jobrunner/drivers/claude/parser.js";
import { GUARD_PARSER_FIXTURES } from "../../../src/jobrunner/drivers/claude/guardFixtures.js";
import { parseJobRunnerConfig } from "../../../src/jobrunner/limits.js";
import { ConfigError } from "../../../src/jobrunner/limits.js";
import type { DriverFactoryContext } from "../../../src/jobrunner/main.js";
import { PermissionBroker } from "../../../src/jobrunner/drivers/claude/permissionBroker.js";
import { collect, makeRig, sleep, waitFor, makeSpec, makeTemplate, tempDir, FAKE_CLAUDE } from "./helpers.js";

function ctxFor(dataDir: string, engines?: object): DriverFactoryContext {
  const config = parseJobRunnerConfig(engines ? { engines } : {});
  return { engine: "claude", config, dataDir, logger: { debug() {}, info() {}, warn() {}, error() {} }, redact: ((s: string) => s) as never, secrets: {} };
}

describe("claude createDriver", () => {
  it("the shipped guard fixtures pass the parser smoke", () => {
    assert.deepEqual(runParserSmoke(GUARD_PARSER_FIXTURES), { ok: true, failures: [] });
  });

  it("createDriver builds a guarded driver (does not throw: fixtures present)", () => {
    const t = tempDir("a7-cd-");
    try {
      assert.equal(createDriver(ctxFor(t.dir)).engine, "claude");
    } finally {
      t.cleanup();
    }
  });

  it("a never-seen version holds a normal job, lets the list-runs probe through, then approves; state is persisted in the data dir", async () => {
    const rig = makeRig("ok", {}, {});
    try {
      const driver = createClaudeDriver(ctxFor(rig.dataDir), { command: process.execPath, prefixArgs: [FAKE_CLAUDE], env: rig.env, broker: new PermissionBroker() });
      await assert.rejects(driver.start(makeSpec({ jobId: "j1", cwd: rig.cwd, template: makeTemplate({ id: "other" }) })), (e: unknown) => e instanceof ClaudeVersionHeldError);
      await driver.start(makeSpec({ jobId: "p1", cwd: rig.cwd, template: makeTemplate({ id: "list-runs" }) }));
      await collect(driver.events("p1"));
      await driver.start(makeSpec({ jobId: "j2", cwd: rig.cwd, template: makeTemplate({ id: "other" }) }));
      await collect(driver.events("j2"));
      const again = createClaudeDriver(ctxFor(rig.dataDir), { command: process.execPath, prefixArgs: [FAKE_CLAUDE], env: rig.env, broker: new PermissionBroker() });
      await again.start(makeSpec({ jobId: "j3", cwd: rig.cwd, template: makeTemplate({ id: "other" }) }));
      await collect(again.events("j3"));
      await waitFor(() => driver.runningCount === 0 && again.runningCount === 0, 5000, "jobs to end");
      await sleep(300);
      assert.ok(existsSync(join(rig.dataDir, "claude-version-guard.json")));
    } finally {
      rig.cleanup();
    }
  });

  it("engines.claude.path is parsed, must be an absolute .exe, and becomes the driver command", () => {
    const ok = parseJobRunnerConfig({ engines: { claude: { enabled: true, path: "C:\\Tools\\claude.exe" } } });
    assert.equal(ok.engines.claude.path, "C:\\Tools\\claude.exe");
    assert.equal(parseJobRunnerConfig({}).engines.claude.path, undefined);
    for (const bad of ["claude.exe", "C:\\Tools\\claude.cmd", "\\\\srv\\x\\claude.exe", ""]) {
      assert.throws(() => parseJobRunnerConfig({ engines: { claude: { path: bad } } }), ConfigError, bad);
    }
    assert.throws(() => parseJobRunnerConfig({ engines: { dsh: { path: "C:\\x.exe" } } }), ConfigError);
    const t = tempDir("a7-cd-");
    try {
      const d = createClaudeDriver(ctxFor(t.dir, { claude: { path: "C:\\Definitely\\Missing\\claude.exe" } }));
      return assert.rejects(d.version(), /claude --version failed/);
    } finally {
      t.cleanup();
    }
  });
});
