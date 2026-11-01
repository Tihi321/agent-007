import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { PersonaApplier, allowedToolNames } from "../../src/personas/apply.js";
import type { PresetModel } from "../../src/personas/apply.js";
import { BACKGROUND_CONTEXT, Harness, ToolTask, Type, createRegistry, createRunnerModels, createToolSearchExtension, defineExtension, defineTool, hook, openNodeSqliteStorage } from "../../src/pi/adapter.js";
import type { AgentChange, Conversation, Extension, Registry } from "../../src/pi/adapter.js";
import { SettingsError } from "../../src/settings/contracts.js";
import { READONLY_TOOLS } from "../../src/settings/catalog.js";
import { draft, personaFixture } from "./helpers.js";

const tool = (name: string, deferred = false) =>
  defineTool({
    name,
    description: `the ${name} tool`,
    parameters: Type.Object({}),
    ...(deferred ? { deferred: true as const } : {}),
    execute: async () => ({ output: [{ type: "text" as const, text: "ok" }] }),
  });

const NAMES = ["tool_search", "system_facts", "list_dir", "read_file", "list_templates", "job_status", "shell", "write_file", "remember", "search_files"];
const DEFERRED = new Set(["shell", "write_file", "remember", "search_files"]);

function a7(withHook: boolean): Extension {
  return defineExtension({
    name: "a7",
    tools: NAMES.filter((n) => n !== "tool_search").map((n) => tool(n, DEFERRED.has(n))),
    ...(withHook ? { hooks: [hook(ToolTask, { beforeTool: async () => undefined })] } : {}),
  }) as Extension;
}

interface Rig {
  f: ReturnType<typeof personaFixture>;
  h: Harness;
  conv: Conversation;
  registry: Registry;
  calls: AgentChange[];
  spy: Conversation;
  applier: PersonaApplier;
  preset: { up: boolean };
  dir: string;
}

async function rig(opts: { hook?: boolean } = {}): Promise<Rig> {
  const f = personaFixture();
  const { models } = createRunnerModels({ id: "lmstudio", baseUrl: "http://127.0.0.1:9/v1", modelId: "m", apiKey: "k", contextWindow: 8192, maxTokens: 256 });
  const registry = createRegistry();
  registry.install(a7(opts.hook ?? true));
  registry.install(createToolSearchExtension() as Extension);
  const h = await Harness.open(await openNodeSqliteStorage(join(f.dir, "a.sqlite")), { models, registry, settings: {} }, BACKGROUND_CONTEXT);
  const conv = await h.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "lmstudio", modelId: "m" } } }, BACKGROUND_CONTEXT);
  f.chatOf.set(String(conv.id), 4242);
  const calls: AgentChange[] = [];
  const spy = {
    id: conv.id,
    agent: (c: typeof BACKGROUND_CONTEXT) => conv.agent(c),
    configure: (change: AgentChange, c: typeof BACKGROUND_CONTEXT) => {
      calls.push(change);
      return conv.configure(change, c);
    },
  } as unknown as Conversation;
  const preset = { up: true };
  const applier = new PersonaApplier({
    resolver: f.resolver,
    registry: () => registry,
    getConversation: async () => spy,
    baseModel: { provider: "lmstudio", modelId: "m" },
    presetModel: (id): PresetModel | undefined => (id === "strata" ? { ref: { provider: "strata", modelId: "s" }, up: async () => preset.up } : undefined),
    guardExtension: "a7",
  });
  return { f, h, conv, registry, calls, spy, applier, preset, dir: f.dir };
}

const toolNames = async (r: Rig): Promise<{ offered: string[]; deferred: string[] }> => {
  const a = await r.conv.agent(BACKGROUND_CONTEXT);
  return { offered: a.tools.map((t) => t.name).sort(), deferred: a.deferred.map((t) => t.name).sort() };
};

test("the default persona is never configured (a no-persona install behaves exactly as Phase 2)", async () => {
  const r = await rig();
  try {
    const before = await toolNames(r);
    assert.deepEqual(await r.applier.ensureApplied(String(r.conv.id), r.spy), {});
    assert.deepEqual(r.calls, [], "configure() was not called");
    assert.deepEqual(await toolNames(r), before);
    assert.ok(before.offered.includes("tool_search") && before.deferred.includes("shell"), "the host default offers tool_search and can load shell");
  } finally {
    await r.h.close(BACKGROUND_CONTEXT);
    r.f.cleanup();
  }
});

test("a persona without shell: the tool is hidden from the model AND from the tool_search index (U43b), the guard hook is still active, and configure never gets `extensions`", async () => {
  const r = await rig();
  try {
    await r.f.resolver.apply(String(r.conv.id), "readonly");
    assert.equal(r.calls.length, 1);
    assert.ok(!("extensions" in r.calls[0]!), "extensions is never passed (footgun 30)");
    assert.ok(Array.isArray(r.calls[0]!.tools));
    const { offered, deferred } = await toolNames(r);
    const allowed = [...allowedToolNames(r.f.resolver.effective(String(r.conv.id)))];
    assert.ok(offered.every((n) => allowed.includes(n)), `offered ${offered.join()} is within ${allowed.join()}`);
    assert.deepEqual(deferred, ["search_files"].filter((n) => allowed.includes(n)), "tool_search can load only what the persona allows");
    for (const hidden of ["shell", "write_file", "remember"]) assert.ok(!offered.includes(hidden) && !deferred.includes(hidden), `${hidden} is hidden`);
    const agent = await r.conv.agent(BACKGROUND_CONTEXT);
    const guard = agent.extensions.find((e) => e.name === "a7");
    assert.ok(guard && (guard.hooks ?? []).length === 1, "the hook is active after configure");
    // the applied state is cached: the next turn does not configure again
    await r.applier.ensureApplied(String(r.conv.id), r.spy);
    assert.equal(r.calls.length, 1);
    assert.ok(READONLY_TOOLS.includes("tool_search"));
  } finally {
    await r.h.close(BACKGROUND_CONTEXT);
    r.f.cleanup();
  }
});

