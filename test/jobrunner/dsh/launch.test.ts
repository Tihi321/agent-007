import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DshNotFoundError, buildChildEnv, buildLaunch, resolveDshPath } from "../../../src/jobrunner/drivers/dsh/launch.js";
import { tempDir } from "./helpers.js";

test("buildChildEnv: an allowlist of the parent, the key only from the argument", () => {
  const env = buildChildEnv(
    { PATH: "p", SystemRoot: "r", GITHUB_TOKEN: "x", DEEPSEEK_API_KEY: "from-parent", ANTHROPIC_API_KEY: "y" },
    "the-key",
    { FOO: "bar", DEEPSEEK_API_KEY: "sneaky" },
  );
  assert.equal(env["PATH"], "p");
  assert.equal(env["SystemRoot"], "r");
  assert.equal(env["FOO"], "bar");
  assert.equal(env["DEEPSEEK_API_KEY"], "the-key");
  assert.equal(env["GITHUB_TOKEN"], undefined);
  assert.equal(env["ANTHROPIC_API_KEY"], undefined);
  assert.equal(buildChildEnv({ DEEPSEEK_API_KEY: "from-parent" }, undefined)["DEEPSEEK_API_KEY"], undefined);
});

test("buildLaunch: .cmd goes through cmd.exe on Windows with a quoted path; other files run directly", () => {
  const l = buildLaunch("C:\\Users\\me\\AppData\\Local\\dsh dir\\dsh.cmd", ["--profile", "acp"], { platform: "win32", comspec: "C:\\Windows\\System32\\cmd.exe" });
  assert.equal(l.file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(l.args, ["/d", "/s", "/c", '""C:\\Users\\me\\AppData\\Local\\dsh dir\\dsh.cmd" --profile acp"']);
  assert.equal(l.windowsVerbatimArguments, true);
  const exe = buildLaunch("C:\\tools\\dsh.exe", ["--version"], { platform: "win32" });
  assert.deepEqual(exe, { file: "C:\\tools\\dsh.exe", args: ["--version"] });
  assert.deepEqual(buildLaunch("/usr/bin/dsh", ["--profile", "acp"], { platform: "linux" }), { file: "/usr/bin/dsh", args: ["--profile", "acp"] });
});

test("buildLaunch: an unsafe path or argument is refused", () => {
  for (const bad of ['C:\\a&b\\dsh.cmd', 'C:\\a"b\\dsh.cmd', "C:\\a%PATH%\\dsh.cmd", "C:\\a^b\\dsh.cmd", "C:\\a|b\\dsh.cmd"]) {
    assert.throws(() => buildLaunch(bad, ["--version"], { platform: "win32" }), DshNotFoundError, bad);
  }
  assert.throws(() => buildLaunch("C:\\ok\\dsh.cmd", ["--x & calc"], { platform: "win32" }), DshNotFoundError);
  assert.throws(() => buildLaunch("relative\\dsh.cmd", [], { platform: "win32" }), DshNotFoundError);
});

test("resolveDshPath: explicit absolute path must exist; else PATH is searched read-only", () => {
  const dir = tempDir();
  try {
    const bin = join(dir.path, "bin");
    mkdirSync(bin);
    const cmd = join(bin, "dsh.cmd");
    writeFileSync(cmd, "@echo off\r\n");
    assert.equal(resolveDshPath({ explicit: cmd }), cmd);
    assert.throws(() => resolveDshPath({ explicit: join(bin, "missing.cmd") }), DshNotFoundError);
    assert.throws(() => resolveDshPath({ explicit: "dsh.cmd" }), DshNotFoundError);
    assert.equal(resolveDshPath({ env: { PATH: `${join(dir.path, "nothing")};${bin}` }, platform: "win32" }), cmd);
    assert.throws(() => resolveDshPath({ env: { PATH: "" }, platform: "win32" }), DshNotFoundError);
    // a relative PATH entry is ignored
    assert.throws(() => resolveDshPath({ env: { PATH: "bin" }, platform: "win32", isFile: () => true }), DshNotFoundError);
  } finally {
    dir.cleanup();
  }
});
