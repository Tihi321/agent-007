/**
 * Redaction (S1.4). Exact-value redaction of every secret, plus the pattern `bot<digits>:<token>`,
 * because grammY error URLs contain the Telegram bot token.
 */

export type Redactor = (text: string) => string;

const BOT_TOKEN_PATTERN = /bot\d+:[A-Za-z0-9_-]+/g;
const MIN_SECRET_LENGTH = 4;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createRedactor(secrets: Iterable<string | undefined>): Redactor {
  const values = [...new Set([...secrets].filter((s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH))];
  // Longest first, so a secret that contains another one is replaced whole.
  values.sort((a, b) => b.length - a.length);
  const exact = values.length > 0 ? new RegExp(values.map(escapeRegExp).join("|"), "g") : undefined;
  return (text: string) => {
    let out = text;
    if (exact) out = out.replace(exact, "[REDACTED]");
    return out.replace(BOT_TOKEN_PATTERN, "bot[REDACTED]");
  };
}

/** Redacts every string inside a JSON-like value (keys are kept). Returns a copy. */
export function redactDeep<T>(value: T, redact: Redactor): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return redact(v);
    if (depth > 8 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, depth + 1);
    return out;
  };
  return walk(value, 0) as T;
}

/** An Error as log fields, redacted. */
export function errorFields(e: unknown, redact: Redactor): { error: string; stack?: string } {
  if (e instanceof Error) {
    const out: { error: string; stack?: string } = { error: redact(`${e.name}: ${e.message}`) };
    if (e.stack) out.stack = redact(e.stack);
    return out;
  }
  return { error: redact(String(e)) };
}
