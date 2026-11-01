import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinDenies, denyListsOverlap, isBuiltinDenied, isLoopbackUrl, isSameOrUnder } from "../src/config/paths.js";
import { loadConfig, selectRunner, validateConfig } from "../src/config/load.js";
import type { FsProbe } from "../src/config/load.js";
import { ConfigError, parseConfig } from "../src/config/schema.js";
import type { DefaultsEnv } from "../src/config/schema.js";

const ENV: DefaultsEnv = { localAppData: "C:\\Users\\agent007\\AppData\\Local", programData: "C:\\ProgramData", mainUserProfile: "C:\\Users\\Main" };

const EXISTING = new Set(["c:\\data\\notes", "c:\\data\\docs", "c:\\pixotope\\work"]);
const fsProbe: FsProbe = {
  exists: (p) => EXISTING.has(p.toLowerCase()),
  isDirectory: (p) => EXISTING.has(p.toLowerCase()),
};

function baseRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    telegram: { allowedUserIds: [123456789] },
    model: { runner: "lmstudio", runners: { lmstudio: { modelId: "m1" }, strata: {} } },
    folders: { allow: [{ alias: "notes", path: "C:\\Data\\Notes" }, { alias: "docs", path: "C:\\Data\\Docs" }], deny: ["C:\\Pixotope\\Work"] },
    ...over,
  };
}
const SECRETS = { lmStudioApiToken: "tok-1234567890", strataApiKey: "key-1234567890" };

