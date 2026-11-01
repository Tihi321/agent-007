/**
 * S20.1 done-check: the migration of a fixture install is round-trip safe and leaves the old files. The fixture is a real Pi
 * Harness on a real SQLite file (a conversation made through the Telegram bridge over a fake runner and a fake Telegram API).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { applyBotMigration, checkMainMigrated, formatBotMigrationPlan, mainBotDoc, planBotMigration } from "../../src/bots/migrate.js";
import { botPaths } from "../../src/bots/paths.js";
import { parseBots } from "../../src/bots/schema.js";
import { acquireLock, LockHeldError } from "../../src/runtime/lock.js";
import { startFakeOpenAi } from "../helpers/fakeOpenAi.js";
import { MODEL_ID, echoBehavior, openRig } from "../telegram/helpers/bridgeRig.js";
import { USER_ID, textUpdate, waitFor } from "../telegram/helpers/fakeTelegram.js";
import { parseArgs, runBotMigration } from "../../scripts/migrate-bots.js";
import { cleanup, put, tempBase } from "../tools/fixture.js";
import { NOTES, baseSecurity, check, withBots } from "./helpers.js";

const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

const sha = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");

/** Hash of every file under a folder (relative path -> sha). */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(root.length)] = sha(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

function fixtureRoot(): string {
  const dir = tempBase("bots-migrate");
  dirs.push(dir);
  return dir;
}

test("the plan lists every copy and creates nothing; a fresh install has no storage step", () => {
  const data = join(fixtureRoot(), "data");
  put(join(data, "state", "agent.sqlite"), "x");
  put(join(data, "memory", "MEMORY.md"), "- fact\n");
  put(join(data, "workspace", "out.txt"), "w");
  put(join(data, "prefs", "prefs.json"), "{}");
  const plan = planBotMigration({ dataDir: data, runDir: join(data, "run"), now: () => new Date("2026-10-30T10:00:00Z") });
  assert.equal(plan.alreadyMigrated, false);
  const kinds = plan.steps.map((s) => s.kind);
  assert.ok(kinds.includes("backup-sqlite") && kinds.includes("copy-sqlite") && kinds.includes("copy-file") && kinds.includes("copy-dir"));
  assert.ok(plan.steps.some((s) => s.kind === "backup-sqlite" && s.to.includes("pre-bots-20261030T100000Z")));
  assert.equal(existsSync(join(data, "bots")), false, "a dry run creates nothing");
  assert.match(formatBotMigrationPlan(plan).join("\n"), /Ready\. Stop the agent/);

  const fresh = planBotMigration({ dataDir: join(fixtureRoot(), "fresh"), runDir: "x" });
  assert.equal(fresh.steps.some((s) => s.kind === "copy-sqlite"), false);
  assert.ok(fresh.steps.every((s) => s.kind === "mkdir"));
});

test("a fixture install migrates round trip safe: the old files are untouched, the copy is byte-identical and the conversation continues", async () => {
  const root = fixtureRoot();
  const data = join(root, "data");
  const legacy = botPaths(data, "main", "legacy");
  const target = botPaths(data, "main", "bots");
  const fake = await startFakeOpenAi({ behavior: echoBehavior, modelId: MODEL_ID });
  try {
    // 1. a Phase 1 to 3 install: a real conversation in <data>\state\agent.sqlite
    mkdirSync(legacy.stateDir, { recursive: true });
    const old = await openRig({ dir: legacy.stateDir, fake });
    await old.tg.bot.handleUpdate(textUpdate(USER_ID, "remember the blue door", { messageId: 21 }) as never);
    await waitFor(() => old.tg.messageTexts().some((m) => m.text === "echo: remember the blue door"), 8000, "the first answer");
    await old.bridge.delivery()!.idle();
    await old.shutdown();
    put(legacy.memoryFile, "- 2026-10-29: likes tea\n");
    put(join(legacy.workspaceDir, "out", "report.txt"), "report");
    put(join(legacy.prefsDir, "prefs.json"), '{"style":{"tone":"concise"}}');
    put(join(legacy.prefsDir, "personas", "p.json"), "{}");
    const before = tree(data);
    assert.ok(Object.keys(before).some((k) => k.endsWith("agent.sqlite")));

    // 2. the migration
    const plan = planBotMigration({ dataDir: data, runDir: join(data, "run"), now: () => new Date("2026-10-30T10:00:00Z") });
    const result = await applyBotMigration(plan, { dataDir: data, runDir: join(data, "run"), now: () => new Date("2026-10-30T10:00:00Z") });
    assert.equal(result.integrity, "ok");
    assert.match(result.note, /old files were left in place/);

    // 3. the old files are untouched (nothing deleted, nothing changed), new files exist beside them
    const after = tree(data);
    for (const [k, v] of Object.entries(before)) assert.equal(after[k], v, `the old file ${k} is unchanged`);
    assert.equal(sha(target.storageFile), sha(legacy.storageFile), "the storage copy is byte-identical");
    const backup = readdirSync(legacy.stateDir).find((n) => n.startsWith("pre-bots-"));
    assert.ok(backup, "a backup copy exists");
    assert.equal(sha(join(legacy.stateDir, backup, "agent.sqlite")), sha(legacy.storageFile));
    assert.equal(readFileSync(target.memoryFile, "utf8"), "- 2026-10-29: likes tea\n");
    assert.equal(readFileSync(join(target.workspaceDir, "out", "report.txt"), "utf8"), "report");
    assert.equal(readFileSync(join(target.prefsDir, "prefs.json"), "utf8"), '{"style":{"tone":"concise"}}');
    assert.ok(existsSync(join(target.prefsDir, "personas", "p.json")));
    assert.ok(existsSync(join(target.root, "migrated-from-phase3.json")));
    assert.equal(checkMainMigrated(data), undefined);

    // 4. the migrated storage is a working Pi storage: the same chat continues in the same conversation with its history
    const requestsBefore = fake.chatRequests().length;
    const moved = await openRig({ dir: target.stateDir, fake });
    try {
      await moved.tg.bot.handleUpdate(textUpdate(USER_ID, "what did I ask before?", { messageId: 22 }) as never);
      await waitFor(() => moved.tg.messageTexts().some((m) => m.text === "echo: what did I ask before?"), 8000, "the answer after the migration");
      const req = fake.chatRequests()[requestsBefore];
      assert.ok(req, "the model was called");
      assert.ok(JSON.stringify(req.body?.messages).includes("remember the blue door"), "the earlier turn is in the history the model sees");
    } finally {
      await moved.shutdown();
    }

    // 5. a second run does nothing
    const again = planBotMigration({ dataDir: data, runDir: join(data, "run") });
    assert.equal(again.alreadyMigrated, true);
    assert.match(formatBotMigrationPlan(again).join("\n"), /nothing to do/);
    assert.deepEqual((await applyBotMigration(again, { dataDir: data, runDir: join(data, "run") })).copied, []);
  } finally {
    await fake.close();
  }
});

test("the migration refuses while an agent holds the lock, and a failed copy leaves the old files untouched", async () => {
  const data = join(fixtureRoot(), "data");
  const legacy = botPaths(data, "main", "legacy");
  const target = botPaths(data, "main", "bots");
  put(legacy.storageFile, "SQLITE-STAND-IN");
  put(legacy.memoryFile, "- fact\n");
  const before = tree(data);
  const runDir = join(data, "run");
  // a live holder: the parent process stands in for a running agent
  const held = acquireLock(join(runDir, "agent.lock"), { pid: process.ppid });
  try {
    const plan = planBotMigration({ dataDir: data, runDir });
    await assert.rejects(applyBotMigration(plan, { dataDir: data, runDir }), LockHeldError);
  } finally {
    held.release();
  }
  assert.deepEqual(tree(data), before, "nothing was created or changed while the lock was held");
  assert.equal(existsSync(join(runDir, "agent.lock")), false, "the lock is released");
  // a destination file that already exists is never overwritten
  put(target.memoryFile, "- already here\n");
  const plan = planBotMigration({ dataDir: data, runDir });
  await assert.rejects(applyBotMigration(plan, { dataDir: data, runDir }), (e: Error) => /refusing to overwrite|integrity_check|not a database/i.test(e.message));
  for (const [k, v] of Object.entries(before)) assert.equal(tree(data)[k], v, `${k} is unchanged`);
  assert.equal(readFileSync(target.memoryFile, "utf8"), "- already here\n");
  assert.equal(existsSync(join(runDir, "agent.lock")), false, "the lock is released after a failure");
});

test("checkMainMigrated: an explicit bots.main with unmigrated Phase 1 to 3 storage is refused before start; a fresh install is fine", () => {
  const data = join(fixtureRoot(), "data");
  assert.equal(checkMainMigrated(data), undefined, "a fresh install has nothing to migrate");
  put(botPaths(data, "main", "legacy").storageFile, "x");
  assert.match(checkMainMigrated(data) ?? "", /run scripts\\migrate-bots/);
  put(botPaths(data, "main", "bots").storageFile, "x");
  assert.equal(checkMainMigrated(data), undefined);
});

test("mainBotDoc: the block the user enters in the UI is valid and parses back to the same main", () => {
  const sec = baseSecurity();
  const implicit = parseBots(sec, { folderAllow: [{ alias: "notes", path: NOTES }], derivedPresets: [], defaultPreset: "lmstudio" }).bots[0]!;
  const doc = withBots({ main: mainBotDoc(implicit) });
  const r = check(doc);
  assert.equal(r.ok, true, r.issues.join(" | "));
  const explicit = parseBots(doc, { folderAllow: [{ alias: "notes", path: NOTES }], derivedPresets: [], defaultPreset: "lmstudio" }).bots[0]!;
  assert.deepEqual(explicit.tools, implicit.tools);
  assert.deepEqual(explicit.route.primary, implicit.route.primary);
  assert.equal(explicit.layout, "bots");
  assert.equal(implicit.layout, "legacy");
});

test("scripts/migrate-bots: the dry run prints the plan and the bots.main block and copies nothing; a failing --apply reports it and leaves the old files", async () => {
  const root = fixtureRoot();
  const data = join(root, "data");
  put(botPaths(data, "main", "legacy").storageFile, "SQLITE-STAND-IN");
  put(botPaths(data, "main", "legacy").memoryFile, "- fact\n");
  const config = JSON.stringify({
    telegram: { allowedUserIds: [1] },
    model: { runner: "lmstudio", runners: { lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", modelId: "m", contextWindow: 8192, maxTokens: 512 } } },
    folders: { allow: [{ alias: "notes", path: root }], deny: [] },
    paths: { programDataDir: join(root, "pd"), dataDir: data, runDir: join(data, "run") },
  });
  const out: string[] = [];
  const io = { out: (l: string) => void out.push(l), readConfig: () => config, now: () => new Date("2026-10-30T10:00:00Z") };
  let code = await runBotMigration({ config: join(root, "config.json"), apply: false }, io);
  assert.equal(code, 0);
  assert.match(out.join("\n"), /Copy plan/);
  assert.match(out.join("\n"), /enter this as bots\.main in the settings UI/);
  assert.match(out.join("\n"), /"telegramTokenRef": "main"/);
  assert.match(out.join("\n"), /Dry run: nothing was copied/);
  assert.equal(existsSync(join(data, "bots")), false);
  out.length = 0;
  code = await runBotMigration({ config: join(root, "config.json"), apply: true }, { ...io, readFile: () => config });
  // the stand-in is not a real SQLite file, so the integrity check refuses it: the script reports a failure and the old files stay
  assert.equal(code, 1);
  assert.match(out.join("\n"), /FAILED: .*The old files were not changed/);
  assert.equal(readFileSync(botPaths(data, "main", "legacy").memoryFile, "utf8"), "- fact\n");
  assert.deepEqual(parseArgs(["--config", "c.json", "--apply"]), { config: "c.json", apply: true });
  assert.throws(() => parseArgs([]), /--config/);
  assert.throws(() => parseArgs(["--config", "c", "--nope"]), /unknown argument/);
  out.length = 0;
  code = await runBotMigration({ config: join(root, "config.json"), apply: false }, { ...io, readConfig: () => "{ not json" });
  assert.equal(code, 1);
  assert.match(out.join("\n"), /REFUSED/);
});
