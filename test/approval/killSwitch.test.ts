import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as killSwitchModule from "../../src/approval/killSwitch.js";
import { createKillSwitch, killSwitchFlagPath, SHELL_DISABLED_FLAG } from "../../src/approval/killSwitch.js";
import { createMemoryAuditLog } from "../../src/logging/audit.js";
import { createMemoryLogger } from "../../src/logging/logger.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "a7-ks-"));
}

test("off by default; each source turns it on: config, flag file, memory", async () => {
  const dir = tmp();
  try {
    let enabled = true;
    const ks = createKillSwitch({ controlDir: join(dir, "control"), shellEnabled: () => enabled });
    assert.equal(ks.isOn(), false);
    assert.deepEqual(ks.sources(), []);

    // 1. config re-read on every check
    enabled = false;
    assert.equal(ks.isOn(), true);
    assert.deepEqual(ks.sources(), ["config"]);
    assert.equal(ks.blockReason(), "disabled");
    enabled = true;
    assert.equal(ks.isOn(), false, "config is re-read: flipping it back turns shell back on");

    // 2. the flag file, created by someone else (an admin or another process)
    const ks2 = createKillSwitch({ controlDir: dir, shellEnabled: () => true });
    assert.equal(ks2.isOn(), false);
    writeFileSync(killSwitchFlagPath(dir), "x");
    assert.equal(ks2.isOn(), true);
    assert.deepEqual(ks2.sources(), ["flagFile"]);
    assert.equal(ks2.blockReason(), "killswitch");

    // 3. the in-memory flag (and a deleted flag file does not clear it)
    const dir3 = tmp();
    try {
      const ks3 = createKillSwitch({ controlDir: dir3, shellEnabled: () => true });
      await ks3.turnOn("test");
      rmSync(killSwitchFlagPath(dir3));
      assert.equal(ks3.isOn(), true, "memory flag outlives the deleted file in this process");
      assert.deepEqual(ks3.sources(), ["memory"]);
    } finally {
      rmSync(dir3, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a config that throws fails closed", () => {
  const dir = tmp();
  try {
    const ks = createKillSwitch({
      controlDir: dir,
      shellEnabled: () => {
        throw new Error("config unreadable");
      },
    });
    assert.equal(ks.isOn(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("turnOn: memory first, writes the flag file, logs, audits a blocked event, fires onChange", async () => {
  const dir = tmp();
  try {
    const audit = createMemoryAuditLog();
    const logger = createMemoryLogger();
    const ks = createKillSwitch({ controlDir: join(dir, "control"), shellEnabled: () => true, audit, logger, now: () => new Date("2026-10-29T12:00:00Z") });
    let fired = 0;
    let onAtFire: boolean | undefined;
    ks.onChange(() => {
      fired++;
      onAtFire = ks.isOn();
    });
    const p = ks.turnOn("telegram:42");
    assert.equal(ks.isOn(), true, "memory flag is set synchronously, before any await");
    await p;
    assert.equal(fired, 1);
    assert.equal(onAtFire, true, "listeners see the switch already on");
    const flag = join(dir, "control", SHELL_DISABLED_FLAG);
    assert.equal(existsSync(flag), true);
    const body = JSON.parse(readFileSync(flag, "utf8").trim()) as { by: string; at: string };
    assert.equal(body.by, "telegram:42");
    assert.equal(body.at, "2026-10-29T12:00:00.000Z");
    assert.ok(logger.lines.some((l) => l.event === "killswitch.on"));
    const ev = audit.events.find((e) => e.event === "blocked");
    assert.ok(ev && ev.event === "blocked" && ev.reason === "killswitch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing listener or an unwritable control dir does not stop turnOn", async () => {
  const dir = tmp();
  try {
    const logger = createMemoryLogger();
    // controlDir is a path under a FILE, so mkdir/write fail
    const file = join(dir, "afile");
    writeFileSync(file, "x");
    const ks = createKillSwitch({ controlDir: join(file, "sub"), shellEnabled: () => true, logger });
    let second = 0;
    ks.onChange(() => {
      throw new Error("boom");
    });
    ks.onChange(() => second++);
    await ks.turnOn("test");
    assert.equal(ks.isOn(), true);
    assert.equal(second, 1);
    assert.ok(logger.lines.some((l) => l.event === "killswitch.flag_write_failed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no export or method clears the flag, and the source never deletes files", () => {
  const forbidden = /^(turnoff|clear|reset|delete|remove|unset|off|enable|restore|resume)/i;
  for (const name of Object.keys(killSwitchModule)) assert.doesNotMatch(name, forbidden, `export ${name}`);
  const dir = tmp();
  try {
    const ks = createKillSwitch({ controlDir: dir, shellEnabled: () => true });
    for (const name of Object.keys(ks)) assert.doesNotMatch(name, forbidden, `method ${name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const here = fileURLToPath(import.meta.url); // dist/test/approval/killSwitch.test.js
  const src = readFileSync(resolve(here, "..", "..", "..", "..", "src", "approval", "killSwitch.ts"), "utf8");
  assert.doesNotMatch(src, /unlink|rmSync|rmdir|\brm\(/, "killSwitch.ts must not delete anything");
  assert.doesNotMatch(src, /flag:\s*"w"/, "the flag file is only appended to, never rewritten");
});
