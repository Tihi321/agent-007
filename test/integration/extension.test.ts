/**
 * S6.1 done-check, updated by S15.1. No model runner is needed: the registry content, the frozen schemas, the host-default
 * selection and the "no explicit `extensions`" rule. Since Phase 2 the host registry holds four extensions (a7, tool-search,
 * mcp, a7-jobs) and the model is offered the 10 always-loaded tools; `search_files`, `write_file`, `remember` and `shell` are
 * deferred behind `tool_search` with unchanged schemas.
 */
const sortedAlways = [...ALWAYS_LOADED].sort();
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { A7_EXTENSION_NAME } from "../../src/agent/extension.js";
import { ALWAYS_LOADED, DEFERRED_PHASE1_TOOLS } from "../../src/jobs/contracts.js";
import { SECTION_KEYS } from "../../src/prompt/sections.js";
import { TOOL_NAMES, TOOL_SPECS } from "../../src/tools/schemas.js";
import { E2e } from "./rig.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("S6.1: the registry lists extension a7 with exactly the 7 schema tools (the 4 Phase 1 ones deferred) and the 4 section keys", async () => {
  const rig = await E2e.open();
  try {
    const ext = rig.agent.registry.snapshot().extension(A7_EXTENSION_NAME);
    assert.ok(ext, "extension a7 is installed");
    assert.deepEqual(
      (ext.tools ?? []).map((t) => t.name),
      [...TOOL_NAMES],
    );
    assert.equal((ext.tools ?? []).length, 7);
    assert.deepEqual(
      (ext.sections ?? []).map((s) => s.key),
      ["preamble", "persona", "guardrails", "style", "user_profile", "memory", "runtime"], // Phase 3 (I27e); persona and guardrails render only for a non-default persona
    );
    assert.equal((ext.hooks ?? []).length, 1, "one hook: the combined beforeTool (Flow guard, then the shell approval gate)");
    const tools: readonly { name: string; deferred?: boolean }[] = ext.tools ?? [];
    for (const t of tools) assert.equal(t.deferred === true, (DEFERRED_PHASE1_TOOLS as readonly string[]).includes(t.name), `${t.name}: deferred flag`);
    assert.deepEqual(
      rig.agent.registry.snapshot().installed().map((e) => e.name),
      [A7_EXTENSION_NAME, "tool-search", "mcp", "a7-jobs", "a7-settings"],
      "a7 plus the Phase 2 extensions and the Phase 3 settings tools",
    );
  } finally {
    await rig.close();
    rmSync(rig.dirs.root, { recursive: true, force: true });
  }
});

test("S6.1: the tool descriptions and parameter schemas are deep-equal to schemas.ts (no drift from the bake-off)", async () => {
  const rig = await E2e.open();
  try {
    const ext = rig.agent.registry.snapshot().extension(A7_EXTENSION_NAME);
    assert.ok(ext);
    for (const spec of TOOL_SPECS) {
      const tools: readonly { name: string; description?: string; parameters?: unknown }[] = ext.tools ?? [];
      const tool = tools.find((t) => t.name === spec.name);
      assert.ok(tool, `tool ${spec.name} is registered`);
      assert.deepEqual(tool.parameters, spec.parameters, `${spec.name}: parameters drifted from schemas.ts`);
      assert.equal(tool.description, spec.description, `${spec.name}: description drifted from schemas.ts`);
    }
  } finally {
    await rig.close();
    rmSync(rig.dirs.root, { recursive: true, force: true });
  }
});

test("S6.1: a conversation made by the Telegram path (no explicit extensions) is served with the host default selected, also after /new", async () => {
  const rig = await E2e.open();
  try {
    await rig.say("hello", 1);
    await rig.seen((t) => t === "echo: hello", "the first answer");
    assert.deepEqual([...rig.toolNamesOfLastRequest()].sort(), sortedAlways, "the model was offered exactly the 10 always-loaded tools");
    for (const key of SECTION_KEYS) assert.match(rig.lastSystemPrompt(), new RegExp(`<${key}>`), `section ${key} is in the system prompt`);

    await rig.say("/new", 2);
    await rig.seen((t) => t === "Started a new conversation.", "the /new reply");
    await rig.say("hello again", 3);
    await rig.seen((t) => t === "echo: hello again", "the answer in the new conversation");
    assert.deepEqual([...rig.toolNamesOfLastRequest()].sort(), sortedAlways, "the new conversation also has a7 and the Phase 2 tools (and so their hook)");
  } finally {
    await rig.close();
    rmSync(rig.dirs.root, { recursive: true, force: true });
  }
});

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
}

test("S6.1: no explicit `extensions:` array exists anywhere in src (footgun 30)", () => {
  const files: string[] = [];
  walk(join(REPO, "src"), files);
  const hits: string[] = [];
  for (const f of files) {
    readFileSync(f, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (/extensions\s*:/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(hits, []);
});
