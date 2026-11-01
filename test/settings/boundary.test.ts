import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { ROOT } from "./helpers.js";

/** The pure subset (no import of the adapter, usable by the job runner and the migration script). */
const PURE = [
  "contracts", "jsonschema", "schema", "split", "migrate", "allowlist", "audit", "chain", "securityWriter", "personaSchema", "ceiling", "compare", "catalog",
  "store", "prefs", "style", "acl", "load", "drift", "secretShape", "builtins",
];

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1] as string);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const src = (p: string): string => join(ROOT, "src", p);

test("the pure subset never imports the adapter, a Pi package, typebox, or a module that does", () => {
  for (const name of PURE) {
    const file = src(`settings/${name}.ts`);
    for (const spec of importsOf(file)) {
      assert.ok(!/pi\/adapter/.test(spec), `${name}.ts imports the adapter (${spec})`);
      assert.ok(!/@earendil-works|typebox/.test(spec), `${name}.ts imports ${spec}`);
      assert.ok(!/config\/load\.js$/.test(spec), `${name}.ts imports config/load.js, which imports the adapter`);
      assert.ok(!/\/(tools|agent|telegram|jobs|mcp|personas|jobrunner)\//.test(spec), `${name}.ts imports ${spec}, outside the pure subset`);
      if (spec.startsWith("./")) {
        const base = spec.replace(/^\.\//, "").replace(/\.js$/, "");
        assert.ok(PURE.includes(base), `${name}.ts imports ./${base}, which is not in the pure subset`);
      }
    }
  }
});

test("only src/jobrunner/settingsUi/** and scripts/migrate-settings.ts import securityWriter", () => {
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "scripts"))];
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, "/");
    if (rel === "src/settings/securityWriter.ts") continue;
    const uses = importsOf(f).some((s) => /securityWriter(\.js)?$/.test(s));
    if (!uses) continue;
    assert.ok(rel.startsWith("src/jobrunner/settingsUi/") || rel === "scripts/migrate-settings.ts", `${rel} imports securityWriter`);
  }
});

test("no agent-side file imports securityWriter or writes a path built from securityFile", () => {
  const agentSide = [
    ...walk(src("agent")),
    ...walk(src("tools")),
    ...walk(src("shell")),
    ...walk(src("telegram")),
    ...(statSyncSafe(src("personas")) ? walk(src("personas")) : []),
    src("settings/proposals.ts"),
    src("settings/tools.ts"),
  ];
  const write = /\b(writeFileSync|writeFile|appendFile|appendFileSync|renameSync|rename|rmSync|unlinkSync|copyFileSync|saveSecurity|saveJsonAudited|replaceAudited|createWriteStream)\b/;
  for (const f of agentSide) {
    const text = readFileSync(f, "utf8");
    assert.ok(!importsOf(f).some((s) => /securityWriter/.test(s)), `${relative(ROOT, f)} imports securityWriter`);
    if (/securityFile/.test(text)) assert.ok(!write.test(text), `${relative(ROOT, f)} mentions securityFile and a write call`);
  }
  assert.ok(!/securityFile/.test(readFileSync(src("settings/proposals.ts"), "utf8")));
  assert.ok(!/securityFile/.test(readFileSync(src("settings/tools.ts"), "utf8")));
});

test("the allowlist table has no row of security class", () => {
  const text = readFileSync(src("settings/allowlist.ts"), "utf8");
  assert.ok(!/class:\s*"security"/.test(text));
});

function statSyncSafe(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
