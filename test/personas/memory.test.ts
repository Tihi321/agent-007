import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createMemoryPromptView, createMemoryTargetResolver, scopeFile } from "../../src/personas/memory.js";
import { MEMORY_MAX_BYTES, renderMemory } from "../../src/prompt/sections.js";
import type { PromptDeps } from "../../src/prompt/sections.js";
import { parsePersona } from "../../src/settings/personaSchema.js";
import { ToolRefusal } from "../../src/tools/folders.js";
import { createRemember } from "../../src/tools/memory.js";
import { draft, personaFixture } from "./helpers.js";

function rig() {
  const f = personaFixture();
  const memoryFile = join(f.dir, "memory", "MEMORY.md");
  mkdirSync(join(f.dir, "memory"), { recursive: true });
  f.chatOf.set("8", 5555);
  const notices: string[] = [];
  const remember = createRemember({ memoryFile, notifier: { notify: async (_c, t) => void notices.push(t) }, resolveTarget: createMemoryTargetResolver(f.resolver, memoryFile) });
  const deps: PromptDeps = {
    userFile: join(f.dir, "USER.md"),
    memoryFile,
    aliases: [],
    shellConfigured: true,
    modelId: "m",
    memoryFor: createMemoryPromptView(f.resolver, memoryFile),
  };
  return { f, memoryFile, notices, remember, deps };
}

test("two scopes are isolated: A's note is absent from B's file and prompt, and the announcement names the scope", async () => {
  const { f, memoryFile, notices, remember, deps } = rig();
  f.write("user", draft({ id: "alpha", memory: { write: "scope", scope: "alpha", sharedRead: false } }));
  f.write("user", draft({ id: "beta", memory: { write: "scope", scope: "beta", sharedRead: false } }));
  await f.resolver.apply("7", "alpha");
  await f.resolver.apply("8", "beta");
  const a = await remember("7", "alpha likes tea");
  assert.equal(a.text, "Saved to memory (scope alpha): alpha likes tea");
  await remember("8", "beta likes coffee");
  assert.deepEqual(notices, ["Saved to memory (scope alpha): alpha likes tea", "Saved to memory (scope beta): beta likes coffee"]);
  assert.match(readFileSync(scopeFile(memoryFile, "alpha"), "utf8"), /alpha likes tea/);
  assert.ok(!/beta/.test(readFileSync(scopeFile(memoryFile, "alpha"), "utf8")));
  assert.ok(!/alpha/.test(readFileSync(scopeFile(memoryFile, "beta"), "utf8")));
  assert.equal(existsSync(memoryFile), false, "the shared file was not touched");
  const pa = await renderMemory(deps, "7");
  const pb = await renderMemory(deps, "8");
  assert.match(pa, /alpha likes tea/);
  assert.ok(!/beta likes coffee/.test(pa), "B's note is not in A's prompt");
  assert.match(pb, /beta likes coffee/);
  assert.ok(!/alpha likes tea/.test(pb));
  f.cleanup();
});

test("sharedRead: false leaves the shared file out of the prompt; true shows the scope file first, then the shared notes", async () => {
  const { f, memoryFile, remember, deps } = rig();
  writeFileSync(memoryFile, "- 2026-10-01: the user has a cat\n");
  f.write("user", draft({ id: "alpha", memory: { write: "scope", scope: "alpha", sharedRead: false } }));
  f.write("user", draft({ id: "gamma", memory: { write: "scope", scope: "gamma", sharedRead: true } }));
  await f.resolver.apply("7", "alpha");
  await remember("7", "alpha note");
  const hidden = await renderMemory(deps, "7");
  assert.ok(!/has a cat/.test(hidden));
  assert.match(hidden, /alpha note/);
  await f.resolver.apply("7", "gamma");
  await remember("7", "gamma note");
  const both = await renderMemory(deps, "7");
  assert.ok(both.indexOf("gamma note") < both.indexOf("has a cat"), "the scope file comes first");
  assert.match(both, /<untrusted_content source="MEMORY\.gamma\.md">/);
  assert.match(both, /<untrusted_content source="MEMORY\.md">/);
  f.cleanup();
});

test("write: none blocks remember; the default persona behaves as in Phase 1 (shared file, plain announcement)", async () => {
  const { f, memoryFile, notices, remember, deps } = rig();
  f.write("user", draft({ id: "quiet", memory: { write: "none", sharedRead: true } }));
  const first = await remember("7", "shared fact");
  assert.equal(first.text, "Saved to memory: shared fact");
  assert.match(readFileSync(memoryFile, "utf8"), /shared fact/);
  assert.deepEqual(notices, ["Saved to memory: shared fact"]);
  await f.resolver.apply("7", "quiet");
  await assert.rejects(remember("7", "blocked"), (e: unknown) => e instanceof ToolRefusal && /memory writes are turned off/.test(e.message));
  assert.ok(!/blocked/.test(readFileSync(memoryFile, "utf8")));
  assert.match(await renderMemory(deps, "7"), /shared fact/, "it may still read the shared notes");
  f.cleanup();
});

test("a scope name with .. or a separator is rejected at validation and by the path function; the combined prompt keeps the 16 KB cap", async () => {
  for (const scope of ["..", "../etc", "a/b", "a\\b", "A", "x".repeat(30), ""]) {
    assert.equal(parsePersona(draft({ memory: { write: "scope", scope, sharedRead: true } })).persona, undefined, JSON.stringify(scope));
    assert.throws(() => scopeFile("C:\\data\\memory\\MEMORY.md", scope), /not a valid name/);
  }
  assert.equal(scopeFile("C:\\data\\memory\\MEMORY.md", "research"), "C:\\data\\memory\\MEMORY.research.md");
  const { f, memoryFile, deps } = rig();
  f.write("user", draft({ id: "big", memory: { write: "scope", scope: "big", sharedRead: true } }));
  await f.resolver.apply("7", "big");
  writeFileSync(scopeFile(memoryFile, "big"), "- scope line\n".repeat(2000));
  writeFileSync(memoryFile, "- shared line\n".repeat(2000));
  const text = await renderMemory(deps, "7");
  assert.ok(Buffer.byteLength(text, "utf8") <= MEMORY_MAX_BYTES, `${Buffer.byteLength(text, "utf8")} bytes`);
  assert.match(text, /scope line/);
  assert.match(text, /shared line/);
  rmSync(f.dir, { recursive: true, force: true });
});
