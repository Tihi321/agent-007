/**
 * -WhatIf runs of the system-changing scripts, against fixture folders under .claude/temp. They prove that each script
 * prints its intended changes and changes nothing. The helper refuses to run any of them without -WhatIf.
 * The only exception is the "refuses to run unelevated" test, which is skipped when this process is elevated.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HAS_WINDOWS_POWERSHELL, ROOT, isElevated, makeFixture, makeStrataRepo, runDeploy, runPs, snapshot, type Fixture } from "./_fixture.js";

const skip = HAS_WINDOWS_POWERSHELL ? false : "Windows PowerShell is not available";
const NO_USER = "a7fixturenouser";
const TEST_TASK_PATH = "\\agent-007-test\\";

const FAKE_BOT = "111111:FIXTURE_BOT_TOKEN_AAAAAAAAAAAAAAAAAAAA";
const FAKE_LM = "FIXTURE_LM_TOKEN_BBBBBBBBBBBB";
const FAKE_STRATA = "FIXTURE_STRATA_KEY_CCCCCCCCCCCC";
const FAKE_IPC = "FIXTUREIPCKEYDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

function noTask(path: string, name: string): boolean {
  const r = runPs(["-Command", `if (Get-ScheduledTask -TaskPath '${path}' -TaskName '${name}' -ErrorAction SilentlyContinue) { 'exists' } else { 'none' }`]);
  return r.stdout.trim() === "none";
}
function noUser(name: string): boolean {
  const r = runPs(["-Command", `if (Get-LocalUser -Name '${name}' -ErrorAction SilentlyContinue) { 'exists' } else { 'none' }`]);
  return r.stdout.trim() === "none";
}
function writeFakeSecrets(fx: Fixture, extra: Record<string, string> = {}): void {
  mkdirSync(fx.secretsDir, { recursive: true });
  writeFileSync(fx.secretsFile, JSON.stringify({ telegramBotToken: FAKE_BOT, lmStudioApiToken: FAKE_LM, strataApiKey: FAKE_STRATA, ...extra }));
}
function assertNoSecretsIn(text: string): void {
  for (const s of [FAKE_BOT, FAKE_LM, FAKE_STRATA, FAKE_IPC]) assert.ok(!text.includes(s), "a secret value appeared in the output");
}

test("S7.1 setup-agent-user -WhatIf: prints the planned user, group, hide, logon and profile steps; creates nothing", { skip }, () => {
  const r = runDeploy("setup-agent-user.ps1", ["-WhatIf", "-AgentUser", NO_USER, "-DenyInteractiveLogon"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, new RegExp(`\\[WhatIf\\] create local user '${NO_USER}'`));
  assert.match(r.stdout, /random 32-character password, not printed/);
  assert.match(r.stdout, /add 'a7fixturenouser' to the Users group/);
  assert.match(r.stdout, /hide 'a7fixturenouser' from the sign-in screen/);
  assert.match(r.stdout, /deny interactive and remote-interactive logon/);
  assert.match(r.stdout, /create the profile of/);
  assert.doesNotMatch(r.stdout, /Generated password/);
  assert.ok(noUser(NO_USER), "no user was created");
});

test("S7.1 refuses an invalid account name", { skip }, () => {
  const r = runDeploy("setup-agent-user.ps1", ["-WhatIf", "-AgentUser", "bad name!"]);
  assert.notEqual(r.status, 0);
  assert.match(r.all, /not a valid local account name/);
});

test("S7.2 grant-folder-acls -WhatIf: Deny Read only on group (a), never on group (b); nothing changes", { skip }, () => {
  const fx = makeFixture({ runner: "strata" });
  try {
    makeStrataRepo(fx);
    const before = snapshot(fx.root);
    const r = runDeploy("grant-folder-acls.ps1", ["-WhatIf", "-ConfigPath", fx.configPath, "-AgentUser", NO_USER, "-ProgramFilesDir", fx.pf]);
    assert.equal(r.status, 0, r.all);
    const denies = [...r.stdout.matchAll(/^\[WhatIf\] DENY READ \(OI\)\(CI\)R for \S+ on (.+?)\s*$/gm)].map((m) => m[1]!.toLowerCase());
    assert.deepEqual(denies.sort(), [fx.deny, fx.lmstudio].map((p) => p.toLowerCase()).sort(), "Deny Read only for folders.deny and ~\\.lmstudio");
    for (const group of [fx.pd, fx.data, fx.strataInstall, fx.strataData, fx.strataConfig, fx.strataLog]) {
      for (const d of denies) assert.ok(!d.startsWith(group.toLowerCase()), `no Deny Read under group (b) path ${group}`);
    }
    assert.ok(r.stdout.includes(`GRANT (OI)(CI)RX to ${NO_USER} on ${fx.allow}`), "grant RX on the allowed folder");
    for (const p of [fx.pf, fx.configDir, fx.secretsDir, fx.data]) assert.ok(r.stdout.includes(`SET ACL on ${p} `), `ACL step for ${p}`);
    assert.doesNotMatch(r.stdout, /D:\\Strata/i, "the default Strata paths are not involved");
    assert.deepEqual(snapshot(fx.root), before, "the fixture tree is unchanged");
  } finally {
    fx.cleanup();
  }
});

test("S7.2 refuses a folders.deny entry that is, is under, or contains a group (b) path, before changing anything", { skip }, () => {
  const picks: Record<string, (f: Fixture) => string> = {
    "the Strata data dir": (f) => f.strataData,
    "inside the Strata data dir": (f) => join(f.strataData, "sub"),
    "inside the ProgramData folder": (f) => f.configDir,
    "the agent data root": (f) => f.data,
    "a parent of every group (b) path": (f) => f.root,
  };
  for (const [label, pick] of Object.entries(picks)) {
    const fx = makeFixture({ denyOverride: (f) => [pick(f)] });
    try {
      const r = runDeploy("grant-folder-acls.ps1", ["-WhatIf", "-ConfigPath", fx.configPath, "-AgentUser", NO_USER, "-ProgramFilesDir", fx.pf]);
      assert.notEqual(r.status, 0, `${label}: must be refused`);
      assert.match(r.all, /group \(b\)/, `${label}: names group (b)`);
      assert.match(r.all, /Nothing was changed/);
      assert.doesNotMatch(r.stdout, /DENY READ/, `${label}: no Deny Read is printed`);
    } finally {
      fx.cleanup();
    }
  }
});

test("S7.4 new-secrets -WhatIf: no prompts, no values, strataApiKey kept or generated as asked; writes nothing", { skip }, () => {
  const fx = makeFixture({ runner: "strata" });
  try {
    writeFakeSecrets(fx);
    const before = snapshot(fx.root);
    const common = ["-WhatIf", "-ProgramDataDir", fx.pd, "-AgentUser", NO_USER];

    let r = runDeploy("new-secrets.ps1", [...common, "-Runner", "strata"]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /no prompts, nothing is written/);
    assert.match(r.stdout, /strataApiKey\s+: kept \(use -RotateStrataKey to replace it\)/);
    assert.match(r.stdout, /set the secret-file ACL on .*secrets\.json/);
    assertNoSecretsIn(r.all);

    r = runDeploy("new-secrets.ps1", [...common, "-Runner", "strata", "-RotateStrataKey"]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /strataApiKey\s+: will be generated here/);
    assertNoSecretsIn(r.all);

    r = runDeploy("new-secrets.ps1", [...common, "-Runner", "strata", "-NoStrataKey"]);
    assert.match(r.stdout, /skipped \(-NoStrataKey\)/);

    r = runDeploy("new-secrets.ps1", [...common, "-Runner", "lmstudio"]);
    assert.doesNotMatch(r.stdout, /strataApiKey\s+:/);
    assert.match(r.stdout, /lmStudioApiToken : will prompt/);

    r = runDeploy("new-secrets.ps1", [...common, "-Runner", "strata", "-NoStrataKey", "-RotateStrataKey"]);
    assert.notEqual(r.status, 0, "the two switches conflict");
    assert.deepEqual(snapshot(fx.root), before, "the fixture tree is unchanged");
  } finally {
    fx.cleanup();
  }
});

test("S9.4 new-secrets -WhatIf: ipcHmacKey is generated when absent, kept when present, rotated on request; mcpTokens prompts are announced, never run", { skip }, () => {
  const fx = makeFixture();
  try {
    const common = ["-WhatIf", "-ProgramDataDir", fx.pd, "-AgentUser", NO_USER, "-Runner", "lmstudio"];

    // no secrets file yet: the key will be generated
    let r = runDeploy("new-secrets.ps1", common);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /ipcHmacKey\s+: will be generated here \(32 random bytes, base64url\), never shown, never typed/);
    assert.match(r.stdout, /mcpTokens\s+: will prompt \(no echo\) for an optional token for: book-translator; Enter skips or keeps/);

    // a file with a key: kept; with -RotateIpcKey: generated again
    writeFakeSecrets(fx, { ipcHmacKey: FAKE_IPC });
    const before = snapshot(fx.root);
    r = runDeploy("new-secrets.ps1", common);
    assert.match(r.stdout, /ipcHmacKey\s+: kept \(use -RotateIpcKey to replace it\)/);
    assert.ok(!r.all.includes(FAKE_IPC), "the key value appeared in the output");
    r = runDeploy("new-secrets.ps1", [...common, "-RotateIpcKey"]);
    assert.match(r.stdout, /ipcHmacKey\s+: will be generated here/);

    // the prompt list is a parameter; empty means no prompts
    r = runDeploy("new-secrets.ps1", [...common, "-McpTokenServers", "book-translator,other-server"]);
    assert.match(r.stdout, /for: book-translator, other-server;/);
    assert.deepEqual(snapshot(fx.root), before, "the fixture tree is unchanged");
  } finally {
    fx.cleanup();
  }
});

test("S7.5 deploy-app -WhatIf: prints all five steps and changes nothing", { skip }, () => {
  const fx = makeFixture();
  try {
    const before = snapshot(fx.root);
    const args = ["-WhatIf", "-RepoRoot", ROOT, "-ProgramFilesDir", fx.pf, "-ProgramDataDir", fx.pd, "-AgentUser", NO_USER];
    let r = runDeploy("deploy-app.ps1", args);
    assert.equal(r.status, 0, r.all);
    for (const n of [1, 2, 3, 4, 5]) assert.match(r.stdout, new RegExp(`step ${n}/5`), `step ${n}`);
    assert.match(r.stdout, /npm ci --omit=dev --ignore-scripts/);
    assert.match(r.stdout, /agent a7fixturenouser RX only/);
    assert.match(r.stdout, /copy .*config\.example\.json to .*config\.json/);
    assert.deepEqual(snapshot(fx.root), before);

    writeFileSync(join(fx.configDir, "config.json"), "{}");
    const withConfig = snapshot(fx.root);
    r = runDeploy("deploy-app.ps1", [...args, "-SkipRepoBuild"]);
    assert.match(r.stdout, /step 5\/5 .*config\.json exists and is left untouched/);
    assert.match(r.stdout, /step 1\/5 repo build and test \(-SkipRepoBuild\)/);
    assert.deepEqual(snapshot(fx.root), withConfig, "an existing config.json is not touched");
  } finally {
    fx.cleanup();
  }
});

test("S7.6 register-task -WhatIf: prints the task of section S7.6 and registers nothing", { skip }, () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.pf, "dist", "src"), { recursive: true });
    writeFileSync(join(fx.pf, "dist", "src", "main.js"), "// fixture");
    const node = join(fx.root, "node.exe");
    writeFileSync(node, "");
    const before = snapshot(fx.root);
    const r = runDeploy("register-task.ps1", ["-WhatIf", "-ConfigPath", fx.configPath, "-AgentUser", NO_USER, "-ProgramFilesDir", fx.pf, "-NodeExe", node, "-TaskPath", TEST_TASK_PATH, "-TaskName", "a7fixture-agent"]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, new RegExp(`task\\s+: \\\\agent-007-test\\\\a7fixture-agent`));
    assert.ok(r.stdout.includes(`"${join(fx.pf, "dist", "src", "main.js")}"`), "action runs dist\\src\\main.js");
    assert.ok(r.stdout.includes(`workdir   : ${fx.data}`), "working dir is the agent data root");
    assert.match(r.stdout, /LogonType S4U, RunLevel Limited/);
    assert.match(r.stdout, /BootTrigger delay PT60S/);
    assert.match(r.stdout, /TimeTrigger repeat every PT5M/);
    assert.match(r.stdout, /MultipleInstances=IgnoreNew ExecutionTimeLimit=PT0S RestartCount=3 RestartInterval=PT1M DisallowStartIfOnBatteries=False StopIfGoingOnBatteries=False StartWhenAvailable=True/);
    assert.match(r.stdout, /\[WhatIf\] REGISTER task/);
    assert.ok(noTask(TEST_TASK_PATH, "a7fixture-agent"), "nothing was registered");
    assert.deepEqual(snapshot(fx.root), before);

    const pw = runDeploy("register-task.ps1", ["-WhatIf", "-UsePassword", "-ConfigPath", fx.configPath, "-AgentUser", NO_USER, "-ProgramFilesDir", fx.pf, "-NodeExe", node, "-TaskPath", TEST_TASK_PATH, "-TaskName", "a7fixture-agent"]);
    assert.equal(pw.status, 0, pw.all);
    assert.match(pw.stdout, /LogonType Password/);
  } finally {
    fx.cleanup();
  }
});

test("S7.7 uninstall -WhatIf: lists tasks, ACE removals and folders; nothing under the Strata dirs but ACE removal", { skip }, () => {
  const fx = makeFixture({ runner: "strata" });
  try {
    makeStrataRepo(fx);
    mkdirSync(fx.strataDir, { recursive: true });
    const before = snapshot(fx.root);
    const base = ["-WhatIf", "-ConfigPath", fx.configPath, "-AgentUser", NO_USER, "-ProgramFilesDir", fx.pf, "-TaskPath", TEST_TASK_PATH];
    let r = runDeploy("uninstall.ps1", base);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /\[skip\]\s+task \\agent-007-test\\agent not found/);
    assert.match(r.stdout, /\[skip\]\s+task \\agent-007-test\\strata not found/);
    for (const p of [fx.allow, fx.lmstudio, fx.deny, fx.configDir, fx.secretsDir, fx.strataInstall, fx.strataData]) {
      assert.ok(r.stdout.includes(`from ${p} (icacls /remove)`), `ACE removal listed for ${p}`);
    }
    for (const p of [fx.strataInstall, fx.strataData]) assert.ok(r.stdout.includes(`ACEs ONLY (nothing else in it is touched) from ${p}`));
    assert.ok(r.stdout.includes(`DELETE folder ${fx.pf}`));
    assert.match(r.stdout, /\[keep\]\s+local user/);
    assert.match(r.stdout, /\[keep\]\s+data:/);
    assert.doesNotMatch(r.stdout, /DELETE[^\n]*strata/i, "nothing under Strata is deleted");
    assert.deepEqual(snapshot(fx.root), before);

    r = runDeploy("uninstall.ps1", [...base, "-RemoveUser", "-RemoveData"]);
    assert.equal(r.status, 0, r.all);
    assert.ok(r.stdout.includes(`DELETE data folder ${fx.pd}`));
    assert.ok(r.stdout.includes(`DELETE data folder ${fx.data}`));
    assert.match(r.stdout, /\[skip\]\s+local user 'a7fixturenouser' not found/);
    assert.match(r.stdout, /remove the sign-in-screen entry/);
    assert.doesNotMatch(r.stdout, /DELETE[^\n]*strata/i, "-RemoveData never reaches the Strata install or data");
    assert.deepEqual(snapshot(fx.root), before);
  } finally {
    fx.cleanup();
  }
});

test("S7.7 refuses to delete a folder that is not named agent-007 or sits inside Strata", { skip }, () => {
  const fx = makeFixture({ runner: "strata" });
  try {
    makeStrataRepo(fx);
    const other = join(fx.root, "somewhere-else");
    mkdirSync(other, { recursive: true });
    let r = runDeploy("uninstall.ps1", ["-WhatIf", "-ConfigPath", fx.configPath, "-AgentUser", NO_USER, "-ProgramFilesDir", other, "-TaskPath", TEST_TASK_PATH]);
    assert.notEqual(r.status, 0);
    assert.match(r.all, /not named agent-007/);
    const inStrata = join(fx.strataInstall, "agent-007");
    mkdirSync(inStrata, { recursive: true });
    r = runDeploy("uninstall.ps1", ["-WhatIf", "-ConfigPath", fx.configPath, "-AgentUser", NO_USER, "-ProgramFilesDir", inStrata, "-TaskPath", TEST_TASK_PATH]);
    assert.notEqual(r.status, 0);
    assert.match(r.all, /inside/);
  } finally {
    fx.cleanup();
  }
});

test("S7.9 register-strata-task -WhatIf: ACEs, masked config copy and task are printed; nothing is written", { skip }, () => {
  const fx = makeFixture({ runner: "strata" });
  try {
    const head = makeStrataRepo(fx);
    writeFakeSecrets(fx);
    const before = snapshot(fx.root);
    const args = ["-WhatIf", "-ConfigPath", fx.configPath, "-AgentUser", NO_USER, "-PinnedCommit", head.slice(0, 8), "-TaskPath", TEST_TASK_PATH, "-TaskName", "a7fixture-strata"];
    const r = runDeploy("register-strata-task.ps1", args);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /Strata is at the pinned commit/);
    for (const p of [fx.strataInstall, fx.strataData]) {
      assert.ok(r.stdout.includes(`GRANT (OI)(CI)RX to ${NO_USER} on ${p}`), `RX grant on ${p}`);
      assert.ok(r.stdout.includes(`DENY WRITE (OI)(CI)(WD,AD,WEA,WA,DC,D) for ${NO_USER} on ${p}`), `Deny write on ${p}`);
    }
    assert.doesNotMatch(r.stdout, /DENY READ/);
    assert.match(r.stdout, new RegExp(`config copy: .*strata\\.json from .*strata-iq3_s\\.json \\(open_browser=false, log=.*strata\\.log, api_key=\\*{6} \\(masked\\)\\)`));
    assert.ok(r.stdout.includes(`log=${join(fx.strataLog, "strata.log")}`), "log path points at <logDir>\\strata.log");
    assert.ok(r.stdout.includes(`set the secret-file ACL on ${fx.strataConfig}`));
    assert.ok(r.stdout.includes(`"${join(fx.strataInstall, "serve", "server.py")}" --engine strata --config "${fx.strataConfig}" --port 8080`), "task action");
    assert.ok(!r.stdout.includes("--open"), "no --open");
    assert.ok(r.stdout.includes(`workdir   : ${fx.strataDir}`));
    assert.match(r.stdout, /LogonType S4U, RunLevel Limited/);
    assert.match(r.stdout, /BootTrigger\s*\r?$/m, "AtStartup has no delay");
    assert.doesNotMatch(r.stdout, /BootTrigger delay/);
    assert.match(r.stdout, /TimeTrigger repeat every PT5M/);
    assertNoSecretsIn(r.all);
    assert.ok(noTask(TEST_TASK_PATH, "a7fixture-strata"), "nothing was registered");
    assert.deepEqual(snapshot(fx.root), before, "nothing was written, including under the fixture Strata dirs");
  } finally {
    fx.cleanup();
  }
});

test("S7.9 refuses a wrong commit, a dirty tree, and a missing key; with -NoStrataKey it warns", { skip }, () => {
  const fx = makeFixture({ runner: "strata" });
  try {
    const head = makeStrataRepo(fx);
    writeFakeSecrets(fx);
    const base = ["-WhatIf", "-ConfigPath", fx.configPath, "-AgentUser", NO_USER, "-TaskPath", TEST_TASK_PATH, "-TaskName", "a7fixture-strata"];

    let r = runDeploy("register-strata-task.ps1", [...base, "-PinnedCommit", "deadbeef"]);
    assert.notEqual(r.status, 0);
    assert.match(r.all, /not at the pinned commit 'deadbeef'/);
    assert.doesNotMatch(r.stdout, /GRANT|DENY/, "refused before any ACE");

    writeFileSync(join(fx.strataInstall, "stray.txt"), "dirty");
    r = runDeploy("register-strata-task.ps1", [...base, "-PinnedCommit", head.slice(0, 8)]);
    assert.notEqual(r.status, 0);
    assert.match(r.all, /uncommitted changes/);
    assert.doesNotMatch(r.stdout, /GRANT|DENY/);
    writeFileSync(join(fx.strataInstall, "stray.txt"), "dirty");
  } finally {
    fx.cleanup();
  }
  const fx2 = makeFixture({ runner: "strata" });
  try {
    const head = makeStrataRepo(fx2);
    const base = ["-WhatIf", "-ConfigPath", fx2.configPath, "-AgentUser", NO_USER, "-PinnedCommit", head.slice(0, 8), "-TaskPath", TEST_TASK_PATH, "-TaskName", "a7fixture-strata"];
    // no secrets file: a dry run warns, and -NoStrataKey prints the keyless warning and no api_key
    let r = runDeploy("register-strata-task.ps1", base);
    assert.match(r.all, /No strataApiKey in/);
    r = runDeploy("register-strata-task.ps1", [...base, "-NoStrataKey"]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /any local process, under any user, can call Strata/);
    assert.match(r.stdout, /api_key=none/);
  } finally {
    fx2.cleanup();
  }
});

test("S7.9 only api_key is updated in an existing config copy", { skip }, () => {
  const fx = makeFixture({ runner: "strata" });
  try {
    const head = makeStrataRepo(fx);
    writeFakeSecrets(fx);
    mkdirSync(fx.strataDir, { recursive: true });
    writeFileSync(fx.strataConfig, JSON.stringify({ port: 8080, open_browser: false, log: join(fx.strataLog, "strata.log"), api_key: "OLD-KEY-VALUE-DDDDDDDD" }));
    const r = runDeploy("register-strata-task.ps1", ["-WhatIf", "-ConfigPath", fx.configPath, "-AgentUser", NO_USER, "-PinnedCommit", head.slice(0, 8), "-TaskPath", TEST_TASK_PATH, "-TaskName", "a7fixture-strata"]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /config copy exists: .* \(only api_key will be updated\)/);
    assert.ok(!r.all.includes("OLD-KEY-VALUE-DDDDDDDD"));
    assertNoSecretsIn(r.all);
  } finally {
    fx.cleanup();
  }
});

test("every system-changing script refuses to run unelevated (real run, skipped when this process is elevated)", { skip: !HAS_WINDOWS_POWERSHELL ? "no PowerShell" : isElevated() ? "the test process is elevated" : false }, () => {
  const fx = makeFixture({ runner: "strata" });
  try {
    makeStrataRepo(fx);
    const before = snapshot(fx.root);
    const cfg = ["-ConfigPath", fx.configPath, "-AgentUser", NO_USER];
    const cases: [string, string[]][] = [
      ["setup-agent-user.ps1", ["-AgentUser", NO_USER]],
      ["grant-folder-acls.ps1", [...cfg, "-ProgramFilesDir", fx.pf]],
      ["new-secrets.ps1", ["-ProgramDataDir", fx.pd, "-AgentUser", NO_USER, "-Runner", "strata"]],
      ["deploy-app.ps1", ["-RepoRoot", ROOT, "-ProgramFilesDir", fx.pf, "-ProgramDataDir", fx.pd, "-AgentUser", NO_USER]],
      ["register-task.ps1", [...cfg, "-ProgramFilesDir", fx.pf, "-TaskPath", TEST_TASK_PATH, "-TaskName", "a7fixture-agent"]],
      ["uninstall.ps1", [...cfg, "-ProgramFilesDir", fx.pf, "-TaskPath", TEST_TASK_PATH]],
      ["register-strata-task.ps1", [...cfg, "-TaskPath", TEST_TASK_PATH, "-TaskName", "a7fixture-strata"]],
    ];
    for (const [script, args] of cases) {
      const r = runDeploy(script, args, { allowRealRun: true });
      assert.notEqual(r.status, 0, `${script} must refuse`);
      assert.match(r.all, /must run in an elevated/, `${script} says why`);
      assert.match(r.all, /Nothing was changed/);
    }
    assert.deepEqual(snapshot(fx.root), before);
    assert.ok(noUser(NO_USER));
  } finally {
    fx.cleanup();
  }
});

test("S20.5 new-secrets -WhatIf: -Bots and -Mirror print the BotFather checklist and every planned prompt, never a value, and change nothing", { skip }, () => {
  const fx = makeFixture();
  try {
    mkdirSync(fx.secretsDir, { recursive: true });
    writeFileSync(fx.secretsFile, JSON.stringify({ telegramBotToken: FAKE_BOT, lmStudioApiToken: FAKE_LM, botTokens: { ops: "333:OPS_FIXTURE_TOKEN_EEEEEEEEEEEEEEEE" } }));
    const before = snapshot(fx.root);
    const common = ["-WhatIf", "-ProgramDataDir", fx.pd, "-AgentUser", NO_USER, "-Runner", "lmstudio"];

    let r = runDeploy("new-secrets.ps1", [...common, "-Bots", "research,ops", "-Mirror"]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /BotFather checklist for EACH extra bot/);
    assert.match(r.stdout, /\/newbot/);
    assert.match(r.stdout, /\/setjoingroups\s+choose the bot, then Disable/);
    assert.match(r.stdout, /Bot-to-Bot Communication Mode: leave it OFF/);
    assert.match(r.stdout, /botTokens\.research : will prompt \(no echo\); required/);
    assert.match(r.stdout, /botTokens\.ops : will prompt \(no echo\)/);
    assert.match(r.stdout, /mirrorBotToken\s+: will prompt \(no echo\); required/);
    assert.match(r.stdout, /store the token of bot 'research' under botTokens\.research/);
    assert.match(r.stdout, /store the mirror bot token as mirrorBotToken/);
    assert.match(r.stdout, /no prompts, nothing is written/);
    assertNoSecretsIn(r.all);
    assert.ok(!r.all.includes("OPS_FIXTURE_TOKEN"), "a stored bot token appeared in the output");

    // without -Bots a one-bot install is unchanged: no checklist, no bot prompts
    r = runDeploy("new-secrets.ps1", common);
    assert.equal(r.status, 0, r.all);
    assert.doesNotMatch(r.stdout, /BotFather checklist/);
    assert.match(r.stdout, /botTokens\s+: no extra bots \(-Bots is empty\)/);

    // bad ids, main and duplicates are refused before anything is prompted
    for (const bad of ["Bad_Id", "x", "main", "research,research"]) {
      r = runDeploy("new-secrets.ps1", [...common, "-Bots", bad]);
      assert.notEqual(r.status, 0, `${bad} must be refused\n${r.all}`);
      assert.match(r.all, /Bot id .* is not valid|uses telegramBotToken|listed twice/);
    }
    assert.deepEqual(snapshot(fx.root), before, "the fixture tree is unchanged");
  } finally {
    fx.cleanup();
  }
});
