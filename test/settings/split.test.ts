import assert from "node:assert/strict";
import { test } from "node:test";
import { planMigration } from "../../src/settings/migrate.js";
import { DEFAULT_PROPOSALS, KEY_TABLE, UnclassifiedKeyError, mergeConfig, splitConfig, splitTable } from "../../src/settings/split.js";
import { ENV, allFs, phase1Config, phase2Config, strataConfig } from "./helpers.js";

const NOTES = "C:\\Users\\main\\notes";
const DIR = "C:\\ProgramData\\agent-007\\settings";

test("merge(split(c)) deep-equals c for a Phase 1 config, a Phase 2 config with MCP and jobs, and a Strata config", () => {
  for (const c of [phase1Config(NOTES), phase2Config(NOTES), strataConfig(NOTES)]) {
    const { bootstrap, security } = splitConfig(c, DIR);
    assert.deepEqual(mergeConfig(bootstrap, security), c);
  }
});

test("the split puts paths and the main user profile in config.json (v2) and everything else in security.json", () => {
  const { bootstrap, security } = splitConfig(phase2Config(NOTES), DIR);
  assert.equal(bootstrap["schemaVersion"], 2);
  assert.deepEqual(bootstrap["settings"], { dir: DIR });
  assert.ok(bootstrap["paths"] && bootstrap["mainUserProfile"] && bootstrap["_comment"]);
  assert.equal(bootstrap["telegram"], undefined);
  for (const k of ["telegram", "model", "folders", "shell", "mcp", "jobs", "flow", "secondOpinion", "presets", "budgets", "proposals"]) assert.ok(security[k] !== undefined, `security.json has ${k}`);
  assert.equal(security["paths"], undefined);
  assert.equal(security["schemaVersion"], 1);
  assert.deepEqual(security["proposals"], DEFAULT_PROPOSALS);
  assert.equal((security["model"] as Record<string, unknown>)["defaultPreset"], "lmstudio");
  assert.equal((security["presets"] as unknown[]).length, 1);
});

test("an unclassified key makes the split refuse (fail closed) and the table says REFUSED", () => {
  const c = phase1Config(NOTES, { newFeature: { on: true } });
  assert.throws(() => splitConfig(c, DIR), UnclassifiedKeyError);
  assert.deepEqual(splitTable(c).filter((r) => r.goes === "REFUSED"), [{ key: "newFeature", goes: "REFUSED" }]);
  const plan = planMigration(JSON.stringify(c), { settingsDir: DIR, env: ENV, fs: allFs });
  assert.match(plan.refusals.join("\n"), /newFeature/);
  assert.equal(plan.security, undefined);
});

test("every key of the Phase 1/2 config shape is in the table", () => {
  for (const k of Object.keys(phase2Config(NOTES))) assert.ok(k === "_comment" || KEY_TABLE[k] !== undefined, `${k} is classified`);
});

test("a secret-looking value in the old config is refused, naming the key only (never the value)", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const c = phase1Config(NOTES, { telegram: { allowedUserIds: [4242], botToken: secret } });
  const plan = planMigration(JSON.stringify(c), { settingsDir: DIR, env: ENV, fs: allFs });
  const text = plan.refusals.join("\n");
  assert.match(text, /telegram\.botToken/);
  assert.ok(!text.includes(secret), "the value is never printed");
  assert.equal(plan.refusals.length >= 1, true);
});

test("a plan for an already migrated config is a no-op", () => {
  const plan = planMigration(JSON.stringify({ schemaVersion: 2, settings: { dir: DIR } }), { settingsDir: DIR, env: ENV });
  assert.equal(plan.alreadyMigrated, true);
  assert.deepEqual(plan.refusals, []);
});

test("tools (the Phase 2 placeholder block of the example config) is classified security and round-trips", () => {
  assert.equal(KEY_TABLE["tools"], "security");
  const c = phase2Config(NOTES);
  c["tools"] = { _comment: "Nothing to configure." };
  const { bootstrap, security } = splitConfig(c, DIR);
  assert.deepEqual(security["tools"], { _comment: "Nothing to configure." });
  assert.equal(bootstrap["tools"], undefined);
  assert.deepEqual(mergeConfig(bootstrap, security), c);
  assert.deepEqual(splitTable(c).filter((r) => r.key === "tools"), [{ key: "tools", goes: "security" }]);
});
