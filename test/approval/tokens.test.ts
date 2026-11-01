import assert from "node:assert/strict";
import { test } from "node:test";
import { createApprovalTokens } from "../../src/approval/tokens.js";

test("a token is one-shot and bound to the key and the command hash", () => {
  const t = createApprovalTokens();
  t.grant("k1", "h1");
  assert.equal(t.consume("k1", "h1"), true);
  assert.equal(t.consume("k1", "h1"), false);

  t.grant("k1", "h1");
  assert.equal(t.consume("k2", "h1"), false, "another key");
  assert.equal(t.consume("k1", "h1"), true, "the unrelated attempt did not burn it");

  t.grant("k1", "h1");
  assert.equal(t.consume("k1", "other"), false, "wrong command hash");
  assert.equal(t.consume("k1", "h1"), false, "and a wrong attempt burns the token");
});

test("tokens expire and the store is bounded", () => {
  let now = 0;
  const t = createApprovalTokens({ ttlMs: 1000, maxTokens: 3, now: () => now });
  t.grant("a", "h");
  now = 1000;
  assert.equal(t.consume("a", "h"), false, "expired");
  now = 2000;
  for (const k of ["1", "2", "3", "4", "5"]) t.grant(k, "h");
  assert.ok(t.size() <= 3);
  assert.equal(t.consume("5", "h"), true, "the newest survive");
});
