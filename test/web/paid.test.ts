/**
 * M2 (plan section 0a item 6, I58): paid-route spending caps. A paid preset is off for every bot until the OWNER enables it for that bot
 * with a per-day and a per-month cap; usage is counted and audited; the cap is a hard stop with a clear message and the chain falls back.
 * Offline: the scripted engine stands in for the model, the real gateway and stores run.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { userPaths } from "../../src/web/paths.js";
import { totpAt, totpStep } from "../../src/web/totp.js";
import { BOT, ScriptedEngine, makeApp } from "./app.js";
import type { TestApp, Who } from "./app.js";

const PAID_CAPS = { presets: ["strata", "claude-api"] };

async function stepUpOwner(t: TestApp): Promise<void> {
  const ownerId = t.owner.userId;
  const sec = t.app.stack.box.open(t.app.stack.credentials.read().users[ownerId]!.password!.totpSealed, ownerId);
  t.clock.t += 31_000;
  if (!t.app.stack.sessions.resolve(t.owner.cookie.split("=")[1] as string, { ip: "x", ua: "t" })) {
    // the session idled out (a test jumped a day): sign the owner in again on the PC
    const li = await t.post(undefined, "/api/login/password", { login: "owner@example.com", password: "an owner password long", totpCode: totpAt(sec, totpStep(t.clock.t)) });
    assert.equal(li.status, 200, li.text);
    Object.assign(t.owner, { cookie: String(li.headers["set-cookie"]).split(";")[0], csrf: li.json().csrf });
    t.clock.t += 31_000;
  }
  t.app.stack.auth.stepUp(t.app.stack.sessions.resolve(t.owner.cookie.split("=")[1] as string, { ip: "x", ua: "t" })!, { totpCode: totpAt(sec, totpStep(t.clock.t)) }, { identity: { kind: "local" }, host: `localhost:${t.port}`, ip: "local", ua: "t" });
}

async function send(t: TestApp, who: Who, bot: string, text = "hello") {
  const r = await t.post(who, "/api/chat/send", { bot, text });
  if (r.status === 200) await t.app.chat.settle(who.userId, r.json().threadId);
  return r;
}

test("M2: a paid route is off by default for every bot; with no other link the turn is refused, with a fallback the chain answers and says why", async () => {
  const engine = new ScriptedEngine();
  const t = await makeApp({ engine });
  try {
    const alice = await t.addUser("alice@example.com", PAID_CAPS);
    const created = await t.post(alice, "/api/bots/create", { ...BOT, name: "Paid", preset: "claude-api", fallback: "strata" });
    assert.equal(created.status, 200, created.text);
    assert.ok(created.json().warnings.some((w: string) => /paid route.*owner enables it/.test(w)), "the editor is told it stays off");
    assert.deepEqual(created.json().bot.paid.map((p: { preset: string; enabled: boolean }) => [p.preset, p.enabled]), [["claude-api", false]]);
    const solo = (await t.post(alice, "/api/bots/create", { ...BOT, name: "Solo", preset: "claude-api" })).json().bot.id as string;
    // with a local fallback: answered by the local model, with a notice
    const r = await send(t, alice, created.json().bot.id);
    assert.equal(r.status, 200);
    assert.equal(engine.calls.at(-1)!.bot.route.primary, "strata");
    assert.ok(!engine.calls.at(-1)!.bot.route.allowed.includes("claude-api"));
    // no other link: refused, nothing stored, no model call
    const n = engine.calls.length;
    const refused = await send(t, alice, solo);
    assert.equal(refused.status, 403);
    assert.match(refused.json().message, /paid route that is switched off.*owner must enable it/);
    assert.equal(engine.calls.length, n);
    assert.equal((await t.post(alice, "/api/chat/threads", { bot: solo })).json().threads.length, 0, "nothing was stored for the refused turn");
  } finally {
    await t.close();
  }
});

test("M2: only the owner enables a paid route, per bot, with BOTH caps, after a fresh step-up; it is audited", async () => {
  const t = await makeApp();
  try {
    const alice = await t.addUser("alice@example.com", PAID_CAPS);
    const admin = await t.addUser("admin@example.com", PAID_CAPS, "admin");
    const bot = (await t.post(alice, "/api/bots/create", { ...BOT, name: "Paid", preset: "claude-api", fallback: "strata" })).json().bot.id as string;
    const body = { userId: alice.userId, botId: bot, preset: "claude-api", enabled: true, perDay: 100, perMonth: 1000 };
    assert.equal((await t.post(admin, "/api/admin/paid/set", body)).status, 403, "an admin cannot spend the owner's money");
    assert.equal((await t.post(alice, "/api/admin/paid/set", body)).status, 403);
    t.clock.t += 6 * 60_000; // the owner's step-up from addUser is stale now
    assert.equal((await t.post(t.owner, "/api/admin/paid/set", body)).status, 401, "a stale step-up is refused");
    await stepUpOwner(t);
    assert.equal((await t.post(t.owner, "/api/admin/paid/set", { ...body, perMonth: undefined })).status, 400, "both caps are required");
    assert.equal((await t.post(t.owner, "/api/admin/paid/set", { ...body, perDay: 2000 })).status, 400, "the day cap cannot exceed the month cap");
    assert.equal((await t.post(t.owner, "/api/admin/paid/set", { ...body, preset: "strata" })).status, 400, "not a paid route");
    assert.equal((await t.post(t.owner, "/api/admin/paid/set", { ...body, preset: "claude-sonnet" })).status, 404, "not in that bot's chain");
    assert.equal((await t.post(t.owner, "/api/admin/paid/set", { ...body, botId: "nope" })).status, 404);
    assert.equal((await t.post(t.owner, "/api/admin/paid/set", { ...body, userId: "__proto__" })).status, 404);
    const ok = await t.post(t.owner, "/api/admin/paid/set", body);
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual([ok.json().enabled, ok.json().perDay, ok.json().perMonth, ok.json().headroom], [true, 100, 1000, 100]);
    const list = (await t.post(t.owner, "/api/admin/paid/list", {})).json().routes;
    assert.deepEqual(list.map((x: { botId: string; preset: string; enabled: boolean }) => [x.botId, x.preset, x.enabled]), [[bot, "claude-api", true]]);
    assert.ok(t.audit.events.some((e) => e.kind === "paid_grant" && e.detail?.["enabled"] === true && e.detail?.["perDay"] === 100));
    // the grant is for THAT bot only: another bot of the same user with the same paid preset stays off
    const other = (await t.post(alice, "/api/bots/create", { ...BOT, name: "Other", preset: "claude-api", fallback: "strata" })).json().bot.id as string;
    assert.equal(t.app.chat.paid.status(alice.userId, other, "claude-api").enabled, false);
  } finally {
    await t.close();
  }
});

test("M2: usage is counted and audited; the cap is a hard stop (budget passed to the engine, refused or fallen back after); day and month reset; shown to the user", async () => {
  const seen: (number | undefined)[] = [];
  const engine = new ScriptedEngine(async (tt) => {
    seen.push(tt.budget?.("claude-api"));
    tt.emit({ type: "delta", text: "answer" });
    return { usage: { input: 70, output: 50 } };
  });
  const t = await makeApp({ engine });
  try {
    const alice = await t.addUser("alice@example.com", PAID_CAPS);
    const withFb = (await t.post(alice, "/api/bots/create", { ...BOT, name: "Paid", preset: "claude-api", fallback: "strata" })).json().bot.id as string;
    const solo = (await t.post(alice, "/api/bots/create", { ...BOT, name: "Solo", preset: "claude-api" })).json().bot.id as string;
    await stepUpOwner(t);
    for (const b of [withFb, solo]) assert.equal((await t.post(t.owner, "/api/admin/paid/set", { userId: alice.userId, botId: b, preset: "claude-api", enabled: true, perDay: 100, perMonth: 150 })).status, 200);
    // turn 1 on solo: the paid model serves, with a budget of the headroom (100)
    assert.equal((await send(t, alice, solo)).status, 200);
    assert.equal(engine.calls.at(-1)!.bot.route.primary, "claude-api");
    assert.equal(seen.at(-1), 100);
    const st = t.app.chat.paid.status(alice.userId, solo, "claude-api");
    assert.deepEqual([st.dayTokens, st.monthTokens, st.headroom], [120, 120, 0]);
    assert.ok(t.audit.events.some((e) => e.kind === "paid_usage" && e.detail?.["tokens"] === 120 && e.detail?.["bot"] === solo));
    assert.ok(t.audit.events.some((e) => e.kind === "paid_cap_hit" && e.detail?.["bot"] === solo));
    // the cap is reached: solo is refused with the cap message; the other bot is not affected (per-bot ledger)
    const refused = await send(t, alice, solo);
    assert.equal(refused.status, 403);
    assert.match(refused.json().message, /reached its spending cap/);
    assert.equal(t.app.chat.paid.status(alice.userId, withFb, "claude-api").headroom, 100);
    // shown to the user: usage call and bot list
    const usage = (await t.post(alice, "/api/chat/usage", {})).json();
    const soloUsage = usage.paid.find((p: { bot: string }) => p.bot === solo);
    assert.deepEqual([soloUsage.enabled, soloUsage.dayTokens, soloUsage.perDay, soloUsage.headroom], [true, 120, 100, 0]);
    // next day: the day cap resets, the month cap (150) leaves 30
    t.clock.t += 24 * 3_600_000;
    t.clock.t += 31_000;
    const li = await t.post({ cookie: "", csrf: "", login: alice.login!, userId: alice.userId }, "/api/login/password", { login: alice.login, password: alice.password, totpCode: totpAt(alice.secret, totpStep(t.clock.t)) });
    assert.equal(li.status, 200, li.text);
    Object.assign(alice, { cookie: String(li.headers["set-cookie"]).split(";")[0], csrf: li.json().csrf });
    assert.equal(t.app.chat.paid.status(alice.userId, solo, "claude-api").headroom, 30);
    assert.equal((await send(t, alice, solo)).status, 200);
    assert.equal(seen.at(-1), 30, "the engine gets only what the month cap has left");
    assert.equal((await send(t, alice, solo)).status, 403, "month cap reached");
    // with a fallback, the cap moves the chain on and says why
    const fbBot = (await t.post(alice, "/api/bots/create", { ...BOT, name: "Third", preset: "claude-api", fallback: "strata" })).json().bot.id as string;
    await stepUpOwner(t);
    await t.post(t.owner, "/api/admin/paid/set", { userId: alice.userId, botId: fbBot, preset: "claude-api", enabled: true, perDay: 10, perMonth: 10 });
    await send(t, alice, fbBot); // uses up the cap
    const r = await send(t, alice, fbBot);
    assert.equal(r.status, 200);
    assert.equal(engine.calls.at(-1)!.bot.route.primary, "strata");
    const th = (await t.post(alice, "/api/chat/thread/get", { bot: fbBot, thread: r.json().threadId })).json().thread;
    assert.match(th.messages.at(-1).notice, /reached its spending cap/);
    // switching it off stops it at once
    await stepUpOwner(t);
    await t.post(t.owner, "/api/admin/paid/set", { userId: alice.userId, botId: withFb, preset: "claude-api", enabled: false });
    assert.equal(t.app.chat.paid.status(alice.userId, withFb, "claude-api").enabled, false);
    // a damaged ledger never resets spending: everything counts as used up
    writeFileSync(join(userPaths(t.dir, alice.userId).root, "paid-usage.json"), "{not json");
    assert.equal(t.app.chat.paid.status(alice.userId, fbBot, "claude-api").headroom, 0);
    // the audit holds numbers, never the answer text
    assert.ok(!JSON.stringify(t.audit.events).includes("answer"));
  } finally {
    await t.close();
  }
});

test("M2: a corrupt grants file enables nothing (fail closed)", async () => {
  const t = await makeApp();
  try {
    const alice = await t.addUser("alice@example.com", PAID_CAPS);
    const bot = (await t.post(alice, "/api/bots/create", { ...BOT, name: "Paid", preset: "claude-api", fallback: "strata" })).json().bot.id as string;
    await stepUpOwner(t);
    await t.post(t.owner, "/api/admin/paid/set", { userId: alice.userId, botId: bot, preset: "claude-api", enabled: true, perDay: 100, perMonth: 100 });
    assert.equal(t.app.chat.paid.status(alice.userId, bot, "claude-api").enabled, true);
    const f = t.app.chat.paid.store.file;
    writeFileSync(f, readFileSync(f, "utf8").replace('"perDay": 100', '"perDay": "lots"'));
    assert.equal(t.app.chat.paid.status(alice.userId, bot, "claude-api").enabled, false);
  } finally {
    await t.close();
  }
});
