import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { SettingsError } from "../../src/settings/contracts.js";
import { readAuditTail } from "../../src/settings/audit.js";
import { ABSENT_REVISION, revisionOf } from "../../src/settings/store.js";
import type { ReplaceFs } from "../../src/settings/store.js";
import { readJson } from "../settings/helpers.js";
import { draft } from "../settings/helpers.js";
import { readSecurity, signIn, startRig } from "./helpers.js";
import type { UiRig, Session } from "./helpers.js";

async function current(s: Session): Promise<{ doc: Record<string, any>; revision: string }> {
  const r = await s.get("/api/security");
  assert.equal(r.status, 200);
  return r.json() as never;
}

const tmpFiles = (rig: UiRig): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      if (n.isDirectory()) walk(join(d, n.name));
      else if (n.name.endsWith(".tmp")) out.push(join(d, n.name));
    }
  };
  walk(rig.dir);
  return out;
};

test("a valid save writes the new security.json and exactly one source:ui audit line with the diff, both revisions and the session hash (never the cookie)", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const { doc, revision } = await current(s);
    const res = await s.post("/api/security/save", { formId: "shell", sections: { shell: { ...doc["shell"], approvalTimeoutSec: 300 } }, baseRevision: revision });
    assert.equal(res.status, 200, res.text);
    const body = res.json() as { revision: string; restartRequired: boolean };
    assert.equal(body.restartRequired, true);
    const after = readSecurity(rig);
    assert.equal(after.doc["shell"].approvalTimeoutSec, 300);
    assert.equal(body.revision, revisionOf(after.text));
    const lines = readAuditTail(rig.paths.auditDir, 20);
    assert.equal(lines.length, 1);
    const l = lines[0]!;
    assert.equal(l.source, "ui");
    assert.equal(l.kind, "security");
    assert.equal(l.writer, "jobrunner");
    assert.deepEqual(l.target, { file: "security.json", path: "shell" });
    assert.deepEqual(l.diff, [{ path: "shell.approvalTimeoutSec", op: "replace", before: 600, after: 300 }]);
    assert.equal(l.baseRevision, revision);
    assert.equal(l.afterRevision, body.revision);
    assert.equal(l.approver?.kind, "ui");
    assert.match(l.approver?.sessionHash ?? "", /^[0-9a-f]{16}$/);
    const log = readFileSync(join(rig.paths.auditDir, readdirSync(rig.paths.auditDir)[0] as string), "utf8");
    assert.ok(!log.includes(s.cookie.split("=")[1] as string), "the cookie never reaches the log");
    assert.ok(!log.includes(s.csrf), "nor the CSRF token");
    assert.deepEqual(tmpFiles(rig), []);
  } finally {
    await rig.cleanup();
  }
});

test("a validation failure leaves file and log unchanged (the loader's refusals: non-loopback URL, missing folder, duplicate alias, empty allowlist)", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const { doc, revision } = await current(s);
    const before = readSecurity(rig).text;
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["model", { ...doc["model"], runners: { lmstudio: { ...doc["model"].runners.lmstudio, baseUrl: "http://192.168.1.5:1234/v1" } } }, /loopback/],
      ["folders", { ...doc["folders"], allow: [{ alias: "gone", path: "C:\\definitely\\not\\here\\a7" }] }, /does not exist or is not a folder/],
      ["folders", { ...doc["folders"], allow: [...doc["folders"].allow, { alias: "NOTES", path: rig.notes }] }, /duplicate alias/],
      ["folders", { ...doc["folders"], allow: [] }, /at least 1|empty/],
      ["shell", { ...doc["shell"], enabled: "yes" }, /true or false/],
      ["shell", { ...doc["shell"], surprise: 1 }, /not a known setting/],
    ];
    for (const [section, value, re] of cases) {
      const r = await s.post("/api/security/save", { sections: { [section]: value }, baseRevision: revision });
      assert.equal(r.status, 422, `${section}: ${r.text}`);
      assert.match((r.json()["issues"] as string[]).join("\n"), re);
    }
    assert.equal(readSecurity(rig).text, before);
    assert.deepEqual(readdirSync(rig.paths.auditDir), []);
    assert.deepEqual(tmpFiles(rig), []);
    assert.equal((await s.post("/api/security/save", { section: "schemaVersion", value: 1, baseRevision: revision })).status, 400, "schemaVersion is not a section");
    assert.equal((await s.post("/api/security/save", { section: "paths", value: {}, baseRevision: revision })).status, 400, "paths is not a section of security.json");
    assert.equal((await s.post("/api/security/save", { section: "__proto__", value: {}, baseRevision: revision })).status, 400);
  } finally {
    await rig.cleanup();
  }
});

