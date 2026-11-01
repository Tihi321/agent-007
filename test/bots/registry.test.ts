/**
 * S20.4 done-check: the per-bot registry is the code tool list intersected with the bot's allowlist, inside the host-default
 * extension with the guard. Builds the registry for a narrow, a full and an ask_bot-enabled bot and checks the I27 cap per bot.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedToolSet, buildBotRegistry, checkBotRegistry, expectedAlwaysLoaded, narrowExtension, toolAllowed } from "../../src/bots/registry.js";
import { BOT_BUS_TOOLS, CODE_TOOL_NAMES, MAIN_DEFAULT_TOOLS } from "../../src/bots/schema.js";
import { ALWAYS_LOADED, MAX_ALWAYS_LOADED } from "../../src/jobs/contracts.js";
import { ToolTask, Type, createRegistry, defineExtension, defineTool, hook } from "../../src/pi/adapter.js";
import type { Extension, ToolRegistration } from "../../src/pi/adapter.js";
import { KNOWN_TOOLS } from "../../src/settings/catalog.js";
import { READ_ONLY_TOOLS } from "./helpers.js";

function stub(name: string): ToolRegistration {
  const deferred = !(ALWAYS_LOADED as readonly string[]).includes(name);
  return defineTool({ name, description: `stub ${name}`, parameters: Type.Object({}), ...(deferred ? { deferred: true as const } : {}), execute: async () => ({ output: [] }) }) as unknown as ToolRegistration;
}

/** The host extensions of Phases 1 to 4, as stubs: the same names and the same deferred flags as the real ones. */
function hostExtensions(): Extension[] {
  const guard = hook(ToolTask, { beforeTool: (async () => undefined) as never });
  const pick = (names: string[]): ToolRegistration[] => names.map(stub);
  return [
    defineExtension({ name: "a7", tools: pick(["system_facts", "list_dir", "read_file", "search_files", "write_file", "remember", "shell"]), hooks: [guard] }),
    defineExtension({ name: "tool-search", tools: pick(["tool_search"]) }),
    defineExtension({ name: "a7-jobs", tools: pick(["dispatch_job", "job_status", "cancel_job", "list_templates", "ask_user", "hub_status", "hub_start"]) }),
    defineExtension({ name: "a7-settings", tools: pick(["get_settings", "list_personas", "propose_setting", "propose_persona", "switch_persona"]) }),
    defineExtension({ name: "mcp", tools: pick(["tts_line", "chiptune_loop", "comfy_image", "mcp__vibetts__speak"]) }),
    defineExtension({ name: "a7-bots", tools: pick([...BOT_BUS_TOOLS]) }),
  ];
}

const FULL = { tools: [...MAIN_DEFAULT_TOOLS], edges: [] as { to: string; allow: string[]; egress: boolean }[] };
const NARROW = { tools: [...READ_ONLY_TOOLS], edges: [] as { to: string; allow: string[]; egress: boolean }[] };
const EDGE = [{ to: "research", allow: ["read_file"], egress: false }];

test("the stub host registers every code tool, so the checks below see the real shape", () => {
  const names = hostExtensions().flatMap((e) => (e.tools ?? []).map((t) => t.name));
  for (const n of KNOWN_TOOLS) if (!n.startsWith("mcp__")) assert.ok(names.includes(n), `stub is missing ${n}`);
  for (const n of CODE_TOOL_NAMES) assert.ok(names.includes(n), `stub is missing ${n}`);
  assert.equal(MAX_ALWAYS_LOADED, 10);
});

