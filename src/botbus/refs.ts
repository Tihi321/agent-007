/**
 * `attach_refs` (S21.2, I36(5)): the router, not the bot, resolves a workspace reference of the SENDER and inlines its text, so
 * the receiver never sees a path and never reads the sender's folders. A ref is `workspace:<relative path>`; anything else (an
 * absolute path, a drive, a UNC path, `..`, a stream name, a NUL) is refused. To a cloud-capable receiver an attachment is
 * allowed only over an egress edge, and then only from the sender's cloud-safe roots (the reader enforces that with `cloudSafe`).
 *
 * Pure but for the injected reader (the host reads through the bot's own workspace policy).
 */
import { BusError, MAX_ATTACH_BYTES } from "./contracts.js";
import type { Attachment } from "./contracts.js";

export interface RefReadResult {
  text: string;
  truncated: boolean;
}

export interface RefReader {
  /** Reads `relPath` in the workspace of `bot` (text, at most `maxBytes`). Throws when it is missing or outside the policy. */
  readWorkspaceFile(bot: string, relPath: string, opts: { maxBytes: number; cloudSafe: boolean }): Promise<RefReadResult>;
}

export const WORKSPACE_PREFIX = "workspace:";

/** The relative path of a ref, or a `refused` error with the reason `bad_ref`. */
export function parseRef(ref: string): string {
  if (!ref.startsWith(WORKSPACE_PREFIX)) throw new BusError("refused", "bad_ref");
  const rel = ref.slice(WORKSPACE_PREFIX.length).trim();
  if (rel === "" || rel.includes("\0") || rel.includes(":") || rel.startsWith("/") || rel.startsWith("\\")) throw new BusError("refused", "bad_ref");
  const parts = rel.split(/[\\/]+/);
  if (parts.some((p) => p === ".." || p === "." || p === "")) throw new BusError("refused", "bad_ref");
  return parts.join("/");
}

export interface ResolveOptions {
  sender: string;
  receiverCloud: boolean;
  edgeEgress: boolean;
}

export async function resolveRefs(refs: readonly string[], reader: RefReader | undefined, o: ResolveOptions): Promise<Attachment[]> {
  if (refs.length === 0) return [];
  const rels = refs.map(parseRef);
  if (o.receiverCloud && !o.edgeEgress) throw new BusError("refused", "needs_egress_edge");
  if (!reader) throw new BusError("refused", "no_workspace_reader");
  const out: Attachment[] = [];
  for (const rel of rels) {
    try {
      const r = await reader.readWorkspaceFile(o.sender, rel, { maxBytes: MAX_ATTACH_BYTES, cloudSafe: o.receiverCloud });
      out.push({ name: `${WORKSPACE_PREFIX}${rel}`, text: r.text.slice(0, MAX_ATTACH_BYTES), truncated: r.truncated || r.text.length > MAX_ATTACH_BYTES });
    } catch {
      // the reason never carries a path or the reader's message
      throw new BusError("refused", "unreadable_ref");
    }
  }
  return out;
}
