/**
 * S17.7 / G3 registry gate: the whole host registry (Phases 1 to 3) is enumerated. The non-deferred set equals `ALWAYS_LOADED`
 * (exactly 10), the five Phase 3 tools are all deferred, `ALWAYS_LOADED` is unchanged, `KNOWN_TOOLS` equals the registry's
 * names, the section order is the I27e order, and `tool_search` finds the settings tools. S18 and S19 rerun this file.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALWAYS_LOADED, checkToolCap } from "../../src/jobs/contracts.js";
import { KNOWN_TOOLS, MACRO_TOOLS } from "../../src/settings/catalog.js";
import { SETTINGS_TOOL_NAMES } from "../../src/settings/tools.js";
import { E2e } from "./rig.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LITERAL = ["tool_search", "dispatch_job", "job_status", "cancel_job", "list_templates", "ask_user", "hub_status", "system_facts", "list_dir", "read_file"];

test("ALWAYS_LOADED is the literal list of 10 and no Phase 3 file edits it", () => {
  assert.deepEqual([...ALWAYS_LOADED], LITERAL);
  assert.equal(ALWAYS_LOADED.length, 10);
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(join(REPO, "src"));
  for (const f of files) {
    if (f.replace(/\\/g, "/").endsWith("src/jobs/contracts.ts")) continue;
    assert.ok(!/ALWAYS_LOADED\s*=/.test(readFileSync(f, "utf8")), `${f} must not define ALWAYS_LOADED`);
  }
});

test("the host registry: exactly the 10 always-loaded tools are non-deferred, the five Phase 3 tools are deferred, KNOWN_TOOLS equals the names", async () => {
  const rig = await E2e.open();
  try {
    const entries = rig.agent.registry.snapshot().tools();
    const tools = entries.map((e) => e.tool as { name: string; deferred?: boolean });
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, "no duplicate tool name");
    const cap = checkToolCap(tools);
    assert.deepEqual(cap.nonDeferred.sort(), [...LITERAL].sort());
    assert.equal(cap.ok, true);
    for (const n of SETTINGS_TOOL_NAMES) {
      const t = tools.find((x) => x.name === n);
      assert.ok(t, `${n} is registered`);
      assert.equal(t.deferred, true, `${n} is deferred`);
    }
    // KNOWN_TOOLS equals the registry's names (macros are registered only when a server enables them: none here)
    const registered = names.filter((n) => !n.startsWith("mcp__")).sort();
    assert.deepEqual(registered, KNOWN_TOOLS.filter((n) => !MACRO_TOOLS.includes(n)).sort());
    assert.deepEqual(
      rig.agent.registry.snapshot().installed().map((e) => e.name),
      ["a7", "tool-search", "mcp", "a7-jobs", "a7-settings"],
    );
    // and the model is offered exactly the 10 on a real request
    await rig.say("hello", 1);
    await rig.seen((t) => t === "echo: hello", "the answer");
    assert.deepEqual([...rig.toolNamesOfLastRequest()].sort(), [...LITERAL].sort());
  } finally {
    await rig.close();
    rmSync(rig.dirs.root, { recursive: true, force: true });
  }
});

test("the system prompt sections render in the I27e order: preamble, style, user_profile, memory, runtime (persona and guardrails are not shown by default)", async () => {
  const rig = await E2e.open();
  try {
    await rig.say("hi", 1);
    await rig.seen((t) => t === "echo: hi", "the answer");
    const p = rig.lastSystemPrompt();
    const at = (k: string): number => p.indexOf(`<${k}>`);
    const order = ["preamble", "style", "user_profile", "memory", "runtime"].map(at);
    assert.ok(order.every((i) => i >= 0), `all sections present: ${order.join(",")}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "in order");
    assert.ok(at("persona") < 0 && at("guardrails") < 0, "the default persona adds no persona or guardrails section");
    assert.match(p, /<style>\nTone: neutral and plain\.\nLength: short answers/);
  } finally {
    await rig.close();
    rmSync(rig.dirs.root, { recursive: true, force: true });
  }
});

test("tool_search finds the settings tools by the words settings, preference and tone", async () => {
  const rig = await E2e.open({
    behavior: ({ lastUser, afterTool, lastToolText }) => {
      if (afterTool) return { type: "text", text: `found: ${lastToolText}` };
      if (/preference/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "tool_search", args: { query: "change a preference setting such as tone or verbosity" } }] };
      if (/persona/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "tool_search", args: { query: "switch persona" } }] };
      return { type: "text", text: "no" };
    },
  });
  try {
    await rig.say("please change a preference", 1);
    const t = await rig.seen((x) => x.startsWith("found:"), "the tool_search result");
    assert.match(t, /propose_setting/);
    await rig.say("show me the persona list", 2);
    const t2 = await rig.seen((x) => x.startsWith("found:") && /switch_persona/.test(x), "the persona tools");
    assert.match(t2, /switch_persona/);
  } finally {
    await rig.close();
    rmSync(rig.dirs.root, { recursive: true, force: true });
  }
});
