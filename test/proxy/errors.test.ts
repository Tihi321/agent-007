import assert from "node:assert/strict";
import { test } from "node:test";
import { FAILURE_KINDS } from "../../src/models/fallback.js";
import {
  ProxyError,
  classifyProxyMessage,
  classifyProxyResponse,
  classifyThrown,
  codeFromBody,
  failureOf,
  harnessMayRetry,
  markedMessage,
  parseRetryAfter,
  toFallbackFailure,
} from "../../src/proxy/errors.js";
import type { ProxyErrorKind } from "../../src/proxy/errors.js";

const env = (code: string): unknown => ({ error: { message: "x", type: "t", code } });

interface Row {
  name: string;
  status: number;
  body?: unknown;
  retryAfter?: string;
  kind: ProxyErrorKind;
  fallbackKind: string;
  attempts: number;
  delaySec?: number;
  fallback: "after_retries" | "never";
  needsLogin?: boolean;
}

const ROWS: Row[] = [
  { name: "503 provider_auth_required", status: 503, body: env("provider_auth_required"), kind: "auth_required", fallbackKind: "auth_required", attempts: 0, fallback: "after_retries", needsLogin: true },
  { name: "503 auth_required (Antigravity)", status: 503, body: env("auth_required"), kind: "auth_required", fallbackKind: "auth_required", attempts: 0, fallback: "after_retries", needsLogin: true },
  { name: "503 provider_busy with Retry-After", status: 503, body: env("provider_busy"), retryAfter: "17", kind: "busy", fallbackKind: "provider_busy", attempts: 2, delaySec: 17, fallback: "after_retries" },
  { name: "503 without a code", status: 503, body: { error: { message: "x" } }, kind: "busy", fallbackKind: "provider_busy", attempts: 2, delaySec: 30, fallback: "after_retries" },
  { name: "429 provider_queue_full", status: 429, body: env("provider_queue_full"), kind: "queue_full", fallbackKind: "queue_full", attempts: 1, fallback: "after_retries" },
  { name: "504 request_timeout", status: 504, body: env("request_timeout"), kind: "timeout", fallbackKind: "timeout", attempts: 1, fallback: "after_retries" },
  { name: "404 model_not_found", status: 404, body: env("model_not_found"), kind: "model_not_found", fallbackKind: "model_not_found", attempts: 0, fallback: "never" },
  { name: "400 model_not_capable", status: 400, body: env("model_not_capable"), kind: "bad_request", fallbackKind: "bad_request", attempts: 0, fallback: "never" },
  { name: "400 unsupported_parameter", status: 400, body: env("unsupported_parameter"), kind: "bad_request", fallbackKind: "bad_request", attempts: 0, fallback: "never" },
  { name: "401", status: 401, body: env("invalid_api_key"), kind: "bad_key", fallbackKind: "auth_required", attempts: 0, fallback: "after_retries" },
  { name: "401 with no body", status: 401, kind: "bad_key", fallbackKind: "auth_required", attempts: 0, fallback: "after_retries" },
  { name: "500 unknown", status: 500, body: { oops: true }, kind: "unknown", fallbackKind: "other", attempts: 1, fallback: "after_retries" },
];

for (const r of ROWS) {
  test(`error map: ${r.name}`, () => {
    const f = classifyProxyResponse({ status: r.status, body: r.body, ...(r.retryAfter !== undefined ? { retryAfter: r.retryAfter } : {}) });
    assert.equal(f.kind, r.kind);
    assert.equal(f.retry.attempts, r.attempts);
    if (r.delaySec !== undefined) assert.equal(f.retry.delaySec, r.delaySec);
    assert.equal(f.fallback, r.fallback);
    assert.equal(f.needsLogin, r.needsLogin === true);
    assert.equal(harnessMayRetry(f), r.attempts > 0);
    // the S22 fallback.ts kind
    const fb = toFallbackFailure(f);
    assert.ok(fb);
    assert.equal(fb.kind, r.fallbackKind);
    assert.ok((FAILURE_KINDS as readonly string[]).includes(fb.kind), "a kind fallback.ts knows");
    if (r.retryAfter !== undefined) assert.equal(fb.retryAfterSec, Number(r.retryAfter));
    // the same answer when it arrives as Pi's error text
    const text = `${r.status} ${JSON.stringify(r.body ?? {})}`;
    assert.equal(classifyProxyMessage(text).kind, r.kind);
  });
}

