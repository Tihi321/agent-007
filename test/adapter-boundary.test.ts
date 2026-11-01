import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findAcpViolations, findBoundaryViolations } from "../scripts/check-adapter-boundary.js";

// dist/test/adapter-boundary.test.js -> project root
const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

test("the real tree: only src/pi/adapter.ts imports the Pi packages or typebox", () => {
  const v = findBoundaryViolations(ROOT);
  assert.deepEqual(v, []);
});

test("the checker flags an import outside the adapter", () => {
  const dir = mkdtempSync(join(tmpdir(), "a7-boundary-"));
  try {
    mkdirSync(join(dir, "src", "pi"), { recursive: true });
    mkdirSync(join(dir, "src", "tools"), { recursive: true });
    const pkg = "@earendil" + "-works/pi-durable";
    writeFileSync(join(dir, "src", "pi", "adapter.ts"), `import { Harness } from "${pkg}";\n`);
    writeFileSync(join(dir, "src", "tools", "bad.ts"), `import { Harness } from "${pkg}";\n`);
    writeFileSync(join(dir, "src", "tools", "bad2.ts"), `import { Type } from "type${"box"}";\n`);
    writeFileSync(join(dir, "src", "tools", "ok.ts"), `import { x } from "../pi/adapter.js";\n`);
    const v = findBoundaryViolations(dir);
    assert.deepEqual(v.map((x) => x.file).sort(), ["src/tools/bad.ts", "src/tools/bad2.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- S9.2: the second boundary check (the ACP SDK) -------------------------------------------------

const ACP = "@agentclient" + "protocol/sdk";

test("the real tree: the ACP SDK appears only under src/jobrunner/drivers/dsh/ and test/jobrunner/dsh/", () => {
  assert.deepEqual(findAcpViolations(ROOT), []);
});

test("the ACP checker allows the two dsh folders and flags every other file", () => {
  const dir = mkdtempSync(join(tmpdir(), "a7-acp-boundary-"));
  try {
    for (const d of ["src/jobrunner/drivers/dsh", "test/jobrunner/dsh", "src/jobrunner/drivers/claude", "src/jobrunner", "src/pi", "test/jobrunner/core", "scripts"]) mkdirSync(join(dir, d), { recursive: true });
    const line = `import { client } from "${ACP}";\n`;
    writeFileSync(join(dir, "src/jobrunner/drivers/dsh/driver.ts"), line);
    writeFileSync(join(dir, "test/jobrunner/dsh/fake.test.ts"), line);
    writeFileSync(join(dir, "src/jobrunner/drivers/claude/bad.ts"), line);
    writeFileSync(join(dir, "src/jobrunner/server.ts"), line);
    writeFileSync(join(dir, "src/pi/adapter.ts"), line);
    writeFileSync(join(dir, "test/jobrunner/core/bad.test.ts"), line);
    writeFileSync(join(dir, "scripts/bad.ts"), line);
    // a look-alike folder name is not allowed
    mkdirSync(join(dir, "src/jobrunner/drivers/dsh2"), { recursive: true });
    writeFileSync(join(dir, "src/jobrunner/drivers/dsh2/bad.ts"), line);
    const v = findAcpViolations(dir);
    assert.deepEqual(
      v.map((x) => x.file).sort(),
      ["scripts/bad.ts", "src/jobrunner/drivers/claude/bad.ts", "src/jobrunner/drivers/dsh2/bad.ts", "src/jobrunner/server.ts", "src/pi/adapter.ts", "test/jobrunner/core/bad.test.ts"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the adapter checker treats pi-mcp like any other Pi package", () => {
  const dir = mkdtempSync(join(tmpdir(), "a7-boundary-mcp-"));
  try {
    mkdirSync(join(dir, "src", "mcp"), { recursive: true });
    writeFileSync(join(dir, "src", "mcp", "bad.ts"), `import { McpClient } from "@earendil${"-works"}/pi-mcp";\n`);
    assert.deepEqual(findBoundaryViolations(dir).map((x) => x.file), ["src/mcp/bad.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
