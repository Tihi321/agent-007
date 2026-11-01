/** S28: stores, schemas, paths, crypto helpers, audit, ACL script rows. Offline, temp folders only. */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWebAudit, WebAuditError } from "../../src/web/audit.js";
import { SecretBox, bodyDigest, hashPassword, hashSecret, verifyPassword } from "../../src/web/crypto.js";
import { newUserId, parseRuntimeBotId, runtimeBotId } from "../../src/web/ids.js";
import { userPaths, webPaths } from "../../src/web/paths.js";
import { defaultCaps, parseCaps, parseUsersFile } from "../../src/web/schemas.js";
import { WebStoreError, credentialsStore, invitesStore, usersStore } from "../../src/web/store.js";
import { readScript, stripComments } from "../deploy/_fixture.js";
import { tempDir } from "../settings/helpers.js";

const user = (login = "alice@example.com", over: Record<string, unknown> = {}) => ({ login, displayName: "Alice", role: "user", status: "active", caps: defaultCaps(), createdAt: 1, invitedBy: "owner", ...over });

test("users.json: a valid file round-trips; unknown keys, bad ids, bad caps, duplicate logins and two owners are refused", () => {
  const id = newUserId();
  const ok = parseUsersFile({ schemaVersion: 1, users: { [id]: user() } });
  assert.equal(ok.users[id]?.caps.maxJobsPerDay, 0);
  const bad = (doc: unknown, re: RegExp) => assert.throws(() => parseUsersFile(doc), (e: Error) => re.test(e.message));
  bad({ schemaVersion: 1, users: { [id]: { ...user(), extra: 1 } } }, /unknown key/);
  bad({ schemaVersion: 1, users: { "alice": user() } }, /not a user id/);
  bad({ schemaVersion: 1, users: { [id]: user("a b") } }, /not allowed/);
  bad({ schemaVersion: 1, users: { [id]: user("x", {}) } }, /3 to 120/);
  bad({ schemaVersion: 1, users: { [id]: user("alice@example.com", { caps: { ...defaultCaps(), maxJobsPerDay: 5 } }) } }, /must be 0/);
  bad({ schemaVersion: 1, users: { [id]: user("a@x.com"), [newUserId()]: user("A@X.com") } }, /share a login/);
  bad({ schemaVersion: 1, users: { [id]: user("a@x.com", { role: "owner" }), [newUserId()]: user("b@x.com", { role: "owner" }) } }, /more than one owner/);
  bad({ schemaVersion: 2, users: {} }, /must be 1/);
  bad([], /must be an object/);
  // the message never echoes a stored value
  try {
    parseUsersFile({ schemaVersion: 1, users: { [id]: user("secret-login-value!!") } });
  } catch (e) {
    assert.ok(!String((e as Error).message).includes("secret-login-value"));
  }
});

test("schema fuzz: random junk never parses into a users document and never throws anything but WebSchemaError", () => {
  const junk: unknown[] = [null, 1, "x", [], {}, { schemaVersion: 1 }, { schemaVersion: 1, users: [] }, { schemaVersion: 1, users: { a: 1 } }, { schemaVersion: 1, users: { [newUserId()]: null } }, { schemaVersion: 1, users: { [newUserId()]: { login: 1 } } }];
  for (let i = 0; i < 200; i++) junk.push({ schemaVersion: 1, users: { [newUserId()]: { ...user(), [`k${i}`]: i, caps: { ...defaultCaps(), maxBots: i % 2 ? -i : 1e12 } } } });
  for (const j of junk) {
    try {
      parseUsersFile(j);
      assert.deepEqual(j, { schemaVersion: 1, users: {} }, "only the empty document may parse");
    } catch (e) {
      assert.equal((e as Error).name, "WebSchemaError");
    }
  }
  assert.throws(() => parseCaps({ ...defaultCaps(), tools: new Array(41).fill("x") }), /at most 40/);
});

test("stores: a missing file is the empty document, a corrupt file is a loader error, writes are atomic and leave no temp file", () => {
  const dir = tempDir("a7-web-");
  const p = webPaths(dir);
  const users = usersStore(p.usersFile);
  assert.deepEqual(users.read(), { schemaVersion: 1, users: {} });
  const id = newUserId();
  users.update((d) => {
    d.users[id] = user() as never;
  });
  assert.equal(users.read().users[id]?.login, "alice@example.com");
  assert.deepEqual(readdirSync(p.webDir).filter((f) => f.endsWith(".tmp")), []);
  // an invalid change is refused and the old file stays
  assert.throws(
    () =>
      users.update((d) => {
        (d.users[id] as { role: string }).role = "root";
      }),
    WebStoreError,
  );
  assert.equal(users.read().users[id]?.role, "user");
  // corrupt JSON and a schema violation both fail closed
  writeFileSync(p.usersFile, "{not json");
  assert.throws(() => users.read(), /not valid JSON/);
  writeFileSync(p.usersFile, JSON.stringify({ schemaVersion: 1, users: { zz: 1 } }));
  assert.throws(() => users.read(), WebStoreError);
  // the other stores behave the same way
  mkdirSync(p.webDir, { recursive: true });
  writeFileSync(p.invitesFile, "[]");
  assert.throws(() => invitesStore(p.invitesFile).read(), WebStoreError);
  writeFileSync(p.credentialsFile, "");
  assert.throws(() => credentialsStore(p.credentialsFile).read(), WebStoreError);
});