test("error map: a refused connection is `down`, same handling as auth_required", () => {
  for (const text of ["connect ECONNREFUSED 127.0.0.1:8787", "Connection error.", "fetch failed", "read ECONNRESET"]) {
    const f = classifyProxyMessage(text);
    assert.equal(f.kind, "down", text);
    assert.equal(f.needsLogin, true);
    assert.equal(f.retry.attempts, 0);
    assert.equal(f.fallback, "after_retries");
    assert.equal(toFallbackFailure(f)?.kind, "connection_refused");
  }
  const cause = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  assert.equal(classifyThrown(cause).kind, "down");
});

test("caller aborts and limiter refusals never reach the fallback engine", () => {
  assert.equal(classifyProxyMessage("anything", { aborted: true }).kind, "aborted");
  assert.equal(toFallbackFailure(failureOf("aborted")), undefined);
  assert.equal(toFallbackFailure(failureOf("limiter_busy")), undefined);
  assert.equal(failureOf("aborted").fallback, "never");
  const abort = Object.assign(new Error("x"), { name: "AbortError" });
  assert.equal(classifyThrown(abort).kind, "aborted");
  assert.equal(classifyThrown(new Error("x"), { timedOut: true }).kind, "timeout");
  assert.equal(classifyThrown(new ProxyError(failureOf("bad_key"))).kind, "bad_key");
});

test("every proxy error kind maps to a fallback.ts kind or to nothing", () => {
  const kinds: ProxyErrorKind[] = ["auth_required", "bad_key", "busy", "queue_full", "timeout", "model_not_found", "bad_request", "down", "limiter_busy", "aborted", "unknown"];
  for (const k of kinds) {
    const fb = toFallbackFailure(failureOf(k));
    if (fb) assert.ok((FAILURE_KINDS as readonly string[]).includes(fb.kind), k);
  }
});

test("Retry-After is parsed and clamped; a missing one uses the 30 s default", () => {
  assert.equal(parseRetryAfter("30"), 30);
  assert.equal(parseRetryAfter(" 5 "), 5);
  assert.equal(parseRetryAfter("soon"), undefined);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(failureOf("busy", { retryAfterSec: 9999 }).retry.delaySec, 120);
  assert.equal(failureOf("busy").retry.delaySec, 30);
});

test("codeFromBody reads a JSON string, an object and plain text", () => {
  assert.equal(codeFromBody(JSON.stringify(env("provider_busy"))), "provider_busy");
  assert.equal(codeFromBody({ error: { type: "foo" } }), "foo");
  assert.equal(codeFromBody("not json but provider_queue_full"), "provider_queue_full");
  assert.equal(codeFromBody(42), undefined);
});

test("a marked message is not classified as retryable by Pi's regex and round-trips", () => {
  const retryRegex = /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|timed? ?out|timeout|terminated|retry delay/i;
  for (const k of ["auth_required", "bad_key", "model_not_found", "bad_request", "down"] as const) {
    const m = markedMessage(failureOf(k));
    assert.equal(retryRegex.test(m), false, `${k}: ${m}`);
    assert.equal(classifyProxyMessage(m).kind, k);
  }
});

test("a failure message is a fixed sentence: it never echoes the response body", () => {
  const secret = "sk-leaky-1234567890";
  const f = classifyProxyResponse({ status: 503, body: { error: { message: `key ${secret} is bad`, code: "provider_auth_required" } } });
  assert.ok(!JSON.stringify(f).includes(secret));
  const f2 = classifyProxyMessage(`503 key ${secret} provider_busy`);
  assert.ok(!JSON.stringify(f2).includes(secret));
});

test("a Retry-After in the error text sets the busy delay (clamped); without one the table default stays", () => {
  const a = classifyProxyMessage('503 {"error":{"code":"provider_busy"}} retry-after: 7');
  assert.equal(a.kind, "busy");
  assert.equal(a.retry.delaySec, 7);
  assert.equal(a.retry.attempts, 2);
  assert.equal(classifyProxyMessage("503 provider_busy").retry.delaySec, 30);
  assert.equal(classifyProxyMessage("503 provider_busy retry_after=9999").retry.delaySec, 120);
});
