import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { defaultsFromEnv, parseConfig } from "../../src/config/schema.js";
import type { Config } from "../../src/config/schema.js";
import { listDir, readFile, searchFiles } from "../../src/tools/folders.js";
import { PathPolicyError, readPolicyFromConfig, writePolicyFromConfig } from "../../src/tools/pathPolicy.js";
import { writeWorkspaceFile } from "../../src/tools/workspace.js";
import { cleanup, junction, put, tempBase } from "../tools/fixture.js";

let base: string;
let configs: Config[] = [];
let targets: string[] = [];
let dirs: string[] = [];

function config(runner: "lmstudio" | "strata"): Config {
  return parseConfig(
    {
      telegram: { allowedUserIds: [1] },
      model: { runner, runners: { [runner]: { baseUrl: "http://127.0.0.1:1234/v1", modelId: "m", contextWindow: 8192, maxTokens: 512 } } },
      folders: { allow: [{ alias: "notes", path: join(base, "notes") }], deny: [] },
      paths: { programDataDir: join(base, "pd"), dataDir: join(base, "data"), workspaceDir: join(base, "data", "workspace"), memoryFile: join(base, "data", "memory", "MEMORY.md") },
      mainUserProfile: join(base, "profile"),
    },
    defaultsFromEnv(),
  );
}

before(() => {
  base = tempBase("settings-pp");
  put(join(base, "notes", "a.txt"), "allowed");
  put(join(base, "data", "workspace", "w.txt"), "workspace");
  targets = [
    put(join(base, "pd", "settings", "security.json"), "{}"),
    put(join(base, "pd", "settings", "audit", "settings-202610.jsonl"), "{}\n"),
    put(join(base, "data", "prefs", "prefs.json"), "{}"),
    put(join(base, "data", "prefs", "personas", "x.json"), "{}"),
    put(join(base, "data", "memory", "MEMORY.research.md"), "scoped"),
  ];
  dirs = [join(base, "pd", "settings"), join(base, "pd", "settings", "audit"), join(base, "data", "prefs"), join(base, "data", "prefs", "personas")];
  junction(join(base, "notes", "link-settings"), join(base, "pd", "settings"));
  junction(join(base, "notes", "link-prefs"), join(base, "data", "prefs"));
  configs = [config("lmstudio"), config("strata")];
});

after(() => cleanup(base));

function refused(fn: () => unknown): void {
  assert.throws(fn, (e: unknown) => e instanceof PathPolicyError || (e instanceof Error && /refus|denied|outside|not/i.test(e.message)));
}

test("read_file, list_dir, search_files and write_file all refuse security.json, the audit folder, prefs.json and the persona files (either runner)", async () => {
  for (const cfg of configs) {
    const policy = readPolicyFromConfig(cfg, { includeWorkspace: true });
    const wp = writePolicyFromConfig(cfg);
    const deps = { policy, limits: cfg.limits };
    for (const t of targets) {
      refused(() => readFile(deps, { path: t }));
      refused(() => writeWorkspaceFile({ policy: wp }, { path: t, content: "x", mode: "overwrite" }));
    }
    for (const d of dirs) {
      refused(() => listDir(deps, { path: d }));
      await assert.rejects(() => searchFiles(deps, { path: d, nameGlob: "*" }));
    }
    // the workspace and the allowlist still work
    assert.match(readFile(deps, { path: "workspace:w.txt" }), /workspace/);
    assert.match(readFile(deps, { path: "notes:a.txt" }), /allowed/);
  }
});

test("a junction inside an allowed folder and a .. escape do not reach the settings or prefs files", () => {
  const cfg = configs[0] as Config;
  const deps = { policy: readPolicyFromConfig(cfg, { includeWorkspace: true }), limits: cfg.limits };
  refused(() => readFile(deps, { path: "notes:link-settings/security.json" }));
  refused(() => readFile(deps, { path: "notes:link-prefs/prefs.json" }));
  refused(() => listDir(deps, { path: "notes:link-settings" }));
  refused(() => readFile(deps, { path: "notes:..\\..\\pd\\settings\\security.json" }));
  refused(() => readFile(deps, { path: "workspace:..\\prefs\\prefs.json" }));
  const wp = writePolicyFromConfig(cfg);
  refused(() => writeWorkspaceFile({ policy: wp }, { path: "..\\prefs\\prefs.json", content: "x", mode: "overwrite" }));
  refused(() => writeWorkspaceFile({ policy: wp }, { path: "..\\..\\pd\\settings\\security.json", content: "x", mode: "overwrite" }));
});
