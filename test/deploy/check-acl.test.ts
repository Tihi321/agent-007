/**
 * S7.3 done-check: check-acl.ps1 is read-only and exits 1 on a violation of plan section 4.2, 0 on a compliant layout.
 * The fixtures are folders under .claude/temp whose ACLs this test sets with icacls; the "agent user" is the current user.
 * No real install path, drive root or Strata folder is changed.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEPLOY, HAS_WINDOWS_POWERSHELL, icacls, makeFixture, makeStrataRepo, protect, runDeploy, whoami, type Fixture } from "./_fixture.js";

const skip = HAS_WINDOWS_POWERSHELL ? false : "Windows PowerShell is not available";

/** A fixture tree that satisfies section 4.2, with the current user standing in for the agent user. */
function buildCompliant(fx: Fixture, me: string, strata: boolean): void {
  writeFileSync(fx.secretsFile, '{"telegramBotToken":"fixture-not-a-secret"}');
  protect(fx.configDir, me, "R");
  protect(fx.secretsDir, me, "R");
  protect(fx.secretsFile, me, "R");
  protect(fx.data, me, "F");
  protect(fx.pf, me, "RX");
  protect(fx.allow, me, "RX");
  for (const d of [fx.deny, fx.lmstudio]) icacls(d, "/deny", `${me}:(OI)(CI)(RD)`);
  if (strata) {
    mkdirSync(fx.strataDir, { recursive: true });
    mkdirSync(fx.strataLog, { recursive: true });
    writeFileSync(fx.strataConfig, '{"api_key":"fixture-not-a-secret"}');
    protect(fx.strataDir, me, "R");
    protect(fx.strataConfig, me, "R");
    protect(fx.strataLog, me, "M");
    protect(fx.strataInstall, me, "RX");
    protect(fx.strataData, me, "RX");
  }
}

function check(fx: Fixture, me: string) {
  return runDeploy("check-acl.ps1", ["-ConfigPath", fx.configPath, "-AgentUser", me, "-ProgramFilesDir", fx.pf]);
}

function aclText(fx: Fixture, extra: string[] = []): string {
  return [fx.configDir, fx.secretsDir, fx.secretsFile, fx.data, fx.pf, fx.allow, fx.deny, fx.lmstudio, ...extra].map((p) => `${p}\n${icacls(p)}`).join("\n");
}

test("S7.3 a compliant layout exits 0 and the report names the checks; the run changes no ACL", { skip }, () => {
  const fx = makeFixture();
  const me = whoami();
  try {
    buildCompliant(fx, me, false);
    const before = aclText(fx);
    const r = check(fx, me);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /RESULT: OK, no violations/);
    assert.match(r.stdout, /ALLOW\s+.*allow : agent read=True write=False/);
    assert.match(r.stdout, /DENY\(a\)\s+.*\.lmstudio : agent read=False/);
    assert.match(r.stdout, /SECRET\s+secrets\.json/);
    assert.match(r.stdout, /GROUP\(b\)\s+config dir/);
    assert.match(r.stdout, /SKIP\s+Strata paths \(model\.runner is not strata\)/);
    assert.match(r.stdout, /Drive roots and ambient group rights/);
    assert.equal(aclText(fx), before, "check-acl.ps1 changed an ACL");
  } finally {
    fx.cleanup();
  }
});

test("S7.3 secrets.json open to Users: exit 1, and the offending ACE is named", { skip }, () => {
  const fx = makeFixture();
  const me = whoami();
  try {
    buildCompliant(fx, me, false);
    icacls(fx.secretsFile, "/grant", "*S-1-5-32-545:R");
    const r = check(fx, me);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /VIOLATION\s+.*secrets\.json : secrets\.json is open to a broad group: BUILTIN\\Users:\(Allow\)\(/);
    assert.match(r.stdout, /RESULT: FAIL/);
  } finally {
    fx.cleanup();
  }
});

