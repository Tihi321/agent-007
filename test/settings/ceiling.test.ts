import assert from "node:assert/strict";
import { test } from "node:test";
import { READONLY_TOOLS } from "../../src/settings/catalog.js";
import { ceilingFor, defaultEffective, effective, validateAgainstCeiling } from "../../src/settings/ceiling.js";
import type { Ceiling, SecurityLike } from "../../src/settings/ceiling.js";
import type { Persona } from "../../src/settings/contracts.js";
import { parsePersona } from "../../src/settings/personaSchema.js";
import { readonlyEffective } from "../../src/settings/builtins.js";
import { draft } from "./helpers.js";

function security(over: Partial<SecurityLike> = {}): SecurityLike {
  return {
    shell: { enabled: true },
    mcp: { servers: [{ id: "vibetts", allowTools: ["speak", "list_voices"], macros: ["tts_line"] }, { id: "flowmusic", allowTools: ["make_music"], macros: [] }] },
    presets: [{ id: "lmstudio" }, { id: "strata" }],
    model: { defaultPreset: "lmstudio", runner: "lmstudio" },
    budgets: { maxJobsPerDay: 5 },
    ...over,
  };
}

const TEMPLATES = ["tts-line", "list-runs", "visual-novel-from-idea"];
const ceil = (over: Partial<SecurityLike> = {}): Ceiling => ceilingFor(security(over), { templates: TEMPLATES });
const persona = (over: Record<string, unknown> = {}): Persona => {
  const r = parsePersona(draft(over));
  assert.deepEqual(r.issues, []);
  return r.persona as Persona;
};

test("the ceiling: known tools minus shell when it is off, macros only when enabled, MCP tools from the allowlists", () => {
  const c = ceil();
  assert.ok(c.tools.includes("shell") && c.tools.includes("tts_line"));
  assert.ok(!c.tools.includes("chiptune_loop") && !c.tools.includes("comfy_image"), "macros not enabled on any server");
  assert.deepEqual(c.mcp, { vibetts: ["speak", "list_voices"], flowmusic: ["make_music"] });
  assert.deepEqual(c.jobTemplates, TEMPLATES);
  assert.equal(c.maxJobsPerDay, 5);
  const off = ceil({ shell: { enabled: false } });
  assert.ok(!off.tools.includes("shell"));
  assert.equal(ceil({ budgets: {} }).maxJobsPerDay, Infinity);
});

test("a persona that fits the ceiling is valid; an empty list is valid", () => {
  const c = ceil();
  assert.deepEqual(validateAgainstCeiling(persona(), c), { ok: true, reasons: [] });
  assert.equal(validateAgainstCeiling(persona({ toolAllow: [], jobTemplates: [], mcpAllow: {} }), c).ok, true);
  assert.equal(validateAgainstCeiling(persona({ mcpAllow: { vibetts: ["speak"] }, jobTemplates: ["tts-line"], budgets: { maxJobsPerDay: 5 } }), c).ok, true);
});

test("a persona outside the ceiling is invalid with the reason: shell when shell is off, an unknown tool, MCP, templates, preset, budget", () => {
  const c = ceil({ shell: { enabled: false } });
  const r = validateAgainstCeiling(persona({ toolAllow: ["shell", "teleport", "read_file"], mcpAllow: { nope: ["x"], vibetts: ["delete_all"] }, jobTemplates: ["secret-template"], modelPreset: "gpt", budgets: { maxJobsPerDay: 50 } }), c);
  assert.equal(r.ok, false);
  const text = r.reasons.join("\n");
  assert.match(text, /tool "shell" is outside .*shell is turned off/);
  assert.match(text, /tool "teleport" is not a known tool/);
  assert.match(text, /MCP server "nope" is not configured/);
  assert.match(text, /MCP tool "vibetts\/delete_all"/);
  assert.match(text, /job template "secret-template"/);
  assert.match(text, /model preset "gpt"/);
  assert.match(text, /maxJobsPerDay 50 is above the allowed 5/);
  assert.equal(validateAgainstCeiling(persona({ toolAllow: ["chiptune_loop"] }), ceil()).ok, false, "a macro that is not enabled is outside the ceiling");
});

test("effective() intersects every list, budgets take the minimum, and a widened persona never exceeds the ceiling", () => {
  const c = ceil({ shell: { enabled: false } });
  const widened = persona({ toolAllow: ["shell", "read_file", "teleport"], mcpAllow: { vibetts: ["speak", "delete_all"], nope: ["x"] }, jobTemplates: ["tts-line", "ghost"], budgets: { maxJobsPerDay: 99 } });
  const e = effective(widened, c);
  assert.deepEqual(e.tools, ["read_file"]);
  assert.deepEqual(e.mcp, { vibetts: ["speak"] });
  assert.deepEqual(e.jobTemplates, ["tts-line"]);
  assert.equal(e.maxJobsPerDay, 5);
  assert.equal(effective(persona({ budgets: { maxJobsPerDay: 2 } }), c).maxJobsPerDay, 2);
  assert.equal(effective(persona({ modelPreset: "ghost" }), c).modelPreset, c.defaultPreset);
});

test("property: for random sets, effective(p, c) is a subset of c and compare(a, effective(a, c)) is equal or narrower", async () => {
  const { compare } = await import("../../src/settings/compare.js");
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pick = <T,>(xs: readonly T[]): T[] => xs.filter(() => rnd() < 0.5);
  const all = ["tool_search", "read_file", "shell", "write_file", "remember", "dispatch_job", "tts_line", "nonsense", "list_dir"];
  for (let i = 0; i < 200; i++) {
    const c = ceil({ shell: { enabled: rnd() < 0.5 } });
    const p = persona({
      toolAllow: pick(all),
      mcpAllow: rnd() < 0.5 ? { vibetts: pick(["speak", "list_voices", "ghost"]) } : {},
      jobTemplates: pick([...TEMPLATES, "ghost"]),
      budgets: rnd() < 0.5 ? { maxJobsPerDay: Math.floor(rnd() * 9) } : {},
    });
    const e = effective(p, c);
    assert.ok(e.tools.every((t) => c.tools.includes(t)));
    assert.ok(e.jobTemplates.every((t) => c.jobTemplates.includes(t)));
    for (const [s, ts] of Object.entries(e.mcp)) assert.ok(ts.every((t) => (c.mcp[s] ?? []).includes(t)));
    assert.ok((e.maxJobsPerDay ?? Infinity) <= c.maxJobsPerDay);
    const rel = compare(effective(p, c), e).relation;
    assert.equal(rel, "equal");
    const rel2 = compare(defaultEffective(c), e).relation;
    assert.ok(rel2 === "equal" || rel2 === "narrower", `the default is never narrower than a persona: ${rel2}`);
  }
});

test("built-in read-only persona: the read tools only, no MCP, no templates, no memory writes", () => {
  const c = ceil();
  const ro = readonlyEffective(c);
  assert.deepEqual(ro.tools.sort(), READONLY_TOOLS.filter((t) => c.tools.includes(t)).sort());
  assert.deepEqual(ro.mcp, {});
  assert.deepEqual(ro.jobTemplates, []);
  assert.deepEqual(ro.memory, { write: "none", sharedRead: true });
  assert.equal(ro.maxJobsPerDay, 0);
  assert.ok(!ro.tools.includes("shell") && !ro.tools.includes("write_file") && !ro.tools.includes("dispatch_job"));
});
