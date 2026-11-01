import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runMigration } from "../../scripts/migrate-settings.js";
import { auditFiles } from "../../src/settings/audit.js";
import { verifyAuditText } from "../../src/settings/chain.js";
import { ENV, ROOT, allFs, phase1Config, phase2Config, readJson, readLines, strataConfig, tempDir } from "./helpers.js";

interface Fixture {
  root: string;
  config: string;
  settings: string;
  prefs: string;
  out: string[];
}

function fixture(make: (folder: string, paths: Record<string, unknown>) => Record<string, unknown>, opts: { settingsFolder?: boolean } = {}): Fixture {
  const root = tempDir("a7-mig-");
  const notes = join(root, "notes");
  mkdirSync(notes, { recursive: true });
  const pd = join(root, "pd");
  const data = join(root, "data");
  const settings = join(pd, "settings");
  if (opts.settingsFolder !== false) mkdirSync(join(settings, "audit"), { recursive: true });
  const cfg = make(notes, { programDataDir: pd, dataDir: data });
  cfg["paths"] = { programDataDir: pd, dataDir: data };
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify(cfg, null, 2));
  return { root, config, settings, prefs: join(data, "prefs", "prefs.json"), out: [] };
}

const io = (f: Fixture, over: Record<string, unknown> = {}) => ({ out: (l: string) => void f.out.push(l), env: ENV, fs: allFs, checkAcl: () => [], now: () => new Date("2026-10-30T10:00:00Z"), ...over });
const args = (f: Fixture, extra: Record<string, unknown> = {}) => ({ config: f.config, agentUser: "agent007", apply: false, rollback: false, ...extra });

test("migrate: the default is a dry run that prints the split table and changes nothing", async () => {
  const f = fixture((n) => phase1Config(n));
  const before = readFileSync(f.config, "utf8");
  const code = await runMigration(args(f), io(f));
  assert.equal(code, 0);
  assert.match(f.out.join("\n"), /telegram\s+-> security/);
  assert.match(f.out.join("\n"), /paths\s+-> bootstrap/);
  assert.match(f.out.join("\n"), /Ready/);
  assert.equal(readFileSync(f.config, "utf8"), before);
  assert.equal(existsSync(join(f.settings, "security.json")), false);
  rmSync(f.root, { recursive: true, force: true });
});

test("migrate --apply: backup, security.json through the writer (one audit line source migrate), prefs.json, config.json v2", async () => {
  const f = fixture((n) => phase2Config(n));
  const original = readFileSync(f.config, "utf8");
  assert.equal(await runMigration(args(f, { apply: true }), io(f)), 0);
  const rewritten = readJson(f.config);
  assert.equal(rewritten["schemaVersion"], 2);
  assert.equal(rewritten["telegram"], undefined);
  const security = readJson(join(f.settings, "security.json"));
  assert.equal(security["schemaVersion"], 1);
  assert.deepEqual((security["telegram"] as Record<string, unknown>)["allowedUserIds"], [4242]);
  assert.ok(existsSync(f.prefs));
  const backups = readdirSync(f.root).filter((n) => n.startsWith("config.json.pre-phase3-"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(f.root, backups[0] as string), "utf8"), original);
  const files = auditFiles(join(f.settings, "audit"));
  assert.equal(files.length, 1);
  const lines = readLines(files[0] as string);
  const migrateLines = lines.filter((l) => l["source"] === "migrate");
  assert.equal(migrateLines.length >= 1, true);
  assert.ok(lines.some((l) => (l["target"] as Record<string, string>)["file"] === "security.json" && l["source"] === "migrate"));
  assert.equal(verifyAuditText(readFileSync(files[0] as string, "utf8")).ok, true, "the chain verifies");
  rmSync(f.root, { recursive: true, force: true });
});

test("migrate --apply twice is idempotent: the second run is a no-op that exits 0", async () => {
  const f = fixture((n) => strataConfig(n));
  assert.equal(await runMigration(args(f, { apply: true }), io(f)), 0);
  const cfgAfterFirst = readFileSync(f.config, "utf8");
  const secAfterFirst = readFileSync(join(f.settings, "security.json"), "utf8");
  f.out.length = 0;
  assert.equal(await runMigration(args(f, { apply: true }), io(f)), 0);
  assert.match(f.out.join("\n"), /already has schemaVersion 2/);
  assert.equal(readFileSync(f.config, "utf8"), cfgAfterFirst);
  assert.equal(readFileSync(join(f.settings, "security.json"), "utf8"), secAfterFirst);
  assert.equal(readdirSync(f.root).filter((n) => n.startsWith("config.json.pre-phase3-")).length, 1, "no second backup");
  rmSync(f.root, { recursive: true, force: true });
});

