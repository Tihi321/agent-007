/**
 * S11.6 done-checks (never a real install): parse tests, the order of ACL and write, no value echoed, a -WhatIf run against
 * fixture folders under .claude/temp that prints every change and changes nothing, and the ACL functions applied to fixture
 * folders and then judged by the real, read-only check-acl.ps1. The only ACL changes are on those fixture folders.
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { DEPLOY, HAS_WINDOWS_POWERSHELL, ROOT, icacls, makeFixture, protect, runDeploy, runPs, snapshot, stripComments, whoami } from "../deploy/_fixture.js";

const skip = HAS_WINDOWS_POWERSHELL ? false : "Windows PowerShell is not available";
const JR = join(DEPLOY, "jobrunner");
const NO_USER = "a7fixturenouser";
const FAKE_IPC = "FIXTUREIPCKEYDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const OUTPUT = /Write-(Host|Output|Verbose|Debug|Warning|Error|Information)\b/;
const WRITE = /\b(Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|New-Item|Remove-Item|Rename-Item|Clear-Content|WriteAllText|WriteAllBytes|WriteAllLines|Set-Acl|Set-ItemProperty|Register-ScheduledTask|Start-ScheduledTask|Unregister-ScheduledTask)\b/;

function scripts(): string[] {
  return readdirSync(JR).filter((f) => f.endsWith(".ps1")).sort();
}
function read(name: string): string {
  return readFileSync(join(JR, name), "utf8");
}
function code(name: string): string {
  return stripComments(read(name));
}

test("the job runner deploy folder holds the install and check scripts", () => {
  assert.deepEqual(scripts(), ["check-jobrunner.ps1", "install-jobrunner.ps1"]);
});

test("every script is ASCII-only (Windows PowerShell 5.1 reads it the same as PowerShell 7)", () => {
  for (const s of scripts()) {
    const bytes = readFileSync(join(JR, s));
    for (const b of bytes) assert.ok(b < 128, `${s} has a non-ASCII byte`);
  }
});

test("every script parses without errors (PowerShell AST)", { skip }, () => {
  for (const s of scripts()) {
    const file = join(JR, s).replace(/'/g, "''");
    const r = runPs(["-Command", `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e); if($e -and $e.Count -gt 0){ $e | ForEach-Object { $_.ToString() }; exit 1 } else { 'OK' }`]);
    assert.equal(r.status, 0, `${s}: ${r.all}`);
  }
});

test("install: the ACL on each folder is set before anything is copied or written into it", () => {
  const c = code("install-jobrunner.ps1");
  const idx = (re: RegExp): number => {
    const i = c.search(re);
    assert.ok(i >= 0, `missing ${re}`);
    return i;
  };
  const cfgAcl = idx(/Set-JobRunnerConfigDirAcl -Path \$jobRunnerDir/);
  const tplAcl = idx(/Set-JobRunnerTemplatesDirAcl -Path \$templatesDir/);
  const copyTpl = idx(/Copy-Item -LiteralPath \$f\.FullName -Destination \$target/);
  const copyCfg = idx(/Copy-Item -LiteralPath \$exampleConfig -Destination \$configFile/);
  const dataAcl = idx(/Set-JobRunnerDataDirAcl -Path \$DataDir/);
  const emptySecrets = idx(/WriteAllBytes\(\$secretsFile, \[byte\[\]\]@\(\)\)/);
  const secretAcl = idx(/Set-JobRunnerSecretFileAcl -Path \$secretsFile/);
  const firstContent = idx(/WriteAllText\(\$secretsFile/);
  const register = idx(/Register-ScheduledTask/);
  assert.ok(cfgAcl < tplAcl && tplAcl < copyTpl && cfgAcl < copyCfg, "config and templates ACLs before the copies");
  assert.ok(copyCfg < dataAcl, "data folder after the config");
  assert.ok(dataAcl < emptySecrets && emptySecrets < secretAcl && secretAcl < firstContent, "secrets: created empty, ACL, then content");
  assert.ok(firstContent < register);
  // nothing writes secrets content before the ACL
  assert.doesNotMatch(c.slice(0, secretAcl), /WriteAllText|Set-Content|Out-File|Add-Content/);
  // the ipc key is read only after the ACL line, too
  assert.ok(c.search(/\$ipcKeyPlain = \[string\]\$agentSecrets\['ipcHmacKey'\]/) > secretAcl);
});

test("install: the agent user gets nothing on the job runner folder, read-only on templates\\, and nothing on the data folder or secrets", () => {
  const src = stripComments(read("install-jobrunner.ps1"));
  const fn = (name: string): string => new RegExp(`function ${name} \\{[\\s\\S]*?\\n\\}\\n`).exec(src)?.[0] ?? "";
  const cfg = fn("Set-JobRunnerConfigDirAcl");
  const tpl = fn("Set-JobRunnerTemplatesDirAcl");
  const data = fn("Set-JobRunnerDataDirAcl");
  const sec = fn("Set-JobRunnerSecretFileAcl");
  for (const [name, body] of [["config", cfg], ["templates", tpl], ["data", data], ["secret", sec]] as const) {
    assert.ok(body.length > 0, `${name} function found`);
    assert.match(body, /Set-ExactAcl/, `${name}: an exact ACL, inheritance off`);
    assert.match(body, /SidSystem/);
    assert.match(body, /SidAdministrators/);
    assert.doesNotMatch(body, /SidUsers|SidAuthenticatedUsers|SidEveryone/, `${name}: no broad group`);
  }
  for (const [name, body] of [["config", cfg], ["data", data], ["secret", sec]] as const) assert.doesNotMatch(body, /\$Agent\b|AgentUser/, `${name}: no ACE for the agent user`);
  assert.match(tpl, /-Account \$Agent -Rights 'Read'\)/, "templates: the agent user gets Read only");
  assert.doesNotMatch(tpl, /\$Agent -Rights '(Modify|FullControl|Write)/);
  assert.match(cfg, /-Account \$Main -Rights 'Modify'/);
  assert.match(sec, /-Account \$Main -Rights 'FullControl'/);
});

test("install: no value is echoed, every prompt is secure, no environment variable is set, the task is never started", () => {
  const c = code("install-jobrunner.ps1");
  assert.match(c, /Read-Host[^\n]*-AsSecureString/);
  assert.doesNotMatch(c, /Read-Host(?![^\n]*-AsSecureString)/, "every Read-Host is secure");
  for (const l of c.split(/\r?\n/)) {
    if (OUTPUT.test(l)) assert.doesNotMatch(l, /\$(ipcKeyPlain|deepseekPlain|content|existing|agentSecrets|json|sec|bstr)\b/, `value printed: ${l.trim()}`);
  }
  assert.doesNotMatch(c, /\$env:[A-Za-z_]+\s*=/, "no value goes into the environment");
  assert.doesNotMatch(c, /Start-Transcript|Start-ScheduledTask|Start-Process|Invoke-Expression|\biex\b/);
  assert.match(c, /\$ipcKeyPlain = \$null; \$deepseekPlain = \$null/, "the values are cleared at the end");
  // the key comes from the agent's secrets file, never from a prompt
  assert.doesNotMatch(c, /Read-SecretText[^\n]*ipc/i);
  // the task: at logon, main user, interactive, limited; IgnoreNew and restart on failure come from the shared settings
  assert.match(c, /New-ScheduledTaskTrigger -AtLogOn -User \$MainUser/);
  assert.match(c, /New-ScheduledTaskPrincipal -UserId \$MainUser -LogonType Interactive -RunLevel Limited/);
  assert.match(c, /\$settings = New-AgentTaskSettings/);
  const common = stripComments(readFileSync(join(DEPLOY, "common.ps1"), "utf8"));
  assert.match(/function New-AgentTaskSettings[\s\S]*?\n\}\n/.exec(common)?.[0] ?? "", /-MultipleInstances IgnoreNew[\s\S]*-RestartCount 3/);
  assert.match(c, /jobrunner\\main\.js|'jobrunner', *'main\.js'|dist', 'src', 'jobrunner', 'main\.js'/);
  assert.match(read("install-jobrunner.ps1"), /SupportsShouldProcess = \$true/, "-WhatIf is supported");
});

test("check-jobrunner is read only: no write cmdlet, no ACL change, a fixed loopback comparison", () => {
  const c = code("check-jobrunner.ps1");
  for (const l of c.split(/\r?\n/)) if (WRITE.test(l)) assert.fail(`a write cmdlet in the read-only check: ${l.trim()}`);
  assert.doesNotMatch(c, /icacls[^\n]*\/(grant|deny|remove|reset|inheritance|setowner)/i);
  assert.match(c, /-ne '127\.0\.0\.1'/);
  assert.match(c, /Get-NetTCPConnection -LocalPort \$IpcPort -ErrorAction Stop/);
  assert.doesNotMatch(c, /Get-NetTCPConnection[^\n]*-State Listen/);
  assert.match(c, /\$_\.State -eq 'Listen' -or \(\$_\.RemoteAddress -in '0\.0\.0\.0','::' -and \$_\.RemotePort -eq 0 -and -not \$_\.State\)/);
});

// ---- -WhatIf against fixtures -------------------------------------------------------------------------------

function whatIfArgs(fx: ReturnType<typeof makeFixture>, extra: string[] = []): string[] {
  return [
    "-WhatIf",
    "-AgentUser", NO_USER,
    "-MainUser", whoami(),
    "-RepoRoot", ROOT,
    "-ProgramFilesDir", fx.pf,
    "-ProgramDataDir", fx.pd,
    "-DataDir", join(fx.root, "jrdata"),
    "-AgentSecretsFile", fx.secretsFile,
    "-NodeExe", process.execPath,
    "-TaskPath", "\\agent-007-test\\",
    ...extra,
  ];
}

test("install -WhatIf: prints every change in order, never prints the key, and changes nothing", { skip }, () => {
  const fx = makeFixture();
  try {
    mkdirSync(fx.secretsDir, { recursive: true });
    writeFileSync(fx.secretsFile, JSON.stringify({ telegramBotToken: "111111:FIXTURE_BOT_TOKEN_AAAAAAAAAAAAAAAAAAAA", ipcHmacKey: FAKE_IPC }));
    const before = snapshot(fx.root);
    const r = runDeploy("jobrunner/install-jobrunner.ps1", whatIfArgs(fx));
    assert.equal(r.status, 0, r.all);
    const out = r.stdout;
    const jr = join(fx.pd, "jobrunner");
    const tpl = join(jr, "templates");
    const data = join(fx.root, "jrdata");
    const at = (needle: string | RegExp): number => {
      const i = typeof needle === "string" ? out.indexOf(needle) : out.search(needle);
      assert.ok(i >= 0, `missing in the output: ${String(needle)}\n${out}`);
      return i;
    };
    const steps = [
      at(`[WhatIf] create folder ${jr}`),
      at(`[WhatIf] SET ACL on ${jr} (inheritance off, SYSTEM F, Administrators F, ${whoami()} Modify, no ACE for ${NO_USER})`),
      at(`[WhatIf] create folder ${tpl}`),
      at(`[WhatIf] SET ACL on ${tpl} (inheritance off, SYSTEM F, Administrators F, ${whoami()} Modify, ${NO_USER} Read only)`),
      at(/\[WhatIf\] copy template list-runs\.json to /),
      at(`[WhatIf] copy config\\jobrunner.example.json to ${join(jr, "jobrunner.json")}`),
      at(`[WhatIf] create folder ${data}`),
      at(`[WhatIf] SET ACL on ${data} (inheritance off, SYSTEM F, Administrators F, ${whoami()} F, no ACE for ${NO_USER})`),
      at(`[WhatIf] create ${join(data, "secrets.json")} EMPTY if missing`),
      at(`[WhatIf] set the secret-file ACL on ${join(data, "secrets.json")}`),
      at(`[WhatIf] write ipcHmacKey (copied from the agent's secrets file, value not shown)`),
      at(`[WhatIf] REGISTER task \\agent-007-test\\jobrunner for ${whoami()} (at logon, LogonType Interactive, RunLevel Limited)`),
    ];
    assert.deepEqual([...steps].sort((a, b) => a - b), steps, "the steps are printed in order");
    for (const name of readdirSync(join(ROOT, "config", "templates")).filter((f) => f.endsWith(".json"))) assert.ok(out.includes(`copy template ${name} to ${tpl}`), name);
    assert.ok(out.includes("trigger   :") && /AtLogOn|LogonTrigger/.test(out), "the task summary names the logon trigger");
    assert.ok(out.includes("MultipleInstances=IgnoreNew"));
    assert.ok(!out.includes(FAKE_IPC) && !r.stderr.includes(FAKE_IPC), "the key is never printed");
    assert.deepEqual(snapshot(fx.root), before, "the fixture tree is unchanged");
    const t = runPs(["-Command", "if (Get-ScheduledTask -TaskPath '\\agent-007-test\\' -TaskName 'jobrunner' -ErrorAction SilentlyContinue) { 'exists' } else { 'none' }"]);
    assert.equal(t.stdout.trim(), "none", "no task was registered");
  } finally {
    fx.cleanup();
  }
});

test("install -WhatIf with -SkipSecrets -SkipTask omits those steps; a real run is refused by the test helper", { skip }, () => {
  const fx = makeFixture();
  try {
    const r = runDeploy("jobrunner/install-jobrunner.ps1", whatIfArgs(fx, ["-SkipSecrets", "-SkipTask"]));
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /secrets\.json  : skipped/);
    assert.match(r.stdout, /task          : skipped/);
    assert.doesNotMatch(r.stdout, /REGISTER task/);
    assert.throws(() => runDeploy("jobrunner/install-jobrunner.ps1", ["-AgentUser", NO_USER]), /must be run with -WhatIf/);
  } finally {
    fx.cleanup();
  }
});

// ---- the ACL the installer builds satisfies the real check-acl.ps1 ----------------------------------------------

function extractAclFunctions(): string {
  const src = read("install-jobrunner.ps1");
  return ["Set-JobRunnerConfigDirAcl", "Set-JobRunnerTemplatesDirAcl", "Set-JobRunnerDataDirAcl", "Set-JobRunnerSecretFileAcl"]
    .map((n) => new RegExp(`function ${n} \\{[\\s\\S]*?\\n\\}\\n`).exec(src)?.[0] ?? assert.fail(`${n} not found`))
    .join("\n");
}

test("the installer's ACL functions, applied to fixture folders, pass the real check-acl.ps1 job runner rows and leave the agent no access to the data folder", { skip }, () => {
  const fx = makeFixture();
  const me = whoami(); // stands in for the agent user
  const main = `${process.env["COMPUTERNAME"] ?? "."}\\Guest`; // a real local account that is neither me nor an admin
  try {
    // a compliant Phase 1 tree (as in test/deploy/check-acl.test.ts), then the job runner folders built by the installer's functions
    writeFileSync(fx.secretsFile, '{"telegramBotToken":"fixture-not-a-secret"}');
    protect(fx.configDir, me, "R");
    protect(fx.secretsDir, me, "R");
    protect(fx.secretsFile, me, "R");
    protect(fx.data, me, "F");
    protect(fx.pf, me, "RX");
    protect(fx.allow, me, "RX");
    for (const d of [fx.deny, fx.lmstudio]) icacls(d, "/deny", `${me}:(OI)(CI)(RD)`);
    const jr = join(fx.pd, "jobrunner");
    const templates = join(jr, "templates");
    const jrData = join(fx.root, "jrdata");
    const secrets = join(jrData, "secrets.json");
    mkdirSync(templates, { recursive: true });
    mkdirSync(jrData, { recursive: true });
    writeFileSync(secrets, "");
    // children first: the parent ACLs below take the current (non-elevated) test user out of the folder
    const script = `
$ErrorActionPreference = 'Stop'
. '${join(DEPLOY, "common.ps1").replace(/'/g, "''")}'
. '${join(DEPLOY, "acl-write.ps1").replace(/'/g, "''")}'
${extractAclFunctions()}
Set-JobRunnerTemplatesDirAcl -Path '${templates.replace(/'/g, "''")}' -Main '${main}' -Agent '${me}'
Set-JobRunnerSecretFileAcl -Path '${secrets.replace(/'/g, "''")}' -Main '${main}'
'SECRETS-ACL-BEGIN'
& icacls.exe '${secrets.replace(/'/g, "''")}'
'SECRETS-ACL-END'
Set-JobRunnerDataDirAcl -Path '${jrData.replace(/'/g, "''")}' -Main '${main}'
Set-JobRunnerConfigDirAcl -Path '${jr.replace(/'/g, "''")}' -Main '${main}'
'APPLIED'`;
    const applied = runPs(["-Command", script]);
    assert.equal(applied.status, 0, applied.all);
    assert.match(applied.stdout, /APPLIED/);

    const r = runDeploy("check-acl.ps1", ["-ConfigPath", fx.configPath, "-AgentUser", me, "-ProgramFilesDir", fx.pf]);
    assert.match(r.stdout, /JOBRUNNER\s+.*jobrunner : agent read=False write=False/);
    assert.match(r.stdout, /JOBRUNNER\s+.*templates : agent read=True write=False/);
    assert.ok(!/VIOLATION[^\n]*jobrunner/i.test(r.stdout), r.stdout);
    assert.equal(r.status, 0, r.all);

    // the job runner's own data folder and secrets file name only the main user, SYSTEM and Administrators
    const secretsAcl = /SECRETS-ACL-BEGIN([\s\S]*?)SECRETS-ACL-END/.exec(applied.stdout)?.[1] ?? "";
    assert.ok(secretsAcl.includes("Guest"), "the secrets ACL was listed right after it was set");
    for (const [p, acl] of [[jrData, icacls(jrData)], [secrets, secretsAcl]] as const) {
      assert.ok(!acl.toLowerCase().includes(me.toLowerCase()), `the agent user has an ACE on ${p}:\n${acl}`);
      assert.match(acl, /Guest/);
      assert.match(acl, /NT AUTHORITY\\SYSTEM/);
      assert.match(acl, /BUILTIN\\Administrators/);
      assert.doesNotMatch(acl, /BUILTIN\\Users|Authenticated Users|Everyone/);
    }
    assert.ok(!icacls(jr).toLowerCase().includes(me.toLowerCase()), "no ACE for the agent user on the job runner folder");
  } finally {
    fx.cleanup();
  }
});

// ---- check-jobrunner (read only) -------------------------------------------------------------------------------

test("check-jobrunner: reports a loopback listener, a missing task and a closed secrets file; exits 1 with the violations", { skip }, async () => {
  const fx = makeFixture();
  const me = whoami();
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
  const port = (srv.address() as { port: number }).port;
  try {
    const jrData = join(fx.root, "jrdata");
    mkdirSync(jrData, { recursive: true });
    writeFileSync(join(jrData, "secrets.json"), "{}");
    protect(jrData, me, "F");
    protect(join(jrData, "secrets.json"), me, "F");
    const before = snapshot(fx.root);
    const r = runPs(["-File", join(JR, "check-jobrunner.ps1"), "-AgentUser", NO_USER, "-ProgramDataDir", fx.pd, "-DataDir", jrData, "-IpcPort", String(port), "-TaskPath", "\\agent-007-test\\"]);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, new RegExp(`listening on 127\\.0\\.0\\.1:${port}`));
    assert.match(r.stdout, /VIOLATION\s+scheduled task \\agent-007-test\\jobrunner does not exist/);
    assert.doesNotMatch(r.stdout, /VIOLATION\s+port \d+ listens on/);
    assert.doesNotMatch(r.stdout, /VIOLATION\s+.*has an ACE for the agent user/);
    assert.deepEqual(snapshot(fx.root), before, "read only");

    // when the agent user has an ACE on the secrets file, that is a violation
    const r2 = runPs(["-File", join(JR, "check-jobrunner.ps1"), "-AgentUser", me.split("\\").pop() ?? me, "-ProgramDataDir", fx.pd, "-DataDir", jrData, "-IpcPort", String(port), "-TaskPath", "\\agent-007-test\\"]);
    assert.equal(r2.status, 1);
    assert.match(r2.stdout, /VIOLATION\s+.*has an ACE for the agent user or a broad group/);
  } finally {
    srv.close();
    fx.cleanup();
  }
});
