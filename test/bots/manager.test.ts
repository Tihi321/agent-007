/**
 * S20.2 done-check (fake factory): start, stop one bot, a duplicate token refused, a 409, a failed bot that does not stop the others,
 * each runtime gets only its own token, one kill switch for the host, one single-instance lock.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createKillSwitch } from "../../src/approval/killSwitch.js";
import { BotManager, botLogger } from "../../src/bots/manager.js";
import type { BotFactory, BotLifecycle, BotRuntimeContext } from "../../src/bots/manager.js";
import { parseBots } from "../../src/bots/schema.js";
import type { ResolvedBot } from "../../src/bots/schema.js";
import { createRedactor } from "../../src/logging/redact.js";
import { LockHeldError } from "../../src/runtime/lock.js";
import { TokenInUseError } from "../../src/telegram/bot.js";
import { fakeKillSwitch, memoryLogger } from "../telegram/helpers/fakeTelegram.js";
import { cleanup, tempBase } from "../tools/fixture.js";
import { NOTES, READ_ONLY_TOOLS, bot, research } from "./helpers.js";

const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

const TOKENS: Record<string, string> = { main: "111:MAIN-token-aaaaaaaaaaaaaaaaaaaa", research: "222:RESEARCH-token-bbbbbbbbbbbbbbbb", ops: "333:OPS-token-cccccccccccccccccccc" };

function bots(...ids: string[]): ResolvedBot[] {
  const doc = Object.fromEntries(ids.map((id) => [id, id === "main" ? bot() : research({ telegramTokenRef: id, tools: [...READ_ONLY_TOOLS] })]));
  return parseBots({ bots: doc, presets: [{ id: "lmstudio", kind: "local", runner: "lmstudio", modelId: "m", contextWindow: 8192, maxTokens: 512, label: "LM" }] }, { folderAllow: [{ alias: "notes", path: NOTES }], derivedPresets: [], defaultPreset: "lmstudio" }).bots;
}

interface Fake extends BotLifecycle {
  id: string;
  events: string[];
  ctx: BotRuntimeContext;
}

function harness(opts: { failStart?: Record<string, unknown>; failFactory?: Set<string> } = {}) {
  const made = new Map<string, Fake>();
  const calls: BotRuntimeContext[] = [];
  const factory: BotFactory = async (ctx) => {
    calls.push(ctx);
    if (opts.failFactory?.has(ctx.spec.id)) throw new Error(`cannot open storage for ${ctx.spec.id} with token ${ctx.token}`);
    const f: Fake = {
      id: ctx.spec.id,
      events: [],
      ctx,
      async start() {
        f.events.push("start");
        const fail = opts.failStart?.[ctx.spec.id];
        if (fail) throw fail;
      },
      async stop() {
        f.events.push("stop");
      },
    };
    made.set(ctx.spec.id, f);
    return f;
  };
  return { made, calls, factory };
}

function manager(ids: string[], h: ReturnType<typeof harness>, extra: Partial<ConstructorParameters<typeof BotManager>[0]> = {}) {
  const log = memoryLogger();
  const redact = createRedactor(Object.values(TOKENS));
  const m = new BotManager({ bots: bots(...ids), tokenFor: (ref) => TOKENS[ref], factory: h.factory, killSwitch: fakeKillSwitch(), logger: log, redact, ...extra });
  return { m, log };
}

test("every bot starts, is running, and can be stopped alone while the others keep running", async () => {
  const h = harness();
  const { m } = manager(["main", "research", "ops"], h);
  const st = await m.start();
  assert.deepEqual(st.map((s) => [s.id, s.state]), [["main", "running"], ["research", "running"], ["ops", "running"]]);
  await m.stopBot("research");
  assert.equal(m.status("research")?.state, "stopped");
  assert.deepEqual(h.made.get("research")!.events, ["start", "stop"]);
  assert.deepEqual(h.made.get("main")!.events, ["start"]);
  assert.deepEqual(m.running().sort(), ["main", "ops"]);
  const again = await m.startBot("research");
  assert.equal(again.state, "running");
  assert.equal(h.calls.filter((c) => c.spec.id === "research").length, 2, "a restart builds a new runtime");
  await m.stop();
  assert.ok([...h.made.values()].every((f) => f.events.at(-1) === "stop"));
  assert.deepEqual(m.running(), []);
});

test("each runtime receives only its own token", async () => {
  const h = harness();
  const { m } = manager(["main", "research", "ops"], h);
  await m.start();
  for (const c of h.calls) {
    assert.equal(c.token, TOKENS[c.spec.telegramTokenRef]);
    const visible = JSON.stringify({ ...c, killSwitch: undefined });
    for (const [ref, tok] of Object.entries(TOKENS)) if (ref !== c.spec.telegramTokenRef) assert.ok(!visible.includes(tok), `the context of ${c.spec.id} holds the token of ${ref}`);
  }
  // the status never carries a token
  assert.ok(!JSON.stringify(m.status()).includes("token-"));
  await m.stop();
});

test("a failed bot does not stop the others; the error text is redacted", async () => {
  const h = harness({ failFactory: new Set(["research"]), failStart: { ops: new Error(`getMe failed for ${TOKENS["ops"]}`) } });
  const { m, log } = manager(["main", "research", "ops"], h);
  const st = await m.start();
  assert.equal(st.find((s) => s.id === "main")?.state, "running");
  const r = st.find((s) => s.id === "research")!;
  const o = st.find((s) => s.id === "ops")!;
  assert.equal(r.state, "failed");
  assert.equal(r.reason, "error");
  assert.equal(o.state, "failed");
  assert.ok(!JSON.stringify(st).includes("RESEARCH-token") && !JSON.stringify(st).includes("OPS-token"), "tokens are redacted in the status");
  assert.ok(!JSON.stringify(log.lines).includes("OPS-token"), "and in the log");
  assert.deepEqual(h.made.get("ops")!.events, ["start", "stop"], "a runtime whose start failed is stopped");
  assert.deepEqual(m.running(), ["main"]);
  await m.stop();
});

test("a duplicate token is refused for the second bot; no runtime is built for it", async () => {
  const h = harness();
  const m = new BotManager({ bots: bots("main", "research"), tokenFor: () => TOKENS["main"], factory: h.factory, killSwitch: fakeKillSwitch(), logger: memoryLogger() });
  const st = await m.start();
  assert.equal(st.find((s) => s.id === "main")?.state, "running");
  const r = st.find((s) => s.id === "research")!;
  assert.equal(r.state, "failed");
  assert.equal(r.reason, "duplicate_token");
  assert.deepEqual(h.calls.map((c) => c.spec.id), ["main"]);
  await m.stop();
});

test("a 409 at start is reported as token in use elsewhere, and the other bots run", async () => {
  const h = harness({ failStart: { research: new TokenInUseError() } });
  const { m } = manager(["main", "research"], h);
  const st = await m.start();
  const r = st.find((s) => s.id === "research")!;
  assert.equal(r.state, "failed");
  assert.equal(r.reason, "token_in_use");
  assert.match(r.detail ?? "", /token in use elsewhere/);
  assert.equal(st.find((s) => s.id === "main")?.state, "running");
  await m.stop();
});

test("a 409 from the long poll after the start is reported the same way", async () => {
  const h = harness();
  const { m, log } = manager(["main", "research"], h);
  await m.start();
  h.made.get("research")!.ctx.reportFailure({ kind: "token_in_use", error: new Error("409") });
  assert.equal(m.status("research")?.state, "failed");
  assert.equal(m.status("research")?.reason, "token_in_use");
  assert.equal(m.status("main")?.state, "running");
  assert.ok(log.events("bots.bot_failed").some((l) => (l.fields as { bot?: string }).bot === "research"));
  h.made.get("main")!.ctx.reportFailure({ kind: "other", error: new Error(`poll died ${TOKENS["main"]}`) });
  assert.equal(m.status("main")?.reason, "error");
  assert.ok(!(m.status("main")?.detail ?? "").includes("MAIN-token"));
  await m.stop();
});

test("a bot with no token, or one that fails its start-up check, is refused alone", async () => {
  const h = harness();
  const { m } = manager(["main", "research", "ops"], h, { tokenFor: (ref) => (ref === "ops" ? undefined : TOKENS[ref]), preflight: (b) => (b.id === "research" ? "run scripts\\migrate-bots first" : undefined) });
  const st = await m.start();
  assert.equal(st.find((s) => s.id === "ops")?.reason, "no_token");
  assert.equal(st.find((s) => s.id === "research")?.reason, "not_migrated");
  assert.match(st.find((s) => s.id === "research")?.detail ?? "", /migrate-bots/);
  assert.equal(st.find((s) => s.id === "main")?.state, "running");
  assert.deepEqual(h.calls.map((c) => c.spec.id), ["main"]);
  await m.stop();
});

test("one kill switch for the host: every runtime gets the same handle, and one /killshell turns shell off in every bot", async () => {
  const dir = tempBase("bots-kill");
  dirs.push(dir);
  const h = harness();
  const ks = createKillSwitch({ controlDir: join(dir, "control"), shellEnabled: () => true });
  const { m } = manager(["main", "research"], h, { killSwitch: ks });
  await m.start();
  const [a, b] = [h.made.get("main")!.ctx.killSwitch, h.made.get("research")!.ctx.killSwitch];
  assert.equal(a, b, "one object");
  assert.equal(a.isOn() || b.isOn(), false);
  await b.turnOn("telegram:research"); // /killshell typed in the research bot
  assert.equal(a.isOn(), true, "shell is off in main too");
  assert.equal(existsSync(ks.flagPath), true, "the one flag file");
  await m.engageKillSwitch("operator");
  await m.stop();
});

test("one single-instance lock for the host: a second manager on the same lock file is refused until the first stops", async () => {
  const dir = tempBase("bots-lock");
  dirs.push(dir);
  const lockPath = join(dir, "run", "agent.lock");
  const h1 = harness();
  const h2 = harness();
  const a = manager(["main"], h1, { lockPath, lockOptions: { pid: 910001, isAlive: () => true } }).m;
  const b = manager(["main"], h2, { lockPath, lockOptions: { pid: 910002, isAlive: () => true } }).m;
  await a.start();
  assert.equal(existsSync(lockPath), true);
  await assert.rejects(b.start(), LockHeldError);
  assert.equal(h2.calls.length, 0, "no bot of the second host was built");
  await a.stop();
  assert.equal(existsSync(lockPath), false, "released");
  await b.start();
  await b.stop();
  // a lock the entry point already holds is not taken twice and is not released by the manager
  let released = 0;
  const host = manager(["main"], harness(), { lock: { path: "x", release: () => void released++ } }).m;
  await host.start();
  await host.stop();
  assert.equal(released, 0);
});

test("botLogger adds the bot id to every line", () => {
  const log = memoryLogger();
  const l = botLogger(log, "ops");
  l.info("x", { a: 1 });
  l.warn("y");
  assert.deepEqual(log.lines.map((x) => x.fields), [{ bot: "ops", a: 1 }, { bot: "ops" }]);
});
