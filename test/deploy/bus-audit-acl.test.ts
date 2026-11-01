import assert from "node:assert/strict";
import { test } from "node:test";
import { readScript, stripComments } from "./_fixture.js";

// Deviations 102 (I45) and 141: script-text checks only. Nothing here runs a script or touches an ACL.

test("check-acl.ps1 has rows for <dataDir>\\bus-audit (create files + append only) and <dataDir>\\bus\\chains.json", () => {
  const s = stripComments(readScript("check-acl.ps1"));
  assert.match(s, /Join-WinPath \$layout\.DataDir 'bus-audit'/);
  assert.match(s, /Join-WinPath \$layout\.DataDir 'bus', 'chains\.json'/);
  assert.match(s, /cannot read bus chains\.json/);
  assert.match(s, /Test-AuditFolder -Dir \$busAuditDir -Label 'bus audit'/);
  assert.match(s, /Test-AuditFolder -Dir \$auditDir -Label 'settings audit'/, "the settings audit folder uses the same check");
  const fn = /function Test-AuditFolder \{[\s\S]*?\n\}\n/.exec(s)?.[0] ?? "";
  assert.ok(fn.length > 0, "Test-AuditFolder exists");
  assert.match(fn, /WriteData is inherited onto the audit files/, "WriteData on an inheriting or inherited ACE is a violation");
  assert.match(fn, /can delete in the audit folder/, "Delete is a violation");
  assert.match(fn, /creator-owner can write, delete or change the ACL/, "OWNER RIGHTS beyond Read + AppendData is a violation");
  assert.match(fn, /can overwrite or delete this audit file/, "existing files are checked for write data and delete");
  assert.match(fn, /no create-files right/, "no create-files right is a warning");
  assert.match(fn, /no append right on the/, "no append right is a warning");
  assert.match(fn, /no OWNER RIGHTS \(S-1-3-4\) ACE/, "missing OWNER RIGHTS is a warning");
});

test("grant-folder-acls.ps1 gives bus-audit and settings\\audit the create-files + append-only ACL through Set-OurFolder (dry-run capable)", () => {
  const g = stripComments(readScript("grant-folder-acls.ps1"));
  assert.match(g, /Join-WinPath \$layout\.DataDir 'bus-audit'/);
  assert.match(g, /Set-OurFolder -Path \$busAuditDir .*Set-AppendOnlyDirAcl/);
  assert.match(g, /Join-WinPath \$layout\.ProgramDataDir 'settings', 'audit'/);
  assert.match(g, /Set-OurFolder -Path \$settingsAuditDir .*Set-AppendOnlyDirAcl/);
});

test("acl-write.ps1 Set-AppendOnlyDirAcl: folder ACE this-folder-only RX + CreateFiles, inheritable files-only RX + AppendData, OWNER RIGHTS Read + AppendData", () => {
  const w = stripComments(readScript("acl-write.ps1"));
  const fn = /function Set-AppendOnlyDirAcl \{[\s\S]*?\n\}/.exec(w)?.[0] ?? "";
  assert.ok(fn.length > 0, "Set-AppendOnlyDirAcl exists");
  assert.match(fn, /'ReadAndExecute, CreateFiles' -Inherit \$false -InheritFlags 'None' -PropagationFlags 'None'/);
  assert.match(fn, /'ReadAndExecute, AppendData' -Inherit \$false -InheritFlags 'ObjectInherit' -PropagationFlags 'InheritOnly'/);
  assert.match(fn, /-Sid 'S-1-3-4' -Rights 'Read, AppendData' -Inherit \$false -InheritFlags 'ObjectInherit' -PropagationFlags 'InheritOnly'/);
  // the agent and OWNER RIGHTS ACEs carry no write-data, modify or delete right (CreateFiles is WriteData on the directory only)
  const rights = [...fn.matchAll(/-Rights '([^']*)'/g)].map((m) => m[1]).filter((r) => r !== "FullControl");
  assert.deepEqual(rights, ["ReadAndExecute, CreateFiles", "ReadAndExecute, AppendData", "Read, AppendData"]);
  assert.doesNotMatch(rights.join(" "), /Modify|Write|Delete|ChangePermissions|TakeOwnership/);
});
