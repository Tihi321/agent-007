/**
 * S7.2 done-check: the deploy scripts' group (a) and group (b) lists equal builtinDenyNtfs / builtinDenyInProcessOnly
 * of S1.2 (read from the built module), the lists are disjoint, and no group (b) path (nor anything under or above it)
 * can receive a /deny ACE.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { builtinDenies, denyListsOverlap, normalizeWin } from "../../src/config/paths.js";
import { defaultsFromEnv, parseConfig } from "../../src/config/schema.js";
import { DEPLOY, HAS_WINDOWS_POWERSHELL, makeFixture, runPs, type Fixture } from "./_fixture.js";

const skip = HAS_WINDOWS_POWERSHELL ? false : "Windows PowerShell is not available";

function psLists(configPath: string): { a: string[]; b: string[] } {
  const common = join(DEPLOY, "common.ps1").replace(/'/g, "''");
  const cmd = `. '${common}'; $c = Read-JsonFile -Path '${configPath.replace(/'/g, "''")}'; $l = Resolve-AgentLayout -Config $c -AgentUser 'a7fixturenouser'; ConvertTo-Json -Compress -InputObject @{ a = @(Get-GroupAPaths -Layout $l); b = @(Get-GroupBPaths -Layout $l) }`;
  const r = runPs(["-Command", cmd]);
  assert.equal(r.status, 0, r.all);
  const parsed = JSON.parse(r.stdout.trim()) as { a: string[]; b: string[] };
  return { a: [parsed.a].flat(), b: [parsed.b].flat() };
}

function tsLists(f: Fixture, raw: unknown): { a: string[]; b: string[] } {
  const cfg = parseConfig(raw, defaultsFromEnv({ LOCALAPPDATA: f.root, ProgramData: f.root, AGENT007_MAIN_USER_PROFILE: f.profile }));
  const d = builtinDenies(cfg);
  assert.equal(denyListsOverlap(d), false, "the two groups are disjoint (S1.2)");
  return { a: d.ntfs, b: d.inProcessOnly };
}

const norm = (xs: string[]) => xs.map(normalizeWin).sort();

test("group (a) and group (b) of the scripts equal builtinDenies() from S1.2, for lmstudio and strata configs", { skip }, () => {
  for (const runner of ["lmstudio", "strata"] as const) {
    const fx = makeFixture({ runner, extraDeny: [join("C:\\", "Pixotope-fixture-never-created")] });
    try {
      const raw: unknown = JSON.parse(readFileSync(fx.configPath, "utf8"));
      const ts = tsLists(fx, raw);
      const ps = psLists(fx.configPath);
      assert.deepEqual(norm(ps.a), norm(ts.a), `group (a), runner ${runner}`);
      assert.deepEqual(norm(ps.b), norm(ts.b), `group (b), runner ${runner}`);
      // group (a) holds the main user's .lmstudio and folders.deny; group (b) holds the five protected locations
      assert.ok(ps.a.some((p) => normalizeWin(p) === normalizeWin(fx.lmstudio)));
      for (const p of [fx.pd, fx.data, fx.strataInstall, fx.strataData, fx.strataConfig, fx.strataLog]) {
        assert.ok(ps.b.some((x) => normalizeWin(x) === normalizeWin(p)), `group (b) has ${p}`);
        assert.ok(!ps.a.some((x) => normalizeWin(x) === normalizeWin(p)), `group (a) never has ${p}`);
      }
    } finally {
      fx.cleanup();
    }
  }
});

test("without a strata block the scripts use the same defaults as the schema: D:\\Strata, D:\\Strata-data, ProgramData files", { skip }, () => {
  const fx = makeFixture();
  try {
    const raw = JSON.parse(readFileSync(fx.configPath, "utf8")) as { model: { runners: Record<string, unknown> } };
    delete raw.model.runners["strata"];
    writeFileSync(fx.configPath, JSON.stringify(raw));
    const ts = tsLists(fx, raw);
    const ps = psLists(fx.configPath);
    assert.deepEqual(norm(ps.a), norm(ts.a));
    // the schema default for the Strata config copy and log live under programDataDir, as in the script
    assert.deepEqual(norm(ps.b), norm(ts.b));
    for (const p of ["D:\\Strata", "D:\\Strata-data"]) assert.ok(ps.b.some((x) => normalizeWin(x) === normalizeWin(p)), `${p} is in group (b)`);
    assert.ok(!ps.a.some((x) => /^d:\\strata/i.test(x)), "D:\\Strata never in group (a)");
  } finally {
    fx.cleanup();
  }
});

test("Get-DenyRefusalReason refuses every path that is, is under, or contains a group (b) path", { skip }, () => {
  const fx = makeFixture({ runner: "strata" });
  try {
    const common = join(DEPLOY, "common.ps1").replace(/'/g, "''");
    const targets = [fx.pd, join(fx.pd, "config"), fx.data, join(fx.data, "x"), fx.strataInstall, join(fx.strataData, "a", "b"), fx.strataConfig, fx.strataLog, fx.root, join(fx.root, ".."), "C:\\"];
    const ok = [fx.deny, fx.lmstudio, join(fx.root, "elsewhere")];
    const ps = (t: string) =>
      `. '${common}'; $c = Read-JsonFile -Path '${fx.configPath.replace(/'/g, "''")}'; $l = Resolve-AgentLayout -Config $c -AgentUser 'x'; $r = Get-DenyRefusalReason -Target '${t.replace(/'/g, "''")}' -GroupB @(Get-GroupBPaths -Layout $l); if ($r) { 'REFUSED' } else { 'ALLOWED' }`;
    for (const t of targets) assert.equal(runPs(["-Command", ps(t)]).stdout.trim(), "REFUSED", `${t} must be refused`);
    for (const t of ok) assert.equal(runPs(["-Command", ps(t)]).stdout.trim(), "ALLOWED", `${t} must be allowed`);
  } finally {
    fx.cleanup();
  }
});
