/**
 * PowerShell runner tests. They spawn real Windows PowerShell with harmless commands only
 * (Write-Output, whoami, Start-Sleep, exit, environment and location reads).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import { buildShellEnv, composeOutput, createShellRunner, effectiveTimeoutSec, encodeCommand, OUTPUT_ENCODING_PREFIX, resolvePowerShellPath } from "../../src/shell/runner.js";
import type { ShellRunner } from "../../src/shell/runner.js";
import { cfg } from "./fakes.js";

const isWindows = process.platform === "win32";
const opts = { skip: !isWindows };

let ws: string;
let runner: ShellRunner;

before(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "a7-shell-")));
  runner = createShellRunner({ workspaceDir: ws, getShellConfig: () => cfg() });
});
after(() => rmSync(ws, { recursive: true, force: true }));

const run = (command: string, timeoutSec = 30, key = `k${Math.random().toString(36).slice(2)}`) => runner.run({ key, command, timeoutSec });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("pure helpers: absolute PowerShell path, command encoding, timeout clamp", () => {
  assert.equal(resolvePowerShellPath({ SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const enc = encodeCommand("Write-Output 'æøå'");
  assert.equal(Buffer.from(enc, "base64").toString("utf16le"), OUTPUT_ENCODING_PREFIX + "Write-Output 'æøå'");
  const c = cfg({ execTimeoutSec: 120, maxExecTimeoutSec: 600 });
  assert.equal(effectiveTimeoutSec(undefined, c), 120);
  assert.equal(effectiveTimeoutSec(30, c), 30);
  assert.equal(effectiveTimeoutSec(9999, c), 600);
  assert.equal(effectiveTimeoutSec(0, c), 1);
  assert.equal(effectiveTimeoutSec(Number.NaN, c), 120);
});

test("buildShellEnv: only the listed variables, no secrets, TEMP/TMP inside the workspace", () => {
  const src = {
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    Path: "C:\\evil;C:\\other",
    USERPROFILE: "C:\\Users\\a",
    LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
    APPDATA: "C:\\Users\\a\\AppData\\Roaming",
    COMPUTERNAME: "PC",
    USERNAME: "a",
    PSModulePath: "C:\\mods",
    TELEGRAM_TOKEN: "123:secret",
    AWS_SECRET_ACCESS_KEY: "shh",
    LMSTUDIO_API_KEY: "sk-lm",
    TEMP: "C:\\Users\\a\\AppData\\Local\\Temp",
  };
  const env = buildShellEnv("C:\\ws", src);
  assert.equal(env["TEMP"], "C:\\ws\\.tmp");
  assert.equal(env["TMP"], "C:\\ws\\.tmp");
  assert.equal(env["USERPROFILE"], "C:\\Users\\a");
  assert.equal(env["PSModulePath"], "C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules", "system default, not the inherited path");
  assert.ok(!(env["PATH"] ?? "").includes("evil"), "PATH is the system default, not the process PATH");
  assert.ok((env["PATH"] ?? "").startsWith("C:\\Windows\\System32;"));
  const allowed = new Set(["SystemRoot", "windir", "PATH", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "COMPUTERNAME", "USERNAME", "PSModulePath", "ComSpec", "PATHEXT"]);
  for (const k of Object.keys(env)) assert.ok(allowed.has(k), `unexpected variable ${k}`);
  assert.doesNotMatch(JSON.stringify(env), /secret|shh|sk-lm/);
});

test("composeOutput: whole output when small; head + marker + tail when large; multi-byte characters are not split", () => {
  const mk = (s: string) => {
    const b = Buffer.from(s, "utf8");
    return { total: b.length, storedBuffer: () => b, tailBuffer: () => b };
  };
  const small = mk("hello");
  assert.deepEqual(composeOutput(small, 100, 5), { text: "hello", truncatedBytes: 0 });
  const big = mk("a".repeat(1000));
  const r = composeOutput(big, 100, 1000);
  assert.match(r.text, /\[truncated 900 bytes\]/);
  assert.ok(Buffer.byteLength(r.text) < 100 + 40);
  const wide = mk("æ".repeat(500)); // 1000 bytes of 2-byte characters; odd cut points land mid-character
  const w = composeOutput(wide, 101, 1000);
  assert.doesNotMatch(w.text, /\uFFFD/, "no replacement characters from a split character");
});

test("whoami returns the current user", opts, async () => {
  const r = await run("whoami");
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  const me = userInfo().username.toLowerCase();
  assert.ok(r.output.trim().toLowerCase().endsWith(me), `whoami said ${JSON.stringify(r.output.trim())}, expected user ${me}`);
  assert.ok(r.pid && r.pid > 0);
});

test("non-ASCII output round-trips, with no BOM", opts, async () => {
  const r = await run('Write-Output "æøå ÆØÅ ✓"');
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.trim(), "æøå ÆØÅ ✓");
  assert.ok(!r.output.startsWith("\uFEFF"));
  // the saved file holds the same bytes and its hash matches
  const bytes = readFileSync(r.outputFile);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), r.sha256);
  assert.equal(r.totalBytes, bytes.length);
});

test("exit code is returned; stderr is captured too", opts, async () => {
  const r = await run("[Console]::Error.WriteLine('oops'); exit 3");
  assert.equal(r.exitCode, 3);
  assert.match(r.output, /oops/);
});

test("launched with -NoProfile and -ExecutionPolicy Restricted, cwd = workspace, TEMP in the workspace, stdin closed", opts, async () => {
  const r = await run(
    "[Environment]::GetCommandLineArgs() -join ' '; (Get-Location).Path; $env:TEMP; $env:TMP; Get-ExecutionPolicy -Scope Process; $x = [Console]::In.ReadToEnd(); \"stdin-length=$($x.Length)\"",
  );
  assert.equal(r.exitCode, 0, r.output);
  const lines = r.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  assert.match(lines[0] ?? "", /-NoProfile/);
  assert.match(lines[0] ?? "", /-NonInteractive/);
  assert.match(lines[0] ?? "", /-ExecutionPolicy Restricted/);
  assert.match(lines[0] ?? "", /-EncodedCommand/);
  assert.equal(lines[1]?.toLowerCase(), ws.toLowerCase(), "cwd is the workspace");
  assert.equal(lines[2]?.toLowerCase(), join(ws, ".tmp").toLowerCase());
  assert.equal(lines[3]?.toLowerCase(), join(ws, ".tmp").toLowerCase());
  assert.equal(lines[4], "Restricted");
  assert.equal(lines[5], "stdin-length=0");
  assert.ok(existsSync(join(ws, ".tmp")));
});

test("the environment dump contains no secret values from the agent's own environment", opts, async () => {
  process.env["A7_TEST_SECRET_VALUE"] = "super-secret-value-12345";
  process.env["TELEGRAM_BOT_TOKEN"] = "123456:ABC-secret-token";
  try {
    const r = await run("Get-ChildItem Env: | ForEach-Object { $_.Name + '=' + $_.Value }");
    assert.equal(r.exitCode, 0);
    assert.doesNotMatch(r.output, /super-secret-value-12345|ABC-secret-token|A7_TEST_SECRET_VALUE|TELEGRAM_BOT_TOKEN/);
    assert.match(r.output, /SystemRoot=/i);
  } finally {
    delete process.env["A7_TEST_SECRET_VALUE"];
    delete process.env["TELEGRAM_BOT_TOKEN"];
  }
});

test("Start-Sleep 30 with a 3 s timeout is killed, flagged timedOut, and its process is gone", opts, async () => {
  const t0 = Date.now();
  const r = await run("Start-Sleep 30", 3);
  const took = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.ok(took >= 2800 && took < 15_000, `took ${took} ms`);
  assert.ok(r.pid);
  assert.equal(alive(r.pid), false, "the PowerShell process is gone");
});

test("the timeout kills the whole tree: a child process started by the command is gone too", opts, async () => {
  const r = await run(
    "$p = [System.Diagnostics.Process]::Start('powershell.exe', '-NoProfile -NonInteractive -Command Start-Sleep 30'); Write-Output \"CHILD=$($p.Id)\"; Start-Sleep 30",
    4,
  );
  assert.equal(r.timedOut, true);
  const m = /CHILD=(\d+)/.exec(r.output);
  assert.ok(m, `child pid not in output: ${JSON.stringify(r.output)}`);
  const child = Number(m[1]);
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(alive(child), false, "the child process was killed with the tree");
});

test("an abort signal kills the command", opts, async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1500);
  const r = await runner.run({ key: "abort-test", command: "Start-Sleep 30", timeoutSec: 30, signal: ac.signal });
  assert.equal(r.aborted, true);
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, null);
  assert.ok(r.durationMs < 15_000);
  assert.ok(r.pid && !alive(r.pid));
  const pre = new AbortController();
  pre.abort();
  const r2 = await runner.run({ key: "abort-test-2", command: "Start-Sleep 30", timeoutSec: 30, signal: pre.signal });
  assert.equal(r2.aborted, true);
});

test("200 KB of output is capped, truncated with a marker, saved up to the cap, and fully hashed", opts, async () => {
  // 4000 lines of 49 characters plus CRLF = 204,000 bytes
  const r = await run("1..4000 | ForEach-Object { 'x' * 49 }");
  assert.equal(r.exitCode, 0);
  assert.equal(r.totalBytes, 4000 * 51);
  assert.equal(r.storedBytes, 65536, "saved output is capped at maxOutputBytes");
  assert.equal(statSync(r.outputFile).size, 65536);
  assert.ok(Buffer.byteLength(r.output) <= 8192 + 40, `returned ${Buffer.byteLength(r.output)} bytes`);
  const m = /\[truncated (\d+) bytes\]/.exec(r.output);
  assert.ok(m, "marker present");
  assert.equal(Number(m[1]), r.truncatedBytes);
  assert.ok(r.truncatedBytes > 190_000);
  assert.equal(r.output.startsWith("x".repeat(49)), true);
  assert.equal(r.sha256.length, 64);
});

test("head and tail are real: the first and the LAST lines survive, the middle is cut", opts, async () => {
  const r = await run("1..30000 | ForEach-Object { \"L$_\" }");
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /^L1\r?\nL2\r?\n/);
  assert.match(r.output.trimEnd(), /L30000$/, "the tail is from the end of the whole stream, not from the capped copy");
  assert.match(r.output, /\[truncated \d+ bytes\]/);
  assert.doesNotMatch(r.output, /\nL15000\r?\n/);
});

test("the output file is named from the key, safely, inside workspace\\shell-output", opts, async () => {
  const r = await run("Write-Output ok", 30, "conv:1/../../evil call*?");
  assert.ok(r.outputFile.toLowerCase().startsWith(join(ws, "shell-output").toLowerCase()));
  assert.ok(existsSync(r.outputFile));
  assert.doesNotMatch(r.outputFile.slice(ws.length), /[:*?<>|"]/);
});

test("a missing PowerShell binary at an explicit path rejects instead of hanging", opts, async () => {
  const bad = createShellRunner({ workspaceDir: ws, getShellConfig: () => cfg(), powershellPath: join(ws, "no-such-powershell.exe") });
  await assert.rejects(bad.run({ key: "bad", command: "Write-Output 1", timeoutSec: 5 }));
});