test("S7.3 secrets.json with Everyone, with Authenticated Users, with an extra principal, or with inherited ACEs: exit 1", { skip }, () => {
  const cases: [string, (fx: Fixture) => void, RegExp][] = [
    ["Everyone", (fx) => icacls(fx.secretsFile, "/grant", "*S-1-1-0:R"), /open to a broad group: Everyone:/],
    ["Authenticated Users", (fx) => icacls(fx.secretsFile, "/grant", "*S-1-5-11:R"), /open to a broad group: NT AUTHORITY\\Authenticated Users:/],
    ["an extra principal", (fx) => icacls(fx.secretsFile, "/grant", "*S-1-5-32-551:R"), /unexpected principal: BUILTIN\\Backup Operators:/],
    ["inheritance re-enabled", (fx) => icacls(fx.secretsFile, "/reset"), /has an inherited ACE/],
  ];
  const me = whoami();
  for (const [label, mutate, expected] of cases) {
    const fx = makeFixture();
    try {
      buildCompliant(fx, me, false);
      mutate(fx);
      const r = check(fx, me);
      assert.equal(r.status, 1, `${label}\n${r.all}`);
      assert.match(r.stdout, expected, label);
    } finally {
      fx.cleanup();
    }
  }
});

test("S7.3 a Deny Read on a group (b) path (the agent data root) is a violation", { skip }, () => {
  const fx = makeFixture();
  const me = whoami();
  try {
    buildCompliant(fx, me, false);
    icacls(fx.data, "/deny", `${me}:(OI)(CI)(RD)`);
    const r = check(fx, me);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /VIOLATION\s+.*: group \(b\) path has a Deny Read ACE that applies to the agent user/);
  } finally {
    fx.cleanup();
  }
});

test("S7.3 a group (a) path with no Deny Read, a writable Program Files, and a missing allow grant are violations", { skip }, () => {
  const me = whoami();
  const cases: [string, (fx: Fixture) => void, RegExp][] = [
    ["no Deny on a group (a) path", (fx) => icacls(fx.deny, "/remove:d", me), /group \(a\) path has NO Deny Read ACE/],
    ["agent can write its code", (fx) => icacls(fx.pf, "/grant", `${me}:(OI)(CI)M`), /can write its own code/],
    ["agent can write its config", (fx) => icacls(fx.configDir, "/grant", `${me}:(OI)(CI)M`), /can write here \(expected read only\)/],
    ["allowed folder unreadable", (fx) => icacls(fx.allow, "/remove:g", me), /cannot read this allowed folder/],
  ];
  for (const [label, mutate, expected] of cases) {
    const fx = makeFixture();
    try {
      buildCompliant(fx, me, false);
      mutate(fx);
      const r = check(fx, me);
      assert.equal(r.status, 1, `${label}\n${r.all}`);
      assert.match(r.stdout, expected, label);
    } finally {
      fx.cleanup();
    }
  }
});

test("S7.3 with runner strata the Strata paths and config copy are checked; without it they are skipped", { skip }, () => {
  const me = whoami();
  const fx = makeFixture({ runner: "strata" });
  try {
    makeStrataRepo(fx);
    buildCompliant(fx, me, true);
    const r = check(fx, me);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /SECRET\s+Strata config copy/);
    for (const label of ["Strata install", "Strata data", "Strata config folder", "Strata log dir"]) assert.match(r.stdout, new RegExp(`GROUP\\(b\\)\\s+${label}`));

    icacls(fx.strataData, "/grant", `${me}:(OI)(CI)M`);
    let r2 = check(fx, me);
    assert.equal(r2.status, 1, r2.all);
    assert.match(r2.stdout, /the agent user can write here \(expected read only\)/);
    icacls(fx.strataData, "/remove:g", me);
    icacls(fx.strataData, "/grant", `${me}:(OI)(CI)RX`);

    icacls(fx.strataInstall, "/deny", `${me}:(OI)(CI)(RD)`);
    r2 = check(fx, me);
    assert.equal(r2.status, 1, r2.all);
    assert.match(r2.stdout, /group \(b\) path has a Deny Read ACE/);
    icacls(fx.strataInstall, "/remove:d", me);

    icacls(fx.strataConfig, "/grant", "*S-1-5-32-545:R");
    r2 = check(fx, me);
    assert.equal(r2.status, 1, r2.all);
    assert.match(r2.stdout, /Strata config copy is open to a broad group/);
    icacls(fx.strataConfig, "/remove:g", "*S-1-5-32-545");

    icacls(fx.strataLog, "/remove:g", me);
    icacls(fx.strataLog, "/grant", `${me}:(OI)(CI)RX`);
    r2 = check(fx, me);
    assert.equal(r2.status, 1, r2.all);
    assert.match(r2.stdout, /cannot write here \(modify is needed\)/);
  } finally {
    fx.cleanup();
  }
});

