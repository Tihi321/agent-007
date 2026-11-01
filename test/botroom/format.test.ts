/** S24.1: line format, truncation (UI-27), redaction of secret-shaped text, flattening. Pure functions, no I/O. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_POST_CHARS, bodyOf, droppedNotice, formatLine, redactForRoom, takeBatch, truncate } from "../../src/botroom/format.js";
import type { FormatOptions } from "../../src/botroom/format.js";
import { createRedactor } from "../../src/logging/redact.js";
import { ask } from "./helpers.js";

const SECRET = "hunter2-very-secret-value";
const opts = (over: Partial<FormatOptions> = {}): FormatOptions => ({ mode: "truncated", maxChars: 200, redact: createRedactor([SECRET]), ...over });

test("a line reads [from → to, hop n, chain id] text, with the chain id shortened", () => {
  assert.equal(formatLine(ask("what is the disk status?"), opts()), "[research → ops, hop 1, chain 7f3a9c1e] what is the disk status?");
});

test("truncated mode cuts at maxChars with an ellipsis; summary mode keeps the first line, at most 80 characters", () => {
  const long = "x ".repeat(400);
  const t = bodyOf(ask(long), opts({ maxChars: 50 }));
  assert.equal(Array.from(t).length, 50);
  assert.ok(t.endsWith("…"));
  const s = bodyOf(ask(`first line is short\nsecond line stays out\nthird`), opts({ mode: "summary", maxChars: 300 }));
  assert.equal(s, "first line is short");
  const s2 = bodyOf(ask("y".repeat(500).replace(/(.{9})/g, "$1 ")), opts({ mode: "summary", maxChars: 300 }));
  assert.ok(Array.from(s2).length <= 80);
  const s3 = bodyOf(ask("z ".repeat(100)), opts({ mode: "summary", maxChars: 30 }));
  assert.ok(Array.from(s3).length <= 30, "maxChars wins when smaller than the summary length");
});

test("truncation never splits a surrogate pair", () => {
  const out = truncate("😀".repeat(10), 4);
  assert.equal(out, "😀😀😀…");
});

test("exact secret values and bot tokens are redacted", () => {
  const line = formatLine(ask(`use ${SECRET} and https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_x/getMe`), opts()) as string;
  assert.ok(!line.includes(SECRET));
  assert.ok(!line.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_x"));
  assert.ok(line.includes("[REDACTED]"));
});

test("secret-shaped text is redacted: API keys, bearer tokens, JWTs, key=value, private keys, hex digests, long opaque keys", () => {
  const r = createRedactor([]);
  const samples = [
    "key sk-abcdefghijklmnop1234567890",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "api_key=supersecretvalue",
    'config {"password": "p4ssw0rd!!"}',
    "TELEGRAM_BOT_TOKEN: 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_xyz",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIAABCDEFGHIJKLMNOP",
    "sha 0123456789abcdef0123456789abcdef01234567",
    "ipc key AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEf",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
  ];
  const leaks = ["sk-abcdefghijklmnop", "abcdefghijklmnopqrstuvwxyz0123", "dBjftJeZ4CVPmB92K27", "supersecretvalue", "p4ssw0rd", "AAHdqTcvCH1vGWJ", "ghp_abcdefghij", "AKIAABCDEFGHIJKLMNOP", "0123456789abcdef0123456789abcdef", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "b3BlbnNzaC1rZXktdjEAAAAA"];
  for (const s of samples) {
    const out = redactForRoom(s, r);
    for (const leak of leaks) assert.ok(!out.includes(leak), `leaked ${leak} in: ${out}`);
    assert.ok(out.includes("[REDACTED]"), `no redaction in: ${out}`);
  }
});

test("redaction happens before truncation: a secret straddling the cut leaves no prefix", () => {
  const text = "a".repeat(10) + " " + SECRET;
  const t = bodyOf(ask(text), opts({ maxChars: 22 }));
  assert.ok(!t.includes("hunter2"), t);
});

test("the text is flattened to one line with control characters removed; markup stays literal", () => {
  const line = formatLine(ask("line one\n\n\tline two\u0007 <b>bold</b> *x* [y](z)" + String.fromCharCode(0x2028) + "end"), opts()) as string;
  assert.ok(!/[\n\r\t\u0007]/.test(line) && !line.includes(String.fromCharCode(0x2028)));
  assert.ok(line.includes("<b>bold</b> *x* [y](z)"));
});

test("hostile ids are flattened, redacted and shortened", () => {
  const line = formatLine(ask("hi", { from: "evil\nbot", to: `${SECRET}`, chainId: `${SECRET}-and-more` }), opts()) as string;
  assert.ok(!line.includes(SECRET));
  assert.ok(!line.includes("\n"));
});

test("only ask, reply, refused and failed are mirrored: approvals, prompts and unknown kinds are not", () => {
  for (const kind of ["approval", "approval_request", "prompt", "tool_output", "taint", "secret", ""]) assert.equal(formatLine(ask("x", { kind }), opts()), undefined, kind);
  assert.ok(formatLine(ask("x", { kind: "reply" }), opts()));
  const refused = formatLine({ kind: "refused", from: "a", to: "b", hop: 2, chainId: "c1", reason: "hop_limit" }, opts());
  assert.equal(refused, "[a → b, hop 2, chain c1] refused: hop_limit");
  assert.equal(formatLine({ kind: "failed", from: "a", to: "b", hop: 1, chainId: "c1" }, opts()), "[a → b, hop 1, chain c1] failed");
});

test("malformed events give no line instead of throwing", () => {
  assert.equal(formatLine({ kind: "ask" } as never, opts()), undefined);
  assert.ok(formatLine(ask("x", { hop: Number.NaN }), opts())?.includes("hop 0"));
});

test("takeBatch keeps whole lines within the line and character caps; the notice is singular or plural", () => {
  assert.deepEqual(takeBatch(["a", "b", "c"], 2), ["a", "b"]);
  const big = "x".repeat(2000);
  assert.equal(takeBatch([big, big, big], 5).length, 1);
  assert.ok(takeBatch([big, "y".repeat(5000)], 5).join("\n").length <= MAX_POST_CHARS + 1);
  assert.equal(droppedNotice(1), "… 1 line dropped (room rate limit)");
  assert.equal(droppedNotice(25), "… 25 lines dropped (room rate limit)");
});
