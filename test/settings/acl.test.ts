import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsAclError, aclProblems, assertSettingsAcl, checkSettingsAcl } from "../../src/settings/acl.js";
import { parseIcacls } from "../../src/config/secrets.js";
import { settingsPaths } from "../../src/settings/store.js";

const PD = "C:\\ProgramData\\agent-007";
const paths = settingsPaths(PD, "C:\\Users\\agent007\\AppData\\Local\\agent-007");
const AGENT = "agent007";
const FILE = `${paths.auditDir}\\settings-202610.jsonl`;

/** `icacls <path>` output: the first entry shares the path's line, the rest are indented. */
function out(path: string, entries: string[]): string {
  return [`${path} ${entries[0]}`, ...entries.slice(1).map((e) => `      ${e}`), "", "Successfully processed 1 files; Failed processing 0 files"].join("\n");
}

const BASE = ["NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)", "BUILTIN\\Administrators:(I)(OI)(CI)(F)"];

interface Layout {
  [path: string]: string[];
}

function good(): Layout {
  return {
    [paths.securityFile]: [...BASE, `HOST\\${AGENT}:(R)`, "HOST\\main:(M)"],
    [paths.settingsDir]: [...BASE, `HOST\\${AGENT}:(OI)(CI)(RX)`, "HOST\\main:(OI)(CI)(M)"],
    [paths.userPersonasDir]: [...BASE, `HOST\\${AGENT}:(OI)(CI)(RX)`, "HOST\\main:(OI)(CI)(M)"],
    [paths.auditDir]: [...BASE, `HOST\\${AGENT}:(CI)(R,WD)`, `HOST\\${AGENT}:(OI)(IO)(R,AD)`, "HOST\\main:(CI)(R,WD)"],
    [FILE]: [...BASE, `HOST\\${AGENT}:(R,AD)`, "HOST\\main:(R,AD)"],
  };
}

function check(l: Layout): string[] {
  return checkSettingsAcl({ paths, agentUser: AGENT, icacls: (p) => out(p, l[p] ?? []), listAuditFiles: () => [FILE] });
}

test("a compliant layout passes (agent read only on the settings; read, add-file and append on the audit log)", () => {
  assert.deepEqual(check(good()), []);
  assert.doesNotThrow(() => assertSettingsAcl({ paths, agentUser: AGENT, icacls: (p) => out(p, good()[p] ?? []), listAuditFiles: () => [FILE] }));
});

test("the agent user with W on security.json refuses start", () => {
  const l = good();
  l[paths.securityFile] = [...BASE, `HOST\\${AGENT}:(W)`];
  assert.match(check(l).join("\n"), /security\.json: the agent user .* has W/);
  assert.throws(() => assertSettingsAcl({ paths, agentUser: AGENT, icacls: (p) => out(p, l[p] ?? []), listAuditFiles: () => [FILE] }), SettingsAclError);
});

test("the agent user with (AD) on security.json, DC on the folder, or modify on personas is refused", () => {
  let l = good();
  l[paths.securityFile] = [...BASE, `HOST\\${AGENT}:(R,AD)`];
  assert.match(check(l).join("\n"), /security\.json.*AD/);
  l = good();
  l[paths.settingsDir] = [...BASE, `HOST\\${AGENT}:(OI)(CI)(RX,DC)`];
  assert.match(check(l).join("\n"), /settings folder.*DC/);
  l = good();
  l[paths.userPersonasDir] = [...BASE, `HOST\\${AGENT}:(OI)(CI)(M)`];
  assert.match(check(l).join("\n"), /personas folder.*M/);
});

test("Users, Authenticated Users and Everyone may not write under settings", () => {
  for (const who of ["BUILTIN\\Users", "NT AUTHORITY\\Authenticated Users", "Everyone"]) {
    const l = good();
    l[paths.settingsDir] = [...BASE, `HOST\\${AGENT}:(OI)(CI)(RX)`, `${who}:(OI)(CI)(M)`];
    assert.match(check(l).join("\n"), new RegExp(`${who.replace("\\", "\\\\")}.* has write access`), who);
    const r = good();
    r[paths.settingsDir] = [...BASE, `HOST\\${AGENT}:(OI)(CI)(RX)`, `${who}:(OI)(CI)(RX)`];
    assert.deepEqual(check(r), [], `${who} may read`);
  }
});

test("the audit files: write-data, delete or re-ACL for the agent is refused; the folder may not allow delete or change-permissions", () => {
  let l = good();
  l[FILE] = [...BASE, `HOST\\${AGENT}:(R,WD,AD)`];
  assert.match(check(l).join("\n"), /audit file.*WD/);
  l = good();
  l[FILE] = [...BASE, `HOST\\${AGENT}:(F)`];
  assert.match(check(l).join("\n"), /audit file.*F/);
  l = good();
  l[paths.auditDir] = [...BASE, `HOST\\${AGENT}:(CI)(R,WD,DC)`];
  assert.match(check(l).join("\n"), /audit folder.*DC/);
  l = good();
  l[paths.auditDir] = [...BASE, `HOST\\${AGENT}:(CI)(R,WD,WDAC)`];
  assert.match(check(l).join("\n"), /audit folder.*WDAC/);
});

test("an unreadable ACL is a problem, and a Deny entry is not a grant", () => {
  const l = good();
  assert.match(checkSettingsAcl({ paths, agentUser: AGENT, icacls: () => "", listAuditFiles: () => [] }).join("\n"), /no ACL entries/);
  assert.match(checkSettingsAcl({ paths, agentUser: AGENT, icacls: () => { throw new Error("Access is denied."); }, listAuditFiles: () => [] }).join("\n"), /cannot check the ACL/);
  const entries = parseIcacls(out(paths.securityFile, [...BASE, `HOST\\${AGENT}:(DENY)(W)`]), paths.securityFile);
  assert.deepEqual(aclProblems(entries, AGENT, "security.json", new Set(["W"])), []);
  void l;
});
