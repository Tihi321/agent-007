import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { builtinDenies } from "../../src/config/paths.js";
import { parseConfig } from "../../src/config/schema.js";
import { PathPolicyError, createPathPolicy, parseToolPath, readDirSafe, readPolicyFromConfig, writePolicyFromConfig } from "../../src/tools/pathPolicy.js";
import type { PathPolicy } from "../../src/tools/pathPolicy.js";
import { cleanup, junction, put, shortPath, tempBase, trySymlink } from "./fixture.js";

let base: string;
let policy: PathPolicy;
let proj: PathPolicy;
let notes: string;
let outside: string;

before(() => {
  base = tempBase("pathpolicy");
  notes = join(base, "allowed");
  outside = join(base, "outside");
  put(join(notes, "a.txt"), "hello");
  put(join(notes, "sub", "b.md"), "b");
  put(join(notes, "private", "secret.txt"), "classified");
  put(join(notes, "denied-long-name-folder", "d.txt"), "d");
  put(join(outside, "secret.txt"), "outside secret");
  put(join(base, "proj", "p.txt"), "p");
  put(join(base, "proj2", "evil.txt"), "evil");
  junction(join(notes, "link-out"), outside);
  junction(join(notes, "link-private"), join(notes, "private"));
  policy = createPathPolicy({
    roots: [{ alias: "notes", path: notes }],
    denies: { ntfs: [join(notes, "private"), join(notes, "denied-long-name-folder")], inProcessOnly: [], inProcessOnlyExceptions: [] },
  });
  proj = createPathPolicy({ roots: [{ alias: "proj", path: join(base, "proj") }], denies: { ntfs: [], inProcessOnly: [], inProcessOnlyExceptions: [] } });
});

after(() => cleanup(base));

function refused(p: PathPolicy, input: string, code?: string): PathPolicyError {
  try {
    p.resolve(input);
  } catch (e) {
    assert.ok(e instanceof PathPolicyError, `expected PathPolicyError for ${input}, got ${String(e)}`);
    if (code) assert.equal(e.code, code, `${input}: ${e.message}`);
    return e;
  }
  assert.fail(`expected a refusal for ${JSON.stringify(input)}`);
}

test("alias and absolute paths resolve to the real path, alias is case-insensitive", () => {
  const a = policy.resolve("notes:a.txt");
  assert.equal(a.exists, true);
  assert.equal(a.display, "notes:a.txt");
  assert.equal(a.rel, "a.txt");
  assert.equal(policy.resolve("NOTES:SUB/b.md").real, join(notes, "sub", "b.md"));
  assert.equal(policy.resolve(join(notes, "a.txt")).display, "notes:a.txt");
  assert.equal(policy.resolve(join(notes, "a.txt").replace(/\\/g, "/")).real, join(notes, "a.txt"));
  assert.equal(policy.resolve("notes:").rel, "");
  assert.equal(policy.resolve("notes:sub/../a.txt").display, "notes:a.txt", "an inner .. that stays inside is fine");
});

test("`..` traversal is refused", () => {
  refused(policy, "notes:../outside/secret.txt", "outside");
  refused(policy, "notes:sub/../../outside/secret.txt", "outside");
  refused(policy, join(notes, "..", "outside", "secret.txt"), "outside");
  refused(policy, "notes:..", "outside");
});

test("a junction from inside the root to outside it is refused (mklink /J)", () => {
  refused(policy, "notes:link-out/secret.txt", "outside");
  refused(policy, join(notes, "link-out", "secret.txt"), "outside");
  refused(policy, "notes:link-out", "outside");
  // a path that does not exist yet below the junction is refused too (write case)
  refused(policy, "notes:link-out/new.txt", "outside");
});

test("a symlink from inside the root to outside it is refused (skipped without symlink rights)", (t) => {
  const ok = trySymlink(join(notes, "sym-file"), join(outside, "secret.txt"), "file") && trySymlink(join(notes, "sym-dir"), outside, "dir");
  if (!ok) {
    t.skip("symlinks need developer mode or admin on this PC (EPERM)");
    return;
  }
  refused(policy, "notes:sym-file", "outside");
  refused(policy, "notes:sym-dir/secret.txt", "outside");
});

test("mixed case is accepted for allow and deny, and the real path is canonical", () => {
  const r = policy.resolve(join(notes, "SUB", "B.MD").toUpperCase());
  assert.equal(r.exists, true);
  assert.equal(r.real, join(notes, "sub", "b.md"), "realpath restores the on-disk case");
  refused(policy, "notes:PRIVATE/Secret.TXT", "denied");
  refused(policy, join(notes, "PrIvAtE", "secret.txt").toLowerCase(), "denied");
});

