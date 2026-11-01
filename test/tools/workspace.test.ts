import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseConfig } from "../../src/config/schema.js";
import { PathPolicyError, writePolicyFromConfig } from "../../src/tools/pathPolicy.js";
import { ToolRefusal } from "../../src/tools/folders.js";
import * as workspaceModule from "../../src/tools/workspace.js";
import { WORKSPACE_MAX_FILE_BYTES, createWriteFileTool, writeWorkspaceFile } from "../../src/tools/workspace.js";
import type { WorkspaceDeps } from "../../src/tools/workspace.js";
import { cleanup, junction, put, tempBase } from "./fixture.js";

let base: string;
let data: string;
let workspace: string;
let outside: string;
let userFile: string;
let deps: WorkspaceDeps;

before(() => {
  base = tempBase("workspace");
  data = join(base, "Local", "agent-007");
  workspace = join(data, "workspace");
  outside = join(base, "outside");
  const pd = join(base, "ProgramData", "agent-007");
  userFile = join(pd, "config", "USER.md");
  put(userFile, "the user\n");
  put(join(outside, "target.txt"), "outside original");
  put(join(data, "memory", "MEMORY.md"), "- 2026-01-01: memory\n");
  junction(join(workspace, "escape"), outside);
  const cfg = parseConfig(
    { telegram: { allowedUserIds: [1] }, model: { runners: { lmstudio: {} } }, folders: { allow: [{ alias: "all", path: base }] }, paths: { dataDir: data, programDataDir: pd } },
    { localAppData: join(base, "Local"), programData: join(base, "ProgramData"), mainUserProfile: join(base, "Main") },
  );
  deps = { policy: writePolicyFromConfig(cfg) };
});

after(() => cleanup(base));

test("create, overwrite and append inside the workspace, with folders created on the way", () => {
  assert.match(writeWorkspaceFile(deps, { path: "notes/today.txt", content: "one\n", mode: "create" }), /Wrote 4 bytes to workspace:notes\/today\.txt \(create\)/);
  const file = join(workspace, "notes", "today.txt");
  assert.equal(readFileSync(file, "utf8"), "one\n");
  writeWorkspaceFile(deps, { path: "notes/today.txt", content: "two\n", mode: "append" });
  assert.equal(readFileSync(file, "utf8"), "one\ntwo\n");
  writeWorkspaceFile(deps, { path: "notes/today.txt", content: "three\n", mode: "overwrite" });
  assert.equal(readFileSync(file, "utf8"), "three\n");
  // overwrite and append also create a missing file
  writeWorkspaceFile(deps, { path: "fresh.txt", content: "a", mode: "overwrite" });
  writeWorkspaceFile(deps, { path: "workspace:fresh2.txt", content: "b", mode: "append" });
  assert.equal(readFileSync(join(workspace, "fresh.txt"), "utf8"), "a");
  assert.equal(readFileSync(join(workspace, "fresh2.txt"), "utf8"), "b");
  // UTF-8 text round-trips
  writeWorkspaceFile(deps, { path: "utf8.txt", content: "héllo wörld ✓", mode: "create" });
  assert.equal(readFileSync(join(workspace, "utf8.txt"), "utf8"), "héllo wörld ✓");
});

test("create fails when the file exists, and nothing is changed", () => {
  put(join(workspace, "exists.txt"), "original");
  assert.throws(() => writeWorkspaceFile(deps, { path: "exists.txt", content: "new", mode: "create" }), (e: unknown) => e instanceof ToolRefusal && /already exists/.test(e.message));
  assert.equal(readFileSync(join(workspace, "exists.txt"), "utf8"), "original");
});

test("writes outside the workspace are refused: .. traversal, absolute paths, the memory file, USER.md, other drives", () => {
  const before = readFileSync(userFile, "utf8");
  for (const p of ["../escape.txt", "..\\..\\escape.txt", "workspace:../escape.txt", join(base, "outside", "new.txt"), join(data, "memory", "MEMORY.md"), userFile, "C:\\Windows\\Temp\\x.txt", "D:\\Strata-data\\x.bin"]) {
    assert.throws(() => writeWorkspaceFile(deps, { path: p, content: "x", mode: "overwrite" }), PathPolicyError, p);
  }
  assert.equal(readFileSync(userFile, "utf8"), before, "USER.md untouched");
  assert.equal(readFileSync(join(data, "memory", "MEMORY.md"), "utf8"), "- 2026-01-01: memory\n");
  assert.equal(existsSync(join(base, "escape.txt")), false);
});

