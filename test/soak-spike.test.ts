/**
 * Tests for the P0.7 soak probe (against the fake server) and the spike-key PowerShell helper (on temp files only,
 * with -SkipAcl: no ACL, no system change). Live soak results are UNTESTED.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { completionProbe, runSoak, summarize } from "../scripts/smoke/soak-probe.js";
import type { ProbeLine } from "../scripts/smoke/soak-probe.js";
import type { SmokeRunnerConfig } from "../scripts/smoke/config.js";
import { startFakeOpenAi } from "./helpers/fakeOpenAi.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function cfgFor(baseUrl: string): SmokeRunnerConfig {
  return { runner: "strata", baseUrl, modelId: "fake-model", contextWindow: 8192, maxTokens: 256 };
}

test("soak: every probe OK and a stable process id passes; logs and summary are written", async () => {
  const out = mkdtempSync(join(tmpdir(), "a7-soak-"));
  const fake = await startFakeOpenAi({ behavior: () => ({ type: "text", text: "word ".repeat(60), chunkSize: 10, chunkDelayMs: 5 }) });
  try {
    const s = await runSoak({ cfg: cfgFor(fake.baseUrl), durationMs: 900, healthEveryMs: 200, completionEveryMs: 350, outDir: out, pidProbe: async () => [4242] });
    assert.equal(s.pass, true, s.reason);
    assert.ok(s.probes >= 2, `probes: ${s.probes}`); // was >= 8: timing-dependent in a 900 ms window; under the full suite (Phase 3 added 230 tests) the event loop can be starved
    assert.deepEqual(s.pids, [4242]);
    assert.equal(s.pidChanged, false);
    const lines = readFileSync(join(out, "probes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as ProbeLine);
    assert.ok(lines.some((l) => l.kind === "health" && l.ok));
    const comp = lines.find((l) => l.kind === "completion");
    assert.ok(comp?.ok);
    assert.ok((comp?.tokPerSec ?? 0) > 0);
    assert.ok(existsSync(join(out, "summary.json")));
  } finally {
    await fake.close();
    rmSync(out, { recursive: true, force: true });
  }
});

test("soak: a changed process id (crash or restart) fails; so do failed probes", async () => {
  const out = mkdtempSync(join(tmpdir(), "a7-soak2-"));
  const fake = await startFakeOpenAi();
  try {
    let n = 0;
    const s = await runSoak({ cfg: cfgFor(fake.baseUrl), durationMs: 500, healthEveryMs: 150, completionEveryMs: 10_000, outDir: out, pidProbe: async () => [n++ < 2 ? 100 : 200] });
    assert.equal(s.pass, false);
    assert.equal(s.pidChanged, true);
    assert.match(s.reason, /process id changed/);
  } finally {
    await fake.close();
    rmSync(out, { recursive: true, force: true });
  }
  const down = await startFakeOpenAi();
  const url = down.baseUrl;
  await down.close();
  const out2 = mkdtempSync(join(tmpdir(), "a7-soak3-"));
  try {
    const s = await runSoak({ cfg: cfgFor(url), durationMs: 100, healthEveryMs: 200, completionEveryMs: 10_000, outDir: out2, pidProbe: async () => undefined });
    assert.equal(s.pass, false);
    assert.ok(s.healthFailures >= 1);
    assert.match(s.reason, /health probe/);
  } finally {
    rmSync(out2, { recursive: true, force: true });
  }
});

test("soak summary rules: hang and tok/s drift beyond 20 percent fail", () => {
  const base = { at: "t", ok: true, detail: "ok" } as const;
  const mk = (rates: number[], extra: Partial<ProbeLine> = {}): ProbeLine[] => [
    { ...base, kind: "health", ms: 5 },
    ...rates.map((r) => ({ ...base, kind: "completion" as const, ms: 1000, tokPerSec: r, ...extra })),
  ];
  const o = { runner: "strata", startedAt: "t", hangMs: 300_000, driftLimit: 0.2 };
  assert.equal(summarize(mk([30, 30, 29, 30, 29, 30]), o).pass, true);
  const drift = summarize(mk([30, 30, 30, 22, 22, 22]), o);
  assert.equal(drift.pass, false);
  assert.match(drift.reason, /tok\/s dropped/);
  const hang = summarize([{ ...base, kind: "health", ms: 400_000 }], o);
  assert.equal(hang.pass, false);
  assert.match(hang.reason, /hang/);
  assert.equal(summarize([], o).pass, false);
});

test("completionProbe measures TTFT and tok/s from the streamed usage", async () => {
  const fake = await startFakeOpenAi({ behavior: () => ({ type: "text", text: "x".repeat(200), chunkSize: 20, chunkDelayMs: 10, firstDelayMs: 50 }) });
  try {
    const p = await completionProbe(cfgFor(fake.baseUrl));
    assert.equal(p.ok, true);
    assert.ok((p.ttftMs ?? 0) >= 40);
    assert.ok((p.completionTokens ?? 0) > 0);
    assert.ok((p.tokPerSec ?? 0) > 0);
  } finally {
    await fake.close();
  }
});

const PS = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const SCRIPT = join(ROOT, "scripts", "spike", "new-strata-spike-key.ps1");

test("spike-key helper: parses, writes a 64-hex key to both files, keeps other keys, never prints it", { skip: !existsSync(PS) }, () => {
  const dir = mkdtempSync(join(tmpdir(), "a7-spike-"));
  try {
    const cfg = join(dir, "strata", "strata.json");
    const sec = join(dir, "dev", "secrets.json");
    mkdirSync(join(dir, "strata"), { recursive: true });
    mkdirSync(join(dir, "dev"), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ backend: "hip", port: 8080, open_browser: false, nested: { list: [1, 2], flag: true } }));
    writeFileSync(sec, JSON.stringify({ telegramBotToken: "keep-me-123", lmStudioApiToken: "keep-me-too" }));
    const out = execFileSync(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-ConfigCopy", cfg, "-DevSecrets", sec, "-SkipAcl"], { encoding: "utf8", windowsHide: true });
    const c = JSON.parse(readFileSync(cfg, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const s = JSON.parse(readFileSync(sec, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    assert.match(String(c["api_key"]), /^[0-9a-f]{64}$/);
    assert.equal(c["api_key"], s["strataApiKey"]);
    assert.equal(s["telegramBotToken"], "keep-me-123");
    assert.equal(s["lmStudioApiToken"], "keep-me-too");
    assert.equal(c["backend"], "hip");
    assert.equal(c["port"], 8080);
    assert.deepEqual(c["nested"], { list: [1, 2], flag: true });
    assert.equal(out.includes(String(c["api_key"])), false, "the key must not be printed");
    // a second run replaces the key
    execFileSync(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-ConfigCopy", cfg, "-DevSecrets", sec, "-SkipAcl"], { encoding: "utf8", windowsHide: true });
    const c2 = JSON.parse(readFileSync(cfg, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    assert.notEqual(c2["api_key"], c["api_key"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spike-key helper: refuses when the config copy is missing and writes nothing", { skip: !existsSync(PS) }, () => {
  const dir = mkdtempSync(join(tmpdir(), "a7-spike2-"));
  try {
    const run = (args: string[]) => {
      try {
        execFileSync(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        return { code: 0, err: "" };
      } catch (e) {
        const x = e as { status?: number; stderr?: string };
        return { code: x.status ?? 1, err: String(x.stderr) };
      }
    };
    const missing = run(["-ConfigCopy", join(dir, "nope.json"), "-DevSecrets", join(dir, "s.json"), "-SkipAcl"]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.err, /Config copy not found/);
    assert.equal(existsSync(join(dir, "s.json")), false, "nothing is written when the copy is missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