test("an audit-append failure leaves the file unchanged and no temp file behind", async () => {
  const failing = {
    append() {
      throw new SettingsError("audit_failed", "disk full");
    },
  };
  const rig = await startRig({ audit: failing });
  try {
    const s = await signIn(rig);
    const { doc, revision } = await current(s);
    const before = readSecurity(rig).text;
    const r = await s.post("/api/security/save", { sections: { shell: { ...doc["shell"], enabled: false } }, baseRevision: revision });
    assert.equal(r.status, 500);
    assert.equal(r.json()["error"], "audit_failed");
    assert.equal(readSecurity(rig).text, before);
    assert.deepEqual(tmpFiles(rig), []);
  } finally {
    await rig.cleanup();
  }
});

test("a rename failure leaves the file unchanged and adds exactly one apply_failed line; the temp file is gone", async () => {
  const fs: ReplaceFs = {
    readText: (f) => (existsSync(f) ? readFileSync(f, "utf8") : undefined),
    writeText: (f, t) => writeFileSync(f, t, { flag: "wx" }),
    rename: () => {
      throw Object.assign(new Error("locked"), { code: "EBUSY" });
    },
    remove: (f) => rmSync(f, { force: true }),
  };
  const rig = await startRig({ replaceFs: fs });
  try {
    const s = await signIn(rig);
    const { doc, revision } = await current(s);
    const before = readSecurity(rig).text;
    const r = await s.post("/api/security/save", { sections: { shell: { ...doc["shell"], enabled: false } }, baseRevision: revision });
    assert.equal(r.status, 500);
    assert.equal(r.json()["error"], "apply_failed");
    assert.equal(readSecurity(rig).text, before);
    assert.deepEqual(tmpFiles(rig), []);
    const decisions = readAuditTail(rig.paths.auditDir, 10).map((l) => l.decision);
    assert.equal(decisions.filter((d) => d === "apply_failed").length, 1);
    assert.deepEqual(decisions, ["applied", "apply_failed"], "the intended change, then the failure");
  } finally {
    await rig.cleanup();
  }
});

test("a stale baseRevision gets 409 and changes nothing; the first of two concurrent edits wins", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const { doc, revision } = await current(s);
    const before = readSecurity(rig).text;
    const stale = await s.post("/api/security/save", { sections: { shell: { ...doc["shell"], enabled: false } }, baseRevision: "0".repeat(64) });
    assert.equal(stale.status, 409);
    assert.equal(stale.json()["error"], "stale");
    assert.equal(readSecurity(rig).text, before);
    assert.deepEqual(readdirSync(rig.paths.auditDir), []);
    const first = await s.post("/api/security/save", { sections: { limits: { ...doc["limits"], readFileBytes: 4096 } }, baseRevision: revision });
    assert.equal(first.status, 200);
    const second = await s.post("/api/security/save", { sections: { limits: { ...doc["limits"], readFileBytes: 8192 } }, baseRevision: revision });
    assert.equal(second.status, 409, "the second one still used the old revision");
    assert.equal(readSecurity(rig).doc["limits"].readFileBytes, 4096);
  } finally {
    await rig.cleanup();
  }
});

test("a template with bypassPermissions or no shell-tool removal is refused; a valid one is saved, audited and reloaded", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const list = (await s.get("/api/templates")).json() as { items: { file: string; doc: Record<string, any>; revision: string; errors: string[] }[] };
    const item = list.items.find((i) => i.file === "list-runs.json")!;
    assert.deepEqual(item.errors, []);
    const bad = await s.post("/api/templates/save", { doc: { ...item.doc, permissionMode: "bypassPermissions" }, baseRevision: item.revision });
    assert.equal(bad.status, 422);
    assert.match((bad.json()["issues"] as string[]).join("\n"), /permissionMode|bypass/i);
    const noShellBan = await s.post("/api/templates/save", { doc: { ...item.doc, disallowedTools: [] }, baseRevision: item.revision });
    assert.equal(noShellBan.status, 422);
    assert.equal(rig.reloaded.n, 0);
    const ok = await s.post("/api/templates/save", { doc: { ...item.doc, title: "List the runs (edited)" }, baseRevision: item.revision });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(readJson(join(rig.paths.templatesDir, "list-runs.json"))["title"], "List the runs (edited)");
    assert.equal(rig.reloaded.n, 1);
    const l = readAuditTail(rig.paths.auditDir, 5).at(-1)!;
    assert.equal(l.kind, "template");
    assert.equal(l.target.file, "templates/list-runs.json");
    assert.equal(l.source, "ui");
    assert.deepEqual(tmpFiles(rig), []);
    const stale = await s.post("/api/templates/save", { doc: { ...item.doc, title: "again" }, baseRevision: item.revision });
    assert.equal(stale.status, 409);
  } finally {
    await rig.cleanup();
  }
});

