/** The files S11 ships: jobrunner.example.json, the draft templates, and the "no Pi imports" rule for src/jobrunner. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseJobRunnerConfig } from "../../../src/jobrunner/limits.js";
import { cloudUse, loadTemplates } from "../../../src/jobrunner/templates.js";
import { ROOT } from "./helpers.js";

test("config/jobrunner.example.json parses (underscore keys are comments) and says what the plan says", () => {
  const raw = JSON.parse(readFileSync(join(ROOT, "config", "jobrunner.example.json"), "utf8")) as unknown;
  const c = parseJobRunnerConfig(raw, { localAppData: "C:\\Users\\main\\AppData\\Local" });
  assert.deepEqual(c.cwdAllowlist, ["C:\\projects\\Personal\\creative-hub"]);
  assert.equal(c.engines.dsh.enabled, false);
  assert.equal(c.engines.dsh.verified, false);
  assert.deepEqual(c.limits.maxConcurrent, { claude: 1, dsh: 1, hub: 1 });
  assert.equal(c.ipcPort, 47007);
  assert.ok(c.denyPaths.includes("C:\\Pixotope"));
});

test("config/templates/*.json: every draft template loads, none is dsh, shell tools are disallowed in each, Flow only where declared", () => {
  const reg = loadTemplates(join(ROOT, "config", "templates"), { flowServerId: "flow-music-mcp" });
  assert.deepEqual(reg.errors, []);
  assert.deepEqual(reg.all().map((t) => t.id), ["chiptune-loop", "list-runs", "short-video-from-idea", "tts-line", "visual-novel-from-idea"]);
  for (const t of reg.all()) {
    assert.equal(t.engine, "claude");
    assert.ok(["default", "dontAsk"].includes(t.permissionMode));
    assert.deepEqual(t.disallowedTools.filter((d) => ["Bash", "PowerShell"].includes(d)), ["Bash", "PowerShell"]);
    assert.equal(t.cwd, "C:\\projects\\Personal\\creative-hub");
    assert.equal(t.flow.enabled, t.id === "short-video-from-idea");
  }
  const video = reg.get("short-video-from-idea")!;
  assert.deepEqual(cloudUse(video), ["claude-subscription", "google-flow"]);
  assert.equal(video.flow.maxCredits, 200);
  assert.equal(reg.get("visual-novel-from-idea")?.paidModels, true, "VN Studio roles may use paid models");
  assert.deepEqual(reg.get("visual-novel-from-idea")?.autostart, ["pixel-studio", "chiptune-studio", "comfyui"]);
});

function walk(dir: string, out: string[]): void {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith(".ts")) out.push(p);
  }
}

test("src/jobrunner does not import the Pi adapter or any Pi package (the job runner has no Pi dependency)", () => {
  const files: string[] = [];
  walk(join(ROOT, "src", "jobrunner"), files);
  assert.ok(files.length >= 10);
  const scope = "@earendil" + "-works/";
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.ok(!text.includes(scope), `${f} imports a Pi package`);
    assert.doesNotMatch(text, /from\s+["'][^"']*pi\/adapter(\.js)?["']/, `${f} imports the adapter`);
  }
});
