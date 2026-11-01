import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireLock, EXIT_CODE_LOCK_HELD, isProcessAlive, LockHeldError } from "../src/runtime/lock.js";

const CHILD = resolve(fileURLToPath(import.meta.url), "..", "helpers", "lock-child.js");

function run(lockPath: string, holdMs: number): { child: ChildProcess; out: Promise<string>; exit: Promise<number | null> } {
  const child = spawn(process.execPath, [CHILD, lockPath, String(holdMs)], { stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  const out = new Promise<string>((res) => {
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      if (/ACQUIRED|HELD/.test(buf)) res(buf.trim());
    });
    child.on("exit", () => res(buf.trim()));
  });
  const exit = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
  return { child, out, exit };
}

test("two processes: the second exits 3 while the first holds the lock; a dead holder is taken over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a7-lock-"));
  const lockPath = join(dir, "run", "agent.lock");
  try {
    const first = run(lockPath, 30_000);
    assert.equal(await first.out, "ACQUIRED");
    const info = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; startedAt: string };
    assert.equal(info.pid, first.child.pid);

    const second = run(lockPath, 0);
    assert.match(await second.out, /^HELD \d+$/);
    assert.equal(await second.exit, EXIT_CODE_LOCK_HELD);

    // kill the holder without a clean release: the lock file stays, but the PID is dead
    first.child.kill("SIGKILL");
    await first.exit;
    assert.equal(existsSync(lockPath), true);
    assert.equal(isProcessAlive(info.pid), false);

    const third = run(lockPath, 0);
    assert.equal(await third.out, "ACQUIRED");
    assert.equal(await third.exit, 0);
    assert.equal(existsSync(lockPath), false, "a clean release removes the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in-process: live holder refuses, dead holder and garbage are taken over, release only removes our own", () => {
  const dir = mkdtempSync(join(tmpdir(), "a7-lock2-"));
  const p = join(dir, "agent.lock");
  try {
    writeFileSync(p, JSON.stringify({ pid: 4242, startedAt: "x" }));
    assert.throws(() => acquireLock(p, { pid: 1, isAlive: (pid) => pid === 4242 }), LockHeldError);
    const lock = acquireLock(p, { pid: 1, isAlive: () => false });
    assert.equal(JSON.parse(readFileSync(p, "utf8")).pid, 1);
    lock.release();
    assert.equal(existsSync(p), false);

    writeFileSync(p, "not json");
    const l2 = acquireLock(p, { pid: 2 });
    writeFileSync(p, JSON.stringify({ pid: 99, startedAt: "x" })); // someone else now owns it
    l2.release();
    assert.equal(existsSync(p), true, "must not delete another instance's lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
