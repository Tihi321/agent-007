import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ClaudeVersionGuard, ClaudeVersionHeldError } from "../../../src/jobrunner/drivers/claude/versionGuard.js";
import { PARSER_FIXTURES } from "./fixtures.js";
import { collect, makeRig, makeSpec, makeTemplate, tempDir } from "./helpers.js";

describe("version guard (S12.5)", () => {
  it("holds a new version until the parser smoke and one live job both pass", () => {
    const g = new ClaudeVersionGuard({ approved: ["2.1.300 (Claude Code)"] });
    assert.deepEqual(g.check("2.1.300 (Claude Code)"), { held: false, missing: [] });
    assert.deepEqual(g.check("2.1.310 (Claude Code)"), { held: true, missing: ["parser_smoke", "live_job"] });
    g.recordParserSmoke("2.1.310 (Claude Code)", true);
    assert.deepEqual(g.check("2.1.310 (Claude Code)"), { held: true, missing: ["live_job"] });
    g.recordLiveJob("2.1.310 (Claude Code)", true);
    assert.equal(g.isApproved("2.1.310 (Claude Code)"), true);
    assert.equal(g.isApproved("2.1.311 (Claude Code)"), false);
    g.recordParserSmoke("2.1.310 (Claude Code)", false);
    assert.equal(g.isApproved("2.1.310 (Claude Code)"), false);
  });

  it("persists across instances", () => {
    const t = tempDir("a7-guard-");
    try {
      const file = join(t.dir, "sub", "guard.json");
      const a = new ClaudeVersionGuard({ file });
      a.recordParserSmoke("v1", true);
      a.recordLiveJob("v1", true);
      assert.equal(new ClaudeVersionGuard({ file }).isApproved("v1"), true);
      assert.equal(new ClaudeVersionGuard({ file: join(t.dir, "missing.json") }).isApproved("v1"), false);
    } finally {
      t.cleanup();
    }
  });

  it("the driver holds a job on a changed version string, then lets only the probe template through", async () => {
    const guard = new ClaudeVersionGuard({ approved: ["2.1.300 (Claude Code)"] });
    const rig = makeRig("ok", { guard, parserFixtures: PARSER_FIXTURES, probeTemplateIds: ["probe"] }, { FAKE_CLAUDE_VERSION: "2.1.310 (Claude Code)" });
    try {
      // a normal job on the new version: the parser smoke reruns (and passes), the live probe is still missing
      await assert.rejects(rig.driver.start(makeSpec({ jobId: "j1", cwd: rig.cwd })), (e: unknown) => e instanceof ClaudeVersionHeldError && e.missing.join() === "live_job" && e.version === "2.1.310 (Claude Code)");
      assert.equal(rig.driver.runningCount, 0);
      assert.equal(rig.broker.activeCount, 0, "no token is left behind by a held job");
      // the harmless probe template runs and its success approves the version
      await rig.driver.start(makeSpec({ jobId: "p1", cwd: rig.cwd, template: makeTemplate({ id: "probe" }) }));
      const events = await collect(rig.driver.events("p1"));
      const last = events.at(-1);
      assert.ok(last?.kind === "state" && last.state === "succeeded");
      assert.equal(guard.isApproved("2.1.310 (Claude Code)"), true);
      // now an ordinary job is accepted
      await rig.driver.start(makeSpec({ jobId: "j2", cwd: rig.cwd }));
      await collect(rig.driver.events("j2"));
    } finally {
      rig.cleanup();
    }
  });

  it("a failing parser smoke holds even the probe", async () => {
    const guard = new ClaudeVersionGuard();
    const bad = PARSER_FIXTURES.map((f) => ({ ...f, expectKinds: ["nothing"] }));
    const rig = makeRig("ok", { guard, parserFixtures: bad, probeTemplateIds: ["probe"] });
    try {
      await assert.rejects(rig.driver.start(makeSpec({ jobId: "p1", cwd: rig.cwd, template: makeTemplate({ id: "probe" }) })), ClaudeVersionHeldError);
      assert.equal(guard.check("2.1.310 (Claude Code)").missing.includes("parser_smoke"), true);
    } finally {
      rig.cleanup();
    }
  });
});
