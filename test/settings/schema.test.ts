import assert from "node:assert/strict";
import { test } from "node:test";
import { validate, schemaPaths } from "../../src/settings/jsonschema.js";
import type { Schema } from "../../src/settings/jsonschema.js";
import { SECURITY_SCHEMA, validateSecurityDoc } from "../../src/settings/schema.js";
import { splitConfig } from "../../src/settings/split.js";
import { ENV, allFs, phase1Config, phase2Config, strataConfig } from "./helpers.js";

const NOTES = "C:\\Users\\main\\notes";

function securityOf(cfg: Record<string, unknown>): Record<string, unknown> {
  return splitConfig(cfg, "C:\\ProgramData\\agent-007\\settings").security;
}

function check(doc: unknown): { ok: boolean; issues: string[] } {
  return validateSecurityDoc(doc, { env: ENV, fs: allFs });
}

function mutate(base: Record<string, unknown>, fn: (d: Record<string, any>) => void): Record<string, unknown> {
  const d = structuredClone(base) as Record<string, any>;
  fn(d);
  return d;
}

test("jsonschema: types, enums, ranges, patterns, required, additionalProperties and comments", () => {
  const s: Schema = {
    type: "object",
    required: ["a"],
    properties: {
      a: { type: "integer", minimum: 1, maximum: 5 },
      b: { type: "string", pattern: "^x+$", maxLength: 3 },
      c: { type: "string", enum: ["u", "v"] },
      d: { type: "array", items: { type: "boolean" }, maxItems: 2 },
    },
  };
  assert.deepEqual(validate(s, { a: 2, b: "xx", c: "u", d: [true] }), []);
  assert.equal(validate(s, {}).length, 1, "required");
  assert.match(validate(s, { a: 9 })[0]?.message ?? "", /at most 5/);
  assert.match(validate(s, { a: 1.5 })[0]?.message ?? "", /whole number/);
  assert.equal(validate(s, { a: 1, b: "ab12" }).length, 2, "pattern and length");
  assert.match(validate(s, { a: 1, c: "w" })[0]?.message ?? "", /one of/);
  assert.match(validate(s, { a: 1, d: [true, 1] })[0]?.path ?? "", /d\[1\]/);
  assert.match(validate(s, { a: 1, zzz: 1 })[0]?.message ?? "", /not a known setting/);
  assert.deepEqual(validate(s, { a: 1, _note: "ignored" }), [], "underscore keys are comments");
  assert.match(validate(s, JSON.parse('{"a":1,"__proto__":{"x":1}}'))[0]?.message ?? "", /not an allowed key/);
  assert.ok(schemaPaths(s).includes("a"));
});

test("security.json: every migrated shape is valid (Phase 1, Phase 2 with MCP and jobs, Strata)", () => {
  for (const cfg of [phase1Config(NOTES), phase2Config(NOTES), strataConfig(NOTES)]) {
    const r = check(securityOf(cfg));
    assert.deepEqual(r.issues, []);
    assert.equal(r.ok, true);
  }
});

test("security.json: the refusals of the Phase 1/2 loader are enforced on the document", () => {
  const base = securityOf(phase1Config(NOTES));
  const nonLoopback = mutate(base, (d) => (d.model.runners.lmstudio.baseUrl = "http://192.168.1.5:1234/v1"));
  assert.match(check(nonLoopback).issues.join("\n"), /loopback/);
  const empty = mutate(base, (d) => (d.folders.allow = []));
  assert.equal(check(empty).ok, false, "an empty allowlist is refused");
  const unknownRunner = mutate(base, (d) => (d.model.runner = "ollama"));
  assert.equal(check(unknownRunner).ok, false);
  const missingBlock = mutate(base, (d) => (d.model.runner = "strata"));
  assert.match(check(missingBlock).issues.join("\n"), /no (block|runner block)/);
  const dup = mutate(base, (d) => d.folders.allow.push({ alias: "NOTES", path: NOTES }));
  assert.match(check(dup).issues.join("\n"), /duplicate alias/);
  const badMcp = mutate(securityOf(phase2Config(NOTES)), (d) => (d.mcp.servers[0].url = "http://example.com/mcp"));
  assert.match(check(badMcp).issues.join("\n"), /loopback/);
  const dupMcp = mutate(securityOf(phase2Config(NOTES)), (d) => d.mcp.servers.push({ ...d.mcp.servers[0] }));
  assert.match(check(dupMcp).issues.join("\n"), /duplicate server id/);
});

test("security.json: a hand-edited unknown key is rejected; comments are not; a missing folder is refused", () => {
  const base = securityOf(phase1Config(NOTES));
  assert.match(check(mutate(base, (d) => (d.surprise = true))).issues.join("\n"), /surprise: is not a known setting/);
  assert.match(check(mutate(base, (d) => (d.shell.extra = 1))).issues.join("\n"), /shell\.extra/);
  assert.equal(check(mutate(base, (d) => (d._comment = "note"))).ok, true);
  const missing = validateSecurityDoc(base, { env: ENV, fs: { exists: () => false, isDirectory: () => false } });
  assert.match(missing.issues.join("\n"), /does not exist or is not a folder/);
  assert.equal(validateSecurityDoc(base, { env: ENV, skipFolderExists: true, fs: { exists: () => false, isDirectory: () => false } }).ok, true);
});

test("security.json: presets must name a runner block and the default preset must exist; ids are unique", () => {
  const base = securityOf(phase1Config(NOTES));
  assert.match(check(mutate(base, (d) => (d.model.defaultPreset = "nope"))).issues.join("\n"), /not one of the presets/);
  assert.match(check(mutate(base, (d) => d.presets.push({ ...d.presets[0] }))).issues.join("\n"), /duplicate preset id/);
  assert.match(check(mutate(base, (d) => (d.presets[0].runner = "strata"))).issues.join("\n"), /no runner block/);
  assert.match(check(mutate(base, (d) => (d.proposals.perHour = 0))).issues.join("\n"), /at least 1/);
  assert.equal(check(mutate(base, (d) => (d.proposals.autoApplyCosmetic = true))).ok, true);
});

test("the security schema describes every section the forms need (descriptors drive the UI)", () => {
  const paths = schemaPaths(SECURITY_SCHEMA);
  for (const p of ["telegram.allowedUserIds", "folders.allow", "folders.deny", "shell.enabled", "model.runners", "mcp.servers", "jobs.ipcPort", "proposals.autoApplyCosmetic", "budgets.maxJobsPerDay", "presets"]) {
    assert.ok(paths.includes(p), `descriptor for ${p}`);
  }
});
