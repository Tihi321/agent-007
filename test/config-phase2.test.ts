/** S9.4: the Phase 2 config blocks (`mcp`, `jobs`, `flow`, `secondOpinion`) and the Phase 2 secrets (`ipcHmacKey`, `mcpTokens`). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig } from "../src/config/load.js";
import type { FsProbe } from "../src/config/load.js";
import { ConfigError, DEFAULT_FLOW_SERVER_ID, DEFAULT_IPC_PORT, DEFAULT_PROXY_BASE_URL, MCP_SERVER_ID_PATTERN, parseConfig } from "../src/config/schema.js";
import type { DefaultsEnv } from "../src/config/schema.js";
import { SecretsError, parseSecrets, secretValues } from "../src/config/secrets.js";
import { KEY_TEXT_A } from "./ipc/helpers.js";

const ENV: DefaultsEnv = { localAppData: "C:\\Users\\agent007\\AppData\\Local", programData: "C:\\ProgramData", mainUserProfile: "C:\\Users\\Main" };
const fsProbe: FsProbe = { exists: () => true, isDirectory: () => true };
const SECRETS = { lmStudioApiToken: "tok-1234567890", strataApiKey: "key-1234567890" };

function baseRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    telegram: { allowedUserIds: [123456789] },
    model: { runner: "lmstudio", runners: { lmstudio: { modelId: "m1" } } },
    folders: { allow: [{ alias: "notes", path: "C:\\Data\\Notes" }], deny: [] },
    ...over,
  };
}

function structural(raw: unknown): string {
  try {
    parseConfig(raw, ENV);
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    return e.message;
  }
  assert.fail("expected parseConfig to refuse");
}

function semantic(raw: unknown, secrets: object = SECRETS): { message: string } | { warnings: string[] } {
  const cfg = parseConfig(raw, ENV);
  try {
    return { warnings: validateConfig(cfg, secrets, { fs: fsProbe }) };
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    return { message: e.message };
  }
}

test("a Phase 1 config still loads: the Phase 2 blocks take their defaults", () => {
  const cfg = parseConfig(baseRaw(), ENV);
  assert.deepEqual(cfg.mcp, { servers: [], callTimeoutSec: 300 });
  assert.deepEqual(cfg.jobs, { ipcPort: DEFAULT_IPC_PORT, approvalTimeoutSec: 1800, progressIntervalSec: 30 });
  assert.deepEqual(cfg.flow, { serverId: DEFAULT_FLOW_SERVER_ID });
  assert.deepEqual(cfg.secondOpinion, { enabled: false, baseUrl: DEFAULT_PROXY_BASE_URL, modelId: "" });
  assert.equal(DEFAULT_IPC_PORT, 47007);
  assert.deepEqual(semantic(baseRaw()), { warnings: [] });
});

test("explicit Phase 2 blocks parse; per-server timeout overrides the default", () => {
  const cfg = parseConfig(
    baseRaw({
      mcp: {
        callTimeoutSec: 120,
        servers: [
          { id: "vibetts", url: "http://127.0.0.1:7001/mcp", allowTools: ["speak"], macros: ["tts_line"] },
          { id: "flow-music-mcp", url: "http://localhost:7002/mcp", allowTools: ["a", "b"], macros: [], callTimeoutSec: 900 },
        ],
      },
      jobs: { ipcPort: 50000, approvalTimeoutSec: 600, progressIntervalSec: 5 },
      flow: { serverId: "flow-music-mcp" },
      secondOpinion: { enabled: true, baseUrl: "http://127.0.0.1:9000/v1", modelId: "codex" },
    }),
    ENV,
  );
  assert.equal(cfg.mcp.callTimeoutSec, 120);
  assert.deepEqual(cfg.mcp.servers[0], { id: "vibetts", url: "http://127.0.0.1:7001/mcp", allowTools: ["speak"], macros: ["tts_line"] });
  assert.equal(cfg.mcp.servers[1]?.callTimeoutSec, 900);
  assert.equal(cfg.jobs.ipcPort, 50000);
  assert.equal(cfg.flow.serverId, "flow-music-mcp");
  assert.equal(cfg.secondOpinion.enabled, true);
});

test("the loader refuses a non-loopback MCP url (a host, a LAN address, 0.0.0.0, a look-alike, a bad scheme)", () => {
  for (const url of ["http://example.com/mcp", "http://192.168.1.4:7000/mcp", "http://0.0.0.0:7000/mcp", "http://127.0.0.1.evil.com/mcp", "ftp://127.0.0.1/mcp", "not a url", "http://[::1]:7000/mcp"]) {
    const r = semantic(baseRaw({ mcp: { servers: [{ id: "x", url, allowTools: [], macros: [] }] } }));
    assert.ok("message" in r, url);
    assert.match((r as { message: string }).message, /mcp\.servers\[0\]\.url must be an http\(s\) URL on loopback/, url);
  }
  assert.ok("warnings" in semantic(baseRaw({ mcp: { servers: [{ id: "x", url: "http://127.0.0.1:7000/mcp", allowTools: [], macros: [] }] } })));
});

test("the loader refuses a non-loopback second-opinion URL, also while it is disabled", () => {
  for (const enabled of [false, true]) {
    const r = semantic(baseRaw({ secondOpinion: { enabled, baseUrl: "http://203.0.113.5:8787/v1", modelId: "m" } }));
    assert.match((r as { message: string }).message, /secondOpinion\.baseUrl must be an http\(s\) URL on loopback/);
  }
});

test("the loader refuses a duplicate MCP server id (case-insensitive)", () => {
  const r = semantic(
    baseRaw({
      mcp: {
        servers: [
          { id: "Vibetts", url: "http://127.0.0.1:1/mcp", allowTools: [], macros: [] },
          { id: "vibetts", url: "http://127.0.0.1:2/mcp", allowTools: [], macros: [] },
        ],
      },
    }),
  );
  assert.match((r as { message: string }).message, /duplicate server id "vibetts"/);
});

test("structural refusals: bad ids, bad lists, enabled second opinion without a model, a port out of range", () => {
  assert.match(structural(baseRaw({ mcp: { servers: [{ id: "a__b", url: "http://127.0.0.1:1/mcp" }] } })), /mcp\.servers\[0\]\.id/);
  assert.match(structural(baseRaw({ mcp: { servers: [{ id: "bad id", url: "http://127.0.0.1:1/mcp" }] } })), /mcp\.servers\[0\]\.id/);
  assert.match(structural(baseRaw({ mcp: { servers: [{ id: "trailing_", url: "http://127.0.0.1:1/mcp" }] } })), /mcp\.servers\[0\]\.id/);
  assert.match(structural(baseRaw({ mcp: { servers: [{ id: "x".repeat(33), url: "http://127.0.0.1:1/mcp" }] } })), /mcp\.servers\[0\]\.id/);
  assert.match(structural(baseRaw({ mcp: { servers: [{ id: "x" }] } })), /mcp\.servers\[0\]\.url: expected a non-empty string/);
  assert.match(structural(baseRaw({ mcp: { servers: [{ id: "x", url: "http://127.0.0.1:1/mcp", allowTools: "all" }] } })), /allowTools: expected an array of strings/);
  assert.match(structural(baseRaw({ mcp: { servers: [{ id: "x", url: "http://127.0.0.1:1/mcp", allowTools: [1] }] } })), /allowTools\[0\]: expected a non-empty string/);
  assert.match(structural(baseRaw({ mcp: { servers: "none" } })), /mcp\.servers: expected an array/);
  assert.match(structural(baseRaw({ mcp: { callTimeoutSec: 0 } })), /mcp\.callTimeoutSec/);
  assert.match(structural(baseRaw({ jobs: { ipcPort: 80 } })), /jobs\.ipcPort/);
  assert.match(structural(baseRaw({ jobs: { ipcPort: 70000 } })), /jobs\.ipcPort: expected a port between 1024 and 65535/);
  assert.match(structural(baseRaw({ jobs: { approvalTimeoutSec: 1 } })), /jobs\.approvalTimeoutSec/);
  assert.match(structural(baseRaw({ jobs: { progressIntervalSec: 0 } })), /jobs\.progressIntervalSec/);
  assert.match(structural(baseRaw({ secondOpinion: { enabled: true } })), /secondOpinion\.modelId: required when secondOpinion\.enabled is true/);
  assert.match(structural(baseRaw({ secondOpinion: { enabled: "yes" } })), /secondOpinion\.enabled: expected a boolean/);
  for (const ok of ["a", "book-translator", "flow-music-mcp", "a_b", "A1", "x".repeat(32)]) assert.equal(MCP_SERVER_ID_PATTERN.test(ok), true, ok);
});

test("warnings: a Flow server that is not configured, and a token for an unknown server", () => {
  const raw = baseRaw({ mcp: { servers: [{ id: "vibetts", url: "http://127.0.0.1:7001/mcp", allowTools: [], macros: [] }] } });
  const r = semantic(raw, { ...SECRETS, mcpTokens: { "book-translator": "bt-token-value-1" } }) as { warnings: string[] };
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings.join("\n"), /flow\.serverId "flow-music-mcp" is not in mcp\.servers/);
  assert.match(r.warnings.join("\n"), /mcpTokens has an entry for "book-translator"/);
});

test("the always-loaded list cannot come from config: unknown keys such as tools.alwaysLoaded change nothing", async () => {
  const { ALWAYS_LOADED } = await import("../src/jobs/contracts.js");
  const cfg = parseConfig(baseRaw({ tools: { alwaysLoaded: ["shell", "remember"] } }), ENV) as unknown as Record<string, unknown>;
  assert.equal(cfg["tools"], undefined);
  assert.equal(ALWAYS_LOADED.length, 10);
});

// ---- secrets ------------------------------------------------------------------------------------------

const BASE_SECRETS = { telegramBotToken: "123456:abcdefghijklmnopqrstuvwxyz" };

test("secrets: ipcHmacKey and mcpTokens parse; both are optional; empty strings are dropped", () => {
  const s = parseSecrets(JSON.stringify({ ...BASE_SECRETS, ipcHmacKey: KEY_TEXT_A, mcpTokens: { "book-translator": "bt-token-value-1", empty: "" } }));
  assert.equal(s.ipcHmacKey, KEY_TEXT_A);
  assert.deepEqual(s.mcpTokens, { "book-translator": "bt-token-value-1" });
  const none = parseSecrets(JSON.stringify(BASE_SECRETS));
  assert.equal(none.ipcHmacKey, undefined);
  assert.equal(none.mcpTokens, undefined);
  assert.equal(parseSecrets(JSON.stringify({ ...BASE_SECRETS, ipcHmacKey: "" })).ipcHmacKey, undefined);
});

test("secrets: a short or malformed ipcHmacKey, and a malformed mcpTokens, are refused without echoing the value", () => {
  for (const bad of ["short-key-value", "!".repeat(50), 12345]) {
    try {
      parseSecrets(JSON.stringify({ ...BASE_SECRETS, ipcHmacKey: bad }));
      assert.fail("should refuse");
    } catch (e) {
      assert.ok(e instanceof SecretsError);
      assert.doesNotMatch(e.message, /short-key-value/);
      assert.match(e.message, /ipcHmacKey/);
    }
  }
  assert.throws(() => parseSecrets(JSON.stringify({ ...BASE_SECRETS, mcpTokens: ["a"] })), /mcpTokens must be an object/);
  assert.throws(() => parseSecrets(JSON.stringify({ ...BASE_SECRETS, mcpTokens: { a: 1 } })), /mcpTokens\.a must be a string/);
});

test("secretValues lists the Phase 2 secrets, so the redactor covers them", () => {
  const values = secretValues({ ...BASE_SECRETS, ipcHmacKey: KEY_TEXT_A, mcpTokens: { a: "token-aaaa", b: "token-bbbb" } });
  for (const v of [KEY_TEXT_A, "token-aaaa", "token-bbbb", BASE_SECRETS.telegramBotToken]) assert.ok(values.includes(v), v);
});
