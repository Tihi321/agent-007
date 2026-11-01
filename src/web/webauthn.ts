/**
 * WebAuthn (passkeys) verifier with node:crypto only (S31, UI-34, I57: no added dependency). Scope is deliberately narrow:
 *   - algorithm ES256 (COSE -7, P-256) only; attestation "none" only (we want the key, not a statement about the device);
 *   - user verification is REQUIRED on both ceremonies (flags UP and UV set);
 *   - the RP ID is the host the request came to (the ts.net name, or `localhost` on the PC); the origin must match exactly;
 *   - challenges are 32 random bytes, single use, 5 minutes;
 *   - a signature counter that does not increase (when either side is non-zero) is refused as a possible clone.
 * Recorded as a deviation: this replaces `@simplewebauthn/server` (UI-34). It is the most security-sensitive hand-written code of the
 * milestone and is listed for the S36 review.
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";

// ---- minimal CBOR (RFC 8949): unsigned/negative ints, bytes, text, arrays, maps, simple values ----------------------------------

export type Cbor = number | bigint | Buffer | string | Cbor[] | Map<Cbor, Cbor> | boolean | null | undefined;

export function cborDecode(buf: Buffer, offset = 0, depth = 0): { value: Cbor; end: number } {
  if (depth > 8) throw new Error("cbor too deep");
  const first = buf[offset];
  if (first === undefined) throw new Error("cbor truncated");
  const major = first >> 5;
  const info = first & 31;
  let p = offset + 1;
  let arg: number | bigint;
  if (info < 24) arg = info;
  else if (info === 24) {
    arg = buf[p] ?? NaN;
    p += 1;
  } else if (info === 25) {
    arg = buf.readUInt16BE(p);
    p += 2;
  } else if (info === 26) {
    arg = buf.readUInt32BE(p);
    p += 4;
  } else if (info === 27) {
    arg = buf.readBigUInt64BE(p);
    p += 8;
  } else throw new Error("cbor: indefinite lengths are not supported");
  if (typeof arg === "number" && Number.isNaN(arg)) throw new Error("cbor truncated");
  const n = typeof arg === "bigint" ? Number(arg) : arg;
  switch (major) {
    case 0:
      return { value: arg, end: p };
    case 1:
      return { value: typeof arg === "bigint" ? -1n - arg : -1 - arg, end: p };
    case 2:
    case 3: {
      if (p + n > buf.length) throw new Error("cbor truncated");
      const b = buf.subarray(p, p + n);
      return { value: major === 2 ? Buffer.from(b) : b.toString("utf8"), end: p + n };
    }
    case 4: {
      if (n > 1000) throw new Error("cbor array too long");
      const arr: Cbor[] = [];
      for (let i = 0; i < n; i++) {
        const r = cborDecode(buf, p, depth + 1);
        arr.push(r.value);
        p = r.end;
      }
      return { value: arr, end: p };
    }
    case 5: {
      if (n > 1000) throw new Error("cbor map too long");
      const m = new Map<Cbor, Cbor>();
      for (let i = 0; i < n; i++) {
        const k = cborDecode(buf, p, depth + 1);
        const v = cborDecode(buf, k.end, depth + 1);
        m.set(k.value, v.value);
        p = v.end;
      }
      return { value: m, end: p };
    }
    case 7:
      if (info === 20) return { value: false, end: p };
      if (info === 21) return { value: true, end: p };
      if (info === 22) return { value: null, end: p };
      if (info === 23) return { value: undefined, end: p };
      throw new Error("cbor: unsupported simple value");
    default:
      throw new Error("cbor: unsupported type");
  }
}

// ---- ceremonies --------------------------------------------------------------------------------------------------------------

export class WebAuthnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAuthnError";
  }
}

const sha256 = (b: Buffer | string): Buffer => createHash("sha256").update(b).digest();
const b64u = (b: Buffer): string => b.toString("base64url");
const fromB64u = (s: unknown, what: string): Buffer => {
  if (typeof s !== "string" || s.length > 20_000 || !/^[A-Za-z0-9_-]*$/.test(s)) throw new WebAuthnError(`${what} is not base64url`);
  return Buffer.from(s, "base64url");
};

interface PendingChallenge {
  kind: "create" | "get";
  rpId: string;
  origin: string;
  userId?: string;
  expiresAt: number;
}

/** Single-use challenges in memory (a restart drops them; the user just starts again). */
export class ChallengeStore {
  readonly #m = new Map<string, PendingChallenge>();
  readonly #now: () => number;
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }
  issue(p: Omit<PendingChallenge, "expiresAt">): string {
    const now = this.#now();
    for (const [k, v] of this.#m) if (v.expiresAt < now) this.#m.delete(k);
    if (this.#m.size > 1000) throw new WebAuthnError("too many pending challenges");
    const c = b64u(randomBytes(32));
    this.#m.set(c, { ...p, expiresAt: now + 5 * 60_000 });
    return c;
  }
  /** Removes and returns the challenge (single use), or undefined when unknown or expired. */
  take(challenge: string): PendingChallenge | undefined {
    const p = this.#m.get(challenge);
    this.#m.delete(challenge);
    return p && p.expiresAt >= this.#now() ? p : undefined;
  }
}

export interface CreationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: -7 }[];
  authenticatorSelection: { userVerification: "required"; residentKey: "preferred" };
  attestation: "none";
  timeout: number;
  excludeCredentials: { type: "public-key"; id: string }[];
}

