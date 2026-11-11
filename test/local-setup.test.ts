import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { missingConfigMessage } from "../src/config/load.js";
import { EXIT_FATAL, runMain } from "../src/main.js";
import { setupLocal } from "../scripts/setup-local.js";
import { checkCwd } from "../src/jobrunner/cwd.js";
import { parseTemplate } from "../src/jobrunner/templates.js";
import { parseJobRunnerConfig } from "../src/jobrunner/limits.js";
import { ensureJobrunner, hasTelegramPlaceholders, setupPersonal, updatePersonal } from "../src/setup/personal.js";
import { validateSecurityDoc } from "../src/settings/schema.js";

test("a missing config file gives one clear line and exit 1, not a raw ENOENT", async () => {
  const p = join(tmpdir(), "agent007-nope", "config.json");
  assert.match(missingConfigMessage(p) ?? "", /not found.*yarn setup:local.*Start menu.*deploy\/deploy-app\.ps1/);
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

/** A fake icacls that records the call order and what the file held at that moment (it must still be empty). */
function fakeIcacls(): { calls: { path: string; size: number }[]; run: (args: string[]) => void } {
  const calls: { path: string; size: number }[] = [];
  return { calls, run: (args) => void calls.push({ path: args[0] as string, size: statSync(args[0] as string).isDirectory() ? -1 : readFileSync(args[0] as string).length }) };
}

const TOKEN = "123456789:AAEhBOweik6ad9r_QXMENQjcrpOzxcLIkgY";

test("setupPersonal puts the answers only into files it creates, sets the secrets ACL before the content, and never overwrites", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent007-personal-"));
  const acl = fakeIcacls();
  const answers = { proxyApiKey: "proxy-key-abc", acceptClaudeTerms: true, telegram: { botToken: TOKEN, allowedUserId: 4242 } };
  const r = setupPersonal({ root: dir, resourcesDir: process.cwd(), home: dir, answers, icacls: acl.run });
  const secrets = JSON.parse(readFileSync(r.secretsPath, "utf8")) as Record<string, string>;
  assert.equal(secrets["proxyApiKey"], "proxy-key-abc");
  assert.equal(secrets["telegramBotToken"], TOKEN);
  assert.deepEqual((JSON.parse(readFileSync(join(dir, "settings", "security.json"), "utf8")) as { telegram: { allowedUserIds: number[] } }).telegram.allowedUserIds, [4242]);
  assert.equal((JSON.parse(readFileSync(join(dir, "settings", "security.json"), "utf8")) as { termsAccepted: { claude: boolean } }).termsAccepted.claude, true);
  assert.equal(hasTelegramPlaceholders(dir), false);
  const forSecrets = acl.calls.filter((c) => c.path === r.secretsPath);
  assert.equal(forSecrets.length, 1);
  assert.equal(forSecrets[0]?.size, 0, "the ACL is set while the file is still empty");
  assert.ok(acl.calls.some((c) => c.path === join(r.dataDir, "web")), "data\\web gets the ACL before the gateway creates web.key");

  const again = setupPersonal({ root: dir, resourcesDir: process.cwd(), home: dir, answers: { proxyApiKey: "other" }, icacls: acl.run });
  assert.equal(again.created.length, 0);
  assert.equal((JSON.parse(readFileSync(r.secretsPath, "utf8")) as Record<string, string>)["proxyApiKey"], "proxy-key-abc");
  updatePersonal(dir, { proxyApiKey: "rotated" }, acl.run);
  const after = JSON.parse(readFileSync(r.secretsPath, "utf8")) as Record<string, string>;
  assert.equal(after["proxyApiKey"], "rotated");
  assert.equal(after["telegramBotToken"], TOKEN);
  assert.throws(() => updatePersonal(dir, { telegram: { botToken: "bad", allowedUserId: 1 } }, acl.run), (e: Error) => !e.message.includes("bad"));
});

test("a setup without answers leaves the Telegram placeholders, and the launcher can tell", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent007-personal-"));
  setupPersonal({ root: dir, resourcesDir: process.cwd(), home: dir, icacls: fakeIcacls().run });
  assert.equal(hasTelegramPlaceholders(dir), true);
});

test("ensureJobrunner creates the config and the secrets (ACL first), shares the agent's ipcHmacKey or generates one into both, and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent007-jr-"));
  const acl = fakeIcacls();
  const set = setupPersonal({ root: dir, resourcesDir: process.cwd(), home: dir, icacls: acl.run });
  const agentKey = "A".repeat(43);
  writeFileSync(set.secretsPath, JSON.stringify({ proxyApiKey: "p", ipcHmacKey: agentKey }));
  const a = ensureJobrunner(dir, { resourcesDir: process.cwd(), icacls: acl.run });
  const cfg = parseJobRunnerConfig(JSON.parse(readFileSync(a.configPath, "utf8")));
  assert.equal(cfg.settingsUi.enabled, true);
  const policy = { allowlist: cfg.cwdAllowlist, denyPaths: cfg.denyPaths };
  assert.equal(checkCwd(join(dir, "data", "workspace"), policy).ok, true, "the default workspace is usable");
  assert.equal(checkCwd(join(dir, "secrets"), policy).ok, false, "the secrets folder stays refused");
  assert.ok(cfg.paths.dataDir.startsWith(dir) && cfg.paths.configDir.startsWith(dir));
  assert.equal((JSON.parse(readFileSync(a.secretsPath, "utf8")) as { ipcHmacKey: string }).ipcHmacKey, agentKey);
  assert.equal(acl.calls.filter((c) => c.path === a.secretsPath)[0]?.size, 0, "ACL set while the file is empty");
  // REQ-0014: the browser template (cwd = the workspace), the shots folder, and paths.jobArtifactsDir in the agent's config.json
  const shots = join(dir, "jobrunner-data", "browser", "shots");
  const tpl = JSON.parse(readFileSync(join(dir, "jobrunner", "templates", "browser-session.json"), "utf8")) as { id: string; engine: string; cwd: string };
  assert.deepEqual([tpl.id, tpl.engine, tpl.cwd], ["browser-session", "browser", join(dir, "data", "workspace")]);
  const parsed = parseTemplate(tpl, { flowServerId: "flow" });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
  assert.ok(existsSync(shots));
  assert.equal((JSON.parse(readFileSync(set.configPath, "utf8")) as { paths: { jobArtifactsDir: string } }).paths.jobArtifactsDir, shots);
  const before = readFileSync(a.secretsPath, "utf8");
  assert.deepEqual(ensureJobrunner(dir, { resourcesDir: process.cwd(), icacls: acl.run }).created, []);
  assert.equal(readFileSync(a.secretsPath, "utf8"), before);

  const dir2 = mkdtempSync(join(tmpdir(), "agent007-jr-"));
  const set2 = setupPersonal({ root: dir2, resourcesDir: process.cwd(), home: dir2, icacls: acl.run });
  const b = ensureJobrunner(dir2, { resourcesDir: process.cwd(), icacls: acl.run });
  const generated = (JSON.parse(readFileSync(b.secretsPath, "utf8")) as { ipcHmacKey: string }).ipcHmacKey;
  assert.match(generated, /^[A-Za-z0-9_-]{43,}$/);
  assert.equal((JSON.parse(readFileSync(set2.secretsPath, "utf8")) as { ipcHmacKey: string }).ipcHmacKey, generated);
});
