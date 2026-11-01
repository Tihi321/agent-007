import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { PersonaResolver } from "../../src/personas/resolver.js";
import { BACKGROUND_CONTEXT, Harness, createRegistry, createRunnerModels, openNodeSqliteStorage } from "../../src/pi/adapter.js";
import { SettingsError } from "../../src/settings/contracts.js";
import { defaultEffective } from "../../src/settings/ceiling.js";
import { draft, personaFixture, security } from "./helpers.js";

test("with only the built-ins the effective set equals the ceiling (the Phase 2 tool set); readonly is narrower", () => {
  const f = personaFixture();
  const e = f.resolver.effective("7");
  assert.equal(f.resolver.current("7"), "default");
  assert.deepEqual(e, defaultEffective(f.ceiling()));
  assert.deepEqual([...e.tools].sort(), [...f.ceiling().tools].sort());
  assert.equal(f.resolver.resolve("7").fallback, false);
  assert.equal(f.resolver.noticeFor("7"), undefined);
  f.cleanup();
});

test("new chats start with prefs.defaultPersona; an explicit choice wins; /new (a new conversation of the same chat) keeps it", async () => {
  const f = personaFixture({ defaultPersona: "readonly" });
  assert.equal(f.resolver.current("7"), "readonly", "a new chat starts with the default persona of the prefs");
  f.write("user", draft({ id: "research" }));
  await f.resolver.apply("7", "research");
  assert.equal(f.resolver.current("7"), "research");
  f.chatOf.set("9", 4242); // /new: another conversation id, the same chat
  assert.equal(f.resolver.current("9"), "research", "/new keeps the persona");
  f.chatOf.set("10", 777);
  assert.equal(f.resolver.current("10"), "readonly", "another chat is not affected");
  await assert.rejects(f.resolver.apply("7", "ghost"), (e: unknown) => e instanceof SettingsError && e.code === "unknown_persona");
  f.cleanup();
});

test("an invalid active persona runs as readonly with exactly one notice, and never falls back to default", async () => {
  const f = personaFixture();
  f.write("user", draft({ id: "ops", toolAllow: ["shell", "read_file"] }));
  await f.resolver.apply("7", "ops");
  assert.equal(f.resolver.resolve("7").personaId, "ops");
  assert.equal(f.resolver.noticeFor("7"), undefined);
  f.sec.v = security({ shell: { enabled: false } }); // a security narrowing
  const r = f.resolver.resolve("7");
  assert.equal(r.personaId, "readonly");
  assert.equal(r.requested, "ops");
  assert.equal(r.fallback, true);
  assert.ok(!r.effective.tools.includes("shell") && !r.effective.tools.includes("write_file"));
  assert.deepEqual(r.effective.memory, { write: "none", sharedRead: true });
  const notice = f.resolver.noticeFor("7");
  assert.match(notice ?? "", /The "ops" persona cannot be used right now \(.*shell is turned off.*\), so I am running in the read-only persona/);
  for (let i = 0; i < 5; i++) {
    f.resolver.resolve("7");
    assert.equal(f.resolver.noticeFor("7"), undefined, "exactly one notice");
  }
  assert.equal(f.resolver.current("7"), "ops", "the choice is kept; it is only not usable");
  await assert.rejects(f.resolver.apply("7", "ops"), (e: unknown) => e instanceof SettingsError && e.code === "persona_invalid");
  // a missing persona file fails closed the same way, and when it is fixed the notice can come again for a new problem
  f.sec.v = security();
  assert.equal(f.resolver.resolve("7").personaId, "ops");
  f.sec.v = security({ shell: { enabled: false } });
  f.resolver.resolve("7");
  assert.match(f.resolver.noticeFor("7") ?? "", /read-only persona/, "a new episode gets its own notice");
  f.cleanup();
});

test("a prefs default persona that does not exist fails closed to readonly with a notice", () => {
  const f = personaFixture({ defaultPersona: "ghost" });
  const r = f.resolver.resolve("7");
  assert.equal(r.personaId, "readonly");
  assert.match(f.resolver.noticeFor("7") ?? "", /"ghost" persona cannot be used right now \(the persona does not exist\)/);
  f.cleanup();
});

test("the PersonaMap survives reopening the storage; the job count is durable, per persona, and resets at local midnight", async () => {
  const f = personaFixture();
  f.write("user", draft({ id: "research", budgets: { maxJobsPerDay: 2 }, jobTemplates: ["tts-line"] }));
  const sqlite = join(f.dir, "agent.sqlite");
  const open = async (): Promise<Harness> => {
    const { models } = createRunnerModels({ id: "lmstudio", baseUrl: "http://127.0.0.1:9/v1", modelId: "m", apiKey: "k", contextWindow: 8192, maxTokens: 256 });
    return Harness.open(await openNodeSqliteStorage(sqlite), { models, registry: createRegistry(), settings: {} }, BACKGROUND_CONTEXT);
  };
  let h = await open();
  const mk = () =>
    new PersonaResolver({ store: f.store, ceiling: f.ceiling, chats: { chatForConversation: (id) => f.chatOf.get(id) }, prefs: f.prefs, getHarness: () => h, now: () => f.clock.t });
  let r = mk();
  await r.load();
  await r.apply("7", "research");
  assert.deepEqual(await r.countJob("7"), { ok: true, used: 1, max: 2 });
  await h.close(BACKGROUND_CONTEXT);
  h = await open();
  r = mk();
  await r.load();
  assert.equal(r.current("7"), "research", "the choice survived the restart");
  assert.deepEqual(await r.countJob("7"), { ok: true, used: 2, max: 2 });
  assert.deepEqual(await r.countJob("7"), { ok: false, used: 2, max: 2 }, "the third is over the limit");
  f.clock.t += 24 * 3600 * 1000; // the next local day
  assert.deepEqual(await r.countJob("7"), { ok: true, used: 1, max: 2 }, "resets at midnight");
  await r.apply("7", "default");
  assert.deepEqual(await r.countJob("7"), { ok: true, used: 0 }, "the default persona is not counted here");
  await h.close(BACKGROUND_CONTEXT);
  f.cleanup();
});

test("memoryFor: scope, shared and none follow the persona", async () => {
  const f = personaFixture();
  f.write("user", draft({ id: "research" })); // scope research
  f.write("user", draft({ id: "quiet", memory: { write: "none", sharedRead: false } }));
  assert.deepEqual(f.resolver.memoryFor("7"), { personaId: "default", write: "shared", sharedRead: true });
  await f.resolver.apply("7", "research");
  assert.deepEqual(f.resolver.memoryFor("7"), { personaId: "research", write: "scope", scope: "research", sharedRead: true });
  await f.resolver.apply("7", "quiet");
  assert.deepEqual(f.resolver.memoryFor("7"), { personaId: "quiet", write: "none", sharedRead: false });
  f.cleanup();
});
