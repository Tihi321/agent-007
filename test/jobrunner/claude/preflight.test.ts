import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { claudePreflight } from "../../../src/jobrunner/drivers/claude/preflight.js";
import { tempDir } from "./helpers.js";

function hub(files: Record<string, string>): { cwd: string; cleanup(): void } {
  const t = tempDir("a7-preflight-");
  mkdirSync(join(t.dir, ".claude"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(t.dir, ".claude", name), text);
  return { cwd: t.dir, cleanup: t.cleanup };
}

describe("claude pre-flight (S12.1)", () => {
  it("accepts a settings file with reviewed, argument-scoped rules", async () => {
    const h = hub({
      "settings.json": JSON.stringify({ permissions: { allow: ["Read(./runs/**)", "Glob", "mcp__vibetts__speak"], deny: ["Bash"] } }),
      "settings.local.json": JSON.stringify({ permissions: { allow: [] } }),
    });
    try {
      const r = await claudePreflight({ cwd: h.cwd });
      assert.equal(r.ok, true, r.reasons.join("; "));
      assert.equal(r.filesRead.length, 2);
    } finally {
      h.cleanup();
    }
  });

  it("accepts a missing settings folder", async () => {
    const t = tempDir("a7-preflight-");
    try {
      assert.deepEqual(await claudePreflight({ cwd: t.dir }), { ok: true, reasons: [], warnings: [], filesRead: [] });
    } finally {
      t.cleanup();
    }
  });

  it("refuses allow rules for Bash or PowerShell, with or without arguments", async () => {
    for (const rule of ["Bash", "Bash(git log *)", "PowerShell", "powershell(Get-ChildItem)"]) {
      const h = hub({ "settings.local.json": JSON.stringify({ permissions: { allow: [rule] } }) });
      try {
        const r = await claudePreflight({ cwd: h.cwd });
        assert.equal(r.ok, false, rule);
        assert.match(r.reasons[0] ?? "", /shell tool/);
        assert.match(r.reasons[0] ?? "", /settings\.local\.json/);
      } finally {
        h.cleanup();
      }
    }
  });

  it("refuses wildcard tools unless reviewed", async () => {
    const h = hub({ "settings.json": JSON.stringify({ permissions: { allow: ["*", "mcp__*", "mcp__vibetts__*", "Read(//c/x/**)"] } }) });
    try {
      const r = await claudePreflight({ cwd: h.cwd });
      assert.equal(r.ok, false);
      assert.equal(r.reasons.length, 3);
      const ok = await claudePreflight({ cwd: h.cwd, reviewedAllow: ["*", "mcp__*", "mcp__vibetts__*"] });
      assert.equal(ok.ok, true);
      const some = await claudePreflight({ cwd: h.cwd, reviewedAllow: ["mcp__vibetts__*"] });
      assert.equal(some.reasons.length, 2);
    } finally {
      h.cleanup();
    }
  });

  it("fails closed on invalid JSON, a wrong shape or an unreadable file", async () => {
    const h = hub({ "settings.json": "{ nope", "settings.local.json": JSON.stringify({ permissions: { allow: "Bash" } }) });
    try {
      const r = await claudePreflight({ cwd: h.cwd });
      assert.equal(r.ok, false);
      assert.equal(r.reasons.length, 2);
    } finally {
      h.cleanup();
    }
    const r = await claudePreflight({
      cwd: "C:\\x",
      readText: async () => {
        throw Object.assign(new Error("locked"), { code: "EBUSY" });
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.reasons[0] ?? "", /EBUSY/);
  });

  it("warns about hooks and a bypass defaultMode, and reads extra files on request", async () => {
    const h = hub({ "settings.json": JSON.stringify({ hooks: { PreToolUse: [] }, permissions: { defaultMode: "bypassPermissions" } }) });
    try {
      const r = await claudePreflight({ cwd: h.cwd });
      assert.equal(r.ok, true);
      assert.equal(r.warnings.length, 2);
      const extra = join(h.cwd, "user-settings.json");
      writeFileSync(extra, JSON.stringify({ permissions: { allow: ["Bash"] } }));
      assert.equal((await claudePreflight({ cwd: h.cwd, extraSettingsFiles: [extra] })).ok, false);
    } finally {
      h.cleanup();
    }
  });
});
