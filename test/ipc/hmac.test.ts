/** S9.3: HMAC, canonical JSON, key handling. Pure, no sockets. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { IPC_KEY_PATTERN } from "../../src/config/secrets.js";
import { IPC_KEY_TEXT_PATTERN, IpcKey, bodyHash, canonicalJson, computeMac, signingString, verifyMac } from "../../src/ipc/hmac.js";
import type { SignedFields } from "../../src/ipc/hmac.js";
import { KEY_TEXT_A, KEY_TEXT_B } from "./helpers.js";

const fields: SignedFields = { v: 1, id: "id-1", ts: 1_730_000_000_000, nonce: "n".repeat(22), type: "submit", body: { b: 2, a: [1, { y: 1, x: 2 }], s: "x" } };

test("key text is 32 bytes of base64url; the secrets loader and the IPC module accept the same shapes", () => {
  assert.equal(KEY_TEXT_A.length, 43);
  assert.equal(IPC_KEY_TEXT_PATTERN.source, IPC_KEY_PATTERN.source);
  assert.throws(() => IpcKey.fromBase64Url("short"), /at least 32 bytes/);
  assert.throws(() => IpcKey.fromBase64Url("!".repeat(43)), /at least 32 bytes/);
  assert.throws(() => IpcKey.fromBytes(new Uint8Array(31)), /at least 32 bytes/);
  assert.ok(IpcKey.fromBase64Url(KEY_TEXT_A));
  assert.ok(IpcKey.generate());
});

test("the error for a bad key text never echoes it", () => {
  try {
    IpcKey.fromBase64Url("secret-looking-but-short");
    assert.fail("should throw");
  } catch (e) {
    assert.doesNotMatch((e as Error).message, /secret-looking/);
  }
});

test("canonical JSON sorts keys, drops whitespace, and refuses what JSON cannot carry", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, 2], c: null } }), '{"a":{"c":null,"d":[3,2]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ a: undefined }), /undefined/);
  assert.throws(() => canonicalJson({ a: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ a: () => 1 }), /function/);
  let deep: unknown = 1;
  for (let i = 0; i < 40; i++) deep = [deep];
  assert.throws(() => canonicalJson(deep), /too deeply/);
});

test("the MAC covers v|id|ts|nonce|type|sha256(body); the string has exactly those six parts", () => {
  const s = signingString(fields);
  const parts = s.split("|");
  assert.equal(parts.length, 6);
  assert.deepEqual(parts.slice(0, 5), ["1", "id-1", "1730000000000", "n".repeat(22), "submit"]);
  assert.equal(parts[5], bodyHash(fields.body));
  assert.match(parts[5] ?? "", /^[0-9a-f]{64}$/);
});

test("a body with the same content in another key order has the same MAC", () => {
  const key = IpcKey.fromBase64Url(KEY_TEXT_A);
  const reordered: SignedFields = { ...fields, body: { s: "x", a: [1, { x: 2, y: 1 }], b: 2 } };
  assert.equal(computeMac(key, fields), computeMac(key, reordered));
});

test("verify accepts the right MAC and rejects a changed field, key, or malformed MAC", () => {
  const key = IpcKey.fromBase64Url(KEY_TEXT_A);
  const other = IpcKey.fromBase64Url(KEY_TEXT_B);
  const mac = computeMac(key, fields);
  assert.equal(verifyMac(key, fields, mac), true);
  assert.equal(verifyMac(other, fields, mac), false, "another key");
  for (const changed of [{ id: "id-2" }, { ts: fields.ts + 1 }, { nonce: "m".repeat(22) }, { type: "cancel" }, { v: 2 }, { body: { b: 2, a: [1, { y: 1, x: 2 }], s: "y" } }]) {
    assert.equal(verifyMac(key, { ...fields, ...changed } as SignedFields, mac), false, JSON.stringify(Object.keys(changed)));
  }
  assert.equal(verifyMac(key, fields, mac.slice(0, 62)), false, "short");
  assert.equal(verifyMac(key, fields, mac.toUpperCase()), false, "wrong alphabet");
  assert.equal(verifyMac(key, fields, "z".repeat(64)), false);
  assert.equal(verifyMac(key, fields, ""), false);
});

test("comparison is constant time: the source uses timingSafeEqual and never compares MACs with === or !==", () => {
  const src = readFileSync(resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "src", "ipc", "hmac.ts"), "utf8");
  assert.match(src, /timingSafeEqual\(/);
  assert.doesNotMatch(src, /\b(mac|expected|given)\b\s*[!=]==/);
});

test("a key never prints: toString, JSON, inspect and a log-style dump show [IpcKey]", () => {
  const key = IpcKey.fromBase64Url(KEY_TEXT_A);
  const dumps = [String(key), `${key}`, JSON.stringify({ key }), inspect(key, { showHidden: true, depth: 5 }), inspect({ nested: { key } }), JSON.stringify(Object.getOwnPropertyNames(key))];
  for (const d of dumps) {
    assert.doesNotMatch(d, new RegExp(KEY_TEXT_A.slice(0, 12)));
    assert.doesNotMatch(d, /abcdefghijkl/);
  }
  assert.equal(String(key), "[IpcKey]");
  assert.match(key.fingerprint, /^[0-9a-f]{8}$/);
  assert.notEqual(key.fingerprint, IpcKey.fromBase64Url(KEY_TEXT_B).fingerprint);
});
