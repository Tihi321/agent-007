import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../../src/config/load.js";
import { ConfigError, parseConfig } from "../../src/config/schema.js";
import { loadEffectiveConfig } from "../../src/settings/load.js";
import { defaultPrefs } from "../../src/settings/prefs.js";
import { revisionOf, settingsPaths } from "../../src/settings/store.js";
import { splitConfig, mergeConfig } from "../../src/settings/split.js";
import { ENV, phase1Config, phase2Config, tempDir, writeJson } from "./helpers.js";

const SECRETS = { lmStudioApiToken: "t", strataApiKey: "k" } as const;

function install(make: (n: string) => Record<string, unknown>): { root: string; configPath: string; paths: ReturnType<typeof settingsPaths>; legacy: Record<string, unknown> } {
  const root = tempDir("a7-load-");
  const notes = join(root, "notes");
  mkdirSync(notes, { recursive: true });
  const legacy = make(notes);
  legacy["paths"] = { programDataDir: join(root, "pd"), dataDir: join(root, "data") };
  const configPath = join(root, "config.json");
  writeJson(configPath, legacy);
  return { root, configPath, paths: settingsPaths(join(root, "pd"), join(root, "data")), legacy };
}

function migrate(i: ReturnType<typeof install>): void {
  const { bootstrap, security } = splitConfig(i.legacy, i.paths.settingsDir);
  writeJson(i.paths.securityFile, security);
  writeJson(i.configPath, bootstrap);
}

test("legacy mode: a Phase 1/2 config.json is read as before and a note is returned", () => {
  const i = install((n) => phase2Config(n));
  const eff = loadEffectiveConfig({ configPath: i.configPath, secrets: SECRETS, env: ENV });
  assert.equal(eff.settings.mode, "legacy");
  assert.equal(eff.settings.security, undefined);
  assert.match(eff.settings.notes.join("\n"), /legacy mode/);
  assert.deepEqual(eff.config, parseConfig(i.legacy, ENV));
  // loadConfig delegates and keeps its Phase 1/2 result shape
  const lc = loadConfig({ configPath: i.configPath, secrets: SECRETS, env: ENV });
  assert.deepEqual(lc.config, eff.config);
  assert.equal(lc.settings.mode, "legacy");
  rmSync(i.root, { recursive: true, force: true });
});

test("migrated mode: the Config shape is identical to the legacy one; security.json is an immutable snapshot with its revision", () => {
  const i = install((n) => phase2Config(n));
  const legacyConfig = loadEffectiveConfig({ configPath: i.configPath, secrets: SECRETS, env: ENV }).config;
  migrate(i);
  const eff = loadEffectiveConfig({ configPath: i.configPath, secrets: SECRETS, env: ENV });
  assert.equal(eff.settings.mode, "migrated");
  assert.deepEqual(eff.config, legacyConfig);
  assert.ok(eff.settings.security && Object.isFrozen(eff.settings.security));
  const text = (eff.settings.security ? JSON.stringify(eff.settings.security) : "") && undefined;
  void text;
  assert.equal(eff.settings.securityRevision.length, 64);
  assert.deepEqual(eff.settings.prefs.prefs, defaultPrefs());
  assert.deepEqual(mergeConfig({}, eff.settings.security as Record<string, unknown>)["folders"], (i.legacy["folders"] as unknown));
  rmSync(i.root, { recursive: true, force: true });
});

test("an invalid, missing or malformed security.json refuses start (ConfigError)", () => {
  const i = install((n) => phase1Config(n));
  migrate(i);
  const sec = { ...(splitConfig(i.legacy, i.paths.settingsDir).security as Record<string, unknown>), surprise: 1 };
  writeJson(i.paths.securityFile, sec);
  assert.throws(() => loadEffectiveConfig({ configPath: i.configPath, secrets: SECRETS, env: ENV }), ConfigError);
  writeFileSync(i.paths.securityFile, "{not json");
  assert.throws(() => loadEffectiveConfig({ configPath: i.configPath, secrets: SECRETS, env: ENV }), /not valid JSON/);
  rmSync(i.paths.securityFile);
  assert.throws(() => loadEffectiveConfig({ configPath: i.configPath, secrets: SECRETS, env: ENV }), /cannot be read/);
  rmSync(i.root, { recursive: true, force: true });
});

test("an invalid prefs.json falls back to the defaults with a warning; a valid one is read", () => {
  const i = install((n) => phase1Config(n));
  migrate(i);
  mkdirSync(i.paths.prefsDir, { recursive: true });
  writeFileSync(i.paths.prefsFile, JSON.stringify({ style: { tone: "angry" }, extra: 1 }));
  const bad = loadEffectiveConfig({ configPath: i.configPath, secrets: SECRETS, env: ENV });
  assert.deepEqual(bad.settings.prefs.prefs, defaultPrefs());
  assert.equal(bad.settings.prefs.fellBack, true);
  assert.match(bad.settings.notes.join("\n"), /prefs\.json is invalid/);
  writeJson(i.paths.prefsFile, { style: { tone: "friendly" } });
  const good = loadEffectiveConfig({ configPath: i.configPath, secrets: SECRETS, env: ENV });
  assert.equal(good.settings.prefs.prefs.style.tone, "friendly");
  assert.equal(good.settings.prefs.prefs.style.verbosity, "short", "defaults fill the rest");
  assert.equal(good.settings.prefs.revision, revisionOf(good.settings.prefs.text));
  rmSync(i.root, { recursive: true, force: true });
});

test("config.json with an unsupported schemaVersion or an invalid bootstrap is refused", () => {
  const i = install((n) => phase1Config(n));
  writeJson(i.configPath, { schemaVersion: 3 });
  assert.throws(() => loadEffectiveConfig({ configPath: i.configPath, secrets: SECRETS, env: ENV }), /not supported/);
  writeJson(i.configPath, { schemaVersion: 2, telegram: { allowedUserIds: [1] } });
  assert.throws(() => loadEffectiveConfig({ configPath: i.configPath, secrets: SECRETS, env: ENV }), /telegram: is not a known setting/);
  rmSync(i.root, { recursive: true, force: true });
});
