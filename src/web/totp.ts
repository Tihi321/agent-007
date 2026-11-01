/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) with node:crypto, plus base32 (RFC 4648). No dependency (I57). */
import { createHmac, randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export const TOTP_PERIOD_S = 30;
export const totpStep = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_PERIOD_S);

/** The code for a time step. `digits` is 6 for apps; the RFC test vectors use 8. */
export function totpAt(secretBase32: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const off = (h[h.length - 1] as number) & 15;
  const bin = (((h[off] as number) & 0x7f) << 24) | (((h[off + 1] as number) & 0xff) << 16) | (((h[off + 2] as number) & 0xff) << 8) | ((h[off + 3] as number) & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/**
 * Accepts a code for the current step or one step either side (clock drift), but only a step LATER than `lastStep` (a code is single
 * use). Returns the accepted step, or undefined.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number, lastStep: number): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const cur = totpStep(nowMs);
  for (const step of [cur - 1, cur, cur + 1]) {
    if (step > lastStep && totpAt(secretBase32, step) === code) return step;
  }
  return undefined;
}

export function otpauthUri(secretBase32: string, account: string, issuer = "agent-007"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
