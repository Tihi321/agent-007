import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DshDriver } from "../../../src/jobrunner/drivers/dsh/driver.js";
import { FileEvidenceStore, evaluateGate, evidenceProblems, parseEvidence } from "../../../src/jobrunner/drivers/dsh/gate.js";
import { DshRefusedError } from "../../../src/jobrunner/drivers/dsh/types.js";
import type { DshProbeEvidence } from "../../../src/jobrunner/drivers/dsh/types.js";
import { FAKE_DSH_PATH, FAKE_VERSION, collect, goodEvidence, kinds, readLog, rig, spec, tempDir, template } from "./helpers.js";

async function refusal(r: ReturnType<typeof rig>): Promise<DshRefusedError> {
  try {
    await r.driver.start(spec(r.host, r.dir.path));
  } catch (e) {
    assert.ok(e instanceof DshRefusedError, `expected DshRefusedError, got ${String(e)}`);
    return e;
  }
  assert.fail("the job was not refused");
}

test("dsh.verified false: the job is refused and no process starts", async () => {
  const r = rig({ verified: false });
  try {
    const e = await refusal(r);
    assert.equal(e.code, "dsh_unverified");
    assert.ok(e.reasons.some((x) => x.includes("dsh.verified is false")));
    assert.equal(r.launches.length, 0);
    assert.deepEqual(readLog(r.logFile), []);
    assert.ok(r.logger.entries.some((x) => x.event === "dsh.job.refused"));
  } finally {
    r.cleanup();
  }
});

test("no probe evidence: the job is refused even with dsh.verified true", async () => {
  const r = rig({ evidence: undefined });
  try {
    const e = await refusal(r);
    assert.ok(e.reasons.some((x) => x.includes("no probe evidence")));
    assert.equal(r.launches.length, 0);
  } finally {
    r.cleanup();
  }
});

const BAD: Array<[string, Partial<DshProbeEvidence>, string]> = [
  ["no permission request was seen (not ask-first)", { permissionRequestSeen: false }, "not ask-first"],
  ["the request was not labelled execute", { executeKindLabelled: false }, "execute"],
  ["the probe did not reject", { rejected: false }, "did not reject"],
  ["the command ran anyway", { executedAnyway: true }, "ran"],
  ["shell state unknown", { shell: { state: "unknown", how: "-" } }, "shell state unknown"],
  ["process check failed", { processCheck: "fail" }, "process check"],
  ["process check not run", { processCheck: "not_run" }, "process check"],
  ["other protocol version", { protocolVersion: 2 }, "protocol version"],
  ["another dsh version", { dshVersion: "dsh 9.9.9" }, "version changed"],
  ["another dsh path", { dshPath: "C:\\elsewhere\\dsh.cmd" }, "path differs"],
];
for (const [name, over, needle] of BAD) {
  test(`evidence that does not hold up refuses the job: ${name}`, async () => {
    const r = rig({ evidence: goodEvidence({ ...over, passed: true }) });
    try {
      const e = await refusal(r);
      assert.ok(e.reasons.some((x) => x.includes(needle)), `reasons: ${e.reasons.join(" | ")}`);
      assert.equal(r.launches.length, 0);
    } finally {
      r.cleanup();
    }
  });
}

test("the stored `passed` flag is not trusted", () => {
  const forged = goodEvidence({ permissionRequestSeen: false, passed: true, reasons: [] });
  assert.ok(evidenceProblems(forged).length > 0);
  const verdict = evaluateGate({ configVerified: true, evidence: forged, currentVersion: FAKE_VERSION, currentPath: FAKE_DSH_PATH });
  assert.equal(verdict.allowed, false);
});

