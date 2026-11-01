import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkText, sendableChunks, tailText, TELEGRAM_LIMIT } from "../../src/telegram/chunk.js";

test("chunk: empty gives no chunks; short text is one chunk", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("hello"), ["hello"]);
});

test("chunk: the 4096 boundary", () => {
  const exact = "a".repeat(TELEGRAM_LIMIT);
  assert.deepEqual(chunkText(exact), [exact]);
  const over = "a".repeat(TELEGRAM_LIMIT + 1);
  const parts = chunkText(over);
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.length, TELEGRAM_LIMIT);
  assert.equal(parts[1]?.length, 1);
  assert.equal(parts.join(""), over);
  const triple = "b".repeat(TELEGRAM_LIMIT * 2 + 5);
  const p3 = chunkText(triple);
  assert.equal(p3.length, 3);
  assert.equal(p3.join(""), triple);
});

test("chunk: never splits a surrogate pair, loses nothing", () => {
  // the emoji (2 code units) straddles the 4096 boundary
  const text = "a".repeat(TELEGRAM_LIMIT - 1) + "😀" + "b".repeat(10);
  const parts = chunkText(text);
  assert.equal(parts.join(""), text);
  for (const p of parts) {
    assert.ok(p.length <= TELEGRAM_LIMIT, "chunk within the limit");
    const first = p.charCodeAt(0);
    const last = p.charCodeAt(p.length - 1);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "no chunk starts with a lone low surrogate");
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "no chunk ends with a lone high surrogate");
  }
  assert.equal(parts[0]?.length, TELEGRAM_LIMIT - 1);
  // a text made only of astral characters
  const emojis = "😀".repeat(5000);
  const ep = chunkText(emojis);
  assert.equal(ep.join(""), emojis);
  assert.ok(ep.every((p) => p.length <= TELEGRAM_LIMIT && p.length % 2 === 0));
});

test("chunk: prefers a newline, then a space, in the second half of the window", () => {
  const line = "x".repeat(3000);
  const text = `${line}\n${"y".repeat(2000)}`;
  const parts = chunkText(text);
  assert.equal(parts[0], `${line}\n`);
  assert.equal(parts.join(""), text);
  const words = `${"w".repeat(3000)} ${"z".repeat(2000)}`;
  const wp = chunkText(words);
  assert.equal(wp[0], `${"w".repeat(3000)} `);
  assert.equal(wp.join(""), words);
});

test("chunk: small limit works, invalid limit throws, whitespace-only pieces are dropped", () => {
  assert.deepEqual(chunkText("abcdef", 2), ["ab", "cd", "ef"]);
  assert.throws(() => chunkText("x", 1), RangeError);
  assert.deepEqual(sendableChunks("a\n\n\n   \nb", 3).filter((c) => c.trim() === ""), []);
  assert.deepEqual(sendableChunks("   "), []);
});

test("tailText keeps the end, with an ellipsis, and does not cut a surrogate pair", () => {
  assert.equal(tailText("short", 10), "short");
  const t = tailText("a".repeat(100), 10);
  assert.equal(t, `…${"a".repeat(10)}`);
  const emoji = tailText("x" + "😀".repeat(10), 5);
  assert.ok(!/^…[\udc00-\udfff]/.test(emoji));
});