export function creationOptions(store: ChallengeStore, a: { rpId: string; origin: string; userId: string; login: string; displayName: string; existing: string[] }): CreationOptions {
  const challenge = store.issue({ kind: "create", rpId: a.rpId, origin: a.origin, userId: a.userId });
  return {
    challenge,
    rp: { id: a.rpId, name: "agent-007" },
    user: { id: b64u(Buffer.from(a.userId, "hex")), name: a.login, displayName: a.displayName },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
    attestation: "none",
    timeout: 120_000,
    excludeCredentials: a.existing.map((id) => ({ type: "public-key" as const, id })),
  };
}

export interface RequestOptions {
  challenge: string;
  rpId: string;
  userVerification: "required";
  timeout: number;
  allowCredentials: { type: "public-key"; id: string }[];
}

export function requestOptions(store: ChallengeStore, a: { rpId: string; origin: string; userId?: string; credentialIds: string[] }): RequestOptions {
  const challenge = store.issue({ kind: "get", rpId: a.rpId, origin: a.origin, ...(a.userId ? { userId: a.userId } : {}) });
  return { challenge, rpId: a.rpId, userVerification: "required", timeout: 120_000, allowCredentials: a.credentialIds.map((id) => ({ type: "public-key" as const, id })) };
}

function checkClientData(raw: Buffer, type: "webauthn.create" | "webauthn.get", store: ChallengeStore): PendingChallenge {
  let cd: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    cd = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new WebAuthnError("clientDataJSON is not JSON");
  }
  if (cd.type !== type) throw new WebAuthnError("wrong ceremony type");
  if (cd.crossOrigin === true) throw new WebAuthnError("cross-origin ceremony");
  if (typeof cd.challenge !== "string") throw new WebAuthnError("no challenge");
  const p = store.take(cd.challenge);
  if (!p || p.kind !== (type === "webauthn.create" ? "create" : "get")) throw new WebAuthnError("unknown or expired challenge");
  if (cd.origin !== p.origin) throw new WebAuthnError("origin mismatch");
  return p;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function checkAuthData(authData: Buffer, rpId: string): { flags: number; signCount: number } {
  if (authData.length < 37) throw new WebAuthnError("authenticator data too short");
  if (!authData.subarray(0, 32).equals(sha256(rpId))) throw new WebAuthnError("rpId hash mismatch");
  const flags = authData[32] as number;
  if (!(flags & FLAG_UP)) throw new WebAuthnError("user presence missing");
  if (!(flags & FLAG_UV)) throw new WebAuthnError("user verification missing");
  return { flags, signCount: authData.readUInt32BE(33) };
}

