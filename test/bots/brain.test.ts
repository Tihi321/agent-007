import assert from "node:assert/strict";
import { test } from "node:test";
import { BRAIN_CHOICES, DEFAULT_BRAIN, applyBrain, brainBadge, brainOf, brainRoute } from "../../src/bots/brain.js";
import { botFromDoc } from "../../src/bots/schema.js";
import { FallbackEngine, decide } from "../../src/models/fallback.js";
import { claudeFormTemplates } from "../../src/models/templates.js";
import { classifyProxyResponse, toFallbackFailure } from "../../src/proxy/errors.js";
import { shippedForms } from "../../src/jobrunner/settingsUi/forms/registry.js";
import { startFakeProxy, FAKE_KEY } from "../proxy/helpers.js";
import { STRATA, ALL_TERMS } from "../models/helpers.js";
import { ACP_CODEX, baseSecurity, bot, check, withBots } from "./helpers.js";

const claude = (id: string, modelId: string) => ({ ...ACP_CODEX, id, providerId: "claude", modelId, label: id, autoFallback: false });
const presets = () => [...baseSecurity().presets, claude("claude-sonnet", "claude/sonnet"), claude("claude-opus", "claude/opus")];

test("brainRoute: Sonnet or Opus primary, Sonnet+Opus+Strata allowed, Strata the only fallback; Sonnet is the default", () => {
  assert.equal(DEFAULT_BRAIN, "sonnet");
  for (const c of BRAIN_CHOICES) {
    const r = brainRoute(c);
    assert.equal(brainOf(r), c);
    assert.deepEqual(r.allowed, ["claude-sonnet", "claude-opus", "strata"]);
    assert.deepEqual(r.fallback, ["strata"]);
    assert.equal(r.onAuthRequired, "fallback");
  }
  assert.equal(brainOf({ primary: "lmstudio" }), undefined);
});

test("a new bot can be created with Sonnet or Opus as default and a Strata fallback; the loader accepts it with the terms flag only", () => {
  for (const c of BRAIN_CHOICES) {
    const { bot: applied } = applyBrain(botFromDoc(bot()), c);
    const doc = withBots({ main: bot(), claudy: { ...bot({ telegramTokenRef: "claudy", tools: ["tool_search", "read_file"] }), route: applied.route } }, { presets: presets() });
    const without = check(doc);
    assert.equal(without.ok, false);
    assert.ok(without.issues.some((i) => /termsAccepted\.claude/.test(i)));
    const ok = check({ ...doc, termsAccepted: { claude: true } });
    assert.deepEqual(ok.issues, []);
    assert.equal(ok.ok, true);
  }
});

test("shell on a Claude-primary bot is refused without the relax flag; applyBrain removes shell and dispatch_job and says so", () => {
  const base = botFromDoc(bot());
  assert.ok(base.tools.includes("shell"));
  const { bot: applied, removedTools, notes } = applyBrain(base, "sonnet");
  assert.deepEqual(removedTools.sort(), ["dispatch_job", "shell"]);
  assert.ok(!applied.tools.includes("shell") && !applied.tools.includes("dispatch_job"));
  assert.ok(notes.some((n) => /removed/.test(n)));
  // the loader refuses the unmodified tools on that route
  const bad = withBots({ main: bot({ route: brainRoute("sonnet") }) }, { presets: presets(), termsAccepted: { claude: true } });
  const r = check(bad);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /shell/.test(i)));
  // with the relax flag the tools stay and the loader accepts
  const relaxed = botFromDoc(bot({ relax: { privateRoots: false, privilegedTools: true } }));
  assert.deepEqual(applyBrain(relaxed, "opus").removedTools, []);
  const okDoc = withBots({ main: bot({ route: brainRoute("sonnet"), relax: { privilegedTools: true } }) }, { presets: presets(), termsAccepted: { claude: true } });
  assert.equal(check(okDoc).issues.some((i) => /shell/.test(i)), false);
});

test("proxy 503 provider_auth_required (a real fake-proxy answer): I39 falls back to Strata once and tells the user once", async () => {
  const px = await startFakeProxy({ modelsReply: { status: 503, body: { error: { message: "login", type: "x", code: "provider_auth_required" } } } });
  try {
    const res = await fetch(`http://127.0.0.1:${px.port}/v1/models`, { headers: { authorization: `Bearer ${FAKE_KEY}` } });
    assert.equal(res.status, 503);
    const failure = classifyProxyResponse({ status: res.status, body: await res.json() });
    const mapped = toFallbackFailure(failure);
    assert.ok(mapped);
    const route = brainRoute("sonnet");
    const sonnet = { ...claude("claude-sonnet", "claude/sonnet"), kind: "acp" as const, contextWindow: 100000, maxTokens: 4096, privacy: "cloud" as const };
    const list = [sonnet, { ...STRATA, id: "strata" }];
    const d = decide(mapped, sonnet as never, route, { presets: list as never, terms: ALL_TERMS, attempt: 0 });
    assert.equal(d.action, "fallback");
    assert.equal(d.action === "fallback" && d.preset.id, "strata");
    const e = new FallbackEngine({ bot: { id: "main", route }, presets: list as never, terms: () => ALL_TERMS });
    const first = e.handle(mapped, "claude-sonnet");
    assert.ok(first.notice);
    assert.equal(e.handle(mapped, "claude-sonnet").notice, undefined);
    // proxy down: same
    assert.equal(e.handle({ kind: "connection_refused" }, "claude-sonnet").decision.action, "fallback");
  } finally {
    await px.close();
  }
});

test("badge and egress note; the bots form offers a template per brain", () => {
  const b = applyBrain(botFromDoc(bot()), "opus").bot;
  const ps = [{ ...claude("claude-opus", "claude/opus"), kind: "acp", contextWindow: 1, maxTokens: 1, privacy: "cloud" }, { ...STRATA, id: "strata" }] as never;
  const badge = brainBadge(b, ps);
  assert.equal(badge.cloud, true);
  assert.match(badge.label, /cloud/);
  assert.match(badge.egressNote, /cloud-safe/);
  const local = brainBadge({ route: { primary: "strata", allowed: ["strata"], fallback: [], onAuthRequired: "fallback" } }, ps);
  assert.equal(local.cloud, false);
  const f = shippedForms().get("bots");
  assert.equal(f?.templates?.length, 2);
  const t = JSON.parse(f?.templates?.[0]?.json ?? "{}");
  assert.equal(t.route.primary, "claude-sonnet");
  assert.deepEqual(t.route.fallback, ["strata"]);
  assert.ok(!t.tools.includes("shell"));
  assert.equal(claudeFormTemplates().length, 2);
});
