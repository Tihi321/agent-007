import assert from "node:assert/strict";
import { test } from "node:test";
import { appliesWithoutCard, compare } from "../../src/settings/compare.js";
import type { EffectivePersona } from "../../src/settings/contracts.js";

function eff(over: Partial<EffectivePersona> = {}): EffectivePersona {
  return {
    id: "x",
    tools: ["read_file", "list_dir"],
    mcp: { vibetts: ["speak"] },
    jobTemplates: ["tts-line"],
    modelPreset: "lmstudio",
    memory: { write: "scope", scope: "a", sharedRead: true },
    maxJobsPerDay: 5,
    prompt: "",
    ...over,
  };
}

test("equal: the same capabilities (a different prompt or id does not matter)", () => {
  const r = compare(eff(), eff({ id: "y", prompt: "other" }));
  assert.deepEqual(r, { relation: "equal", added: [], removed: [] });
  assert.equal(appliesWithoutCard("equal"), true);
});

test("narrower: only removals; broader: only additions; incomparable: both (removes shell, adds write_file)", () => {
  assert.equal(compare(eff(), eff({ tools: ["read_file"] })).relation, "narrower");
  const b = compare(eff(), eff({ tools: ["read_file", "list_dir", "shell"] }));
  assert.equal(b.relation, "broader");
  assert.deepEqual(b.added, ["tool: shell"]);
  const inc = compare(eff({ tools: ["read_file", "shell"] }), eff({ tools: ["read_file", "write_file"] }));
  assert.equal(inc.relation, "incomparable");
  assert.deepEqual(inc.added, ["tool: write_file"]);
  assert.deepEqual(inc.removed, ["tool: shell"]);
  assert.equal(appliesWithoutCard("narrower"), true);
  assert.equal(appliesWithoutCard("broader"), false);
  assert.equal(appliesWithoutCard("incomparable"), false);
});

test("MCP tools per server and job templates are compared as sets", () => {
  assert.equal(compare(eff(), eff({ mcp: { vibetts: ["speak", "list_voices"] } })).relation, "broader");
  assert.equal(compare(eff(), eff({ mcp: {} })).relation, "narrower");
  assert.deepEqual(compare(eff(), eff({ mcp: { vibetts: ["speak"], other: ["go"] } })).added, ["MCP tool: other/go"]);
  assert.deepEqual(compare(eff(), eff({ jobTemplates: ["tts-line", "list-runs"] })).added, ["job template: list-runs"]);
  assert.equal(compare(eff(), eff({ jobTemplates: [] })).relation, "narrower");
});

test("memory: shared > scope > none, two different scopes are incomparable, sharedRead up and down", () => {
  assert.equal(compare(eff({ memory: { write: "none", sharedRead: true } }), eff({ memory: { write: "scope", scope: "a", sharedRead: true } })).relation, "broader");
  assert.equal(compare(eff({ memory: { write: "shared", sharedRead: true } }), eff({ memory: { write: "scope", scope: "a", sharedRead: true } })).relation, "narrower");
  assert.equal(compare(eff({ memory: { write: "shared", sharedRead: true } }), eff({ memory: { write: "none", sharedRead: true } })).relation, "narrower");
  const two = compare(eff({ memory: { write: "scope", scope: "a", sharedRead: true } }), eff({ memory: { write: "scope", scope: "b", sharedRead: true } }));
  assert.equal(two.relation, "incomparable");
  assert.match(two.added.join(), /scope b/);
  assert.equal(compare(eff({ memory: { write: "scope", scope: "a", sharedRead: false } }), eff()).relation, "broader");
  assert.equal(compare(eff(), eff({ memory: { write: "scope", scope: "a", sharedRead: false } })).relation, "narrower");
});

test("maxJobsPerDay: higher or absent is broader", () => {
  assert.equal(compare(eff({ maxJobsPerDay: 3 }), eff({ maxJobsPerDay: 5 })).relation, "broader");
  assert.equal(compare(eff({ maxJobsPerDay: 5 }), eff({ maxJobsPerDay: 3 })).relation, "narrower");
  assert.equal(compare(eff({ maxJobsPerDay: 5 }), eff({ maxJobsPerDay: undefined })).relation, "broader");
  assert.equal(compare(eff({ maxJobsPerDay: undefined }), eff({ maxJobsPerDay: 0 })).relation, "narrower");
});

test("a model preset difference is not a broadening in Phase 3; the hook can make it one (Phase 4)", () => {
  assert.equal(compare(eff(), eff({ modelPreset: "strata" })).relation, "equal");
  const r = compare(eff(), eff({ modelPreset: "cloud" }), { presetWidens: (_f, t) => t === "cloud" });
  assert.equal(r.relation, "broader");
  assert.deepEqual(r.added, ["model preset: cloud"]);
});