test("S7.3 a missing secrets file is a warning (not created yet), not a violation", { skip }, () => {
  const fx = makeFixture();
  const me = whoami();
  try {
    buildCompliant(fx, me, false);
    // let the test remove the file it created: reset the file's ACL and give the folder delete rights
    icacls(fx.secretsFile, "/reset");
    icacls(fx.secretsDir, "/grant", `${me}:(OI)(CI)F`);
    rmSync(fx.secretsFile, { force: true });
    icacls(fx.secretsDir, "/remove:g", me);
    icacls(fx.secretsDir, "/grant", `${me}:(OI)(CI)R`);
    const r = check(fx, me);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /WARN\s+.*secrets\.json : secrets\.json does not exist yet/);
  } finally {
    fx.cleanup();
  }
});
// ---- S9.4: the Phase 2 job runner folder and the Phase 3 settings folders ---------------------------

const SYSTEM_ADMIN_FULL = ["*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"];

/** `<pd>\jobrunner` with no ACE for the agent (the current user stands in for it) and `templates\` readable: section 4.2. */
function buildJobRunner(fx: Fixture, me: string): { jr: string; templates: string } {
  const jr = join(fx.pd, "jobrunner");
  const templates = join(jr, "templates");
  mkdirSync(templates, { recursive: true });
  writeFileSync(join(templates, "tts-line.json"), "{}");
  protect(templates, me, "RX");
  icacls(jr, "/inheritance:r", "/grant:r", ...SYSTEM_ADMIN_FULL);
  return { jr, templates };
}

/** `<pd>\settings`: R for the agent, security.json R, and `audit\` append only. */
function buildSettings(fx: Fixture, me: string): { settings: string; security: string; audit: string } {
  const settings = join(fx.pd, "settings");
  const audit = join(settings, "audit");
  const security = join(settings, "security.json");
  mkdirSync(audit, { recursive: true });
  writeFileSync(security, "{}");
  protect(security, me, "R");
  icacls(audit, "/inheritance:r", "/grant:r", `${me}:(RX,WD)`, `${me}:(OI)(IO)(RX,AD)`, "*S-1-3-4:(OI)(IO)(R,AD)", ...SYSTEM_ADMIN_FULL);
  protect(settings, me, "R");
  return { settings, security, audit };
}

test("S9.4 a missing jobrunner\ and settings\ are SKIPs (a Phase 1 install has neither), not violations", { skip }, () => {
  const fx = makeFixture();
  const me = whoami();
  try {
    buildCompliant(fx, me, false);
    const r = check(fx, me);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /SKIP\s+.*jobrunner does not exist \(the job runner is not installed yet\)/);
    assert.match(r.stdout, /SKIP\s+.*settings does not exist \(Phase 3 settings are not installed\)/);
  } finally {
    fx.cleanup();
  }
});

