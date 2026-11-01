/**
 * "Does this text look like a secret?" (pure, no imports). The same patterns as the `remember` tool (S2.5): a long base64 or hex
 * run, a Telegram bot token, an `sk-` key, a password word, a PEM header, GitHub, Slack and AWS key shapes, a JWT.
 * Used by the settings proposals (a secret-shaped value is refused before any card), the audit writer (a secret-shaped value is
 * never written to the log) and the migration (a secret-looking value in the old config is refused, naming the key only).
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /[A-Za-z0-9+/_-]{32,}={0,2}/,
  /\b[0-9a-fA-F]{24,}\b/,
  /bot\d+:/i,
  /\bsk-[A-Za-z0-9]/i,
  /pass(?:word|wd|phrase)/i,
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{10,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
];

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** Key paths (dotted) of every string in `value` that looks like a secret. Values are never returned. */
export function secretShapedKeys(value: unknown, prefix = ""): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string, depth: number): void => {
    if (depth > 12) return;
    if (typeof v === "string") {
      if (looksSecret(v)) out.push(at || "(root)");
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`, depth + 1));
    else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) walk(x, at === "" ? k : `${at}.${k}`, depth + 1);
  };
  walk(value, prefix, 0);
  return out;
}