test("migrate --rollback restores a byte-identical config.json and renames the new files", async () => {
  const f = fixture((n) => phase1Config(n));
  const original = readFileSync(f.config, "utf8");
  await runMigration(args(f, { apply: true }), io(f));
  assert.notEqual(readFileSync(f.config, "utf8"), original);
  assert.equal(await runMigration(args(f, { rollback: true }), io(f)), 0);
  assert.equal(readFileSync(f.config, "utf8"), original, "byte-identical");
  assert.equal(existsSync(join(f.settings, "security.json")), false);
  assert.ok(readdirSync(f.settings).some((n) => n.startsWith("security.json.rolledback-")));
  assert.ok(readdirSync(join(f.root, "data", "prefs")).some((n) => n.startsWith("prefs.json.rolledback-")));
  // and a rollback with no backup says so
  const g = fixture((n) => phase1Config(n));
  assert.equal(await runMigration(args(g, { rollback: true }), io(g)), 1);
  rmSync(f.root, { recursive: true, force: true });
  rmSync(g.root, { recursive: true, force: true });
});

test("migrate --apply without the settings folder, or with wrong ACLs, warns and does not run", async () => {
  const f = fixture((n) => phase1Config(n), { settingsFolder: false });
  const before = readFileSync(f.config, "utf8");
  assert.equal(await runMigration(args(f, { apply: true }), io(f)), 1);
  assert.match(f.out.join("\n"), /setup-settings-acl\.ps1/);
  assert.equal(readFileSync(f.config, "utf8"), before);
  const g = fixture((n) => phase1Config(n));
  assert.equal(await runMigration(args(g, { apply: true }), io(g, { checkAcl: () => ["security.json: the agent user (HOST\\agent007) has W (read only is required)"] })), 1);
  assert.match(g.out.join("\n"), /ACLs are not as required/);
  assert.equal(existsSync(join(g.settings, "security.json")), false);
  assert.equal(readdirSync(g.root).some((n) => n.startsWith("config.json.pre-phase3-")), false, "nothing was backed up or changed");
  rmSync(f.root, { recursive: true, force: true });
  rmSync(g.root, { recursive: true, force: true });
});

test("migrate refuses an unclassified key and a secret-looking value (key name only)", async () => {
  const f = fixture((n) => phase1Config(n, { mystery: 1 }));
  assert.equal(await runMigration(args(f, { apply: true }), io(f)), 1);
  assert.match(f.out.join("\n"), /mystery/);
  const g = fixture((n) => phase1Config(n, { model: { ...(phase1Config(n)["model"] as object), apiKey: "sk-0123456789abcdefghijklmnopqrstuv" } }));
  assert.equal(await runMigration(args(g), io(g)), 1);
  assert.match(g.out.join("\n"), /model\.apiKey/);
  assert.ok(!g.out.join("\n").includes("0123456789abcdefghijklmnopqrstuv"));
  rmSync(f.root, { recursive: true, force: true });
  rmSync(g.root, { recursive: true, force: true });
});

test("migrate: config/config.example.json (with its top-level tools block) applies and rolls back (ACL check stubbed)", async () => {
  const example = JSON.parse(readFileSync(join(ROOT, "config", "config.example.json"), "utf8")) as Record<string, unknown>;
  assert.ok(example["tools"] !== undefined, "the example still carries a tools block");
  const f = fixture((notes) => {
    const c = structuredClone(example);
    c["folders"] = { allow: [{ alias: "notes", path: notes }], deny: [] };
    return c;
  });
  const original = readFileSync(f.config, "utf8");
  const dry = await runMigration(args(f), io(f));
  assert.equal(dry, 0, f.out.join("\n"));
  const code = await runMigration(args(f, { apply: true }), io(f));
  assert.equal(code, 0, f.out.join("\n"));
  const security = readJson(join(f.settings, "security.json"));
  assert.ok(security["tools"] !== undefined, "tools moved to security.json");
  assert.equal(readJson(f.config)["schemaVersion"], 2);
  const back = await runMigration(args(f, { rollback: true }), io(f, { now: () => new Date("2026-10-30T10:00:05Z") }));
  assert.equal(back, 0, f.out.join("\n"));
  assert.equal(readFileSync(f.config, "utf8"), original, "config.json is restored byte for byte");
});
