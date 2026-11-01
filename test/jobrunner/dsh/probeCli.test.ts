import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProbeArgs, runProbeCli } from "../../../src/jobrunner/drivers/dsh/probeCli.js";
import type { ProbeCliDeps } from "../../../src/jobrunner/drivers/dsh/probeCli.js";
import type { RunProbeOptions } from "../../../src/jobrunner/drivers/dsh/probe.js";
import { MemoryEvidenceStore } from "../../../src/jobrunner/drivers/dsh/gate.js";
import { goodEvidence, memoryLogger } from "./helpers.js";

function deps(over: Partial<ProbeCliDeps> = {}): ProbeCliDeps & { lines: string[]; calls: RunProbeOptions[] } {
  const lines: string[] = [];
  const calls: RunProbeOptions[] = [];
  const d: ProbeCliDeps = {
    out: (l) => lines.push(l),
    env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" },
    isEmptyDir: () => true,
    resolveDsh: (e) => e ?? "C:\\tools\\dsh.exe",
    readDeepseekKey: () => "sk-test-not-real",
    probe: async (o) => {
      calls.push(o);
      return goodEvidence();
    },
    storeFor: () => new MemoryEvidenceStore(undefined),
    logger: memoryLogger(),
    ...over,
  };
  return Object.assign(d, { lines, calls });
}

test("probe cli: parses flags and refuses unknown ones", () => {
  const a = parseProbeArgs(["--live", "--cwd", "C:\\s", "--timeout-sec", "60", "--ask-first-mode", "ask"]);
  assert.equal(a.live, true);
  assert.equal(a.timeoutSec, 60);
  assert.equal(a.askFirstModeId, "ask");
  assert.throws(() => parseProbeArgs(["--bogus"]));
  assert.throws(() => parseProbeArgs(["--cwd"]));
  assert.throws(() => parseProbeArgs(["--timeout-sec", "5"]));
});

test("probe cli: without --live nothing runs (exit 2, usage printed)", async () => {
  const d = deps();
  assert.equal(await runProbeCli(["--cwd", "C:\\scratch"], d), 2);
  assert.equal(d.calls.length, 0);
  assert.ok(d.lines.some((l) => /dry run/.test(l)));
});

test("probe cli: refuses a relative, work or non-empty scratch folder, and an unknown dsh", async () => {
  for (const [cwd, over] of [
    ["scratch", {}],
    ["C:\\projects\\Personal\\creative-hub", {}],
    ["C:\\Pixotope\\x", {}],
    ["C:\\scratch", { isEmptyDir: () => false }],
  ] as Array<[string, Partial<ProbeCliDeps>]>) {
    const d = deps(over);
    assert.equal(await runProbeCli(["--live", "--cwd", cwd], d), 2, cwd);
    assert.equal(d.calls.length, 0);
  }
  const d = deps({ resolveDsh: () => { throw new Error("nope"); } });
  assert.equal(await runProbeCli(["--live", "--cwd", "C:\\scratch"], d), 2);
  assert.equal(d.calls.length, 0);
});

test("probe cli: --live passes the options to the probe, writes under the data dir, exits 0 on PASS, never prints the key", async () => {
  const d = deps();
  const code = await runProbeCli(["--live", "--cwd", "C:\\scratch", "--data-dir", "C:\\data", "--shell-off-attestation", "tools.shell=false", "--timeout-sec", "30"], d);
  assert.equal(code, 0);
  assert.equal(d.calls.length, 1);
  const o = d.calls[0] as RunProbeOptions;
  assert.equal(o.cwd, "C:\\scratch");
  assert.equal(o.timeoutMs, 30_000);
  assert.equal(o.shellOffAttestation, "tools.shell=false");
  assert.equal(o.deepseekApiKey, "sk-test-not-real");
  const text = d.lines.join("\n");
  assert.ok(text.includes("PASS"));
  assert.ok(text.includes("NOT changed"));
  assert.equal(text.includes("sk-test-not-real"), false);
  assert.ok(text.includes("C:\\data\\dsh-probe.json"));
});

test("probe cli: a failing probe exits 1 and lists the reasons", async () => {
  const d = deps({ probe: async () => goodEvidence({ passed: false, reasons: ["it ran anyway"] }) });
  assert.equal(await runProbeCli(["--live", "--cwd", "C:\\scratch"], d), 1);
  assert.ok(d.lines.some((l) => l.includes("it ran anyway")));
  assert.equal(d.lines.some((l) => /NOT changed/.test(l)), false);
});
