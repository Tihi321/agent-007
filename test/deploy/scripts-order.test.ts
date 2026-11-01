/**
 * Parse-level tests (S7.4, S7.7, S7.9 done-checks): the order of ACL and write, secrets never printed, Strata and user
 * deletion guards. These read the scripts as text or through the PowerShell AST; nothing is executed.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DEPLOY, HAS_WINDOWS_POWERSHELL, readScript, runPs, stripComments } from "./_fixture.js";

const skipAst = HAS_WINDOWS_POWERSHELL ? false : "Windows PowerShell is not available";

const WRITE = /\b(Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|New-Item|Remove-Item|Rename-Item|Clear-Content|WriteAllText|WriteAllBytes|WriteAllLines|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty)\b/;
const OUTPUT = /Write-(Host|Output|Verbose|Debug|Warning|Error|Information)\b/;

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

test("S7.4 new-secrets: the file is created empty, the ACL is set, and only then is any content written", () => {
  const code = stripComments(readScript("new-secrets.ps1"));
  const empty = code.search(/WriteAllBytes\(\$secretsFile,\s*\[byte\[\]\]@\(\)\)/);
  const acl = code.search(/Set-SecretFileAcl\s+-Path\s+\$secretsFile/);
  const firstWrite = code.search(/WriteAllText\(\$secretsFile/);
  assert.ok(empty >= 0 && acl >= 0 && firstWrite >= 0, "all three steps exist");
  assert.ok(empty < acl, "created empty before the ACL");
  assert.ok(acl < firstWrite, "ACL before the first content write");
  // nothing else writes secrets content before the ACL
  const before = code.slice(0, acl);
  assert.doesNotMatch(before, /WriteAllText|Set-Content|Out-File|Add-Content/);
  // the ACL helper itself removes inheritance and sets an exact DACL
  const helper = /function Set-SecretFileAcl[\s\S]*?\n}\n/.exec(readScript("acl-write.ps1"))?.[0] ?? "";
  assert.match(helper, /Set-ExactAcl/);
  const exact = /function Set-ExactAcl[\s\S]*?\n}\n/.exec(readScript("acl-write.ps1"))?.[0] ?? "";
  assert.match(exact, /SetAccessRuleProtection\(\$true,\s*\$false\)/, "inheritance off, inherited ACEs not copied");
  assert.match(exact, /RemoveAccessRule/);
  assert.match(helper, /Read'/, "agent gets Read");
  assert.match(helper, /SidSystem/);
  assert.match(helper, /SidAdministrators/);
  assert.doesNotMatch(helper, /SidUsers|SidAuthenticatedUsers|SidEveryone/);
});

test("S7.4 new-secrets: no echo, Strata key generated with RandomNumberGenerator and never prompted or printed", () => {
  const code = stripComments(readScript("new-secrets.ps1"));
  assert.match(code, /Read-Host[^\n]*-AsSecureString/, "prompts with -AsSecureString");
  assert.doesNotMatch(code, /Read-Host(?![^\n]*-AsSecureString)/, "every Read-Host is secure");
  assert.match(code, /RandomNumberGenerator\]::Create\(\)/);
  assert.doesNotMatch(code, /Get-Random/, "no Get-Random");
  assert.match(code, /function New-Base64UrlKey/);
  assert.doesNotMatch(code, /Read-SecretText[^\n]*(strataApiKey|Strata (API )?key)/i, "the Strata key is not prompted for");
  for (const l of lines(code)) {
    if (OUTPUT.test(l)) assert.doesNotMatch(l, /\$(botTokenPlain|lmTokenPlain|strataKeyPlain|json|content|existing|secrets|sec|bstr)\b/, `value printed: ${l.trim()}`);
  }
  assert.doesNotMatch(code, /\$env:[A-Za-z_]+\s*=/, "no value goes into the environment");
  assert.doesNotMatch(code, /Start-Transcript/);
  // an empty LM Studio token is accepted only with -Runner strata
  assert.match(code, /elseif \(\$Runner -eq 'lmstudio'\) \{ throw 'An LM Studio API token is required with -Runner lmstudio\.' \}/);
  // the key is kept unless -RotateStrataKey; -NoStrataKey skips it
  assert.match(code, /\$willGenerate = \(\$Runner -eq 'strata' -and -not \$NoStrataKey -and \(\$RotateStrataKey -or -not \$hasStrata\)\)/);
});

test("S9.4 new-secrets: ipcHmacKey is generated (not typed), written only after the ACL, never printed; MCP tokens are secure prompts", () => {
  const code = stripComments(readScript("new-secrets.ps1"));
  const acl = code.search(/Set-SecretFileAcl\s+-Path\s+\$secretsFile/);
  const assign = code.search(/\$content\['ipcHmacKey'\] = \$ipcKeyPlain/);
  const tokens = code.search(/\$content\['mcpTokens'\] = \$mcpMap/);
  assert.ok(acl >= 0 && assign > acl && tokens > acl, "both keys enter the content only after the ACL step");
  // generation: 32 bytes from the crypto RNG through the same helper as the Strata key; kept unless -RotateIpcKey
  assert.match(code, /if \(\$willGenerateIpc\) \{ \$ipcKeyPlain = New-Base64UrlKey -Bytes 32 \}/);
  assert.match(code, /\$willGenerateIpc = \(\$RotateIpcKey -or -not \$hasIpc\)/);
  assert.doesNotMatch(code, /Read-SecretText[^\n]*ipc/i, "the IPC key is never prompted");
  // the optional tokens are secure prompts; no plain Read-Host
  assert.match(code, /\$mcpTokenPlain = Read-SecretText -Prompt/);
  assert.doesNotMatch(code, /Read-Host(?![^\n]*-AsSecureString)/);
  for (const l of lines(code)) {
    if (OUTPUT.test(l)) assert.doesNotMatch(l, /\$(ipcKeyPlain|mcpTokenPlain|mcpMap)\b/, `value printed: ${l.trim()}`);
  }
  assert.match(code, /\$ipcKeyPlain = \$null; \$mcpTokenPlain = \$null; \$mcpMap = \$null/, "the values are cleared at the end");
});

test("S9.4 new-secrets: the generator's output is a 32-byte base64url key that the IPC module accepts, and differs every time", { skip: skipAst }, () => {
  const src = readScript("new-secrets.ps1");
  const fn = /function New-Base64UrlKey \{[\s\S]*?\n\}\n/.exec(src)?.[0];
  assert.ok(fn, "the generator function exists");
  const r = runPs(["-Command", `${fn}\n\$a = New-Base64UrlKey -Bytes 32; \$b = New-Base64UrlKey -Bytes 32; Write-Output \$a; Write-Output \$b`]);
  assert.equal(r.status, 0, r.all);
  const [a, b] = r.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  assert.match(a ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.match(b ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a ?? "", "base64url").length, 32);
});

test("S7.7 uninstall: Remove-LocalUser only inside the -RemoveUser branch; Remove-Item only on the guarded folders; no Strata write", { skip: skipAst }, () => {
  const file = join(DEPLOY, "uninstall.ps1").replace(/'/g, "''");
  const snippet = `
$e=$null;$t=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e)
$cmds=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst]},$true)
$bad=@()
foreach($c in $cmds){
  $name=$c.GetCommandName()
  if($name -eq 'Remove-LocalUser'){
    $p=$c.Parent;$guarded=$false
    while($p){ if($p -is [System.Management.Automation.Language.IfStatementAst]){ foreach($cl in $p.Clauses){ if($cl.Item1.Extent.Text -match 'RemoveUser'){ $guarded=$true } } }; $p=$p.Parent }
    if(-not $guarded){ $bad+='Remove-LocalUser outside -RemoveUser' }
  }
}
if($bad.Count -gt 0){ $bad; exit 1 } else { 'OK' }`;
  const r = runPs(["-Command", snippet]);
  assert.equal(r.status, 0, r.all);

  const code = stripComments(readScript("uninstall.ps1"));
  const removeItems = lines(code).filter((l) => /\bRemove-Item\b/.test(l) && !/Remove-ItemProperty/.test(l));
  assert.ok(removeItems.length >= 2);
  for (const l of removeItems) {
    assert.doesNotMatch(l, /strata|installDir|dataDir/i, `Remove-Item must not target Strata: ${l.trim()}`);
    assert.match(l, /-LiteralPath \$(layout\.ProgramFilesDir|d)\b/, `Remove-Item targets only the guarded folders: ${l.trim()}`);
  }
  // every deletion is preceded by the safety check
  assert.match(code, /Assert-SafeToDelete -Path \$layout\.ProgramFilesDir[\s\S]*?Remove-Item -LiteralPath \$layout\.ProgramFilesDir/);
  assert.match(code, /Assert-SafeToDelete -Path \$d[\s\S]*?Remove-Item -LiteralPath \$d/);
  // the Strata dirs appear only in ACE removal, the safety check and messages
  for (const l of lines(code)) {
    if (/StrataInstallDir|StrataDataDir/.test(l)) assert.doesNotMatch(l, WRITE, `a write cmdlet touches a Strata dir: ${l.trim()}`);
  }
  assert.doesNotMatch(code, /\bgit(\.exe)?\b/i, "no git at all");
});

test("S7.9 register-strata-task: no write cmdlet targets the Strata install or data; git is read-only; the copy's ACL precedes the key", () => {
  const code = stripComments(readScript("register-strata-task.ps1"));
  for (const l of lines(code)) {
    if (WRITE.test(l)) {
      assert.doesNotMatch(l, /\$(installDir|dataDir|sourceConfig|pythonExe|serverPy)\b|StrataInstallDir|StrataDataDir/, `write cmdlet on a Strata path: ${l.trim()}`);
    }
  }
  // only these verbs, and only through the whitelisting wrapper
  const gitCalls = [...code.matchAll(/git\.exe/g)].length;
  assert.equal(gitCalls, 1, "git.exe is invoked in exactly one place");
  assert.match(code, /function Invoke-GitReadOnly\s*\{\s*[^}]*ValidateSet\('rev-parse',\s*'status'\)/);
  assert.match(code, /--no-optional-locks/);
  for (const m of code.matchAll(/Invoke-GitReadOnly\s+-Verb\s+'([^']+)'/g)) assert.ok(["rev-parse", "status"].includes(m[1]!), `git verb ${m[1]}`);
  // refuses before any ACL or write
  const refuse = code.search(/not at the pinned commit/);
  const firstChange = code.search(/Invoke-Step\s+-/);
  assert.ok(refuse >= 0 && refuse < firstChange, "the commit and clean-tree checks come before any change");
  assert.ok(code.search(/uncommitted changes/) < firstChange);
  // no Deny Read anywhere in this script; only Add-DenyWrite
  assert.doesNotMatch(code, /Add-DenyRead|DENY READ|\/deny/i);
  assert.match(code, /Add-DenyWrite/);
  // the copy's ACL line comes before the line that writes the key
  const empty = code.search(/WriteAllBytes\(\$configCopy,/);
  const acl = code.search(/Set-SecretFileAcl\s+-Path\s+\$configCopy/);
  const write = code.search(/WriteAllText\(\$configCopy,/);
  assert.ok(empty >= 0 && acl > empty && write > acl, "empty file, then ACL, then content");
  assert.ok(code.indexOf("Set-SecretFileAcl") === acl, "no earlier ACL call is on another path");
  // the key is read from secrets.json, never prompted and never printed
  assert.doesNotMatch(code, /Read-Host/);
  for (const l of lines(code)) {
    if (OUTPUT.test(l)) assert.doesNotMatch(l.replace(/if \(\$strataKey\)/g, ""), /\$(strataKey|newContent|current|src)\b/, `value printed: ${l.trim()}`);
  }
  // task: no --open, port 8080 default, agent user, S4U, AtStartup without delay
  assert.doesNotMatch(code, /--open/);
  assert.match(code, /\[int\]\$Port = 8080/);
  assert.match(code, /New-AgentTaskTriggers -StartupDelaySec 0/);
  assert.match(code, /-LogonType S4U -RunLevel Limited/);
  assert.match(code, /\$PinnedCommit = 'e88ee39d'/);
});

test("S7.5/S7.6 register-task and deploy-app carry the settings of the plan", () => {
  const rt = stripComments(readScript("register-task.ps1"));
  assert.match(rt, /New-AgentTaskTriggers -StartupDelaySec 60/);
  assert.match(rt, /\$TaskPath = '\\agent-007\\'/);
  assert.match(rt, /\$TaskName = 'agent'/);
  assert.match(rt, /C:\\Program Files\\nodejs\\node\.exe/);
  assert.match(rt, /dist', 'src', 'main\.js'/);
  assert.match(rt, /-LogonType \$logonType -RunLevel Limited/);
  assert.match(rt, /\$logonType = 'S4U'/);
  assert.match(rt, /\$logonType = 'Password'/);
  const cm = stripComments(readScript("common.ps1"));
  for (const needle of ["-MultipleInstances IgnoreNew", "-ExecutionTimeLimit (New-TimeSpan -Seconds 0)", "-RestartCount 3", "-RestartInterval (New-TimeSpan -Minutes 1)", "-AllowStartIfOnBatteries", "-DontStopIfGoingOnBatteries", "-StartWhenAvailable", "-AtStartup", "-RepetitionInterval (New-TimeSpan -Minutes 5)"]) {
    assert.ok(cm.includes(needle), `common.ps1 task builder has ${needle}`);
  }
  const da = stripComments(readScript("deploy-app.ps1"));
  assert.match(da, /'workspaces', 'focus', '--production'/);
  assert.match(da, /Set-ProgramFilesAcl/);
  assert.match(da, /Test-Path -LiteralPath \$configFile -PathType Leaf/);
});

test("S7.1 setup-agent-user: not an admin, hidden, password not printed unless -ShowPassword, idempotent checks", () => {
  const code = stripComments(readScript("setup-agent-user.ps1"));
  assert.match(code, /SpecialAccounts\\UserList/);
  assert.match(code, /SidAdministrators[\s\S]*?Remove-LocalGroupMember/);
  assert.match(code, /if \(\$ShowPassword\) \{ Write-Host "Generated password/);
  assert.equal([...code.matchAll(/Generated password/g)].length, 1, "the password is printed in exactly one guarded place");
  assert.match(code, /does not reset|not reset/i);
  assert.doesNotMatch(code, /Set-LocalUser[^\n]*-Password\b/, "an existing user's password is never reset");
  assert.match(code, /SeDenyInteractiveLogonRight/);
  assert.match(code, /SeDenyRemoteInteractiveLogonRight/);
});

test("S20.5 new-secrets: bot and mirror tokens are secure prompts, written only after the ACL, never printed, cleared at the end", () => {
  const code = stripComments(readScript("new-secrets.ps1"));
  const acl = code.search(/Set-SecretFileAcl\s+-Path\s+\$secretsFile/);
  const botWrite = code.search(/\$content\['botTokens'\] = \$botTokenMap/);
  const mirrorWrite = code.search(/\$content\['mirrorBotToken'\] = \$mirrorTokenPlain/);
  assert.ok(acl >= 0 && botWrite > acl && mirrorWrite > acl, "both enter the content only after the ACL step");
  // the prompts only read; nothing is written before the ACL
  assert.match(code, /\$extraTokenPlain = Read-SecretText -Prompt/);
  assert.match(code, /\$mirrorTokenPlain = Read-SecretText -Prompt/);
  assert.doesNotMatch(code, /Read-Host(?![^\n]*-AsSecureString)/);
  assert.doesNotMatch(code.slice(0, acl), /WriteAllText|Set-Content|Out-File|Add-Content/);
  for (const l of lines(code)) {
    if (OUTPUT.test(l)) assert.doesNotMatch(l, /\$(extraTokenPlain|mirrorTokenPlain|botTokenMap|seenTokens|tokenOwners)\b/, `value printed: ${l.trim()}`);
  }
  assert.match(code, /\$botTokenMap = \$null; \$extraTokenPlain = \$null; \$mirrorTokenPlain = \$null/, "the values are cleared at the end");
  // the checklist names every step
  const steps = /function Write-BotFatherSteps \{[\s\S]*?\n\}\n/.exec(code)?.[0] ?? "";
  assert.match(steps, /\/newbot/);
  assert.match(steps, /\/setjoingroups\s+choose the bot, then Disable/);
  assert.match(steps, /Bot-to-Bot Communication Mode: leave it OFF/);
  // a token two bots share, and a bad bot id, are refused; the proxy key is not handled here
  assert.match(code, /have the same token \(value not shown\)/);
  assert.match(code, /\^\[a-z\]\[a-z0-9-\]\{1,23\}\$/);
  assert.doesNotMatch(code, /proxyApiKey/);
  assert.doesNotMatch(code, /Read-SecretText[^\n]*proxy/i);
});
