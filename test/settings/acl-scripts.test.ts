/**
 * Parse-level tests of the Phase 3 settings ACL scripts (S17.4), as S7.3 does for deploy/*.ps1: no admin, nothing changed.
 * `check-settings-acl.ps1` is read-only; `setup-settings-acl.ps1` is only ever run with -WhatIf here.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HAS_WINDOWS_POWERSHELL, runPs, whoami } from "../deploy/_fixture.js";
import { ROOT, tempDir } from "./helpers.js";

const SETUP = join(ROOT, "scripts", "settings", "setup-settings-acl.ps1");
const CHECK = join(ROOT, "scripts", "settings", "check-settings-acl.ps1");
const skip = HAS_WINDOWS_POWERSHELL ? false : "Windows PowerShell is not available";

const PARSE = (file: string) =>
  `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$t,[ref]$e); if($e.Count -gt 0){$e|ForEach-Object{'ERR line '+$_.Extent.StartLineNumber+': '+$_.Message};exit 1}else{'OK'}`;

function strip(text: string): string {
  return text.replace(/<#[\s\S]*?#>/g, "").replace(/(^|\s)#.*$/gm, "$1");
}

test("both scripts parse in Windows PowerShell 5.1 and are ASCII only", { skip }, () => {
  for (const f of [SETUP, CHECK]) {
    const r = runPs(["-Command", PARSE(f)]);
    assert.equal(r.status, 0, `${f}\n${r.all}`);
    const bytes = [...readFileSync(f)];
    assert.equal(bytes.findIndex((b) => b > 126 || (b < 32 && b !== 9 && b !== 10 && b !== 13)), -1, `${f} is not ASCII`);
  }
});

test("check-settings-acl.ps1 changes nothing: no write cmdlet, no icacls grant, deny, remove, reset or setowner", () => {
  const code = strip(readFileSync(CHECK, "utf8"));
  for (const bad of [/\bSet-Acl\b/, /\bSet-Content\b/, /\bNew-Item\b/, /\bRemove-Item\b/, /\bOut-File\b/, /\bAdd-Content\b/, /\bCopy-Item\b/, /\bMove-Item\b/, /\bicacls(\.exe)?\b/i, /\bInvoke-Icacls\b/, /\bSet-ExactAcl\b/, /acl-write\.ps1/]) {
    assert.ok(!bad.test(code), `check-settings-acl.ps1 must not contain ${bad}`);
  }
  assert.match(code, /\bGet-Acl\b/);
});

test("setup-settings-acl.ps1 sets each ACL before any file is created and goes through Invoke-Step (so -WhatIf changes nothing)", () => {
  const code = strip(readFileSync(SETUP, "utf8"));
  const firstFile = code.indexOf("-ItemType File");
  const auditAcl = code.indexOf("'/inheritance:r', '/grant:r'");
  assert.ok(auditAcl > 0 && firstFile > auditAcl, "the audit folder ACL is set before the Plan B files are created");
  assert.ok(/Set-ExactAcl -Path \$d/.test(code));
  assert.ok(!/Set-Acl\b/.test(code), "only the shared helpers set ACLs");
  assert.ok(/\(R,AD\)/.test(code) && /\(OI\)\(IO\)/.test(code), "the audit files inherit read plus append only");
  assert.equal((code.match(/Invoke-Step/g) ?? []).length >= 4, true);
});

test("setup-settings-acl.ps1 -WhatIf prints its steps and creates nothing", { skip }, () => {
  const root = tempDir("a7-setupacl-");
  const r = runPs(["-File", SETUP, "-WhatIf", "-ProgramDataDir", root, "-AgentUser", "agent007", "-PlanB", "-PreCreateMonths", "2"]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /\[WhatIf\] create .*settings with inheritance off/);
  assert.match(r.all, /append-only/);
  assert.match(r.all, /pre-create .*settings-\d{6}\.jsonl/);
  assert.equal(existsSync(join(root, "settings")), false, "nothing was created");
  rmSync(root, { recursive: true, force: true });
});

test("check-settings-acl.ps1 exits 1 on a fixture folder where the test user has write access", { skip }, () => {
  const root = tempDir("a7-checkacl-");
  for (const d of ["settings", "settings\\personas", "settings\\audit"]) mkdirSync(join(root, d), { recursive: true });
  const me = whoami().split("\\").pop() as string;
  const r = runPs(["-File", CHECK, "-ProgramDataDir", root, "-AgentUser", me]);
  assert.equal(r.status, 1, r.all);
  assert.match(r.all, /VIOLATIONS/);
  assert.match(r.all, /can write, append, delete or change permissions|inheritance on/);
  rmSync(root, { recursive: true, force: true });
});