test("a full allowlist: the non-deferred set equals ALWAYS_LOADED (exactly 10); ask_bot and list_bots are not registered without an edge", () => {
  const reg = buildBotRegistry(hostExtensions(), FULL);
  const r = checkBotRegistry(reg, FULL, { guardExtension: "a7" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([...r.nonDeferred].sort(), [...ALWAYS_LOADED].sort());
  assert.equal(r.nonDeferred.length, 10);
  assert.deepEqual(r.missingAlwaysLoaded, []);
  assert.deepEqual(r.stray, []);
  for (const t of BOT_BUS_TOOLS) assert.ok(!r.names.includes(t), `${t} is not registered without an edge`);
  assert.ok(r.names.includes("shell") && r.names.includes("remember"), "deferred tools are registered");
  assert.deepEqual(expectedAlwaysLoaded(FULL).sort(), [...ALWAYS_LOADED].sort());
});

test("a narrow allowlist: the non-deferred set is a subset of ALWAYS_LOADED with at most 10 names, and nothing outside the allowlist exists", () => {
  const reg = buildBotRegistry(hostExtensions(), NARROW);
  const r = checkBotRegistry(reg, NARROW, { guardExtension: "a7" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.nonDeferred.length <= 10);
  assert.ok(r.nonDeferred.every((n) => (ALWAYS_LOADED as readonly string[]).includes(n)));
  assert.deepEqual([...r.nonDeferred].sort(), ["ask_user", "list_dir", "read_file", "system_facts", "tool_search"]);
  assert.deepEqual([...r.names].sort(), [...READ_ONLY_TOOLS].sort());
  for (const gone of ["shell", "write_file", "remember", "dispatch_job", "hub_start", "propose_setting", "ask_bot"]) assert.ok(!r.names.includes(gone), `${gone} is not offered`);
  assert.deepEqual(expectedAlwaysLoaded(NARROW).sort(), [...r.nonDeferred].sort());
});

test("an ask_bot-enabled bot: both bus tools are registered and deferred, the always-loaded set is unchanged", () => {
  const bot = { tools: [...NARROW.tools, "ask_bot", "list_bots"], edges: EDGE };
  const r = checkBotRegistry(buildBotRegistry(hostExtensions(), bot), bot, { guardExtension: "a7" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.names.includes("ask_bot") && r.names.includes("list_bots"));
  assert.ok(!r.nonDeferred.includes("ask_bot") && !r.nonDeferred.includes("list_bots"), "deferred (I27)");
  assert.deepEqual([...r.nonDeferred].sort(), ["ask_user", "list_dir", "read_file", "system_facts", "tool_search"]);
  // the same allowlist with no edge registers neither
  const noEdge = { tools: bot.tools, edges: [] as typeof EDGE };
  const r2 = checkBotRegistry(buildBotRegistry(hostExtensions(), noEdge), noEdge);
  assert.equal(r2.ok, true);
  assert.ok(!r2.names.includes("ask_bot") && !r2.names.includes("list_bots"));
});

test("narrowing keeps the host-default extension with its guard: same name, same hooks and sections, never an explicit extensions list", () => {
  const exts = hostExtensions();
  const a7 = exts[0] as Extension;
  const narrowed = narrowExtension(a7, allowedToolSet(NARROW));
  assert.equal(narrowed.name, "a7");
  assert.equal(narrowed.hooks, a7.hooks);
  assert.equal(narrowed.sections, a7.sections);
  assert.deepEqual((narrowed.tools ?? []).map((t) => t.name).sort(), ["list_dir", "read_file", "search_files", "system_facts"]);
  assert.equal((a7.tools ?? []).length, 7, "the original extension is not modified");
  const reg = buildBotRegistry(exts, NARROW);
  assert.ok(checkBotRegistry(reg, NARROW, { guardExtension: "a7" }).hookExtensions.includes("a7"));
  assert.equal(checkBotRegistry(reg, NARROW, { guardExtension: "nonexistent" }).ok, false, "a missing guard extension fails the check");
  // an extension with no tools is installed unchanged
  const bare = defineExtension({ name: "bare" });
  assert.equal(narrowExtension(bare, new Set()), bare);
});

test("every bot has its own registry: two bots never share tools or hooks", () => {
  const a = buildBotRegistry(hostExtensions(), FULL);
  const b = buildBotRegistry(hostExtensions(), NARROW);
  assert.notEqual(a, b);
  assert.ok(a.snapshot().tools().length > b.snapshot().tools().length);
  assert.equal(b.snapshot().tools().some((x) => x.tool.name === "shell"), false);
  assert.equal(a.snapshot().tools().some((x) => x.tool.name === "shell"), true);
});

test("the check catches a registry that is not narrowed, a bus tool without an edge and a non-deferred extra tool", () => {
  const wide = createRegistry();
  for (const e of hostExtensions()) wide.install(e);
  const r = checkBotRegistry(wide, NARROW);
  assert.equal(r.ok, false);
  assert.ok(r.stray.includes("shell"));
  assert.ok(r.busWithoutEdge.includes("ask_bot"));
  const loud = createRegistry();
  loud.install(defineExtension({ name: "loud", tools: [defineTool({ name: "ask_bot", description: "x", parameters: Type.Object({}), execute: async () => ({ output: [] }) }) as unknown as ToolRegistration] }));
  const withEdge = { tools: ["ask_bot"], edges: EDGE };
  const r2 = checkBotRegistry(loud, withEdge);
  assert.equal(r2.ok, false, "a bus tool that is not deferred breaks I27");
  assert.ok(r2.unexpected.includes("ask_bot"));
});

test("MCP tools: mcp__* and mcp__<server>__* entries narrow by prefix, an exact name matches only itself", () => {
  const allow = (...a: string[]) => new Set(a);
  assert.equal(toolAllowed(allow("mcp__*"), "mcp__vibetts__speak"), true);
  assert.equal(toolAllowed(allow("mcp__vibetts__*"), "mcp__vibetts__speak"), true);
  assert.equal(toolAllowed(allow("mcp__vibetts__*"), "mcp__flow-music-mcp__make_music"), false);
  assert.equal(toolAllowed(allow("mcp__vibetts__speak"), "mcp__vibetts__speak"), true);
  assert.equal(toolAllowed(allow("mcp__vibetts__speak"), "mcp__vibetts__other"), false);
  assert.equal(toolAllowed(allow("mcp__*"), "shell"), false, "mcp__* never allows a non-MCP tool");
  const bot = { tools: ["tool_search", "mcp__vibetts__*"], edges: [] as typeof EDGE };
  const r = checkBotRegistry(buildBotRegistry(hostExtensions(), bot), bot);
  assert.deepEqual([...r.names].sort(), ["mcp__vibetts__speak", "tool_search"]);
  assert.equal(r.ok, true);
  // the full allowlist keeps the MCP tools, the narrow one drops them
  assert.ok(checkBotRegistry(buildBotRegistry(hostExtensions(), FULL), FULL).names.includes("mcp__vibetts__speak"));
  assert.ok(!checkBotRegistry(buildBotRegistry(hostExtensions(), NARROW), NARROW).names.includes("mcp__vibetts__speak"));
});