function refusal(raw: unknown, secrets: object = SECRETS): string {
  try {
    const cfg = parseConfig(raw, ENV);
    validateConfig(cfg, secrets, { fs: fsProbe });
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected ConfigError, got ${String(e)}`);
    return e.message;
  }
  assert.fail("expected the loader to refuse");
}

test("a valid config parses with defaults", () => {
  const cfg = parseConfig(baseRaw(), ENV);
  assert.equal(cfg.model.runner, "lmstudio");
  assert.equal(cfg.model.runners.lmstudio?.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(cfg.model.runners.strata?.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(cfg.model.runners.strata?.modelId, "qwen3.8-flash-next-iq3_s");
  assert.equal(cfg.model.runners.strata?.installDir, "D:\\Strata");
  assert.equal(cfg.model.runners.strata?.configFile, "C:\\ProgramData\\agent-007\\strata\\strata.json");
  assert.equal(cfg.shell.approvalTimeoutSec, 600);
  assert.equal(cfg.shell.execTimeoutSec, 120);
  assert.equal(cfg.shell.maxExecTimeoutSec, 600);
  assert.equal(cfg.shell.maxOutputBytes, 65536);
  assert.equal(cfg.shell.returnBytes, 8192);
  assert.equal(cfg.limits.readFileBytes, 32768);
  assert.equal(cfg.limits.searchMaxFiles, 5000);
  assert.equal(cfg.paths.dataDir, "C:\\Users\\agent007\\AppData\\Local\\agent-007");
  assert.equal(cfg.paths.memoryFile, "C:\\Users\\agent007\\AppData\\Local\\agent-007\\memory\\MEMORY.md");
  assert.deepEqual(validateConfig(cfg, SECRETS, { fs: fsProbe }), []);
});

test("refuses an empty allowlist", () => {
  assert.match(refusal(baseRaw({ folders: { allow: [], deny: [] } })), /folders\.allow is empty/);
});

test("refuses a non-loopback baseUrl in any runner block, selected or not", () => {
  const raw = baseRaw({ model: { runner: "lmstudio", runners: { lmstudio: { modelId: "m" }, strata: { baseUrl: "http://192.168.1.5:8080/v1" } } } });
  assert.match(refusal(raw), /model\.runners\.strata\.baseUrl must be loopback/);
  const raw2 = baseRaw({ model: { runner: "lmstudio", runners: { lmstudio: { baseUrl: "http://0.0.0.0:1234/v1" } } } });
  assert.match(refusal(raw2), /model\.runners\.lmstudio\.baseUrl must be loopback/);
  assert.equal(isLoopbackUrl("http://localhost:1234/v1"), true);
  assert.equal(isLoopbackUrl("http://127.0.0.1.evil.com/v1"), false);
});

test("refuses an unknown model.runner", () => {
  assert.match(refusal(baseRaw({ model: { runner: "ollama", runners: { lmstudio: {} } } })), /unknown runner "ollama"/);
});

test("refuses a missing block for the selected runner", () => {
  assert.match(refusal(baseRaw({ model: { runner: "strata", runners: { lmstudio: {} } } })), /no block for the selected runner "strata"/);
});

test("refuses lmstudio without lmStudioApiToken", () => {
  assert.match(refusal(baseRaw(), { strataApiKey: "k-12345678" }), /no lmStudioApiToken/);
});

test("refuses a duplicate alias (case-insensitive)", () => {
  const raw = baseRaw({ folders: { allow: [{ alias: "notes", path: "C:\\Data\\Notes" }, { alias: "NOTES", path: "C:\\Data\\Docs" }], deny: [] } });
  assert.match(refusal(raw), /duplicate alias "NOTES"/);
});

test("refuses an allowed path that does not exist, and only warns for a missing deny path", () => {
  const raw = baseRaw({ folders: { allow: [{ alias: "gone", path: "C:\\Data\\Missing" }], deny: ["C:\\Nope"] } });
  assert.match(refusal(raw), /does not exist or is not a folder: C:\\Data\\Missing/);
  const ok = baseRaw({ folders: { allow: [{ alias: "notes", path: "C:\\Data\\Notes" }], deny: ["C:\\Nope"] } });
  const warnings = validateConfig(parseConfig(ok, ENV), SECRETS, { fs: fsProbe });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /folders\.deny: path does not exist/);
});

test("rejects a bad alias, ids and structural errors with every issue listed", () => {
  const raw = { telegram: { allowedUserIds: [] }, model: { runner: 7 }, folders: { allow: [{ alias: "bad alias!", path: "C:\\x" }] } };
  try {
    parseConfig(raw, ENV);
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.ok(e.issues.length >= 3, e.message);
    assert.match(e.message, /allowedUserIds/);
    assert.match(e.message, /model\.runner/);
    assert.match(e.message, /alias/);
  }
});

test("Strata without a key only warns; with a key the provider options carry it as apiKey", () => {
  const cfg = parseConfig(baseRaw({ model: { runner: "strata", runners: { strata: {} } } }), ENV);
  const warnings = validateConfig(cfg, {}, { fs: fsProbe });
  assert.match(warnings.join("\n"), /Strata without an API key/);
  const keyless = selectRunner(cfg, {});
  assert.equal(keyless.provider.apiKey, undefined);
  assert.equal(keyless.authMode, "none");
  assert.match(keyless.warnings.join("\n"), /Strata without an API key/);
  assert.equal(keyless.provider.baseUrl, "http://127.0.0.1:8080/v1");
  const keyed = selectRunner(cfg, { strataApiKey: "key-abcdef123" });
  assert.equal(keyed.provider.apiKey, "key-abcdef123");
  assert.equal(keyed.authMode, "api-key");
  // runner: strata loads with no lmStudioApiToken
  assert.deepEqual(validateConfig(cfg, { strataApiKey: "key-abcdef123" }, { fs: fsProbe }), []);
});

test("loadConfig reads JSON through the injected reader and reports bad JSON", () => {
  const out = loadConfig({ configPath: "x", secrets: SECRETS, env: ENV, readFile: () => JSON.stringify(baseRaw()), fs: fsProbe });
  assert.equal(out.config.telegram.allowedUserIds[0], 123456789);
  assert.throws(() => loadConfig({ configPath: "x", secrets: SECRETS, env: ENV, readFile: () => "{nope", fs: fsProbe }), ConfigError);
});

test("built-in denies: two disjoint lists with the planned membership", () => {
  const cfg = parseConfig(baseRaw(), ENV);
  const d = builtinDenies(cfg);
  assert.equal(denyListsOverlap(d), false);
  // (a) user data: .lmstudio and folders.deny
  assert.ok(d.ntfs.includes("C:\\Users\\Main\\.lmstudio"));
  assert.ok(d.ntfs.includes("C:\\Pixotope\\Work"));
  // (b) in-process only: Strata install and data, ProgramData root, agent data root
  for (const p of ["D:\\Strata", "D:\\Strata-data", "C:\\ProgramData\\agent-007", "C:\\Users\\agent007\\AppData\\Local\\agent-007"]) {
    assert.ok(d.inProcessOnly.some((x) => isSameOrUnder(x, p) && isSameOrUnder(p, x)), `${p} must be in list (b)`);
    assert.ok(!d.ntfs.some((x) => isSameOrUnder(p, x) || isSameOrUnder(x, p)), `${p} must never be in list (a)`);
  }
  assert.deepEqual(d.inProcessOnlyExceptions, [cfg.paths.workspaceDir]);
});

test("built-in denies refuse the Strata and agent paths whichever runner is selected", () => {
  for (const runner of ["lmstudio", "strata"] as const) {
    const cfg = parseConfig(baseRaw({ model: { runner, runners: { lmstudio: {}, strata: {} } } }), ENV);
    const d = builtinDenies(cfg);
    for (const p of [
      "D:\\Strata-data\\models\\a.gguf",
      "d:\\strata\\serve\\server.py",
      "C:\\ProgramData\\agent-007\\strata\\strata.json",
      "C:\\ProgramData\\agent-007\\logs\\strata.log",
      "C:\\ProgramData\\agent-007\\secrets\\secrets.json",
      "C:\\Users\\Main\\.lmstudio\\models\\x",
      "C:\\Pixotope\\Work\\config.xml",
      "C:\\Users\\agent007\\AppData\\Local\\agent-007\\state\\agent.sqlite",
      "C:\\Users\\agent007\\AppData\\Local\\agent-007\\audit\\shell-202610.jsonl",
    ]) {
      assert.equal(isBuiltinDenied(p, d), true, `${runner}: ${p} must be denied`);
    }
    // the workspace stays reachable, and allowed folders are untouched
    assert.equal(isBuiltinDenied("C:\\Users\\agent007\\AppData\\Local\\agent-007\\workspace\\a.txt", d), false);
    assert.equal(isBuiltinDenied("C:\\Data\\Notes\\todo.md", d), false);
    // lookalike prefixes are not denied
    assert.equal(isBuiltinDenied("D:\\Strata-other\\x", d), false);
  }
});

test("a custom Strata block moves the in-process denies with it", () => {
  const cfg = parseConfig(
    baseRaw({
      model: {
        runner: "strata",
        runners: { strata: { installDir: "E:\\S", dataDir: "E:\\S-data", configFile: "C:\\ProgramData\\agent-007\\strata\\strata.json", logDir: "C:\\ProgramData\\agent-007\\logs" } },
      },
    }),
    ENV,
  );
  const d = builtinDenies(cfg);
  assert.equal(isBuiltinDenied("E:\\S-data\\m.gguf", d), true);
  assert.equal(isBuiltinDenied("E:\\S\\serve\\server.py", d), true);
});
