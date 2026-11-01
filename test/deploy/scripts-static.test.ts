import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultsFromEnv, parseConfig } from "../../src/config/schema.js";
import { isLoopbackUrl } from "../../src/config/paths.js";
import { DEPLOY, HAS_PWSH, HAS_WINDOWS_POWERSHELL, ROOT, psScripts, readScript, runPs, stripComments } from "./_fixture.js";

const skipPs = HAS_WINDOWS_POWERSHELL ? false : "Windows PowerShell is not available";

const PARSE_SNIPPET = (file: string) =>
  `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$t,[ref]$e); if($e.Count -gt 0){$e|ForEach-Object{'ERR line '+$_.Extent.StartLineNumber+': '+$_.Message};exit 1}else{'OK'}`;

test("every deploy/*.ps1 parses with no errors in Windows PowerShell 5.1", { skip: skipPs }, () => {
  const scripts = psScripts();
  assert.deepEqual(scripts, [
    "acl-write.ps1",
    "check-acl.ps1",
    "common.ps1",
    "deploy-app.ps1",
    "grant-folder-acls.ps1",
    "new-secrets.ps1",
    "register-strata-task.ps1",
    "register-task.ps1",
    "setup-agent-user.ps1",
    "uninstall.ps1",
  ]);
  for (const s of scripts) {
    const r = runPs(["-Command", PARSE_SNIPPET(join(DEPLOY, s))]);
    assert.equal(r.status, 0, `${s} does not parse:\n${r.stdout}${r.stderr}`);
  }
});

test("every deploy/*.ps1 parses with no errors in PowerShell 7", { skip: HAS_PWSH ? false : "pwsh is not available" }, () => {
  for (const s of psScripts()) {
    const r = runPs(["-Command", PARSE_SNIPPET(join(DEPLOY, s))], { shell: "pwsh" });
    assert.equal(r.status, 0, `${s} does not parse in pwsh:\n${r.stdout}${r.stderr}`);
  }
});

test("the scripts are ASCII only (Windows PowerShell 5.1 reads BOM-less files as ANSI)", () => {
  for (const s of psScripts()) {
    const bytes = readFileSync(join(DEPLOY, s));
    const bad = [...bytes].findIndex((b) => b > 126 || (b < 32 && b !== 9 && b !== 10 && b !== 13));
    assert.equal(bad, -1, `${s} has a non-ASCII byte at offset ${bad}`);
  }
});

const SYSTEM_CHANGING = [
  "setup-agent-user.ps1",
  "grant-folder-acls.ps1",
  "new-secrets.ps1",
  "deploy-app.ps1",
  "register-task.ps1",
  "uninstall.ps1",
  "register-strata-task.ps1",
];

test("every system-changing script supports -WhatIf and checks elevation before any change or prompt", () => {
  for (const s of SYSTEM_CHANGING) {
    const text = stripComments(readScript(s));
    assert.match(text, /\[CmdletBinding\(SupportsShouldProcess\s*=\s*\$true\)\]/, `${s}: SupportsShouldProcess`);
    assert.match(text, /\$dry\s*=\s*\[bool\]\$WhatIfPreference/, `${s}: reads $WhatIfPreference`);
    const elev = text.search(/^\s*Assert-Elevated\s+-DryRun:\$dry/m);
    assert.ok(elev >= 0, `${s}: calls Assert-Elevated -DryRun:$dry`);
    for (const change of [/Invoke-Step\s+-/, /Read-Host/, /New-LocalUser/, /Register-ScheduledTask/, /Set-Acl/, /icacls/i, /Set-ExactAcl/, /Remove-Item\s/]) {
      const at = text.search(change);
      if (at >= 0) assert.ok(elev < at, `${s}: Assert-Elevated must come before ${change}`);
    }
  }
});