test("good evidence plus dsh.verified opens the gate; shell `off` attested counts like always_ask", () => {
  for (const shell of [{ state: "always_ask" as const, how: "observed" }, { state: "off" as const, how: "config" }]) {
    const v = evaluateGate({ configVerified: true, evidence: goodEvidence({ shell }), currentVersion: FAKE_VERSION, currentPath: FAKE_DSH_PATH });
    assert.deepEqual(v, { allowed: true, reasons: [] });
  }
  const closed = evaluateGate({ configVerified: false, evidence: goodEvidence(), currentVersion: FAKE_VERSION, currentPath: FAKE_DSH_PATH });
  assert.equal(closed.allowed, false);
});

test("version guard: after dsh updates, the next job is refused until the probe runs again", async () => {
  const r = rig({ scenario: "basic" });
  let version = FAKE_VERSION;
  const driver = new DshDriver({
    dshPath: FAKE_DSH_PATH,
    verified: true,
    evidence: r.evidence,
    logger: r.logger,
    launch: () => ({ file: process.execPath, args: ["-e", "0"] }),
    readVersion: async () => version,
    versionTtlMs: 0,
  });
  try {
    assert.equal((await driver.gate()).allowed, true);
    version = "dsh 0.0.1-test (nightly)";
    const g = await driver.gate();
    assert.equal(g.allowed, false);
    assert.ok(g.reasons.some((x) => x.includes("version changed")));
    await assert.rejects(driver.start(spec(r.host, r.dir.path)), (e: unknown) => e instanceof DshRefusedError && e.code === "dsh_unverified");
  } finally {
    r.cleanup();
  }
});

test("a version that cannot be read closes the gate", async () => {
  const r = rig({ driver: { readVersion: async () => { throw new Error("spawn failed"); } } });
  try {
    const g = await r.driver.gate();
    assert.equal(g.allowed, false);
    assert.ok(g.reasons[0]?.includes("could not read the dsh version"));
  } finally {
    r.cleanup();
  }
});

test("an open gate lets a job run to the end", async () => {
  const r = rig();
  try {
    await r.driver.start(spec(r.host, r.dir.path));
    const events = await collect(r.driver, "job-1");
    assert.equal(events.at(-1)?.kind, "state");
    assert.deepEqual(kinds(events).slice(-2), ["result", "state:succeeded"]);
  } finally {
    r.cleanup();
  }
});

test("parseEvidence is strict; FileEvidenceStore round-trips and reads a bad file as no evidence", async () => {
  assert.equal(parseEvidence(null), undefined);
  assert.equal(parseEvidence({ schema: 2 }), undefined);
  assert.equal(parseEvidence({ ...goodEvidence(), shell: { state: "maybe", how: "x" } }), undefined);
  assert.equal(parseEvidence({ ...goodEvidence(), processCheck: "sure" }), undefined);
  const e = goodEvidence({ modeId: "ask" });
  assert.deepEqual(parseEvidence(JSON.parse(JSON.stringify(e))), e);

  const dir = tempDir();
  try {
    const path = join(dir.path, "nested", "dsh-probe.json");
    const store = new FileEvidenceStore(path);
    assert.equal(await store.read(), undefined);
    await store.write(e);
    assert.deepEqual(await store.read(), e);
    writeFileSync(path, "{ not json");
    assert.equal(await store.read(), undefined);
    writeFileSync(path, JSON.stringify({ schema: 1 }));
    assert.equal(await store.read(), undefined);
  } finally {
    dir.cleanup();
  }
});

test("a template whose engine is not dsh, or a relative cwd, is refused before anything starts", async () => {
  const r = rig();
  try {
    await assert.rejects(
      r.driver.start(spec(r.host, r.dir.path, { template: template({ engine: "claude" }) })),
      (e: unknown) => e instanceof DshRefusedError && e.code === "dsh_bad_spec",
    );
    await assert.rejects(
      r.driver.start(spec(r.host, "relative/dir")),
      (e: unknown) => e instanceof DshRefusedError && e.code === "dsh_bad_spec",
    );
    assert.equal(r.launches.length, 0);
  } finally {
    r.cleanup();
  }
});