test("S9.4 a compliant jobrunner\ (agent: nothing on the folder, R on templates\ only) and settings\ exit 0 and are reported", { skip }, () => {
  const fx = makeFixture();
  const me = whoami();
  try {
    buildCompliant(fx, me, false);
    const { jr, templates } = buildJobRunner(fx, me);
    const { settings, audit } = buildSettings(fx, me);
    const before = [jr, templates, settings, audit].map((p) => `${p}\n${icacls(p)}`).join("\n");
    const r = check(fx, me);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /JOBRUNNER\s+.*jobrunner : agent read=False write=False/);
    assert.match(r.stdout, /JOBRUNNER\s+.*templates : agent read=True write=False/);
    assert.match(r.stdout, /SETTINGS\s+.*settings : agent read=True write=False/);
    assert.match(r.stdout, /SETTINGS\s+.*audit : agent read=True write=True/, "append counts as write in the report line");
    assert.equal([jr, templates, settings, audit].map((p) => `${p}\n${icacls(p)}`).join("\n"), before, "check-acl.ps1 changed an ACL");
  } finally {
    fx.cleanup();
  }
});

test("S9.4 jobrunner\ violations: agent access to the folder, inheritance on, a broad group, writable or unreadable templates\\", { skip }, () => {
  const me = whoami();
  const cases: [string, (jr: string, templates: string) => void, RegExp][] = [
    ["agent can read the job runner folder", (jr) => icacls(jr, "/grant", `${me}:(OI)(CI)R`), /the agent user has access to the job runner folder/],
    ["agent can write the job runner folder", (jr) => icacls(jr, "/grant", `${me}:(OI)(CI)M`), /the agent user has access to the job runner folder/],
    ["Users can read the job runner folder", (jr) => icacls(jr, "/grant", "*S-1-5-32-545:(OI)(CI)R"), /job runner folder is open to a broad group/],
    ["inheritance on", (jr) => icacls(jr, "/inheritance:e"), /job runner folder has inheritance on/],
    ["templates writable", (_jr, t) => icacls(t, "/grant", `${me}:(OI)(CI)M`), /the agent user can write the job templates/],
    ["templates unreadable (Deny Read)", (_jr, t) => icacls(t, "/deny", `${me}:(OI)(CI)(RD)`), /templates folder has a Deny Read that applies to the agent user/],
  ];
  for (const [label, mutate, expected] of cases) {
    const fx = makeFixture();
    try {
      buildCompliant(fx, me, false);
      const { jr, templates } = buildJobRunner(fx, me);
      mutate(jr, templates);
      const r = check(fx, me);
      assert.equal(r.status, 1, `${label}\n${r.all}`);
      assert.match(r.stdout, expected, label);
    } finally {
      fx.cleanup();
    }
  }
});

test("S9.4 settings\ violations: writable settings folder or security.json, an audit log the agent can overwrite, inheritance on", { skip }, () => {
  const me = whoami();
  const cases: [string, (s: { settings: string; security: string; audit: string }) => void, RegExp][] = [
    ["settings folder writable", (s) => icacls(s.settings, "/grant", `${me}:(OI)(CI)M`), /the agent user can write the settings folder/],
    ["security.json writable", (s) => icacls(s.security, "/grant", `${me}:M`), /the agent user can write security\.json/],
    ["security.json unreadable", (s) => icacls(s.security, "/remove:g", me), /the agent user cannot read security\.json/],
    ["audit overwritable", (s) => icacls(s.audit, "/grant", `${me}:(OI)(CI)M`), /the agent user can delete in the audit folder/],
    ["inheritance on", (s) => icacls(s.settings, "/inheritance:e"), /settings folder has inheritance on/],
  ];
  for (const [label, mutate, expected] of cases) {
    const fx = makeFixture();
    try {
      buildCompliant(fx, me, false);
      mutate(buildSettings(fx, me));
      const r = check(fx, me);
      assert.equal(r.status, 1, `${label}\n${r.all}`);
      assert.match(r.stdout, expected, label);
    } finally {
      fx.cleanup();
    }
  }
});

