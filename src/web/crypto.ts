/**
 * Web gateway crypto helpers (S28, I53). node:crypto only. Secrets (session ids, invite codes, recovery codes) are stored as sha256
 * hashes; passwords as scrypt; TOTP secrets encrypted with AES-256-GCM under a 32-byte key from the web key file.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

export const sha256Hex = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

/** A random token as base64url. 32 bytes = 256 bits (sessions), 20 bytes = 160 bits (invites). */
export const randomToken = (bytes: number): string => randomBytes(bytes).toString("base64url");

/** Domain-separated hash of a secret value, so a hash from one store cannot be replayed in another. */
export const hashSecret = (domain: string, value: string): string => sha256Hex(`a7-web:${domain}:${value}`);

export function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

/** Digest of a message body for the audit log: length and hash, never the text (I54). */
export const bodyDigest = (text: string): { len: number; sha256: string } => ({ len: Buffer.byteLength(text), sha256: sha256Hex(text) });

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password.normalize("NFKC"), salt, keylen, opts, (e, k) => (e ? reject(e) : resolve(k))));
}

export const MIN_PASSWORD_LENGTH = 12;

/** `scrypt$N$r$p$salt$hash` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N > 1 << 20 || N < 2) return false;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const want = Buffer.from(parts[5] ?? "", "base64url");
  if (want.length === 0) return false;
  const got = await scryptAsync(password, salt, want.length, { N, r, p });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** AES-256-GCM with a random 12-byte nonce: `v1.<nonce>.<tag>.<ciphertext>` (base64url). */
export class SecretBox {
  readonly #key: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("the web key must be 32 bytes");
    this.#key = key;
  }
  static generateKey(): Buffer {
    return randomBytes(32);
  }
  seal(plain: string, aad = ""): string {
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.#key, nonce);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", nonce.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
  }
  open(sealed: string, aad = ""): string {
    const [v, n, t, c] = sealed.split(".");
    if (v !== "v1" || !n || !t || c === undefined) throw new Error("bad sealed value");
    const d = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(n, "base64url"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(t, "base64url"));
    return Buffer.concat([d.update(Buffer.from(c, "base64url")), d.final()]).toString("utf8");
  }
}
