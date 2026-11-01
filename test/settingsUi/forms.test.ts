import assert from "node:assert/strict";
import { test } from "node:test";
import { FormRegistry, registerForm, shippedForms } from "../../src/jobrunner/settingsUi/forms/registry.js";
import { readAuditTail } from "../../src/settings/audit.js";
import { validate } from "../../src/settings/jsonschema.js";
import { SECURITY_SCHEMA } from "../../src/settings/schema.js";
import { readSecurity, signIn, startRig } from "./helpers.js";

test("the shipped forms cover Telegram ids, folders, shell limits, models and presets, MCP servers, jobs, Flow and proposals", () => {
  const forms = shippedForms().list();
  const ids = forms.map((f) => f.id);
  for (const id of ["telegram", "folders", "shell", "limits", "models", "mcp", "jobs", "jobrunner", "proposals", "bots", "terms", "botbus", "botroom", "gate"]) assert.ok(ids.includes(id), id);
  const sections = new Set(forms.flatMap((f) => f.section));
  for (const s of Object.keys(SECURITY_SCHEMA.properties ?? {})) {
    if (s === "schemaVersion" || s === "secondOpinion" || s === "tools") continue; // read-only marker; the endpoint is not built; tools is an empty placeholder block (nothing to edit)
    assert.ok(sections.has(s), `the section ${s} has a form`);
  }
  const folders = forms.find((f) => f.id === "folders")!;
  assert.match((folders.warnings ?? []).join(), /grant-folder-acls\.ps1/);
  assert.equal(forms.find((f) => f.id === "jobrunner")?.target, "jobrunner");
  // every descriptor is a schema of the same subset the validator understands
  for (const f of forms) assert.equal(f.schema.type, "object");
});

test("a descriptor is checked when it is registered: duplicate ids, bad ids and unknown sections throw", () => {
  const r = new FormRegistry();
  const d = { id: "extra", title: "Extra", target: "security" as const, section: ["limits"], schema: { type: "object" as const, properties: {} } };
  registerForm(r, d);
  assert.throws(() => registerForm(r, d), /already registered/);
  assert.throws(() => registerForm(r, { ...d, id: "Bad Id" }), /not valid/);
  assert.throws(() => registerForm(r, { ...d, id: "other", section: ["nonsense"] }), /unknown security section/);
  assert.throws(() => registerForm(r, { ...d, id: "schemaver", section: ["schemaVersion"] }), /unknown security section/);
});

test("GET /api/schema returns the descriptors and every registered form (a test form too)", async () => {
  const forms = shippedForms();
  registerForm(forms, { id: "extra", title: "Extra form", target: "security", section: ["limits"], schema: { type: "object", properties: { limits: SECURITY_SCHEMA.properties!["limits"]! } } });
  const rig = await startRig({ forms });
  try {
    const s = await signIn(rig);
    const body = (await s.get("/api/schema")).json() as { forms: { id: string }[]; security: { properties: Record<string, unknown> }; persona: unknown; prefs: unknown; absentRevision: string };
    assert.ok(body.forms.some((f) => f.id === "extra"));
    assert.ok(body.security.properties["telegram"]);
    assert.ok(body.persona && body.prefs);
    assert.match(body.absentRevision, /^[0-9a-f]{64}$/);
  } finally {
    await rig.cleanup();
  }
});

test("a form with ack refuses a save without the ticked acknowledgment; with it, the text is stored in the audit line", async () => {
  const forms = shippedForms();
  const ackText = "I understand that this sends my text to a third party.";
  registerForm(forms, { id: "ackdemo", title: "Ack demo", target: "security", section: ["proposals"], schema: { type: "object", properties: { proposals: SECURITY_SCHEMA.properties!["proposals"]! } }, ack: { text: ackText } });
  const rig = await startRig({ forms });
  try {
    const s = await signIn(rig);
    const cur = (await s.get("/api/security")).json() as { doc: Record<string, any>; revision: string };
    const sections = { proposals: { ...cur.doc["proposals"], perHour: 9 } };
    const noAck = await s.post("/api/security/save", { formId: "ackdemo", sections, baseRevision: cur.revision });
    assert.equal(noAck.status, 422);
    assert.equal(noAck.json()["error"], "ack_required");
    assert.equal(noAck.json()["message"], ackText);
    const falseAck = await s.post("/api/security/save", { formId: "ackdemo", sections, baseRevision: cur.revision, ack: "true" });
    assert.equal(falseAck.status, 422, "only the boolean true counts");
    assert.equal(readSecurity(rig).doc["proposals"].perHour, 5, "nothing was written");
    assert.deepEqual(readAuditTail(rig.paths.auditDir, 5), []);
    const ok = await s.post("/api/security/save", { formId: "ackdemo", sections, baseRevision: cur.revision, ack: true });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(readSecurity(rig).doc["proposals"].perHour, 9);
    const l = readAuditTail(rig.paths.auditDir, 5).at(-1)!;
    assert.match(l.note ?? "", /^ack: I understand that this sends my text/);
  } finally {
    await rig.cleanup();
  }
});

test("a form can only save the sections it names, and an unknown form is 404", async () => {
  const rig = await startRig();
  try {
    const s = await signIn(rig);
    const cur = (await s.get("/api/security")).json() as { doc: Record<string, any>; revision: string };
    const limits = { readFileBytes: 4096 };
    const wrong = await s.post("/api/security/save", { formId: "shell", sections: { limits }, baseRevision: cur.revision });
    assert.equal(wrong.status, 400);
    const unknown = await s.post("/api/security/save", { formId: "ghost", sections: { limits }, baseRevision: cur.revision });
    assert.equal(unknown.status, 404);
    const runnerForm = await s.post("/api/security/save", { formId: "jobrunner", sections: { limits }, baseRevision: cur.revision });
    assert.equal(runnerForm.status, 404, "the job runner form does not save to security.json");
    const multi = await s.post("/api/security/save", { formId: "models", sections: { model: cur.doc["model"], presets: cur.doc["presets"] }, baseRevision: cur.revision });
    assert.equal(multi.status, 200, "a multi-section form saves both sections at once");
  } finally {
    await rig.cleanup();
  }
});

test("the form schemas validate the very documents they edit (a form can never offer what the validator refuses)", async () => {
  const rig = await startRig({ phase2: true });
  try {
    const doc = readSecurity(rig).doc;
    for (const f of shippedForms().list().filter((x) => x.target === "security")) {
      const value = Object.fromEntries(f.section.filter((k) => doc[k] !== undefined).map((k) => [k, doc[k]]));
      assert.deepEqual(validate(f.schema, value), [], f.id);
    }
  } finally {
    await rig.cleanup();
  }
});