test("check-acl.ps1 and common.ps1 are read-only: no Set-Acl, no icacls grant/deny/remove/reset/setowner/inheritance, no acl-write", () => {
  for (const s of ["check-acl.ps1", "common.ps1"]) {
    const text = readScript(s).replace(/<#[\s\S]*?#>/g, "").replace(/^\s*#.*$/gm, "");
    assert.doesNotMatch(text, /Set-Acl/i, `${s}: Set-Acl`);
    assert.doesNotMatch(text, /icacls[^\r\n]*\/(grant|deny|remove|reset|setowner|inheritance)/i, `${s}: icacls change switch`);
    assert.doesNotMatch(text, /acl-write\.ps1/i, `${s}: must not load the ACL-writing helpers`);
    assert.doesNotMatch(text, /\b(Add-DenyRead|Add-DenyWrite|Add-GrantReadExecute|Remove-AgentAces|Set-ExactAcl|Set-SecretFileAcl)\b/, `${s}: ACL-writing function`);
    assert.doesNotMatch(text, /\b(Remove-Item|Set-Content|Out-File|New-Item|Register-ScheduledTask|New-LocalUser|Set-ItemProperty)\b/, `${s}: write cmdlet`);
  }
  const ck = readScript("check-acl.ps1");
  assert.match(ck, /Get-Acl/);
  assert.match(ck, /Get-PSDrive/);
});

test("acl-write.ps1: Add-DenyRead refuses group (b) first; Add-DenyWrite never denies a read right", () => {
  const text = readScript("acl-write.ps1");
  const denyRead = /function Add-DenyRead[\s\S]*?\n}\n/.exec(text)?.[0] ?? "";
  assert.ok(denyRead.indexOf("Get-DenyRefusalReason") >= 0 && denyRead.indexOf("Get-DenyRefusalReason") < denyRead.indexOf("'/deny'"), "refusal check before the /deny");
  const denyWrite = /function Add-DenyWrite[\s\S]*?\n}\n/.exec(text)?.[0] ?? "";
  const spec = /"\$\{AgentUser\}:(\(OI\)\(CI\)\(([A-Z,]+)\))"/.exec(denyWrite);
  assert.ok(spec, "Add-DenyWrite spec found");
  const rights = (spec?.[2] ?? "").split(",");
  assert.deepEqual(rights.sort(), ["AD", "D", "DC", "WA", "WD", "WEA"].sort());
  // exactly two places in the whole deploy folder may contain '/deny'
  let count = 0;
  for (const s of psScripts()) count += (readScript(s).match(/'\/deny'/g) ?? []).length;
  assert.equal(count, 2, "only Add-DenyRead and Add-DenyWrite contain /deny");
});

test("config.example.json parses with the S1.2 schema, carries both runners and matches the defaults", () => {
  const raw = JSON.parse(readFileSync(join(ROOT, "config", "config.example.json"), "utf8")) as Record<string, unknown>;
  const env = defaultsFromEnv({ LOCALAPPDATA: "C:\\Users\\agent007\\AppData\\Local", ProgramData: "C:\\ProgramData", AGENT007_MAIN_USER_PROFILE: "C:\\Users\\CHANGE-ME" });
  const cfg = parseConfig(raw, env);
  assert.equal(cfg.model.runner, "lmstudio");
  assert.ok(cfg.model.runners.lmstudio);
  assert.ok(cfg.model.runners.strata);
  for (const b of [cfg.model.runners.lmstudio, cfg.model.runners.strata]) assert.equal(isLoopbackUrl(b!.baseUrl), true);
  assert.equal(cfg.model.runners.strata!.modelId, "qwen3.8-flash-next-iq3_s");
  // the explicit sections equal what the loader would default to for the agent007 account
  const stripped = { ...raw } as Record<string, unknown>;
  for (const k of ["paths", "shell", "limits"]) delete stripped[k];
  const model = { ...(raw["model"] as Record<string, unknown>) };
  delete model["streamTimeoutMs"];
  delete model["retry"];
  stripped["model"] = model;
  const defaults = parseConfig(stripped, env);
  assert.deepEqual(cfg.paths, defaults.paths);
  assert.deepEqual(cfg.shell, defaults.shell);
  assert.deepEqual(cfg.limits, defaults.limits);
  assert.deepEqual(cfg.model.retry, defaults.model.retry);
  assert.equal(cfg.model.streamTimeoutMs, defaults.model.streamTimeoutMs);
  // placeholders are visible, and no secret-looking value is present
  const text = readFileSync(join(ROOT, "config", "config.example.json"), "utf8");
  assert.match(text, /CHANGE-ME/);
  assert.doesNotMatch(text, /\d{6,}:[A-Za-z0-9_-]{20,}/, "no bot token");
  assert.deepEqual(cfg.folders.deny, []);
});

test("USER.example.md is a template with no secrets", () => {
  const text = readFileSync(join(ROOT, "config", "USER.example.md"), "utf8");
  assert.ok(text.length > 200);
  assert.match(text, /How I want answers/);
  assert.doesNotMatch(text, /\d{6,}:[A-Za-z0-9_-]{20,}/);
});

test("deploy/README-ops.md covers every operator action with the real task paths", () => {
  const text = readFileSync(join(DEPLOY, "README-ops.md"), "utf8");
  for (const needle of [
    "\\agent-007\\",
    "-TaskName 'agent'",
    "-TaskName 'strata'",
    "Stop-ScheduledTask",
    "Disable-ScheduledTask",
    "Enable-ScheduledTask",
    "Start-ScheduledTask",
    "shell-disabled",
    "controlDir",
    "check-acl.ps1",
    "-WhatIf",
  ]) assert.ok(text.includes(needle), `README-ops.md mentions ${needle}`);
});
