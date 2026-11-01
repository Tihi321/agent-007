import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { reconstructPrefs } from "../../src/jobrunner/settingsUi/routes.js";
import { revisionOf } from "../../src/settings/store.js";
import { readSecurity, signIn, startRig } from "./helpers.js";

test("GET /api/security returns the document and its revision (sha256 of the file)", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const r = await s.get("/api/security");
    assert.equal(r.status, 200);
    const body = r.json() as { doc: Record<string, any>; revision: string };
    assert.equal(body.revision, revisionOf(readFileSync(rig.paths.securityFile, "utf8")));
    assert.deepEqual(body.doc["telegram"].allowedUserIds, [4242]);
    assert.equal(body.doc["schemaVersion"], 1);
  } finally {
    await rig.cleanup();
  }
});

test("without a security.json (not migrated) the security routes say so and the others still work", async () => {
  const rig = await startRig({ noSecurity: true });
  try {
    const s = await signIn(rig);
    const r = await s.get("/api/security");
    assert.equal(r.status, 404);
    assert.equal(r.json()["error"], "not_migrated");
    assert.equal((await s.post("/api/security/save", { section: "shell", value: {}, baseRevision: "x" })).status, 404);
    assert.equal((await s.post("/api/security/preview", { section: "shell", value: {} })).status, 404);
    assert.equal((await s.get("/api/status")).status, 200);
    assert.equal((await s.get("/api/audit")).status, 200);
    assert.equal((await s.get("/api/templates")).status, 200);
  } finally {
    await rig.cleanup();
  }
});

test("GET /api/audit shows what was written, newest last, and limits the count", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    for (let i = 0; i < 5; i++) {
      rig.audit.append({ source: "system", kind: "setting", target: { file: "prefs.json", path: `style.n${i}` }, diff: [], decision: "loaded", baseRevision: "a", afterRevision: "b" });
    }
    const all = (await s.get("/api/audit?limit=50")).json() as { lines: { target: { path: string } }[] };
    assert.deepEqual(all.lines.map((l) => l.target.path), ["style.n0", "style.n1", "style.n2", "style.n3", "style.n4"]);
    const two = (await s.get("/api/audit?limit=2")).json() as { lines: { target: { path: string } }[] };
    assert.deepEqual(two.lines.map((l) => l.target.path), ["style.n3", "style.n4"]);
    assert.equal(((await s.get("/api/audit?limit=abc")).json() as { lines: unknown[] }).lines.length, 5, "a bad limit falls back to the default");
  } finally {
    await rig.cleanup();
  }
});

test("GET /api/status: the running revision comes from the agent's own (running) audit line; restartRequired when it differs", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const file = revisionOf(readSecurity(rig).text);
    const none = (await s.get("/api/status")).json() as Record<string, unknown>;
    assert.equal(none["fileRevision"], file);
    assert.equal(none["runningRevision"], null);
    assert.equal(none["restartRequired"], false, "unknown is not a pending restart");
    const { createSettingsAudit } = await import("../../src/settings/audit.js");
    const agent = createSettingsAudit({ dir: rig.paths.auditDir, writer: "agent" });
    agent.append({ source: "system", kind: "security", target: { file: "security.json", path: "(running)" }, diff: [], decision: "loaded", baseRevision: "old", afterRevision: "old" });
    const differs = (await s.get("/api/status")).json() as Record<string, unknown>;
    assert.equal(differs["runningRevision"], "old");
    assert.equal(differs["restartRequired"], true);
    agent.append({ source: "system", kind: "security", target: { file: "security.json", path: "(running)" }, diff: [], decision: "loaded", baseRevision: file, afterRevision: file });
    const same = (await s.get("/api/status")).json() as Record<string, unknown>;
    assert.equal(same["restartRequired"], false);
    assert.match(String(same["killSwitchNote"]), /delete the flag file/);
  } finally {
    await rig.cleanup();
  }
});

test("the preferences view is rebuilt from the audit log (the agent profile is not readable by the main user)", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    rig.audit.append({ source: "propose", kind: "setting", target: { file: "prefs.json", path: "style.verbosity" }, diff: [{ path: "style.verbosity", op: "replace", before: "short", after: "detailed" }], decision: "approved", baseRevision: "a", afterRevision: "b" });
    rig.audit.append({ source: "propose", kind: "setting", target: { file: "prefs.json", path: "style.tone" }, diff: [{ path: "style.tone", op: "replace", before: "neutral", after: "friendly" }], decision: "rejected", baseRevision: "a", afterRevision: "a" });
    rig.audit.append({ source: "telegram", kind: "setting", target: { file: "prefs.json", path: "style.language" }, diff: [{ path: "style.language", op: "replace", before: "en", after: "de" }], decision: "applied", baseRevision: "b", afterRevision: "c" });
    const body = (await s.get("/api/prefs")).json() as { prefs: { style: Record<string, string> }; source: string };
    assert.equal(body.source, "audit");
    assert.equal(body.prefs.style["verbosity"], "detailed");
    assert.equal(body.prefs.style["tone"], "neutral", "a rejected change is not applied");
    assert.equal(body.prefs.style["language"], "de");
    assert.equal(reconstructPrefs([]).defaultPersona, "default");
  } finally {
    await rig.cleanup();
  }
});

test("an unknown API route is 404 for a signed-in user, and a malformed body is a 400, not a crash", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    assert.equal((await s.get("/api/nope")).status, 404);
    assert.equal((await s.post("/api/nope")).status, 404);
    const bad = await s.post("/api/security/save", "{not json" as never);
    assert.equal(bad.status, 400);
    assert.equal((await s.post("/api/security/save", [1, 2] as never)).status, 400);
    assert.equal((await s.post("/api/security/save", { baseRevision: 5 })).status, 400);
    assert.equal((await s.post("/api/personas/save", { baseRevision: "x" })).status, 422);
    assert.equal((await s.get("/api/schema")).status, 200, "the server is still fine");
  } finally {
    await rig.cleanup();
  }
});
