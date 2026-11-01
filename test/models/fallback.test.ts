/** S22.3: the I39 table, row by row, and the engine's one-notice-per-outage rule. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotRoute, PresetConfig } from "../../src/bots/schema.js";
import { BACKOFF_MS, FAILURE_KINDS, FallbackEngine, decide } from "../../src/models/fallback.js";
import type { Decision, Failure, FailureKind } from "../../src/models/fallback.js";
import { capturingAudit } from "../settings/helpers.js";
import { ALL_PRESETS, ALL_TERMS, ANTI, CLAUDE, CODEX, CODEX2, LM, NO_TERMS, STRATA, route } from "./helpers.js";

const ctx = (attempt = 0, terms = ALL_TERMS, presets: readonly PresetConfig[] = ALL_PRESETS) => ({ presets, terms, attempt });
const R = (over: Partial<BotRoute> = {}): BotRoute => route({ fallback: ["lmstudio"], ...over });

function ids(d: Decision): string {
  return d.action === "fallback" ? `fallback:${d.preset.id}` : d.action;
}

interface Row {
  name: string;
  failure: Failure;
  preset: PresetConfig;
  route: BotRoute;
  attempt?: number;
  want: string;
  extra?: (d: Decision) => void;
}

const ROWS: Row[] = [
  { name: "503 auth: no retry, needs login, then the local fallback", failure: { kind: "auth_required" }, preset: CODEX, route: R(), want: "fallback:lmstudio", extra: (d) => assert.ok(d.action === "fallback" && d.needsLogin && !d.refreshModels) },
  { name: "503 busy with Retry-After 7: wait 7 s and retry (first attempt)", failure: { kind: "provider_busy", retryAfterSec: 7 }, preset: CODEX, route: R(), want: "retry", extra: (d) => assert.ok(d.action === "retry" && d.afterMs === 7000) },
  { name: "503 busy, second retry", failure: { kind: "provider_busy", retryAfterSec: 7 }, preset: CODEX, route: R(), attempt: 1, want: "retry" },
  { name: "503 busy stays busy after two retries: the route rule", failure: { kind: "provider_busy", retryAfterSec: 7 }, preset: CODEX, route: R(), attempt: 2, want: "fallback:lmstudio", extra: (d) => assert.ok(d.action === "fallback" && !d.needsLogin) },
  { name: "429 queue full: one backoff retry", failure: { kind: "queue_full" }, preset: CODEX, route: R(), want: "retry", extra: (d) => assert.ok(d.action === "retry" && d.afterMs === BACKOFF_MS) },
  { name: "429 queue full again: the route rule", failure: { kind: "queue_full" }, preset: CODEX, route: R(), attempt: 1, want: "fallback:lmstudio" },
  { name: "504 timeout: one backoff retry", failure: { kind: "timeout" }, preset: CODEX, route: R(), want: "retry" },
  { name: "504 timeout again: the route rule", failure: { kind: "timeout" }, preset: CODEX, route: R(), attempt: 1, want: "fallback:lmstudio" },
  { name: "other failure behaves like a timeout", failure: { kind: "other" }, preset: CODEX, route: R(), want: "retry" },
  { name: "404 model not found: no retry, refresh the list", failure: { kind: "model_not_found" }, preset: CODEX, route: R(), want: "fallback:lmstudio", extra: (d) => assert.ok(d.action === "fallback" && d.refreshModels) },
  { name: "400: fail, never a fallback", failure: { kind: "bad_request" }, preset: CODEX, route: R(), want: "fail" },
  { name: "connection refused on a proxy preset: needs login, then the fallback", failure: { kind: "connection_refused" }, preset: CODEX, route: R(), want: "fallback:lmstudio", extra: (d) => assert.ok(d.action === "fallback" && d.needsLogin) },
  { name: "connection refused on a local preset: no login flag, falls to the next local one", failure: { kind: "connection_refused" }, preset: LM, route: R({ fallback: ["strata"] }), want: "fallback:strata", extra: (d) => assert.ok(d.action === "fallback" && !d.needsLogin && /not running/.test(d.message)) },
  { name: "cloud -> cloud at another vendor needs autoFallback and the acknowledgment: allowed when both hold", failure: { kind: "auth_required" }, preset: CODEX, route: R({ fallback: ["claude"] }), want: "fallback:claude" },
  { name: "cloud -> cloud: claude without termsAccepted is not a candidate", failure: { kind: "auth_required" }, preset: CODEX, route: R({ fallback: ["claude"] }), want: "tell_user" },
  { name: "cloud -> cloud: a fallback with autoFallback off is not selected", failure: { kind: "auth_required" }, preset: CLAUDE, route: R({ fallback: ["codex2"] }), want: "tell_user" },
  { name: "no fallback configured: tell the user", failure: { kind: "auth_required" }, preset: CODEX, route: R({ fallback: [] }), want: "tell_user" },
  { name: "onAuthRequired ask: tell the user to use /model", failure: { kind: "auth_required" }, preset: CODEX, route: R({ onAuthRequired: "ask" }), want: "tell_user", extra: (d) => assert.ok(d.action === "tell_user" && /\/model/.test(d.message) && d.choices.map((c) => c.id).join() === "lmstudio") },
  { name: "onAuthRequired fail: the turn fails", failure: { kind: "auth_required" }, preset: CODEX, route: R({ onAuthRequired: "fail" }), want: "fail" },
];

for (const r of ROWS) {
  test(`I39: ${r.name}`, () => {
    const noTerms = /claude without termsAccepted/.test(r.name);
    const d = decide(r.failure, r.preset, r.route, ctx(r.attempt ?? 0, noTerms ? NO_TERMS : ALL_TERMS));
    assert.equal(ids(d), r.want);
    r.extra?.(d);
  });
}

test("I39: the Retry-After wait is clamped to 1..60 s and defaults to 5 s", () => {
  const wait = (retryAfterSec?: number) => {
    const d = decide({ kind: "provider_busy", ...(retryAfterSec === undefined ? {} : { retryAfterSec }) }, CODEX, R(), ctx());
    assert.equal(d.action, "retry");
    return d.action === "retry" ? d.afterMs : -1;
  };
  assert.equal(wait(0.2), 1000);
  assert.equal(wait(30), 30000);
  assert.equal(wait(500), 60000);
  assert.equal(wait(undefined), 5000);
});

test("I39: 404 never substitutes another model of the same provider; the failed preset itself is never chosen", () => {
  const sameVendorAuto: PresetConfig = { ...CODEX2, autoFallback: true };
  const presets = [LM, CODEX, sameVendorAuto];
  const d = decide({ kind: "model_not_found" }, CODEX, route({ allowed: ["lmstudio", "codex", "codex2"], fallback: ["codex2", "codex", "lmstudio"] }), ctx(0, ALL_TERMS, presets));
  assert.equal(ids(d), "fallback:lmstudio");
  // while an auth failure may fall to the same vendor's other model
  const a = decide({ kind: "auth_required" }, CODEX, route({ allowed: ["lmstudio", "codex", "codex2"], fallback: ["codex2", "lmstudio"] }), ctx(0, ALL_TERMS, presets));
  assert.equal(ids(a), "fallback:codex2");
});

test("I39: the fallback text says when the fallback sends text to a cloud vendor", () => {
  const d = decide({ kind: "connection_refused" }, LM, route({ fallback: ["codex"] }), ctx());
  assert.ok(d.action === "fallback" && /sends text to codex/.test(d.message));
  const e = decide({ kind: "auth_required" }, CODEX, route({ fallback: ["claude"] }), ctx());
  assert.ok(e.action === "fallback" && !/sends text/.test(e.message), "cloud to cloud: no new class of egress in the sentence");
});

test("no path selects a preset without autoFallback, and no per-token-billed preset can be selected", () => {
  const noAuto = ALL_PRESETS.map((p) => ({ ...p, autoFallback: false }));
  const paid = { ...CODEX, id: "paid", kind: "api", autoFallback: true } as unknown as PresetConfig;
  const paidKey = { ...CODEX, id: "paidkey", apiKeyRef: "openaiKey", autoFallback: true } as unknown as PresetConfig;
  const cases: { presets: PresetConfig[]; fallback: string[] }[] = [
    { presets: noAuto, fallback: noAuto.map((p) => p.id) },
    { presets: [...ALL_PRESETS, paid, paidKey], fallback: ["paid", "paidkey"] },
  ];
  for (const c of cases) {
    for (const kind of FAILURE_KINDS) {
      for (const attempt of [0, 1, 2, 3]) {
        for (const onAuthRequired of ["fallback", "ask", "fail"] as const) {
          for (const failed of [LM, CODEX]) {
            const d = decide({ kind, retryAfterSec: 1 }, failed, route({ allowed: c.presets.map((p) => p.id), fallback: c.fallback, onAuthRequired }), ctx(attempt, ALL_TERMS, c.presets));
            assert.notEqual(d.action, "fallback", `${kind}/${attempt}/${onAuthRequired}/${failed.id} selected a preset`);
            if (d.action === "tell_user") assert.deepEqual(d.choices, []);
          }
        }
      }
    }
  }
  // and the positive control: with autoFallback and a legal preset it does select
  assert.equal(ids(decide({ kind: "auth_required" }, CODEX, R(), ctx())), "fallback:lmstudio");
  // anti without terms is never chosen
  assert.equal(ids(decide({ kind: "auth_required" }, CODEX, R({ fallback: ["anti"] }), ctx(0, NO_TERMS))), "tell_user");
  assert.ok(ANTI && STRATA);
});

// ---- the engine ----------------------------------------------------------------------------------------------------

function engine(over: { route?: Partial<BotRoute>; audit?: ReturnType<typeof capturingAudit> } = {}) {
  const audit = over.audit ?? capturingAudit();
  const e = new FallbackEngine({ bot: { id: "main", route: R(over.route) }, presets: ALL_PRESETS, terms: () => ALL_TERMS, audit });
  return { e, audit };
}

test("engine: a second failure of the same outage gives no second message and no second audit line; recovery re-arms it", () => {
  const { e, audit } = engine();
  const first = e.handle({ kind: "auth_required" }, "codex");
  assert.equal(first.decision.action, "fallback");
  assert.match(first.notice ?? "", /needs a login/);
  const second = e.handle({ kind: "auth_required" }, "codex");
  assert.equal(second.decision.action, "fallback", "the decision is still made");
  assert.equal(second.notice, undefined, "but nothing new is said");
  const third = e.handle({ kind: "connection_refused" }, "codex");
  assert.equal(third.notice, undefined);
  assert.equal(audit.lines.length, 1, "one audit line per outage");
  assert.equal(audit.lines[0]?.note, "fallback: auth_required -> fallback");
  assert.deepEqual(audit.lines[0]?.diff, [{ path: "bots.main.activePreset", op: "replace", before: "codex", after: "lmstudio" }]);
  assert.equal(audit.lines[0]?.source, "system");
  assert.equal(e.inOutage("codex"), true);
  e.succeeded("codex");
  assert.equal(e.inOutage("codex"), false);
  assert.ok(e.handle({ kind: "auth_required" }, "codex").notice, "a new outage says it once more");
  assert.equal(audit.lines.length, 2);
});

test("engine: a retry carries no notice and does not start an outage; the notice comes when retries are used up", () => {
  const { e } = engine();
  assert.equal(e.handle({ kind: "queue_full" }, "codex", 0).notice, undefined);
  assert.equal(e.inOutage("codex"), false);
  const last = e.handle({ kind: "queue_full" }, "codex", 1);
  assert.match(last.notice ?? "", /overloaded/);
  assert.equal(e.handle({ kind: "queue_full" }, "codex", 1).notice, undefined);
});

test("engine: the needs-login flag is set for auth and connection failures of a proxy preset and cleared when it answers", () => {
  const { e } = engine();
  assert.deepEqual(e.needsLogin(), []);
  e.handle({ kind: "auth_required" }, "codex");
  e.handle({ kind: "connection_refused" }, "claude");
  assert.deepEqual(e.needsLogin().sort(), ["claude", "codex"]);
  e.succeeded("codex");
  assert.deepEqual(e.needsLogin(), ["claude"]);
  e.handle({ kind: "connection_refused" }, "lmstudio");
  assert.deepEqual(e.needsLogin(), ["claude"], "a local runner being down is not a login problem");
});

test("engine: a 400 fails with a notice once, an unknown preset fails, and a failing audit never blocks the notice", () => {
  const { e, audit } = engine();
  const bad = e.handle({ kind: "bad_request" }, "codex");
  assert.equal(bad.decision.action, "fail");
  assert.match(bad.notice ?? "", /malformed/);
  assert.equal(e.needsLogin().length, 0);
  assert.equal(e.handle({ kind: "other" }, "ghost").decision.action, "fail");
  audit.failNext();
  const r = e.handle({ kind: "auth_required" }, "claude");
  assert.ok(r.notice, "the notice is sent although the audit write threw");
});

test("engine: every I39 failure kind is covered by a row above", () => {
  const covered: FailureKind[] = ROWS.map((r) => r.failure.kind);
  for (const k of FAILURE_KINDS) assert.ok(covered.includes(k), `${k} has a table row`);
});
