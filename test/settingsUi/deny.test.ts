import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { denyRulesForPaths } from "../../src/jobrunner/drivers/claude/argv.js";
import { DenyPathsUnavailableError, denyPathSource, effectiveDenyPaths } from "../../src/jobrunner/settingsUi/denyPaths.js";
import { checkCwd } from "../../src/jobrunner/cwd.js";
import { splitConfig } from "../../src/settings/split.js";
import { claudeTemplate, makeRig, submitBody } from "../jobrunner/core/helpers.js";
import { buildClaudeArgs } from "../../src/jobrunner/drivers/claude/argv.js";
import { parseTemplate } from "../../src/jobrunner/templates.js";
import { phase1Config, tempDir, writeJson } from "../settings/helpers.js";

function securityFile(dir: string, deny: string[]): string {
  const cfg = phase1Config(dir, { folders: { allow: [{ alias: "notes", path: dir }], deny } });
  const file = join(dir, "settings", "security.json");
  writeJson(file, splitConfig(cfg, join(dir, "settings")).security);
  return file;
}

test("effectiveDenyPaths is the union of the job runner's own list and security.json folders.deny (no duplicates)", () => {
  const dir = tempDir("a7-deny-");
  const file = securityFile(dir, ["C:\\Pixotope", "D:\\Work", "c:\\pixotope\\"]);
  const eff = effectiveDenyPaths({ ownDeny: ["C:\\Pixotope", "C:\\ProgramData\\agent-007"], securityFile: file });
  assert.deepEqual(eff, ["C:\\Pixotope", "C:\\ProgramData\\agent-007", "D:\\Work"]);
  assert.deepEqual(effectiveDenyPaths({ ownDeny: ["C:\\A"] }), ["C:\\A"], "no security file configured");
  assert.deepEqual(effectiveDenyPaths({ ownDeny: ["C:\\A"], securityFile: join(dir, "missing.json") }), ["C:\\A"], "an install that was never migrated");
  rmSync(dir, { recursive: true, force: true });
});

test("a path added to security.json appears as a cwd refusal and as one Read, Edit and Write deny rule in the next job's argv; removing it removes the rules", () => {
  const dir = tempDir("a7-deny-");
  const own = ["C:\\Pixotope"];
  const file = securityFile(dir, []);
  const source = denyPathSource({ ownDeny: own, securityFile: file });
  const tpl = parseTemplate(claudeTemplate({ hub: dir }), { flowServerId: "flow-music-mcp" });
  assert.ok(tpl.ok);
  const argvOf = (): string[] => buildClaudeArgs({ template: (tpl as { ok: true; template: import("../../src/jobs/contracts.js").JobTemplate }).template, mcpConfigPath: join(dir, "m.json"), denyPaths: source(), flowServerId: "flow-music-mcp" }).args;
  const rulesFor = (args: string[], needle: string): string[] => args.filter((a) => a.includes(needle));
  assert.equal(rulesFor(argvOf(), "TopSecret").length, 0);
  const secret = join(dir, "TopSecret");
  mkdirSync(secret, { recursive: true });
  writeFileSync(file, readNew(file, [secret]));
  const withDeny = argvOf();
  const rules = rulesFor(withDeny, "TopSecret");
  assert.equal(rules.length, 3, "one Read, one Edit, one Write rule");
  assert.deepEqual(rules.map((r) => r.split("(")[0]).sort(), ["Edit", "Read", "Write"]);
  assert.deepEqual(denyRulesForPaths([secret]).length, 3);
  // the cwd check refuses a cwd under it, with the live list
  const refused = checkCwd(join(secret, "inner"), { allowlist: [dir], denyPaths: source() });
  assert.equal(refused.ok, false);
  // removing it removes the rules
  writeFileSync(file, readNew(file, []));
  assert.equal(rulesFor(argvOf(), "TopSecret").length, 0);
  rmSync(dir, { recursive: true, force: true });
});

function readNew(file: string, deny: string[]): string {
  const doc = JSON.parse(readFileSync(file, "utf8")) as { folders: { deny: string[] } };
  doc.folders.deny = deny;
  return JSON.stringify(doc, null, 2);
}

test("an unreadable or invalid security.json makes the deny list throw (fail closed)", () => {
  const dir = tempDir("a7-deny-");
  const file = securityFile(dir, []);
  writeFileSync(file, "{broken");
  assert.throws(() => effectiveDenyPaths({ ownDeny: [], securityFile: file }), DenyPathsUnavailableError);
  const doc = JSON.parse(JSON.stringify(splitConfig(phase1Config(dir), dir).security)) as Record<string, unknown>;
  doc["surprise"] = true;
  writeJson(file, doc);
  assert.throws(() => effectiveDenyPaths({ ownDeny: [], securityFile: file }), /not valid/);
  writeJson(file, { ...doc, surprise: undefined, folders: { allow: [], deny: [] } });
  assert.throws(() => effectiveDenyPaths({ ownDeny: [], securityFile: file }), DenyPathsUnavailableError);
  rmSync(dir, { recursive: true, force: true });
});

test("the job manager refuses NEW jobs while the deny list cannot be read, and accepts them once it can", async () => {
  const dir = tempDir("a7-deny-");
  const file = securityFile(dir, []);
  const rig = makeRig({ overrides: { denyPaths: denyPathSource({ ownDeny: [], securityFile: file }) } });
  try {
    writeFileSync(file, "{broken");
    await assert.rejects(rig.manager.submit(submitBody("j1")), (e: unknown) => (e as { code?: string }).code === "cwd_refused" && /deny paths could not be read/.test((e as Error).message));
    assert.equal(rig.drivers.claude.starts.length, 0, "no job started");
    writeJson(file, splitConfig(phase1Config(dir), join(dir, "settings")).security);
    const ok = await rig.manager.submit(submitBody("j2"));
    assert.ok(ok);
  } finally {
    rig.env.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
