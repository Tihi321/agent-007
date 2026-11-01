/**
 * HMAC-SHA256 for the agent <-> job runner IPC (I16, S9.3). Nothing here touches the network.
 *
 * - The MAC is HMAC-SHA256 over `v|id|ts|nonce|type|sha256(body)`, where `sha256(body)` is the hex digest of the
 *   canonical JSON of the body (sorted keys, no whitespace), so the MAC does not depend on key order or spacing.
 * - Comparison is constant time (`timingSafeEqual`).
 * - A key is an `IpcKey`: the 32 or more bytes live in a module-private WeakMap, and `toString`, `toJSON` and
 *   `util.inspect` print `[IpcKey]`, so a key that reaches a log call by mistake is not printed. The key text itself is
 *   also registered with the redactor (`secretValues` in src/config/secrets.ts).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";
import type { Json } from "../jobs/contracts.js";

export const MIN_KEY_BYTES = 32;
/** The key text in the secrets files: base64url without padding, 32 bytes = 43 characters or more. */
export const IPC_KEY_TEXT_PATTERN = /^[A-Za-z0-9_-]{43,}$/;

const KEY_BYTES = new WeakMap<IpcKey, Buffer>();

export class IpcKey {
  private constructor() {}

  /** From raw bytes (at least 32). */
  static fromBytes(bytes: Uint8Array): IpcKey {
    if (bytes.length < MIN_KEY_BYTES) throw new Error(`IPC key must be at least ${MIN_KEY_BYTES} bytes`);
    const key = new IpcKey();
    KEY_BYTES.set(key, Buffer.from(bytes));
    return key;
  }

  /** From the text in `secrets.json` (`ipcHmacKey`). The error never echoes the text. */
  static fromBase64Url(text: string): IpcKey {
    if (!IPC_KEY_TEXT_PATTERN.test(text)) throw new Error("IPC key must be a base64url string of at least 32 bytes (43 characters)");
    return IpcKey.fromBytes(Buffer.from(text, "base64url"));
  }

  static generate(): IpcKey {
    return IpcKey.fromBytes(randomBytes(MIN_KEY_BYTES));
  }

  /** The first 8 hex characters of SHA-256 of the key: enough to tell two keys apart in a log, useless as a secret. */
  get fingerprint(): string {
    return createHash("sha256").update(keyBytes(this)).digest("hex").slice(0, 8);
  }

  toString(): string {
    return "[IpcKey]";
  }
  toJSON(): string {
    return "[IpcKey]";
  }
  [inspect.custom](): string {
    return "[IpcKey]";
  }
}

function keyBytes(key: IpcKey): Buffer {
  const b = KEY_BYTES.get(key);
  if (!b) throw new Error("not an IpcKey");
  return b;
}

/** A key plus the name the receiver learns when a message verifies against it (`main`, or `job:<id>` for I28). */
export interface KeyCandidate {
  key: IpcKey;
  principal: string;
}

// ---- canonical JSON ------------------------------------------------------------------------------

const MAX_DEPTH = 32;

/** Sorted keys, no whitespace. Throws on `undefined`, functions, non-finite numbers and nesting beyond 32. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new Error("body is nested too deeply");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("body contains a non-finite number");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v, depth + 1)).join(",") + "]";
      const o = value as Record<string, unknown>;
      const keys = Object.keys(o).sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k], depth + 1)).join(",") + "}";
    }
    default:
      throw new Error(`body contains a ${typeof value} value`);
  }
}

export function bodyHash(body: Json): string {
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

// ---- the MAC -------------------------------------------------------------------------------------

export interface SignedFields {
  v: number;
  id: string;
  ts: number;
  nonce: string;
  type: string;
  body: Json;
}

/** The exact string the MAC covers: `v|id|ts|nonce|type|sha256(body)`. */
export function signingString(f: SignedFields): string {
  return [f.v, f.id, f.ts, f.nonce, f.type, bodyHash(f.body)].join("|");
}

export function computeMac(key: IpcKey, fields: SignedFields): string {
  return createHmac("sha256", keyBytes(key)).update(signingString(fields), "utf8").digest("hex");
}

/** Constant-time check of a hex MAC. A MAC of the wrong length or alphabet is simply false. */
export function verifyMac(key: IpcKey, fields: SignedFields, mac: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(mac)) return false;
  const expected = Buffer.from(computeMac(key, fields), "hex");
  const given = Buffer.from(mac, "hex");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** 16 random bytes, base64url: ids and nonces. */
export function randomToken(): string {
  return randomBytes(16).toString("base64url");
}