test("an 8.3 short name resolves to the long name, and a denied folder stays denied through its short name", (t) => {
  const short = shortPath(join(notes, "denied-long-name-folder"));
  if (!short) {
    t.skip("this volume has no 8.3 short names");
    return;
  }
  refused(policy, join(short, "d.txt"), "denied");
  const shortName = short.split("\\").pop() as string;
  refused(policy, `notes:${shortName}/d.txt`, "denied");
  // an allowed folder given by short name resolves to its long, canonical form
  mkdirSync(join(notes, "another-long-folder-name"), { recursive: true });
  put(join(notes, "another-long-folder-name", "ok.txt"), "ok");
  const okShort = shortPath(join(notes, "another-long-folder-name"));
  assert.ok(okShort);
  const r = policy.resolve(join(okShort as string, "ok.txt"));
  assert.equal(r.real, join(notes, "another-long-folder-name", "ok.txt"));
});

test("trailing dots and spaces in any segment are refused", () => {
  for (const p of ["notes:a.txt.", "notes:a.txt ", "notes:sub./b.md", "notes:sub /b.md", "notes:...", `${join(notes, "a.txt")}.`, "notes:private./secret.txt"]) {
    refused(policy, p, "invalid");
  }
});

test("alternate data streams are refused", () => {
  for (const p of ["notes:a.txt:zone", "notes:a.txt::$DATA", "notes:a.txt:Zone.Identifier:$DATA", `${join(notes, "a.txt")}:zone`, "notes:sub:x/b.md"]) {
    refused(policy, p, "invalid");
  }
  // the write policy accepts plain relative paths: a stream suffix must still be refused there
  for (const p of ["a.txt:zone", "sub/a.txt::$DATA", "x.txt:Zone.Identifier"]) assert.throws(() => parseToolPath(p, ["workspace"], true), PathPolicyError, p);
});

test("`\\\\?\\`, `\\\\.\\`, UNC and rooted paths are refused before any lookup", () => {
  const cases = [
    `\\\\?\\${join(notes, "a.txt")}`,
    `\\\\?\\C:\\Windows\\win.ini`,
    "\\\\.\\C:\\Windows\\win.ini",
    "\\\\.\\PhysicalDrive0",
    "\\\\server\\share\\x.txt",
    "//server/share/x.txt",
    "//?/C:/Windows/win.ini",
    "\\??\\C:\\Windows\\win.ini",
    "\\Windows\\win.ini",
    "\\\\?\\UNC\\server\\share\\x",
  ];
  for (const c of cases) refused(policy, c, "invalid");
});

test("device names and NTFS system names are refused, with or without an extension", () => {
  for (const p of ["notes:CON", "notes:nul", "notes:NUL.txt", "notes:sub/aux.md", "notes:COM1", "notes:com9.log", "notes:LPT1", "notes:con .txt", "notes:CONIN$", "notes:$MFT", "notes:$Extend/x"]) {
    refused(policy, p, "invalid");
  }
  // names that merely contain a device name are fine
  assert.equal(policy.resolve("notes:console.txt").exists, false);
});

test("NUL bytes, control characters and wildcards are refused", () => {
  for (const p of ["notes:a\u0000.txt", "notes:a\n.txt", "notes:*.txt", "notes:a?.txt", "notes:a|b", 'notes:"a"', "notes:<a>"]) refused(policy, p, "invalid");
  assert.throws(() => parseToolPath(42, ["notes"], false), PathPolicyError);
  assert.throws(() => parseToolPath("x".repeat(2000), ["notes"], false), PathPolicyError);
});

test("an unknown alias and drive-relative or bare relative paths are refused", () => {
  refused(policy, "other:a.txt", "unknown_alias");
  refused(policy, "C:a.txt", "unknown_alias");
  refused(policy, "a.txt", "invalid");
  refused(policy, "", "invalid");
  const e = refused(policy, "other:a.txt");
  assert.match(e.message, /Allowed aliases: notes/);
});

test("a deny folder nested inside an allow folder wins, also through absolute paths and a junction to it", () => {
  refused(policy, "notes:private", "denied");
  refused(policy, "notes:private/secret.txt", "denied");
  refused(policy, join(notes, "private", "secret.txt"), "denied");
  refused(policy, "notes:link-private/secret.txt", "denied");
  refused(policy, "notes:link-private", "denied");
  // not-yet-existing file under a denied folder
  refused(policy, "notes:private/new.txt", "denied");
  assert.equal(policy.resolve("notes:sub/b.md").exists, true, "siblings stay readable");
});

test("deny wins even when the deny list names the allowed root itself", () => {
  const p = createPathPolicy({ roots: [{ alias: "notes", path: notes }], denies: { ntfs: [notes], inProcessOnly: [], inProcessOnlyExceptions: [] } });
  refused(p, "notes:a.txt", "denied");
  refused(p, "notes:", "denied");
});

test("a prefix-collision sibling is outside (C:\\a\\bc is not inside C:\\a\\b)", () => {
  refused(proj, join(base, "proj2", "evil.txt"), "outside");
  refused(proj, "proj:../proj2/evil.txt", "outside");
  refused(proj, join(base, "proj2"), "outside");
  assert.equal(proj.resolve(join(base, "proj", "p.txt")).exists, true);
});

