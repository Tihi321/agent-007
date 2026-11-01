/** Static guards over the Claude driver sources (S12): imports, and the words that must not appear outside argv.ts. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

// dist/test/jobrunner/claude -> repo root
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const DRIVER_DIR = join(ROOT, "src", "jobrunner", "drivers", "claude");
const HELPER = join(ROOT, "src", "jobrunner", "permissionMcp.ts");

function sources(): Array<{ rel: string; text: string }> {
  const files = readdirSync(DRIVER_DIR).filter((f) => f.endsWith(".ts")).map((f) => join(DRIVER_DIR, f));
  files.push(HELPER);
  return files.map((f) => ({ rel: relative(ROOT, f).replace(/\\/g, "/"), text: readFileSync(f, "utf8") }));
}

describe("claude driver static guards", () => {
  it("finds its sources (the check is not vacuous)", () => {
    assert.ok(sources().length >= 8);
  });

  it("imports neither the Pi adapter nor any Pi package, and no ACP SDK", () => {
    for (const { rel, text } of sources()) {
      assert.equal(/from\s+["'][^"']*pi\/adapter/.test(text), false, `${rel} imports the adapter`);
      assert.equal(/@earendil|@agentclient/.test(text), false, rel);
    }
  });

  it("only argv.ts and its forbidden lists name the bypass flags and modes; nothing sets ANTHROPIC_API_KEY or --bare", () => {
    for (const { rel, text } of sources()) {
      const code = text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
      if (!rel.endsWith("argv.ts")) assert.equal(/dangerously-skip-permissions/.test(code), false, `${rel} names a bypass flag in code`);
      // preflight.ts only reads a settings file's defaultMode to warn about it; nothing else may name the mode
      if (!rel.endsWith("argv.ts") && !rel.endsWith("preflight.ts")) assert.equal(/bypassPermissions/.test(code), false, `${rel} names the bypass mode in code`);
      assert.equal(/ANTHROPIC_API_KEY\s*[:=]/.test(text), false, `${rel} sets ANTHROPIC_API_KEY`);
      assert.equal(/["']--bare["']/.test(text) && !rel.endsWith("argv.ts"), false, `${rel} uses --bare`);
    }
  });

  it("never spawns through a shell", () => {
    for (const { rel, text } of sources()) {
      assert.equal(/shell\s*:\s*true/.test(text), false, rel);
      assert.equal(/\bexec(Sync)?\(/.test(text.replace(/\.exec\(/g, "")), false, `${rel} uses exec`);
    }
  });
});
