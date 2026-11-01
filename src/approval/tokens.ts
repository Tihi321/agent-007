/**
 * One-shot approval tokens (S3.3/S3.4). The gate grants a token after an approval; the shell tool consumes it
 * before it runs. This is defence in depth in case the `beforeTool` hook were ever skipped (footgun 30):
 * with no token the tool refuses to spawn. A token is bound to the call key AND the command hash, is used at most
 * once, and expires. Tokens live in memory only: a restart loses them, and the gate grants again from the
 * persisted decision memo when it reruns.
 */
export interface ApprovalTokens {
  grant(key: string, commandSha256: string): void;
  /** True exactly once per grant, and only for the same key and command hash. */
  consume(key: string, commandSha256: string): boolean;
  size(): number;
}

export interface ApprovalTokenOptions {
  ttlMs?: number;
  maxTokens?: number;
  now?: () => number;
}

export function createApprovalTokens(opts: ApprovalTokenOptions = {}): ApprovalTokens {
  const ttl = opts.ttlMs ?? 15 * 60_000;
  const max = opts.maxTokens ?? 256;
  const now = opts.now ?? Date.now;
  const tokens = new Map<string, { sha: string; expires: number }>();

  const purge = (): void => {
    const t = now();
    for (const [k, v] of tokens) if (v.expires <= t) tokens.delete(k);
    while (tokens.size > max) {
      const oldest = tokens.keys().next();
      if (oldest.done) break;
      tokens.delete(oldest.value);
    }
  };

  return {
    grant(key, commandSha256) {
      purge();
      tokens.set(key, { sha: commandSha256, expires: now() + ttl });
    },
    consume(key, commandSha256) {
      purge();
      const t = tokens.get(key);
      if (!t) return false;
      tokens.delete(key); // one-shot, whether or not the hash matches
      return t.sha === commandSha256;
    },
    size() {
      purge();
      return tokens.size;
    },
  };
}
