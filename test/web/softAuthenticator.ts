/** A software WebAuthn authenticator for tests: ES256 keys, attestation "none". Not a test file. */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

const sha = (b: Buffer | string): Buffer => createHash("sha256").update(b).digest();

type C = number | Buffer | string | Map<C, C> | C[];

export function cborEncode(v: C): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cborEncode)]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cborEncode(k), cborEncode(x)])]);
}

export interface Tweaks {
  /** authData flags (default UP|UV|AT = 0x45 on create, 0x05 on get). */
  flags?: number;
  rpId?: string;
  origin?: string;
  fmt?: string;
  counter?: number;
  alg?: number;
  type?: string;
  crossOrigin?: boolean;
  badSignature?: boolean;
}

export class SoftAuthenticator {
  readonly credId = randomBytes(32);
  readonly #priv: KeyObject;
  readonly #x: Buffer;
  readonly #y: Buffer;
  counter = 0;

  constructor() {
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#priv = kp.privateKey;
    const jwk = kp.publicKey.export({ format: "jwk" });
    this.#x = Buffer.from(jwk.x as string, "base64url");
    this.#y = Buffer.from(jwk.y as string, "base64url");
  }

  get id(): string {
    return this.credId.toString("base64url");
  }

  #clientData(type: string, challenge: string, origin: string, crossOrigin?: boolean): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, ...(crossOrigin !== undefined ? { crossOrigin } : {}) }));
  }

  create(o: { challenge: string; rpId: string; origin: string }, t: Tweaks = {}): { id: string; clientDataJSON: string; attestationObject: string } {
    const cose = new Map<C, C>([[1, 2], [3, t.alg ?? -7], [-1, 1], [-2, this.#x], [-3, this.#y]]);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credId.length);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(t.counter ?? 0);
    const authData = Buffer.concat([sha(t.rpId ?? o.rpId), Buffer.from([t.flags ?? 0x45]), counter, Buffer.alloc(16), idLen, this.credId, cborEncode(cose)]);
    const att = new Map<C, C>([["fmt", t.fmt ?? "none"], ["attStmt", new Map()], ["authData", authData]]);
    return {
      id: this.id,
      clientDataJSON: this.#clientData(t.type ?? "webauthn.create", o.challenge, t.origin ?? o.origin, t.crossOrigin).toString("base64url"),
      attestationObject: cborEncode(att).toString("base64url"),
    };
  }

  get(o: { challenge: string; rpId: string; origin: string }, t: Tweaks = {}): { id: string; clientDataJSON: string; authenticatorData: string; signature: string } {
    this.counter = t.counter ?? this.counter + 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha(t.rpId ?? o.rpId), Buffer.from([t.flags ?? 0x05]), counter]);
    const cd = this.#clientData(t.type ?? "webauthn.get", o.challenge, t.origin ?? o.origin, t.crossOrigin);
    const data = Buffer.concat([authData, sha(cd)]);
    const sig = sign("sha256", t.badSignature ? Buffer.concat([data, Buffer.from("x")]) : data, this.#priv);
    return { id: this.id, clientDataJSON: cd.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: sig.toString("base64url") };
  }
}
