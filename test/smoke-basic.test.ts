/**
 * Unit tests for the Phase 0 smoke scripts S1 to S3, against a fake OpenAI-compatible server.
 * These prove the script logic only. Live results against LM Studio or Strata are UNTESTED.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { run as runS1 } from "../scripts/smoke/s1-sqlite.js";
import { run as runS2 } from "../scripts/smoke/s2-roundtrip.js";
import { run as runS3 } from "../scripts/smoke/s3-toolcall.js";
import { formatSmokeLine, loadSmokeRunner, parseArgs, writeSmokeResult } from "../scripts/smoke/config.js";
import type { SmokeRunnerConfig } from "../scripts/smoke/config.js";
import { startFakeOpenAi } from "./helpers/fakeOpenAi.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "a7-smoke-"));
}

function cfgFor(baseUrl: string, runner: "lmstudio" | "strata", apiKey?: string): SmokeRunnerConfig {
  return { runner, baseUrl, modelId: "fake-model", contextWindow: 8192, maxTokens: 256, apiKey };
}

test("S1: SQLite round trip on a path with spaces and a second path", async () => {
  const dir = tmp();
  try {
    const out = await runS1("lmstudio", { withSpacesDir: join(dir, "dir with space"), localAppDataDir: join(dir, "agent-007-smoke") });
    assert.equal(out.pass, true, out.reason);
    const results = out.details["results"] as { ok: boolean; walSeen: boolean; shmSeen: boolean }[];
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.walSeen && r.shmSeen));
    assert.match(formatSmokeLine(out), /^SMOKE S1 PASS runner=lmstudio: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 LM Studio: PONG round trip, and the wrong-token run fails with an auth error", async () => {
  const dir = tmp();
  const fake = await startFakeOpenAi({ requireKey: "lm-token-1" });
  try {
    const out = await runS2(cfgFor(fake.baseUrl, "lmstudio", "lm-token-1"), { storageDir: dir, timeoutMs: 20_000, negativeTimeoutMs: 20_000 });
    assert.equal(out.pass, true, out.reason);
    const negs = out.details["negatives"] as { name: string; failed: boolean }[];
    assert.deepEqual(negs.map((n) => [n.name, n.failed]), [["wrong-key", true]]);
    // the request shape follows the compat flags: max_tokens, no developer role, no store
    const first = fake.chatRequests().find((r) => r.authorization === "Bearer lm-token-1")?.body;
    assert.ok(first, "a keyed chat request reached the server");
    assert.ok(first.max_tokens !== undefined || first["max_tokens"] !== undefined, "max_tokens field is used");
    assert.equal(first.max_completion_tokens, undefined);
    assert.equal(first.messages.some((m) => m.role === "developer"), false);
    assert.equal(first["store"], undefined);
    // raw probes record what an unauthenticated caller sees (401 on /v1/*, /health open)
    const raw = out.details["raw"] as { name: string; status?: number }[];
    assert.equal(raw.find((r) => r.name.startsWith("GET /v1/models"))?.status, 401);
    assert.equal(raw.find((r) => r.name.startsWith("GET /health"))?.status, 200);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 LM Studio: FAIL when auth is not enforced (wrong token accepted)", async () => {
  const dir = tmp();
  const fake = await startFakeOpenAi(); // no key required
  try {
    const out = await runS2(cfgFor(fake.baseUrl, "lmstudio", "lm-token-1"), { storageDir: dir, timeoutMs: 20_000, negativeTimeoutMs: 20_000 });
    assert.equal(out.pass, false);
    assert.match(out.reason, /ACCEPTED/);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 Strata: keyless run skips the negative runs and records auth none; keyed run needs wrong-key and no-key to fail", async () => {
  const dir = tmp();
  const open = await startFakeOpenAi();
  const keyed = await startFakeOpenAi({ requireKey: "sk-strata" });
  try {
    const a = await runS2(cfgFor(open.baseUrl, "strata"), { storageDir: join(dir, "a"), timeoutMs: 20_000 });
    assert.equal(a.pass, true, a.reason);
    assert.equal(a.details["auth"], "none");
    assert.match(String(a.details["negativeRuns"]), /skipped/);

    const b = await runS2(cfgFor(keyed.baseUrl, "strata", "sk-strata"), { storageDir: join(dir, "b"), timeoutMs: 20_000, negativeTimeoutMs: 20_000 });
    assert.equal(b.pass, true, b.reason);
    const negs = b.details["negatives"] as { name: string; failed: boolean }[];
    assert.deepEqual(negs.map((n) => n.name).sort(), ["no-key", "wrong-key"]);
    assert.ok(negs.every((n) => n.failed));

    // a keyed config pointed at a server that ignores keys must FAIL (U29)
    const c = await runS2(cfgFor(open.baseUrl, "strata", "sk-strata"), { storageDir: join(dir, "c"), timeoutMs: 20_000, negativeTimeoutMs: 20_000 });
    assert.equal(c.pass, false);
    assert.match(c.reason, /ACCEPTED/);
  } finally {
    await open.close();
    await keyed.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2/S3: a runner that is down gives a clear runner-unreachable FAIL and exits cleanly", async () => {
  const fake = await startFakeOpenAi();
  const url = fake.baseUrl;
  await fake.close(); // the port now refuses connections
  const cfg = cfgFor(url, "lmstudio", "k");
  for (const run of [runS2, runS3]) {
    const out = await run(cfg);
    assert.equal(out.pass, false);
    assert.match(out.reason, /runner unreachable/);
    assert.equal(out.details["live"], "UNTESTED");
  }
});

test("S3: the tool runs once with {a:1234,b:4321} and the answer contains 5555", async () => {
  const dir = tmp();
  const fake = await startFakeOpenAi();
  try {
    const out = await runS3(cfgFor(fake.baseUrl, "strata"), { storageDir: dir, timeoutMs: 20_000 });
    assert.equal(out.pass, true, out.reason);
    assert.equal(out.details["toolExecutions"], 1);
    assert.deepEqual(out.details["toolArguments"], [{ a: 1234, b: 4321 }]);
    const body = fake.chatRequests()[0]?.body;
    const tool = body?.tools?.find((t) => t.function?.name === "add_numbers");
    assert.ok(tool, "the tool schema was sent to the runner");
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3: FAIL when the model never calls the tool", async () => {
  const dir = tmp();
  const fake = await startFakeOpenAi({ behavior: () => ({ type: "text", text: "I think it is 5555." }) });
  try {
    const out = await runS3(cfgFor(fake.baseUrl, "lmstudio", undefined), { storageDir: dir, timeoutMs: 20_000 });
    assert.equal(out.pass, false);
    assert.match(out.reason, /executed 0 time/);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config reader: dev config and secrets, --runner override, no key leaks into the result file", () => {
  const dir = tmp();
  try {
    const dev = join(dir, "dev");
    // written by the test, never a real secret
    writeJson(join(dev, "config.json"), { model: { runner: "strata", runners: { strata: { baseUrl: "http://127.0.0.1:8080/v1", modelId: "qwen3.8-flash-next-iq3_s" }, lmstudio: { modelId: "m-lm" } } } });
    writeJson(join(dev, "secrets.json"), { lmStudioApiToken: "lm-secret-token", strataApiKey: "strata-secret-key" });
    const s = loadSmokeRunner(parseArgs([]), dev);
    assert.equal(s.runner, "strata");
    assert.equal(s.apiKey, "strata-secret-key");
    const l = loadSmokeRunner(parseArgs(["--runner", "lmstudio"]), dev);
    assert.equal(l.runner, "lmstudio");
    assert.equal(l.modelId, "m-lm");
    assert.equal(l.apiKey, "lm-secret-token");
    assert.equal(loadSmokeRunner(parseArgs(["--runner=strata", "--no-key"]), dev).apiKey, undefined);
    assert.equal(loadSmokeRunner(parseArgs(["--model", "other"]), dev).modelId, "other");
    assert.deepEqual(parseArgs(["--only", "s2,S3"]).only, ["S2", "S3"]);
    assert.throws(() => parseArgs(["--runner", "ollama"]));
    // missing files fall back to defaults
    const d = loadSmokeRunner(parseArgs([]), join(dir, "nothing"));
    assert.equal(d.runner, "lmstudio");
    assert.equal(d.baseUrl, "http://127.0.0.1:1234/v1");
    // result files carry the runner name and no key
    const out = join(dir, "out");
    const line = writeSmokeResult({ id: "S2", runner: "strata", pass: true, reason: "ok", details: { auth: "api-key" } }, out);
    assert.match(line, /^SMOKE S2 PASS runner=strata: ok$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeJson(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(v));
}