test("S9.4 an audit folder with no append right for the agent is a warning (U48), not a violation", { skip }, () => {
  const fx = makeFixture();
  const me = whoami();
  try {
    buildCompliant(fx, me, false);
    const { audit } = buildSettings(fx, me);
    icacls(audit, "/remove:g", me);
    icacls(audit, "/grant", `${me}:(OI)(CI)RX`, "*S-1-3-4:(OI)(IO)(R,AD)");
    const r = check(fx, me);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /WARN\s+.*audit : .*no append right/);
  } finally {
    fx.cleanup();
  }
});

// ---- Phase 4 (S20.3, I43): the shared folder ----------------------------------------------------------

/** `<pd>\shared` with FACTS.md and skills\, the agent user standing in as `me` with read only. */
function buildShared(fx: Fixture, me: string): { dir: string; facts: string; skills: string } {
  const dir = join(fx.pd, "shared");
  const skills = join(dir, "skills");
  const facts = join(dir, "FACTS.md");
  mkdirSync(skills, { recursive: true });
  writeFileSync(facts, "shared facts");
  writeFileSync(join(skills, "s1.md"), "a shared skill");
  protect(dir, me, "RX");
  protect(skills, me, "RX");
  protect(facts, me, "R");
  return { dir, facts, skills };
}

test("S20.3 a missing shared folder is a SKIP; a shared folder the agent can only read is compliant", { skip }, () => {
  const fx = makeFixture();
  const me = whoami();
  try {
    buildCompliant(fx, me, false);
    let r = check(fx, me);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /SKIP\s+.*shared does not exist \(no shared facts or skills\)/);
    buildShared(fx, me);
    r = check(fx, me);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /SHARED\s+.*shared : agent read=True write=False/);
    assert.match(r.stdout, /SHARED\s+.*FACTS\.md : agent read=True write=False/);
    assert.match(r.stdout, /SHARED\s+.*skills : agent read=True write=False/);
    assert.match(r.stdout, /RESULT: OK, no violations/);
  } finally {
    fx.cleanup();
  }
});

test("S20.3 shared, FACTS.md or the shared skills writable by the agent user is a violation", { skip }, () => {
  const me = whoami();
  const cases: [string, (s: { dir: string; facts: string; skills: string }) => void, RegExp][] = [
    ["the shared folder", (s) => icacls(s.dir, "/grant", `${me}:(OI)(CI)M`), /VIOLATION\s+.*shared : the agent user can write the shared folder \(expected read only/],
    ["FACTS.md", (s) => icacls(s.facts, "/grant", `${me}:M`), /VIOLATION\s+.*FACTS\.md : the agent user can write the shared FACTS\.md/],
    ["the shared skills", (s) => icacls(s.skills, "/grant", `${me}:(OI)(CI)M`), /VIOLATION\s+.*skills : the agent user can write the shared skills folder/],
    ["Users can write the shared folder", (s) => icacls(s.dir, "/grant", "*S-1-5-32-545:(OI)(CI)M"), /VIOLATION\s+.*shared : the agent user can write the shared folder/],
  ];
  for (const [label, mutate, expected] of cases) {
    const fx = makeFixture();
    try {
      buildCompliant(fx, me, false);
      mutate(buildShared(fx, me));
      const r = check(fx, me);
      assert.equal(r.status, 1, `${label}\n${r.all}`);
      assert.match(r.stdout, expected, label);
      assert.match(r.stdout, /RESULT: FAIL/);
    } finally {
      fx.cleanup();
    }
  }
});

test("S20.3 the new check only reads: check-acl.ps1 still loads no ACL-writing script and calls no setter", () => {
  const text = readFileSync(join(DEPLOY, "check-acl.ps1"), "utf8");
  const code = text.replace(/<#[\s\S]*?#>/g, "");
  assert.doesNotMatch(code, /acl-write\.ps1/);
  assert.doesNotMatch(code, /Set-Acl|SetAccessControl|icacls|Set-ExactAcl/i);
  assert.match(text, /5c\. Phase 4: the shared folder/);
});