test("personas: one over the ceiling is refused, a valid one lands in settings/personas and is audited, a built-in id is refused", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const over = await s.post("/api/personas/save", { persona: draft({ toolAllow: ["read_file", "teleport"], modelPreset: "lmstudio" }), baseRevision: ABSENT_REVISION });
    assert.equal(over.status, 422);
    assert.match((over.json()["issues"] as string[]).join("\n"), /not a known tool/);
    const preset = await s.post("/api/personas/save", { persona: draft({ modelPreset: "gpt-cloud" }), baseRevision: ABSENT_REVISION });
    assert.equal(preset.status, 422);
    assert.match((preset.json()["issues"] as string[]).join("\n"), /model preset/);
    const builtin = await s.post("/api/personas/save", { persona: draft({ id: "readonly" }), baseRevision: ABSENT_REVISION });
    assert.equal(builtin.status, 422);
    const malformed = await s.post("/api/personas/save", { persona: { id: "x" }, baseRevision: ABSENT_REVISION });
    assert.equal(malformed.status, 422);
    assert.deepEqual(readdirSync(rig.paths.personasDir), []);
    const ok = await s.post("/api/personas/save", { persona: draft(), baseRevision: ABSENT_REVISION });
    assert.equal(ok.status, 200, ok.text);
    const file = join(rig.paths.personasDir, "research.json");
    assert.equal(readJson(file)["id"], "research");
    const l = readAuditTail(rig.paths.auditDir, 5).at(-1)!;
    assert.equal(l.kind, "persona");
    assert.equal(l.persona, "research");
    assert.equal(l.target.file, "personas/research.json");
    const list = (await s.get("/api/personas")).json() as { personas: { id: string; valid: boolean; revision: string }[]; ceiling: { tools: string[] } };
    assert.deepEqual(list.personas.map((p) => [p.id, p.valid]), [["research", true]]);
    assert.ok(list.ceiling.tools.includes("read_file"));
    const again = await s.post("/api/personas/save", { persona: draft({ name: "Research 2" }), baseRevision: ABSENT_REVISION });
    assert.equal(again.status, 409, "an existing persona needs its current revision");
    const del = await s.post("/api/personas/delete", { id: "research", baseRevision: list.personas[0]!.revision });
    assert.equal(del.status, 200);
    assert.equal(existsSync(file), false);
    assert.equal(readAuditTail(rig.paths.auditDir, 5).at(-1)?.target.file, "personas/research.json");
    assert.equal((await s.post("/api/personas/delete", { id: "../x", baseRevision: "a" })).status, 400);
  } finally {
    await rig.cleanup();
  }
});

test("preview: names a persona that would become invalid, and a new folder that lacks an NTFS grant; it never blocks a save", async () => {
  const rig = await startRig({ folderGrant: (p) => (p.includes("granted") ? "granted" : "missing") });
  try {
    const s = await signIn(rig);
    assert.equal((await s.post("/api/personas/save", { persona: draft({ id: "ops", toolAllow: ["shell", "read_file"] }), baseRevision: ABSENT_REVISION })).status, 200);
    const { doc, revision } = await current(s);
    const pre = await s.post("/api/security/preview", { sections: { shell: { ...doc["shell"], enabled: false } } });
    assert.equal(pre.status, 200);
    const p = pre.json() as { valid: boolean; invalidPersonas: { id: string; reasons: string[] }[]; folderWarnings: string[] };
    assert.equal(p.valid, true);
    assert.deepEqual(p.invalidPersonas.map((x) => x.id), ["ops"]);
    assert.match(p.invalidPersonas[0]!.reasons.join(), /shell is turned off/);
    const f = await s.post("/api/security/preview", { sections: { folders: { ...doc["folders"], allow: [...doc["folders"].allow, { alias: "newone", path: rig.notes }] } } });
    // rig.notes is already allowed under the alias "notes", so only a different path counts as new
    assert.equal((f.json() as { folderWarnings: string[] }).folderWarnings.length, 0);
    const extra = join(rig.dir, "docs");
    mkdirSync(extra, { recursive: true });
    const g = await s.post("/api/security/preview", { sections: { folders: { ...doc["folders"], allow: [...doc["folders"].allow, { alias: "docs", path: extra }] } } });
    const warnings = (g.json() as { folderWarnings: string[] }).folderWarnings;
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /grant-folder-acls\.ps1/);
    // the preview changed nothing, and the save is not blocked by it
    assert.deepEqual(readAuditTail(rig.paths.auditDir, 10).map((l) => l.target.file), ["personas/ops.json"]);
    const save = await s.post("/api/security/save", { sections: { shell: { ...doc["shell"], enabled: false } }, baseRevision: revision });
    assert.equal(save.status, 200, "a save is never blocked by the preview");
    const status = (await s.get("/api/status")).json() as { invalidPersonas: { id: string }[] };
    assert.deepEqual(status.invalidPersonas.map((x) => x.id), ["ops"], "the status lists it too");
  } finally {
    await rig.cleanup();
  }
});

