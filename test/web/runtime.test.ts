/** S33: user bot ceiling, namespacing, non-owner tool registry (I50), file confinement, cross-user isolation, SSRF guard, scheduler fairness (I51). Offline. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { PresetConfig } from "../../src/bots/schema.js";
import { isBotId } from "../../src/bots/schema.js";
import { createBotBus } from "../../src/botbus/bus.js";
import { DEFAULT_BOT_BUS } from "../../src/bots/schema.js";
import { HOST_TOOL_NAMES, USER_ALWAYS_LOADED_MAX, USER_TOOL_UNIVERSE } from "../../src/web/capabilities.js";
import { memoryWebAudit } from "../../src/web/audit.js";
import { newUserId, parseRuntimeBotId, runtimeBotId } from "../../src/web/ids.js";
import { userPaths } from "../../src/web/paths.js";
import { buildUserToolbox } from "../../src/web/runtime/tools.js";
import { SchedulerAbortedError, SchedulerBusyError, TurnScheduler } from "../../src/web/runtime/scheduler.js";
import { checkUrl, isBlockedAddress } from "../../src/web/runtime/ssrf.js";
import { UserBotError, UserBotRegistry, UserBotStore, toRuntimeBot, validateUserBot } from "../../src/web/runtime/userBots.js";
import { UserFs, UserFsError, safeSegments } from "../../src/web/runtime/userFs.js";
import { defaultCaps } from "../../src/web/schemas.js";
import type { Caps } from "../../src/web/schemas.js";
import { tempDir } from "../settings/helpers.js";

const local = (id: string, runner = "strata"): PresetConfig => ({ id, kind: "local", runner, label: id, modelId: id, contextWindow: 100000, maxTokens: 4096, privacy: "local", autoFallback: true });
const cloud = (id: string, providerId: "claude" | "codex" = "claude"): PresetConfig => ({ id, kind: "acp", baseUrl: "http://127.0.0.1:8787/v1", providerId, apiKeyRef: "proxyApiKey", label: id, modelId: `${providerId}/x`, contextWindow: 100000, maxTokens: 4096, privacy: "cloud", autoFallback: false });
const PRESETS = [local("strata"), local("lmstudio", "lmstudio"), cloud("claude-sonnet"), cloud("codex1", "codex")];
const TERMS = { claude: true, antigravity: false };
const caps = (over: Partial<Caps> = {}): Caps => ({ ...defaultCaps(), tools: [...USER_TOOL_UNIVERSE], ...over });
const ctx = (c: Caps = caps()) => ({ caps: c, presets: PRESETS, terms: TERMS });
const good = (over: Record<string, unknown> = {}) => ({ name: "Helper", preset: "strata", tools: ["tool_search", "read_file", "write_file"], ...over });

test("ceiling: a client cannot set read roots, shared, edges, a Telegram token, a route or an unknown field", () => {
  for (const k of ["readRoots", "cloudSafeRoots", "shared", "edges", "telegramTokenRef", "route", "relax", "approvalTimeoutSec", "__proto__x"]) {
    const v = validateUserBot({ ...good(), [k]: k === "edges" ? [{ to: "main", allow: [], egress: true }] : ["C:\\Users"] }, ctx());
    assert.equal(v.ok, false, k);
    assert.match(!v.ok ? v.issues.join() : "", /cannot be set/, k);
  }
  assert.equal(validateUserBot(good(), ctx()).ok, true);
});

test("ceiling: preset, fallback and tools are limited to the user's caps; host tools do not exist; cloud needs an explicit cap", () => {
  const issues = (input: unknown, c = caps()) => {
    const v = validateUserBot(input, ctx(c));
    return v.ok ? [] : v.issues;
  };
  assert.match(issues(good({ preset: "claude-sonnet" })).join(), /preset: not one of the models you may use/, "a cloud preset not in caps");
  assert.deepEqual(issues(good({ preset: "claude-sonnet" }), caps({ presets: ["strata", "claude-sonnet"] })), []);
  const noTerms = validateUserBot(good({ preset: "claude-sonnet" }), { caps: caps({ presets: ["claude-sonnet"] }), presets: PRESETS, terms: { claude: false, antigravity: false } });
  assert.equal(noTerms.ok, false, "the terms acknowledgment still applies");
  assert.match(issues(good({ preset: "nope" })).join(), /models you may use/);
  assert.match(issues(good({ fallback: "claude-sonnet" }), caps({ presets: ["strata", "claude-sonnet"] })).join(), /must be a local model/);
  assert.match(issues(good({ fallback: "strata" })).join(), /must differ/);
  assert.match(issues(good({ fallback: "lmstudio" })).join(), /not one of the models/);
  assert.deepEqual(issues(good({ fallback: "lmstudio" }), caps({ presets: ["strata", "lmstudio"] })), []);
  for (const t of ["shell", "dispatch_job", "ask_bot", "list_bots", "hub_start", "mcp__x__y", "system_facts", "propose_setting", "web_fetch"]) {
    assert.match(issues(good({ tools: [t] })).join(), /does not exist for user bots/, t);
  }
  assert.match(issues(good({ tools: ["remember"] }), caps({ tools: ["read_file"] })).join(), /not allowed for your account/);
  const eleven = [...USER_TOOL_UNIVERSE, "read_file"];
  assert.ok(issues(good({ tools: eleven }), caps({ tools: [...USER_TOOL_UNIVERSE] })).length === 0, "duplicates collapse, the universe fits the cap of ten");
  assert.match(issues(good({ avatar: "javascript:alert(1)" })).join(), /avatar/);
  assert.match(issues(good({ name: "" })).join(), /name/);
  assert.match(issues(good({ persona: "x".repeat(4001) })).join(), /persona/);
  assert.equal(validateUserBot(good({ persona: "Be\u0000 kind\u0007" }), ctx()).ok && (validateUserBot(good({ persona: "Be\u0000 kind\u0007" }), ctx()) as { bot: { persona: string } }).bot.persona, "Be kind", "control characters are stripped");
  assert.ok(USER_TOOL_UNIVERSE.length <= USER_ALWAYS_LOADED_MAX);
});

test("store: creates the per-bot tree, enforces maxBots, unique ids, audits ids and never the persona", () => {
  const dir = tempDir("a7-ub-");
  const userId = newUserId();
  const audit = memoryWebAudit();
  const store = new UserBotStore({ dataDir: dir, userId, caps: () => caps({ maxBots: 2 }), presets: () => PRESETS, terms: () => TERMS, audit });
  const a = store.create(good({ name: "Helper", persona: "SECRET PERSONA TEXT" }));
  const b = store.create(good({ name: "Helper" }));
  assert.deepEqual([a.id, b.id], ["helper", "helper-2"]);
  assert.throws(() => store.create(good({ name: "Third" })), (e: UserBotError) => e.status === 403);
  const p = userPaths(dir, userId).bot("helper");
  for (const d of [p.stateDir, p.memoryDir, p.skillsDir, p.workspaceDir, p.logsDir]) assert.ok(existsSync(d), d);
  assert.deepEqual(store.ids(), ["helper", "helper-2"]);
  store.update("helper", good({ name: "Helper", tagline: "hi" }));
  assert.equal(store.get("helper")?.tagline, "hi");
  assert.equal(store.get("../helper"), undefined);
  assert.throws(() => store.update("nobody", good()), (e: UserBotError) => e.status === 404);
  store.delete("helper-2");
  assert.deepEqual(store.ids(), ["helper"]);
  assert.ok(audit.events.some((e) => e.kind === "bot_create") && audit.events.some((e) => e.kind === "bot_edit") && audit.events.some((e) => e.kind === "bot_delete"));
  assert.ok(!JSON.stringify(audit.events).includes("SECRET PERSONA"));
});

test("namespacing: u:<userId>:<botId> cannot be an owner bot id, two users with the same bot name never collide, the owner BotBus cannot address a user bot", async () => {
  const [u1, u2] = [newUserId(), newUserId()];
  assert.equal(isBotId(runtimeBotId(u1, "helper")), false);
  assert.deepEqual(parseRuntimeBotId(runtimeBotId(u1, "helper")), { userId: u1, botId: "helper" });
  const dir = tempDir("a7-reg-");
  const cfg = { name: "H", tagline: "", avatar: "robot", persona: "p", preset: "strata", tools: ["read_file"], memory: false, starters: [], createdAt: 1, updatedAt: 1 };
  const reg = new UserBotRegistry();
  const b1 = reg.registerUserBot(dir, u1, "helper", cfg);
  const b2 = reg.registerUserBot(dir, u2, "helper", cfg);
  assert.notEqual(b1.runtimeId, b2.runtimeId);
  assert.deepEqual(reg.forUser(u1).map((b) => b.runtimeId), [b1.runtimeId]);
  assert.deepEqual(b1.edges, []);
  assert.equal(b1.shared.read, false);
  assert.equal(b1.telegramTokenRef, undefined);
  assert.deepEqual(b1.readRoots.map((r) => r.alias), ["workspace", "uploads"]);
  assert.ok(b1.readRoots.every((r) => r.dir.startsWith(userPaths(dir, u1).root)), "roots are inside the user's own tree");
  assert.equal(b1.readRoots.find((r) => r.alias === "uploads")?.writable, false);
  reg.unregisterUser(u1);
  assert.equal(reg.forUser(u1).length, 0);
  assert.equal(reg.forUser(u2).length, 1);
  // the owner bus is built from owner bots only; an ask to a user bot id is an unknown bot
  const bus = createBotBus({ bots: [{ id: "main", description: "m", tools: ["ask_bot"], edges: [{ to: "research", allow: [], egress: false }], cloudCapable: false }, { id: "research", description: "r", tools: [], edges: [], cloudCapable: false }], limits: DEFAULT_BOT_BUS });
  bus.register("main", { handle: async () => ({ text: "x" }) } as never);
  bus.beginUserTurn("main", "c1");
  await assert.rejects(() => bus.channel("main").send({ to: runtimeBotId(u1, "helper"), message: "hi" }, { conversationId: "c1" }));
});

test("I50: the registry of a user bot enumerates only universe tools; host tools do not exist and the module imports no host code", () => {
  const dir = tempDir("a7-tools-");
  const u = newUserId();
  const all = toRuntimeBot(dir, u, "helper", { name: "H", tagline: "", avatar: "robot", persona: "", preset: "strata", tools: [...USER_TOOL_UNIVERSE, ...HOST_TOOL_NAMES, "mcp__x__y"], memory: true, starters: [], createdAt: 1, updatedAt: 1 });
  const box = buildUserToolbox(all, { storageMB: 1 });
  for (const n of box.names()) assert.ok(USER_TOOL_UNIVERSE.includes(n), n);
  for (const n of HOST_TOOL_NAMES) {
    assert.ok(!box.names().includes(n), `${n} must not be registered`);
    assert.deepEqual(box.call(n, {}), { ok: false, text: `no such tool: ${n}` });
  }
  assert.ok(box.names().length <= USER_ALWAYS_LOADED_MAX);
  assert.deepEqual(buildUserToolbox({ ...all, tools: ["read_file"] }, { storageMB: 1 }).names(), ["read_file"], "only the bot's own subset");
  // the module cannot reach host power: it imports none of the host tool code
  const src = readFileSync(join(process.cwd(), "src", "web", "runtime", "tools.ts"), "utf8");
  for (const bad of ["../../shell", "../../jobs", "../../mcp", "../../botbus", "../../jobrunner", "child_process", "../../settings", "../../agent"]) assert.ok(!src.includes(`"${bad}`) && !src.includes(bad + "/") , bad);
  assert.ok(!/child_process|spawn|exec\(|fetch\(/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "no process or network call in the registry");
  // remember writes only the bot's own memory file, and refuses secrets
  assert.deepEqual(box.call("remember", { note: "likes tea" }), { ok: true, text: "saved" });
  assert.match(readFileSync(all.memoryFile, "utf8"), /- likes tea/);
  assert.ok(all.memoryFile.startsWith(userPaths(dir, u).bot("helper").root));
  assert.equal(box.call("remember", { note: "my key is sk-abcdefghijklmnopqrstuvwxyz123456" }).ok, false);
  assert.equal(buildUserToolbox({ ...all, memory: false }, { storageMB: 1 }).call("remember", { note: "x y z" }).ok, false);
  assert.equal(box.call("ask_user", { question: "which one?" }).question, "which one?");
});

test("files: every escape is refused before and after touching the file system; reads and writes stay in workspace and uploads", () => {
  const dir = tempDir("a7-fs-");
  const ws = join(dir, "ws");
  const up = join(dir, "up");
  const outside = join(dir, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
  const fs = new UserFs([{ alias: "workspace", dir: ws, writable: true }, { alias: "uploads", dir: up, writable: false }]);
  fs.write("notes/a.txt", "hello");
  assert.equal(fs.read("workspace:notes/a.txt").text, "hello");
  assert.equal(fs.read("notes/a.txt").text, "hello", "bare paths are workspace");
  writeFileSync(join(up, "u.txt"), "uploaded");
  assert.equal(fs.read("uploads:u.txt").text, "uploaded");
  assert.throws(() => fs.write("uploads:evil.txt", "x"), /read only/);
  const bad = ["..\\outside\\secret.txt", "../outside/secret.txt", "a/../../outside/secret.txt", join(outside, "secret.txt"), "C:\\Windows\\win.ini", "\\\\server\\share\\x", "\\\\?\\C:\\x", "/etc/passwd", "a.txt:stream", "notes/a.txt::$DATA", "CON", "nul.txt", "aux", "com1.log", "a.txt.", "a.txt ", "a<b", "a|b", "a?b", "a*b", "x\0y", "a".repeat(300), "workspace:..", "uploads:../ws/notes/a.txt", "other:foo"];
  for (const p of bad) assert.throws(() => fs.read(p), UserFsError, JSON.stringify(p).slice(0, 50));
  for (const p of bad) assert.throws(() => fs.write(p, "x"), UserFsError, "write " + JSON.stringify(p).slice(0, 50));
  assert.throws(() => safeSegments("a/../b"), /`\.\.`/);
  // a junction (directory link) inside the workspace that points outside is not followed
  const link = join(ws, "escape");
  symlinkSync(outside, link, "junction");
  assert.throws(() => fs.read("escape/secret.txt"), /leaves the folder/);
  assert.throws(() => fs.write("escape/new.txt", "x"), /leaves the folder/);
  assert.throws(() => fs.list("workspace:escape"), /leaves the folder/);
  assert.ok(!existsSync(join(outside, "new.txt")));
  assert.ok(!fs.list("workspace:").some((e) => e.name === "escape" && e.type === "file"));
  assert.ok(!fs.search("TOP SECRET").length, "search does not follow links either");
  // limits
  assert.throws(() => fs.write("big.txt", "x".repeat(300 * 1024)), /at most 256 KB/);
  const small = new UserFs([{ alias: "workspace", dir: join(dir, "q"), writable: true }], { quotaBytes: 100 });
  small.write("a.txt", "x".repeat(60));
  assert.throws(() => small.write("b.txt", "x".repeat(60)), /quota/);
  small.write("a.txt", "y".repeat(90));
  writeFileSync(join(ws, "bin.dat"), Buffer.from([1, 0, 2]));
  assert.throws(() => fs.read("bin.dat"), /binary/);
  assert.equal(fs.search("hello").length, 1);
  assert.equal(fs.read("notes/a.txt", 2).text, "he");
});

test("cross-user isolation: user B can reach nothing of user A by any path, tool, id or bot name", () => {
  const dir = tempDir("a7-iso-");
  const [A, B] = [newUserId(), newUserId()];
  const cfg = (tools: string[]) => ({ name: "Helper", tagline: "", avatar: "robot", persona: "", preset: "strata", tools, memory: true, starters: [], createdAt: 1, updatedAt: 1 });
  const botA = toRuntimeBot(dir, A, "helper", cfg([...USER_TOOL_UNIVERSE]));
  const botB = toRuntimeBot(dir, B, "helper", cfg([...USER_TOOL_UNIVERSE]));
  const a = buildUserToolbox(botA, { storageMB: 5 });
  const b = buildUserToolbox(botB, { storageMB: 5 });
  assert.equal(a.call("write_file", { path: "secret.txt", content: "A's secret" }).ok, true);
  assert.equal(a.call("remember", { note: "A likes cats" }).ok, true);
  mkdirSync(userPaths(dir, A).uploadsDir, { recursive: true });
  writeFileSync(join(userPaths(dir, A).uploadsDir, "a-upload.txt"), "A upload");
  const aFile = join(userPaths(dir, A).bot("helper").workspaceDir, "secret.txt");
  assert.ok(existsSync(aFile));
  const attempts: [string, Record<string, unknown>][] = [
    ["read_file", { path: "secret.txt" }],
    ["read_file", { path: aFile }],
    ["read_file", { path: `..\\..\\..\\${A}\\bots\\helper\\workspace\\secret.txt` }],
    ["read_file", { path: `workspace:..\\..\\..\\..\\${A}\\bots\\helper\\workspace\\secret.txt` }],
    ["read_file", { path: "uploads:a-upload.txt" }],
    ["read_file", { path: botA.memoryFile }],
    ["read_file", { path: `memory\\MEMORY.md` }],
    ["list_dir", { path: userPaths(dir, A).root }],
    ["list_dir", { path: `uploads:..\\..\\${A}` }],
    ["search_files", { contains: "A's secret", path: `workspace:..\\..\\..\\${A}` }],
    ["write_file", { path: aFile, content: "pwn" }],
    ["write_file", { path: `..\\..\\..\\${A}\\bots\\helper\\workspace\\secret.txt`, content: "pwn" }],
  ];
  for (const [tool, args] of attempts) {
    const r = b.call(tool, args);
    assert.equal(r.ok, false, `${tool} ${JSON.stringify(args)} -> ${r.text}`);
    assert.ok(!/A's secret|A likes cats|A upload/.test(r.text), "nothing of A in the answer");
  }
  assert.equal(readFileSync(aFile, "utf8"), "A's secret", "A's file is untouched");
  assert.equal(b.call("search_files", { contains: "secret" }).text, "no matches");
  assert.equal(b.call("list_dir", { path: "uploads:" }).text, "(empty)");
  assert.equal(b.call("read_file", { path: "memory/MEMORY.md" }).ok, false);
  // same bot name, different trees; deleting a user removes only that tree
  assert.notEqual(botA.memoryFile, botB.memoryFile);
  assert.ok(!existsSync(botB.memoryFile));
  // every root of every bot is inside its own user's folder
  for (const [bot, id] of [[botA, A], [botB, B]] as const) for (const r of bot.readRoots) assert.ok(r.dir.startsWith(userPaths(dir, id).root + "\\"), r.dir);
  assert.equal(dirname(botA.memoryFile).startsWith(userPaths(dir, B).root), false);
});

test("SSRF guard: private, loopback, link-local, CGNAT and tailnet addresses, numeric tricks, the model and gateway ports, DNS answers with one bad address", async () => {
  for (const ip of ["127.0.0.1", "127.1.2.3", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.100.100.100", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd7a:115c:a1e0::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "ff02::1"]) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111"]) assert.equal(isBlockedAddress(ip), false, ip);
  const dns = (map: Record<string, string[]>) => async (h: string) => map[h] ?? [];
  const allow = ["example.com", "*.docs.example.org"];
  const ok = await checkUrl("https://example.com/page", allow, dns({ "example.com": ["93.184.216.34"] }));
  assert.equal(ok.ok, true);
  const no = async (url: string, map: Record<string, string[]> = {}, list = allow) => {
    const r = await checkUrl(url, list, dns(map));
    assert.equal(r.ok, false, url);
    return r.ok ? "" : r.reason;
  };
  await no("ftp://example.com/x");
  await no("file:///C:/Windows/win.ini");
  await no("https://user:pw@example.com/");
  await no("http://localhost/");
  await no("http://localhost:8080/v1/models", {}, ["localhost"]);
  await no("http://127.0.0.1:1234/v1", {}, ["127.0.0.1"]);
  await no("http://[::1]/", {}, ["::1"]);
  await no("http://2130706433/", {}, ["2130706433"]);
  await no("http://0x7f.0.0.1/", {}, ["0x7f.0.0.1"]);
  await no("http://0177.0.0.1/", {}, ["0177.0.0.1"]);
  await no("http://pc.tail1234.ts.net/", {}, ["pc.tail1234.ts.net"]);
  await no("http://printer.local/", {}, ["printer.local"]);
  await no("https://example.com:8787/", { "example.com": ["93.184.216.34"] });
  await no("https://example.com:47009/", { "example.com": ["93.184.216.34"] });
  assert.match(await no("https://evil.com/", { "evil.com": ["93.184.216.34"] }), /allowlist/);
  assert.match(await no("https://example.com/", { "example.com": ["93.184.216.34", "10.0.0.5"] }), /resolves to a private/, "rebinding: one bad address blocks");
  assert.match(await no("https://example.com/", { "example.com": ["100.101.102.103"] }), /tailnet/);
  assert.match(await no("https://example.com/", {}), /did not resolve/);
  assert.equal((await checkUrl("https://a.docs.example.org/x", allow, dns({ "a.docs.example.org": ["93.184.216.34"] }))).ok, true);
  assert.equal((await checkUrl("https://example.com/", [], dns({ "example.com": ["93.184.216.34"] }))).ok, false, "an empty allowlist allows nothing (UI-41)");
});

test("scheduler (I51): owner first, peer next, web turns after them, per-user concurrency 1, fair between users, bounded queue, abortable", async () => {
  let t = 0;
  const s = new TurnScheduler({ slots: 1, maxQueue: 5, agingMs: 60_000, now: () => t });
  const order: string[] = [];
  const run = async (key: string, cls: Parameters<TurnScheduler["acquire"]>[0]["cls"], hold: () => Promise<void>) => {
    const l = await s.acquire({ key, cls });
    order.push(`${key}:${cls}`);
    await hold();
    l.release();
  };
  // a web turn is running; while it runs, queue up: web(bob), web(carol), peer, owner
  let freeFirst!: () => void;
  const first = run("alice", "web", () => new Promise<void>((r) => (freeFirst = r)));
  await Promise.resolve();
  const quick = () => Promise.resolve();
  const rest = [run("bob", "web", quick), run("carol", "web", quick), run("bot-peer", "peer", quick), run("owner", "owner", quick)];
  await Promise.resolve();
  assert.deepEqual(s.status().byClass, { owner: 1, peer: 1, web: 2, background: 0, summary: 0 });
  freeFirst();
  await Promise.all([first, ...rest]);
  assert.deepEqual(order, ["alice:web", "owner:owner", "bot-peer:peer", "bob:web", "carol:web"], "a guest never goes ahead of the owner or a peer");

  // per-user concurrency 1, and a user cannot pile up turns
  const s2 = new TurnScheduler({ slots: 2, maxQueue: 5, now: () => t });
  const l1 = await s2.acquire({ key: "u1", cls: "web" });
  let second = false;
  const p2 = s2.acquire({ key: "u1", cls: "web" }).then((l) => ((second = true), l));
  await Promise.resolve();
  assert.equal(second, false, "the second turn of the same user waits although a slot is free");
  await assert.rejects(() => s2.acquire({ key: "u1", cls: "web" }), SchedulerBusyError);
  const other = await s2.acquire({ key: "u2", cls: "web" });
  other.release();
  l1.release();
  (await p2).release();
  assert.equal(second, true);

  // round robin: with one slot, three users each queue two turns; they alternate
  const s3 = new TurnScheduler({ slots: 1, maxQueue: 20, now: () => t });
  const seq: string[] = [];
  const hold = await s3.acquire({ key: "blocker", cls: "owner" });
  const jobs: Promise<void>[] = [];
  for (const k of ["u1", "u2", "u3"]) {
    jobs.push(s3.acquire({ key: k, cls: "web" }).then(async (l) => { seq.push(k); l.release(); }));
  }
  hold.release();
  await Promise.all(jobs);
  assert.deepEqual(seq.sort(), ["u1", "u2", "u3"]);

  // bounded queue: web is refused with a clear error, the owner never is
  const s4 = new TurnScheduler({ slots: 1, maxQueue: 2, now: () => t });
  const busy = await s4.acquire({ key: "x", cls: "owner" });
  const w1 = s4.acquire({ key: "a", cls: "web" });
  const w2 = s4.acquire({ key: "b", cls: "web" });
  await assert.rejects(() => s4.acquire({ key: "c", cls: "web" }), SchedulerBusyError);
  const own = s4.acquire({ key: "owner2", cls: "owner" });
  busy.release();
  (await own).release();
  (await w1).release();
  (await w2).release();

  // abort while waiting
  const s5 = new TurnScheduler({ slots: 1, now: () => t });
  const hold5 = await s5.acquire({ key: "h", cls: "web" });
  const ac = new AbortController();
  const waiting = s5.acquire({ key: "w", cls: "web", signal: ac.signal });
  ac.abort();
  await assert.rejects(() => waiting, SchedulerAbortedError);
  assert.equal(s5.status().queued, 0);
  hold5.release();
  await assert.rejects(() => s5.acquire({ key: "z", cls: "web", signal: ac.signal }), SchedulerAbortedError);

  // aging: a long-waiting web turn rises but never above a peer turn
  const s6 = new TurnScheduler({ slots: 1, agingMs: 1000, now: () => t });
  const h6 = await s6.acquire({ key: "h", cls: "owner" });
  const order6: string[] = [];
  const webOld = s6.acquire({ key: "old", cls: "web" }).then((l) => (order6.push("web"), l.release()));
  t += 10_000;
  const peerNew = s6.acquire({ key: "peer", cls: "peer" }).then((l) => (order6.push("peer"), l.release()));
  h6.release();
  await Promise.all([webOld, peerNew]);
  assert.deepEqual(order6, ["peer", "web"]);
});
