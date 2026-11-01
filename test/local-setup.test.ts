import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { missingConfigMessage } from "../src/config/load.js";
import { EXIT_FATAL, runMain } from "../src/main.js";
import { setupLocal } from "../scripts/setup-local.js";
import { validateSecurityDoc } from "../src/settings/schema.js";

test("a missing config file gives one clear line and exit 1, not a raw ENOENT", async () => {
  const p = join(tmpdir(), "agent007-nope", "config.json");
  assert.match(missingConfigMessage(p) ?? "", /not found.*yarn setup:local.*deploy\/deploy-app\.ps1/);
  const lines: string[] = [];
  const code = await runMain({ configPath: p, secretsPath: p, telegram: false, checkAcl: false }, { err: (l) => lines.push(l), out: () => undefined });
  assert.equal(code, EXIT_FATAL);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]?.includes(p));
});

test("setup:local writes a valid security.json inside the target folder and never overwrites", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent007-local-"));
  const a = setupLocal({ repoRoot: process.cwd(), dir, home: dir });
  assert.equal(a.created.length, 3);
  const secPath = join(dir, "settings", "security.json");
  const sec = JSON.parse(readFileSync(secPath, "utf8")) as { presets: { id: string }[] };
  assert.deepEqual(sec.presets.map((p) => p.id), ["strata", "claude-sonnet", "claude-opus"]);
  assert.equal(validateSecurityDoc(sec, { skipFolderExists: true }).ok, true);
  assert.ok(readFileSync(join(dir, "config", "config.json"), "utf8").includes(dir.replaceAll("\\", "\\\\")));
  writeFileSync(join(dir, "secrets", "secrets.json"), '{"telegramBotToken":"mine"}');
  const b = setupLocal({ repoRoot: process.cwd(), dir, home: dir });
  assert.equal(b.created.length, 0);
  assert.equal(b.kept.length, 3);
  assert.equal(readFileSync(join(dir, "secrets", "secrets.json"), "utf8"), '{"telegramBotToken":"mine"}');
});
