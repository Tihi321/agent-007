/** S22.1: presets and routes (I38, I41, I42). Pure functions; no sockets. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseBots } from "../../src/bots/schema.js";
import type { PresetConfig } from "../../src/bots/schema.js";
import { activePresetProblem, compactionOverrides, hasLocalRoute, presetProblem, resolveActivePreset, routeProblems } from "../../src/models/presets.js";
import { fallbackCandidates, pickerEntries, switchVerdict } from "../../src/models/routes.js";
import { NOTES, baseSecurity, bot, research, withBots } from "../bots/helpers.js";
import { ALL_PRESETS, ALL_TERMS, ANTI, CLAUDE, CODEX, CODEX2, LM, NO_TERMS, STRATA, botOf, route } from "./helpers.js";

const ROOT = process.cwd(); // yarn test runs from the repo root

test("an activePreset outside route.allowed is rejected and never used", () => {
  const r = route({ allowed: ["lmstudio", "strata"] });
  assert.match(activePresetProblem({ route: r }, ALL_PRESETS, "codex", ALL_TERMS) ?? "", /not one of the presets this bot may use/);
  assert.match(activePresetProblem({ route: r }, ALL_PRESETS, "nope", ALL_TERMS) ?? "", /no preset/);
  assert.match(activePresetProblem({ route: r }, ALL_PRESETS, 42, ALL_TERMS) ?? "", /must be text/);
  assert.equal(activePresetProblem({ route: r }, ALL_PRESETS, "strata", ALL_TERMS), undefined);
  // a stored value (prefs.json is untrusted) outside allowed falls back to the primary and says why
  const got = resolveActivePreset({ route: r }, ALL_PRESETS, "codex", ALL_TERMS);
  assert.equal(got?.preset.id, "lmstudio");
  assert.equal(got?.source, "primary");
  assert.match(got?.ignored ?? "", /not one of the presets/);
  assert.equal(resolveActivePreset({ route: r }, ALL_PRESETS, "strata", ALL_TERMS)?.source, "stored");
  assert.equal(resolveActivePreset({ route: r }, ALL_PRESETS, undefined, ALL_TERMS)?.source, "primary");
  assert.equal(resolveActivePreset({ route: r }, ALL_PRESETS, { x: 1 }, ALL_TERMS)?.source, "primary");
  // a preset that cannot be served right now is skipped too
  assert.equal(resolveActivePreset({ route: r }, ALL_PRESETS, "strata", ALL_TERMS, (p) => p.id !== "strata")?.preset.id, "lmstudio");
});

test("a claude or antigravity preset without termsAccepted is refused (I41), with it is allowed; codex needs none", () => {
  assert.match(presetProblem(CLAUDE, NO_TERMS) ?? "", /acknowledgment in the settings UI/);
  assert.match(presetProblem(ANTI, NO_TERMS) ?? "", /acknowledgment/);
  assert.match(presetProblem(CLAUDE, { claude: false, antigravity: true }) ?? "", /acknowledgment/);
  assert.equal(presetProblem(CLAUDE, { claude: true, antigravity: false }), undefined);
  assert.equal(presetProblem(CODEX, NO_TERMS), undefined);
  assert.match(activePresetProblem({ route: route() }, ALL_PRESETS, "claude", NO_TERMS) ?? "", /acknowledgment/);
  const rep = routeProblems(botOf({ route: { allowed: ["lmstudio", "claude"] } }), ALL_PRESETS, NO_TERMS);
  assert.ok(rep.issues.some((i) => /claude/.test(i) && /acknowledgment/.test(i)));
  // a stored claude choice without terms is not used
  assert.equal(resolveActivePreset({ route: route() }, ALL_PRESETS, "claude", NO_TERMS)?.preset.id, "lmstudio");
  // and it is never a fallback candidate
  assert.deepEqual(fallbackCandidates({ route: route({ fallback: ["claude", "strata"] }) }, ALL_PRESETS, LM, NO_TERMS).map((p) => p.id), ["strata"]);
});

test("a per-token-billed (API-key) preset is refused as a kind, a brain and a fallback", () => {
  const paidKind = { ...CODEX, id: "paid", kind: "api" } as unknown as PresetConfig;
  const paidKey = { ...CODEX, id: "paidkey", apiKeyRef: "openaiKey" } as unknown as PresetConfig;
  const localKey = { ...LM, id: "localkey", apiKeyRef: "proxyApiKey" } as unknown as PresetConfig;
  for (const p of [paidKind, paidKey, localKey]) {
    assert.ok(presetProblem(p, ALL_TERMS), `${p.id}: refused as a kind`);
    // brain
    const presets = [LM, p];
    assert.ok(activePresetProblem({ route: route({ allowed: ["lmstudio", p.id] }) }, presets, p.id, ALL_TERMS), `${p.id}: refused as a brain`);
    assert.equal(resolveActivePreset({ route: route({ allowed: ["lmstudio", p.id] }) }, presets, p.id, ALL_TERMS)?.preset.id, "lmstudio");
    // fallback
    const fb = route({ allowed: ["lmstudio", p.id], fallback: [p.id] });
    assert.deepEqual(fallbackCandidates({ route: fb }, presets, LM, ALL_TERMS), [], `${p.id}: never a fallback candidate`);
    assert.ok(routeProblems(botOf({ route: fb }), presets, ALL_TERMS).issues.length > 0, `${p.id}: the route is refused`);
  }
  // the privacy class must match the kind (a proxy preset is cloud; a local one is local)
  assert.match(presetProblem({ ...CODEX, privacy: "local" }, ALL_TERMS) ?? "", /cloud/);
  assert.match(presetProblem({ ...LM, privacy: "cloud" }, ALL_TERMS) ?? "", /local/);
});

test("every shipped bot has a local route (the example main and a loader-built research bot)", () => {
  const example = JSON.parse(readFileSync(join(ROOT, "config", "config.example.json"), "utf8")) as { _bots: Record<string, { route: { primary: string; allowed: string[]; fallback: string[]; onAuthRequired: "fallback" } }> };
  const main = example._bots["main"];
  assert.ok(main);
  assert.equal(hasLocalRoute({ route: main.route }, [LM]), true);
  const doc = withBots({ main: bot(), research: research({ route: { primary: "lmstudio", allowed: ["lmstudio", "strata"], fallback: [], onAuthRequired: "fallback" } }) });
  const ctx = { folderAllow: [{ alias: "notes", path: NOTES }], derivedPresets: [LM, STRATA], defaultPreset: "lmstudio" };
  const parsed = parseBots(doc, ctx);
  assert.ok(parsed.bots.length >= 2);
  for (const b of parsed.bots) assert.equal(hasLocalRoute(b, parsed.presets), true, `${b.id} has a local preset in its route`);
  // the implicit main of a Phase 3 install too
  const implicit = parseBots(undefined, ctx);
  assert.equal(implicit.implicit, true);
  for (const b of implicit.bots) assert.equal(hasLocalRoute(b, implicit.presets), true);
  assert.ok(baseSecurity());
  // a cloud-only route is reported
  const cloudOnly = botOf({ route: { primary: "codex", allowed: ["codex"], fallback: [] } });
  assert.equal(hasLocalRoute(cloudOnly, ALL_PRESETS), false);
  assert.ok(routeProblems(cloudOnly, ALL_PRESETS, ALL_TERMS).warnings.some((w) => /no local preset/.test(w)));
});

test("route report: primary must be allowed, unknown ids refused, fallback without autoFallback warned, privileged tool on a cloud-capable bot refused (I42)", () => {
  assert.ok(routeProblems(botOf({ route: { primary: "strata", allowed: ["lmstudio"] } }), ALL_PRESETS, ALL_TERMS).issues.some((i) => /must include the primary/.test(i)));
  assert.ok(routeProblems(botOf({ route: { fallback: ["ghost"] } }), ALL_PRESETS, ALL_TERMS).issues.some((i) => /ghost/.test(i)));
  assert.ok(routeProblems(botOf({ route: { fallback: ["codex2"] } }), ALL_PRESETS, ALL_TERMS).warnings.some((w) => /autoFallback off/.test(w)));
  assert.ok(routeProblems(botOf({ tools: ["read_file", "shell"] }), ALL_PRESETS, ALL_TERMS).issues.some((i) => /shell/.test(i)));
  assert.equal(routeProblems(botOf({ tools: ["read_file", "shell"], relax: { privateRoots: false, privilegedTools: true } }), ALL_PRESETS, ALL_TERMS).issues.length, 0);
  assert.equal(routeProblems(botOf({ tools: ["shell"], route: { allowed: ["lmstudio", "strata"] } }), ALL_PRESETS, ALL_TERMS).issues.length, 0, "a local-only bot may have shell");
});

test("compaction thresholds are per preset (75% of each contextWindow), keyed provider/modelId", () => {
  const o = compactionOverrides(botOf({ route: { allowed: ["lmstudio", "strata", "codex"] } }), ALL_PRESETS);
  const keys = Object.keys(o).sort();
  assert.deepEqual(keys, ["acp-codex/codex/gpt", "lmstudio/lm-model", "strata/strata-model"]);
  assert.notDeepEqual(o["lmstudio/lm-model"], o["strata/strata-model"]);
  // a preset whose maxTokens is not below the window is skipped
  const odd = { ...LM, id: "odd", maxTokens: 9000, contextWindow: 8192 };
  assert.deepEqual(compactionOverrides({ route: route({ primary: "odd", allowed: ["odd"] }) }, [odd]), {});
});

test("the I38 verdict: local->local, cloud->local, same vendor auto; local->cloud and cloud->other vendor card; outside allowed reject", () => {
  const b = botOf({ route: { allowed: ["lmstudio", "strata", "codex", "codex2", "claude"] } });
  const v = (from: string | undefined, to: string) => switchVerdict(b, ALL_PRESETS, from, to);
  assert.equal(v("lmstudio", "strata"), "auto");
  assert.equal(v("codex", "lmstudio"), "auto");
  assert.equal(v("claude", "strata"), "auto");
  assert.equal(v("codex", "codex2"), "auto", "same vendor");
  assert.equal(v("lmstudio", "codex"), "card");
  assert.equal(v("strata", "claude"), "card");
  assert.equal(v("codex", "claude"), "card", "another vendor is new egress");
  assert.equal(v("lmstudio", "anti"), "reject", "outside allowed");
  assert.equal(v(undefined, "codex"), "card", "no stored value: the primary is the 'from'");
  assert.equal(v("lmstudio", "lmstudio"), "same");
  const entries = pickerEntries(b, ALL_PRESETS, "lmstudio");
  assert.deepEqual(entries.map((e) => e.preset.id), b.route.allowed);
  assert.deepEqual(entries.map((e) => e.verdict), ["same", "auto", "card", "card", "card"]);
  assert.deepEqual(entries[0]?.roles, ["primary", "allowed"]);
});

test("fallback candidates keep the configured order, need autoFallback, and can skip the failed vendor", () => {
  const r = route({ fallback: ["codex2", "strata", "codex", "claude"] });
  assert.deepEqual(fallbackCandidates({ route: r }, ALL_PRESETS, LM, ALL_TERMS).map((p) => p.id), ["strata", "codex", "claude"]);
  assert.deepEqual(fallbackCandidates({ route: r }, ALL_PRESETS, CODEX, ALL_TERMS, { excludeSameVendor: true }).map((p) => p.id), ["strata", "claude"]);
  assert.deepEqual(fallbackCandidates({ route: r }, ALL_PRESETS, CODEX, ALL_TERMS).map((p) => p.id), ["strata", "claude"], "the failed preset itself is never a candidate");
});
