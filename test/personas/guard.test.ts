import assert from "node:assert/strict";
import { test } from "node:test";
import { createPersonaGuard } from "../../src/personas/guard.js";
import type { BeforeToolHandler, Context, HookApi, ToolHookCall } from "../../src/pi/adapter.js";
import { draft, personaFixture } from "./helpers.js";

type Verdict = { block: string } | undefined;
const run = (g: BeforeToolHandler, name: string, args: Record<string, unknown> = {}, conv = "7"): Promise<Verdict> =>
  (g as unknown as (c: ToolHookCall, a: HookApi, x: Context) => Promise<Verdict>)({ id: "c1", name, arguments: args, type: "toolCall" } as unknown as ToolHookCall, { conversationId: conv } as unknown as HookApi, {} as Context);

test("the default persona is never blocked by the guard (it is the Phase 1/2 behaviour)", async () => {
  const f = personaFixture();
  const g = createPersonaGuard({ resolver: f.resolver });
  for (const name of ["shell", "write_file", "remember", "teleport", "mcp__anything__x"]) assert.equal(await run(g, name), undefined, name);
  f.cleanup();
});

test("a persona without shell cannot run it: a forced call is blocked with the persona named", async () => {
  const f = personaFixture();
  f.write("user", draft({ id: "research", name: "Research", toolAllow: ["read_file", "list_dir"] }));
  await f.resolver.apply("7", "research");
  const g = createPersonaGuard({ resolver: f.resolver });
  const v = await run(g, "shell", { command: "whoami", reason: "x" });
  assert.match(v?.block ?? "", /^Blocked: the Research persona does not allow the tool shell\./);
  assert.equal(await run(g, "read_file", { path: "notes:a" }), undefined);
  assert.match((await run(g, "write_file"))?.block ?? "", /does not allow the tool write_file/);
  assert.match((await run(g, "propose_setting"))?.block ?? "", /does not allow/);
  f.cleanup();
});

test("an unknown tool name is blocked in every persona except default; an MCP tool is judged by the persona's per-server list", async () => {
  const f = personaFixture();
  f.write("user", draft({ id: "research", toolAllow: ["read_file"], mcpAllow: { vibetts: ["speak"] } }));
  await f.resolver.apply("7", "research");
  const g = createPersonaGuard({ resolver: f.resolver });
  assert.match((await run(g, "teleport"))?.block ?? "", /not known to the persona rules/);
  assert.equal(await run(g, "mcp__vibetts__speak"), undefined);
  assert.match((await run(g, "mcp__vibetts__list_voices"))?.block ?? "", /does not allow the tool mcp__vibetts__list_voices/);
  assert.match((await run(g, "mcp__other__speak"))?.block ?? "", /does not allow/);
  f.cleanup();
});

test("dispatch_job: a template outside jobTemplates is blocked; maxJobsPerDay is enforced after N and resets at midnight (fake clock)", async () => {
  const f = personaFixture();
  f.write("user", draft({ id: "maker", toolAllow: ["dispatch_job", "read_file"], jobTemplates: ["tts-line", "list-runs"], budgets: { maxJobsPerDay: 2 } }));
  await f.resolver.apply("7", "maker");
  const g = createPersonaGuard({ resolver: f.resolver });
  assert.match((await run(g, "dispatch_job", { templateId: "visual-novel-from-idea" }))?.block ?? "", /may not dispatch the job template "visual-novel-from-idea"/);
  assert.match((await run(g, "dispatch_job", {}))?.block ?? "", /may not dispatch/);
  assert.equal(await run(g, "dispatch_job", { templateId: "tts-line" }), undefined);
  assert.equal(await run(g, "dispatch_job", { templateId: "list-runs" }), undefined);
  assert.match((await run(g, "dispatch_job", { templateId: "tts-line" }))?.block ?? "", /used its 2 jobs for today/);
  f.clock.t += 24 * 3600 * 1000;
  assert.equal(await run(g, "dispatch_job", { templateId: "tts-line" }), undefined, "a new day");
  f.cleanup();
});

test("remember is blocked when the persona's memory writes are off, even if the tool is listed", async () => {
  const f = personaFixture();
  f.write("user", draft({ id: "quiet", toolAllow: ["remember", "read_file"], memory: { write: "none", sharedRead: true } }));
  await f.resolver.apply("7", "quiet");
  const g = createPersonaGuard({ resolver: f.resolver });
  assert.match((await run(g, "remember", { note: "x" }))?.block ?? "", /memory writes turned off/);
  f.cleanup();
});

test("an invalid active persona is judged as readonly: no shell, no writes", async () => {
  const f = personaFixture();
  f.write("user", draft({ id: "ops", toolAllow: ["shell", "write_file", "read_file"] }));
  await f.resolver.apply("7", "ops");
  const g = createPersonaGuard({ resolver: f.resolver });
  assert.equal(await run(g, "shell"), undefined, "valid now");
  f.sec.v = { ...f.sec.v, shell: { enabled: false } };
  const v = await run(g, "write_file");
  assert.match(v?.block ?? "", /the Read-only persona \(the "ops" persona is not usable\) does not allow the tool write_file/);
  assert.match((await run(g, "shell"))?.block ?? "", /Read-only persona/);
  assert.equal(await run(g, "read_file"), undefined);
  f.cleanup();
});