test("switching back to default undoes the narrowing (also after a restart, when nothing is cached)", async () => {
  const r = await rig();
  try {
    const id = String(r.conv.id);
    await r.f.resolver.apply(id, "readonly");
    assert.ok(!(await toolNames(r)).deferred.includes("shell"));
    await r.f.resolver.apply(id, "default");
    const last = r.calls.at(-1)!;
    assert.equal(last.tools, null);
    assert.equal(last.instructions, null);
    assert.ok((await toolNames(r)).deferred.includes("shell"), "shell can be loaded again");
    // "restart": a fresh applier has no cache; an explicit switch to default still resets the conversation
    await r.f.resolver.apply(id, "readonly");
    const fresh = new PersonaApplier({ resolver: r.f.resolver, registry: () => r.registry, getConversation: async () => r.spy, baseModel: { provider: "lmstudio", modelId: "m" }, guardExtension: "a7" });
    const n = r.calls.length;
    await r.f.resolver.apply(id, "default");
    assert.equal(r.calls.length, n + 1);
    assert.ok(fresh);
  } finally {
    await r.h.close(BACKGROUND_CONTEXT);
    r.f.cleanup();
  }
});

test("if the guard hook is not present after configure, the change is reverted and the turn is refused", async () => {
  const r = await rig({ hook: false });
  try {
    await assert.rejects(r.f.resolver.apply(String(r.conv.id), "readonly"), (e: unknown) => e instanceof SettingsError && /could not be applied safely/.test(e.message));
    const last = r.calls.at(-1)!;
    assert.equal(last.tools, null, "reverted to the host default");
    assert.ok((await toolNames(r)).deferred.includes("shell"));
    await assert.rejects(r.applier.ensureApplied(String(r.conv.id), r.spy), (e: unknown) => e instanceof SettingsError);
  } finally {
    await r.h.close(BACKGROUND_CONTEXT);
    r.f.cleanup();
  }
});

test("a persona whose model preset is on a runner that is not running refuses the switch (no silent fallback); when it runs the model is switched", async () => {
  const r = await rig();
  try {
    r.f.write("user", draft({ id: "other", modelPreset: "strata" }));
    const id = String(r.conv.id);
    r.preset.up = false;
    await assert.rejects(r.f.resolver.apply(id, "other"), (e: unknown) => e instanceof SettingsError && /runner that is not running \(strata\)/.test(e.message));
    assert.equal(r.calls.length, 0, "nothing was configured");
    r.preset.up = true;
    await r.f.resolver.apply(id, "other");
    assert.deepEqual(r.calls.at(-1)?.model, { provider: "strata", modelId: "s" });
    await r.f.resolver.apply(id, "default");
    assert.deepEqual(r.calls.at(-1)?.model, { provider: "lmstudio", modelId: "m" }, "back on the base model");
  } finally {
    await r.h.close(BACKGROUND_CONTEXT);
    r.f.cleanup();
  }
});

test("a persona's model preset applies only on a user switch; after a restart the base model (bots.<id>.activePreset) wins and the runner check is skipped", async () => {
  const r = await rig();
  try {
    r.f.write("user", draft({ id: "other", modelPreset: "strata" }));
    const id = String(r.conv.id);
    await r.f.resolver.apply(id, "other");
    assert.deepEqual(r.calls.at(-1)?.model, { provider: "strata", modelId: "s" }, "the user switch uses the persona's preset");
    // "restart": a fresh applier has no cache and the persona is still the chat's persona; the runner of the preset is down
    r.preset.up = false;
    const base = { provider: "lmstudio", modelId: "active-preset-model" };
    const fresh = new PersonaApplier({
      resolver: r.f.resolver,
      registry: () => r.registry,
      getConversation: async () => r.spy,
      baseModel: base,
      presetModel: (pid): PresetModel | undefined => (pid === "strata" ? { ref: { provider: "strata", modelId: "s" }, up: async () => r.preset.up } : undefined),
      guardExtension: "a7",
    });
    const n = r.calls.length;
    await fresh.ensureApplied(id, r.spy);
    assert.equal(r.calls.length, n + 1, "the tool set was applied");
    assert.deepEqual(r.calls.at(-1)?.model, base, "the persona did not overwrite the active preset's model");
  } finally {
    await r.h.close(BACKGROUND_CONTEXT);
    r.f.cleanup();
  }
});

test("a persona that omits the tool of the approval gate still runs with the gate (the hook is not a tool)", async () => {
  const r = await rig();
  try {
    r.f.write("user", draft({ id: "tiny", toolAllow: ["read_file"], memory: { write: "none", sharedRead: false } }));
    await r.f.resolver.apply(String(r.conv.id), "tiny");
    const { offered } = await toolNames(r);
    assert.deepEqual(offered, ["read_file"]);
    const agent = await r.conv.agent(BACKGROUND_CONTEXT);
    assert.equal(agent.extensions.find((e) => e.name === "a7")?.hooks?.length, 1);
  } finally {
    await r.h.close(BACKGROUND_CONTEXT);
    r.f.cleanup();
  }
});