export interface NewPasskey {
  id: string;
  /** SPKI DER, base64url. */
  publicKey: string;
  signCount: number;
  userId: string;
}

export function finishRegistration(store: ChallengeStore, resp: { id?: unknown; clientDataJSON?: unknown; attestationObject?: unknown }): NewPasskey {
  const clientData = fromB64u(resp.clientDataJSON, "clientDataJSON");
  const pending = checkClientData(clientData, "webauthn.create", store);
  if (!pending.userId) throw new WebAuthnError("registration is not bound to a user");
  let att: Cbor;
  try {
    att = cborDecode(fromB64u(resp.attestationObject, "attestationObject")).value;
  } catch (e) {
    throw new WebAuthnError(e instanceof WebAuthnError ? e.message : "attestationObject is not CBOR");
  }
  if (!(att instanceof Map) || att.get("fmt") !== "none") throw new WebAuthnError("only attestation none is accepted");
  const authData = att.get("authData");
  if (!Buffer.isBuffer(authData)) throw new WebAuthnError("no authData");
  const { flags, signCount } = checkAuthData(authData, pending.rpId);
  if (!(flags & FLAG_AT)) throw new WebAuthnError("no credential data");
  const idLen = authData.readUInt16BE(53);
  if (idLen < 16 || idLen > 1023 || authData.length < 55 + idLen) throw new WebAuthnError("bad credential id length");
  const credId = authData.subarray(55, 55 + idLen);
  let cose: Cbor;
  try {
    cose = cborDecode(authData, 55 + idLen).value;
  } catch {
    throw new WebAuthnError("bad public key");
  }
  if (!(cose instanceof Map) || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) throw new WebAuthnError("only ES256 P-256 keys are accepted");
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new WebAuthnError("bad key coordinates");
  let spki: Buffer;
  try {
    spki = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(x), y: b64u(y) }, format: "jwk" }).export({ type: "spki", format: "der" }) as Buffer;
  } catch {
    throw new WebAuthnError("the key is not on the curve");
  }
  if (typeof resp.id === "string" && resp.id !== b64u(credId)) throw new WebAuthnError("credential id mismatch");
  return { id: b64u(credId), publicKey: b64u(spki), signCount, userId: pending.userId };
}

export interface StoredPasskey {
  id: string;
  publicKey: string;
  signCount: number;
}

export function finishAuthentication(
  store: ChallengeStore,
  resp: { id?: unknown; clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown },
  find: (credentialId: string) => StoredPasskey | undefined,
): { credentialId: string; signCount: number; userId?: string } {
  const clientData = fromB64u(resp.clientDataJSON, "clientDataJSON");
  const pending = checkClientData(clientData, "webauthn.get", store);
  const authData = fromB64u(resp.authenticatorData, "authenticatorData");
  const sig = fromB64u(resp.signature, "signature");
  if (typeof resp.id !== "string") throw new WebAuthnError("no credential id");
  const key = find(resp.id);
  if (!key) throw new WebAuthnError("unknown credential");
  const { signCount } = checkAuthData(authData, pending.rpId);
  const pub = createPublicKey({ key: Buffer.from(key.publicKey, "base64url"), format: "der", type: "spki" });
  const ok = cryptoVerify("sha256", Buffer.concat([authData, sha256(clientData)]), pub, sig);
  if (!ok) throw new WebAuthnError("bad signature");
  if ((signCount !== 0 || key.signCount !== 0) && signCount <= key.signCount) throw new WebAuthnError("signature counter did not increase (possible clone)");
  return { credentialId: resp.id, signCount, ...(pending.userId ? { userId: pending.userId } : {}) };
}