test("a missing target resolves through its nearest existing parent (the write case)", () => {
  const r = policy.resolve("notes:sub/new-dir/new.txt");
  assert.equal(r.exists, false);
  assert.equal(r.real, join(notes, "sub", "new-dir", "new.txt"));
  assert.equal(r.display, "notes:sub/new-dir/new.txt");
});

test("readDirSafe lstat-s each entry: links are flagged, denied entries are hidden", () => {
  const entries = readDirSafe(notes, policy.denyMatcher());
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("a.txt") && names.includes("sub"));
  assert.ok(!names.includes("private"), "denied folder hidden");
  assert.ok(!names.includes("denied-long-name-folder"));
  const out = entries.find((e) => e.name === "link-out");
  assert.ok(out, "the junction is listed");
  assert.equal(out.link, true, "Node reports a junction as a symbolic link");
  assert.equal(entries.find((e) => e.name === "sub")?.link, false);
});

test("built-in denies from config: group (a) and (b), the workspace exception, and folders.deny", () => {
  const pd = join(base, "ProgramData", "agent-007");
  const data = join(base, "Local", "agent-007");
  const main = join(base, "MainUser");
  const work = join(base, "Work");
  put(join(pd, "secrets", "secrets.json"), "{}");
  put(join(pd, "strata", "strata.json"), "{}");
  put(join(pd, "logs", "strata.log"), "log");
  put(join(data, "state", "agent.sqlite"), "db");
  put(join(data, "memory", "MEMORY.md"), "m");
  put(join(data, "workspace", "notes.txt"), "w");
  put(join(main, ".lmstudio", "models", "m.gguf"), "g");
  put(join(work, "client.txt"), "c");
  put(join(base, "Data", "ok.txt"), "ok");
  for (const runner of ["lmstudio", "strata"] as const) {
    const cfg = parseConfig(
      {
        telegram: { allowedUserIds: [1] },
        model: { runner, runners: { lmstudio: {}, strata: {} } },
        // the whole temp tree is allowed, so only the deny lists stand between the model and these files
        folders: { allow: [{ alias: "all", path: base }], deny: [work] },
        paths: { programDataDir: pd, dataDir: data },
        mainUserProfile: main,
      },
      { localAppData: join(base, "Local"), programData: join(base, "ProgramData"), mainUserProfile: main },
    );
    const read = readPolicyFromConfig(cfg);
    for (const denied of [
      join(pd, "secrets", "secrets.json"),
      join(pd, "strata", "strata.json"),
      join(pd, "logs", "strata.log"),
      join(data, "state", "agent.sqlite"),
      join(data, "memory", "MEMORY.md"),
      join(main, ".lmstudio", "models", "m.gguf"),
      join(work, "client.txt"),
    ]) {
      refused(read, denied, "denied");
    }
    assert.equal(read.resolve(join(base, "Data", "ok.txt")).exists, true);
    // the workspace is carved out of the agent data root
    assert.equal(read.resolve(join(data, "workspace", "notes.txt")).exists, true);
    // the real Strata paths are not under the temp allow root, so they are refused as outside; and they are in the deny list
    refused(read, "D:\\Strata-data\\model.gguf");
    refused(read, "D:\\Strata\\engine\\strata.exe");
    const d = builtinDenies(cfg);
    assert.ok(d.inProcessOnly.some((p) => p.toLowerCase() === "d:\\strata-data"));
    // write policy: root is the workspace; the memory file, USER.md and secrets are out of reach
    const write = writePolicyFromConfig(cfg);
    assert.equal(write.resolve("notes.txt").exists, true);
    assert.equal(write.resolve("new/file.txt").exists, false);
    refused(write, join(data, "memory", "MEMORY.md"), "outside");
    refused(write, join(pd, "config", "USER.md"), "outside");
    refused(write, "workspace:../memory/MEMORY.md", "outside");
    refused(write, "..\\state\\agent.sqlite", "outside");
  }
});

test("a junction inside the workspace pointing at the agent data root or a denied path is refused", () => {
  const data = join(base, "Local2", "agent-007");
  put(join(data, "state", "agent.sqlite"), "db");
  put(join(data, "workspace", "ok.txt"), "ok");
  junction(join(data, "workspace", "to-state"), join(data, "state"));
  const cfg = parseConfig(
    { telegram: { allowedUserIds: [1] }, model: { runners: { lmstudio: {} } }, folders: { allow: [{ alias: "all", path: base }] }, paths: { dataDir: data, programDataDir: join(base, "PD2") } },
    { localAppData: join(base, "Local2"), programData: join(base, "PD2"), mainUserProfile: join(base, "Main2") },
  );
  const w = writePolicyFromConfig(cfg);
  refused(w, "to-state/agent.sqlite", "outside");
  refused(w, "to-state/new.db", "outside");
  assert.equal(w.resolve("ok.txt").exists, true);
});