test("jobs form: the job runner limits go to jobrunner.json (limits only, other keys kept), same protocol and audit line", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const got = (await s.get("/api/jobrunner")).json() as { doc: { limits: Record<string, any> }; revision: string };
    assert.equal(got.doc.limits.dailyJobCap, 20);
    const bad = await s.post("/api/jobrunner/save", { limits: { ...got.doc.limits, dailyJobCap: -1 }, baseRevision: got.revision });
    assert.equal(bad.status, 422);
    const ok = await s.post("/api/jobrunner/save", { limits: { ...got.doc.limits, dailyJobCap: 7 }, baseRevision: got.revision });
    assert.equal(ok.status, 200, ok.text);
    const raw = readJson(rig.paths.jobrunnerFile);
    assert.equal((raw["limits"] as Record<string, number>)["dailyJobCap"], 7);
    assert.equal(raw["_comment"], "kept");
    assert.equal(raw["ipcPort"], 47007);
    const l = readAuditTail(rig.paths.auditDir, 5).at(-1)!;
    assert.equal(l.target.file, "jobrunner.json");
    assert.equal(l.source, "ui");
    assert.equal((await s.post("/api/jobrunner/save", { limits: got.doc.limits, baseRevision: got.revision })).status, 409);
    assert.deepEqual(tmpFiles(rig), []);
  } finally {
    await rig.cleanup();
  }
});

test("no route writes outside settings/, jobrunner/templates/ and jobrunner.json (a fake-fs spy on every replace, plus a walk of the tree)", async () => {
  const renames: string[] = [];
  const fs: ReplaceFs = {
    readText: (f) => (existsSync(f) ? readFileSync(f, "utf8") : undefined),
    writeText: (f, t) => writeFileSync(f, t, { flag: "wx" }),
    rename: (from, to) => {
      renames.push(to);
      renameSync(from, to);
    },
    remove: (f) => rmSync(f, { force: true }),
  };
  const rig = await startRig({ replaceFs: fs });
  try {
    const s = await signIn(rig);
    const { doc, revision } = await current(s);
    const before = new Set<string>();
    const walk = (d: string, into: Set<string>): void => {
      for (const n of readdirSync(d, { withFileTypes: true })) (n.isDirectory() ? walk(join(d, n.name), into) : into.add(join(d, n.name)));
    };
    walk(rig.dir, before);
    await s.post("/api/security/save", { sections: { limits: { ...doc["limits"], readFileBytes: 4096 } }, baseRevision: revision });
    await s.post("/api/personas/save", { persona: draft(), baseRevision: ABSENT_REVISION });
    const t = (await s.get("/api/templates")).json() as { items: { doc: Record<string, unknown>; revision: string }[] };
    await s.post("/api/templates/save", { doc: { ...t.items[0]!.doc, title: "x" }, baseRevision: t.items[0]!.revision });
    const jr = (await s.get("/api/jobrunner")).json() as { doc: { limits: Record<string, unknown> }; revision: string };
    await s.post("/api/jobrunner/save", { limits: { ...jr.doc.limits, dailyJobCap: 3 }, baseRevision: jr.revision });
    assert.equal(renames.length, 4);
    const allowed = [rig.paths.settingsDir, rig.paths.templatesDir, rig.paths.jobrunnerFile].map((p) => p.toLowerCase());
    for (const to of renames) assert.ok(allowed.some((a) => to.toLowerCase().startsWith(a)), `${to} is an allowed target`);
    const after = new Set<string>();
    walk(rig.dir, after);
    for (const f of after) {
      if (before.has(f)) continue;
      assert.ok(allowed.some((a) => f.toLowerCase().startsWith(a)), `new file ${relative(rig.dir, f)} is under an allowed folder`);
    }
    for (const f of before) assert.ok(statSync(f).isFile());
    assert.ok(!existsSync(join(rig.dir, "data", "prefs")), "the agent profile is never touched");
    assert.ok(!existsSync(join(rig.dir, "pd", "config")), "config.json and the config folder are never touched");
  } finally {
    await rig.cleanup();
  }
});