test("I52: every user path is under users\\<userId>\\; ids that could escape are refused", () => {
  const dir = "C:\\Users\\agent007\\AppData\\Local\\agent-007";
  const id = newUserId();
  const up = userPaths(dir, id);
  const b = up.bot("helper");
  for (const p of [up.root, up.prefsFile, up.threadsDir, up.uploadsDir, up.quotaFile, b.root, b.storageFile, b.memoryFile, b.workspaceDir, b.skillsDir, b.logsDir, up.threadFile("helper", "0123456789abcdef01234567")]) {
    assert.ok(p.startsWith(`${dir}\\users\\${id}`), p);
  }
  for (const bad of ["..", "..\\x", "a:b", "C:\\x", "", "a/b", "u:" + id, "UPPER", "x".repeat(40)]) {
    assert.throws(() => userPaths(dir, bad), /valid user id/, bad);
  }
  for (const bad of ["..", "a\\b", "a/b", "A", "x", ".hidden"]) assert.throws(() => up.bot(bad), /valid bot id/, bad);
  assert.throws(() => up.threadFile("helper", "../../x"), /valid/);
  assert.equal(parseRuntimeBotId(runtimeBotId(id, "helper"))?.userId, id);
  assert.equal(parseRuntimeBotId("main"), undefined);
  assert.equal(parseRuntimeBotId("u:../x:y"), undefined);
});

test("I53: passwords are scrypt, TOTP secrets are sealed, secrets are hashed; nothing readable is stored", async () => {
  const h = await hashPassword("correct horse battery");
  assert.match(h, /^scrypt\$\d+\$8\$1\$/);
  assert.ok(!h.includes("correct"));
  assert.equal(await verifyPassword("correct horse battery", h), true);
  assert.equal(await verifyPassword("wrong horse battery!", h), false);
  assert.equal(await verifyPassword("x", "scrypt$1$1$1$aa$bb"), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
  const box = new SecretBox(SecretBox.generateKey());
  const sealed = box.seal("JBSWY3DPEHPK3PXP", "u1");
  assert.ok(!sealed.includes("JBSWY3DPEHPK3PXP"));
  assert.equal(box.open(sealed, "u1"), "JBSWY3DPEHPK3PXP");
  assert.throws(() => box.open(sealed, "u2"), "wrong AAD (another user) cannot open it");
  assert.throws(() => new SecretBox(Buffer.alloc(5)), /32 bytes/);
  assert.notEqual(hashSecret("invite", "abc"), hashSecret("session", "abc"));
  assert.match(hashSecret("invite", "abc"), /^[0-9a-f]{64}$/);
});

test("I54: the audit is append-only JSONL, has hashes and lengths but refuses message bodies", () => {
  const dir = join(tempDir("a7-web-audit-"), "web-audit");
  const audit = createWebAudit({ dir, now: () => new Date("2026-11-01T10:00:00Z") });
  audit.write({ kind: "login_ok", user: newUserId(), detail: { ip: "127.0.0.1" } });
  audit.write({ kind: "chat_turn", detail: { ...bodyDigest("hello there"), thread: "t1" } });
  assert.throws(() => audit.write({ kind: "chat_turn", detail: { text: "hello there" } }), WebAuditError);
  assert.throws(() => audit.write({ kind: "chat_turn", detail: { message: "x" } }), WebAuditError);
  const files = readdirSync(dir);
  assert.deepEqual(files, ["web-202611.jsonl"]);
  const lines = readFileSync(join(dir, files[0] as string), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(!lines.join("").includes("hello there"));
  assert.equal(JSON.parse(lines[1] as string).detail.len, 11);
  appendFileSync(join(dir, files[0] as string), "");
});

test("check-acl.ps1 lists web-audit (append-only check) and the web\\ stores; grant-folder-acls.ps1 gives web-audit the append-only ACL", () => {
  const s = stripComments(readScript("check-acl.ps1"));
  assert.match(s, /Join-WinPath \$layout\.DataDir 'web-audit'/);
  assert.match(s, /Test-AuditFolder -Dir \$webAuditDir -Label 'web audit'/);
  for (const f of ["users.json", "invites.json", "credentials.json", "sessions.json", "web.key"]) assert.ok(s.includes(`'${f}'`), f);
  assert.match(s, /Join-WinPath \$layout\.DataDir 'web'/);
  const g = stripComments(readScript("grant-folder-acls.ps1"));
  assert.match(g, /Join-WinPath \$layout\.DataDir 'web-audit'/);
  assert.match(g, /Set-OurFolder -Path \$webAuditDir .*Set-AppendOnlyDirAcl/);
});