test("a write through a junction in the workspace is refused, existing and new targets alike", () => {
  assert.throws(() => writeWorkspaceFile(deps, { path: "escape/target.txt", content: "pwned", mode: "overwrite" }), PathPolicyError);
  assert.throws(() => writeWorkspaceFile(deps, { path: "escape/new.txt", content: "pwned", mode: "create" }), PathPolicyError);
  assert.throws(() => writeWorkspaceFile(deps, { path: "escape/deep/new.txt", content: "pwned", mode: "create" }), PathPolicyError);
  assert.equal(readFileSync(join(outside, "target.txt"), "utf8"), "outside original");
  assert.deepEqual(readdirSync(outside), ["target.txt"], "nothing created, no folder made through the junction");
});

test("path tricks are refused: ADS, trailing dot, device names, UNC, extended prefix", () => {
  for (const p of ["a.txt:zone", "a.txt.", "con.txt", "NUL", "\\\\server\\share\\a.txt", "\\\\?\\C:\\x\\a.txt", "sub/aux", "a?.txt"]) {
    assert.throws(() => writeWorkspaceFile(deps, { path: p, content: "x", mode: "create" }), PathPolicyError, p);
  }
});

test("size limit is 1 MB per file (also for append), NUL bytes and bad modes are refused", () => {
  const max = WORKSPACE_MAX_FILE_BYTES;
  assert.equal(max, 1024 * 1024);
  writeWorkspaceFile(deps, { path: "limit.txt", content: "x".repeat(max), mode: "create" });
  assert.equal(readFileSync(join(workspace, "limit.txt")).length, max);
  assert.throws(() => writeWorkspaceFile(deps, { path: "toolarge.txt", content: "x".repeat(max + 1), mode: "create" }), ToolRefusal);
  assert.equal(existsSync(join(workspace, "toolarge.txt")), false);
  assert.throws(() => writeWorkspaceFile(deps, { path: "limit.txt", content: "y", mode: "append" }), (e: unknown) => e instanceof ToolRefusal && /larger than/.test(e.message));
  assert.throws(() => writeWorkspaceFile(deps, { path: "nul.txt", content: "a\u0000b", mode: "create" }), ToolRefusal);
  assert.throws(() => writeWorkspaceFile(deps, { path: "m.txt", content: "a", mode: "delete" as never }), ToolRefusal);
  // multi-byte text counts in bytes
  assert.throws(() => writeWorkspaceFile(deps, { path: "mb.txt", content: "é".repeat(max / 2 + 1), mode: "create" }), ToolRefusal);
});

test("a folder or the workspace root cannot be written as a file", () => {
  put(join(workspace, "adir", "x.txt"), "x");
  assert.throws(() => writeWorkspaceFile(deps, { path: "adir", content: "x", mode: "overwrite" }), (e: unknown) => e instanceof ToolRefusal && /folder/.test(e.message));
  assert.throws(() => writeWorkspaceFile(deps, { path: "workspace:", content: "x", mode: "overwrite" }), ToolRefusal);
  // a file where a parent folder is needed fails as a filesystem error, not a write
  assert.throws(() => writeWorkspaceFile(deps, { path: "exists.txt/child.txt", content: "x", mode: "create" }));
});

test("no delete or rename tool exists in the module", () => {
  const names = Object.keys(workspaceModule).join(" ").toLowerCase();
  assert.ok(!/delete|remove|rename|unlink/.test(names), names);
});

test("write_file tool: replay unsafe, frozen name, refusals become error results", async () => {
  const tool = createWriteFileTool(deps);
  assert.equal(tool.name, "write_file");
  assert.equal(tool.replay, "unsafe");
  const noApi = {} as never;
  const ok = await tool.execute({ path: "tool-ok.txt", content: "hi", mode: "create" }, noApi, noApi);
  assert.equal(ok.isError, undefined);
  assert.match(JSON.stringify(ok.output), /Wrote 2 bytes/);
  const bad = await tool.execute({ path: "../x.txt", content: "hi", mode: "create" }, noApi, noApi);
  assert.equal(bad.isError, true);
  assert.ok(!JSON.stringify(bad.output).includes(base.replace(/\\/g, "\\\\")));
});
