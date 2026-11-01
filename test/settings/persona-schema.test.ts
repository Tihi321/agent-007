import assert from "node:assert/strict";
import { test } from "node:test";
import { KNOWN_TOOLS, READONLY_TOOLS } from "../../src/settings/catalog.js";
import { PERSONA_PROMPT_MAX, PERSONA_SCHEMA, cleanText, memoryScopeOf, parsePersona } from "../../src/settings/personaSchema.js";
import { schemaPaths } from "../../src/settings/jsonschema.js";
import { draft } from "./helpers.js";

test("a valid draft parses and every list is explicit", () => {
  const r = parsePersona(draft());
  assert.deepEqual(r.issues, []);
  assert.equal(r.persona?.id, "research");
  assert.deepEqual(r.persona?.toolAllow, ["tool_search", "read_file"]);
  assert.equal(memoryScopeOf(r.persona as NonNullable<typeof r.persona>), "research");
});

test("missing lists are refused (no 'absent means all'), and so are unknown keys", () => {
  for (const key of ["toolAllow", "mcpAllow", "jobTemplates", "modelPreset", "memory", "budgets", "prompt", "name", "id"]) {
    const d = draft();
    delete d[key];
    assert.equal(parsePersona(d).persona, undefined, `${key} is required`);
  }
  assert.match(parsePersona(draft({ superpower: true })).issues.join("\n"), /superpower/);
  assert.match(parsePersona(draft({ budgets: { maxJobsPerDay: 1, extra: 1 } })).issues.join("\n"), /extra/);
});

test("ids: lowercase letters, digits and dashes, 2 to 24 characters, starting with a letter", () => {
  for (const ok of ["ab", "research", "ops-2", "a".concat("b".repeat(22), "c")]) assert.equal(parsePersona(draft({ id: ok, memory: { write: "none", sharedRead: false } })).persona?.id, ok, ok);
  for (const bad of ["A", "a", "1abc", "has space", "under_score", "../x", "a".repeat(25), "", "Research"]) assert.equal(parsePersona(draft({ id: bad })).persona, undefined, JSON.stringify(bad));
});

test("persona text is plain text: at most 4,000 characters, control characters stripped, CRLF normalised", () => {
  assert.equal(parsePersona(draft({ prompt: "x".repeat(PERSONA_PROMPT_MAX) })).persona !== undefined, true);
  assert.equal(parsePersona(draft({ prompt: "x".repeat(PERSONA_PROMPT_MAX + 1) })).persona, undefined);
  const r = parsePersona(draft({ prompt: "line one\r\nline\u0007 two\u0000\ttabbed", name: "Na\u0001me " }));
  assert.equal(r.persona?.prompt, "line one\nline two\ttabbed");
  assert.equal(r.persona?.name, "Name");
  assert.equal(cleanText("a\u007fb"), "ab");
});

test("memory: a scope only with write: scope, scope must look like an id, duplicates in lists collapse", () => {
  assert.match(parsePersona(draft({ memory: { write: "shared", scope: "x1", sharedRead: true } })).issues.join("\n"), /only allowed with write: scope/);
  assert.equal(parsePersona(draft({ memory: { write: "scope", scope: "../etc", sharedRead: true } })).persona, undefined);
  assert.equal(parsePersona(draft({ memory: { write: "scope", scope: "a/b", sharedRead: true } })).persona, undefined);
  assert.deepEqual(parsePersona(draft({ toolAllow: ["read_file", "read_file"] })).persona?.toolAllow, ["read_file"]);
});

test("the catalog: the read-only set is inside the known tools, and the descriptor drives a form", () => {
  for (const t of READONLY_TOOLS) assert.ok(KNOWN_TOOLS.includes(t), t);
  assert.ok(!READONLY_TOOLS.includes("shell") && !READONLY_TOOLS.includes("write_file") && !READONLY_TOOLS.includes("remember") && !READONLY_TOOLS.includes("dispatch_job"));
  assert.ok(schemaPaths(PERSONA_SCHEMA).includes("memory.write"));
});
