/**
 * Hash chain of the settings audit log (I29a). Each line carries `writer`, a per-writer `wseq`, `prev` (the hash of that
 * writer's previous line in the same file; 64 zeros for the first) and `h = sha256(prev + "\n" + canonical JSON of the line
 * without h)`. `verifyAuditText` checks every writer's chain independently and reports gaps and edits. It detects an edit or
 * a deletion in the middle; it cannot see the removal of the LAST lines (a trim candidate, section 11).
 *
 * Pure: node:crypto only.
 */
import { createHash } from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

/** JSON with sorted keys and no `undefined` values: the same text on every machine. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The hash of a line: `line` without its own `h`. */
export function lineHash(prev: string, line: Record<string, unknown>): string {
  const { h: _h, ...rest } = line;
  void _h;
  return sha256Text(`${prev}\n${canonicalJson(rest)}`);
}

export interface ChainReport {
  ok: boolean;
  lines: number;
  problems: string[];
  writers: Record<string, { lines: number; lastWseq: number }>;
}

/** Walks one audit file's text. A blank line is ignored; a line that is not JSON is a problem. */
export function verifyAuditText(text: string, label = "audit"): ChainReport {
  const problems: string[] = [];
  const writers: Record<string, { lines: number; lastWseq: number; lastH: string }> = {};
  let n = 0;
  const rows = text.split("\n");
  rows.forEach((raw, idx) => {
    if (raw.trim() === "") return;
    n++;
    const at = `${label} line ${idx + 1}`;
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      problems.push(`${at}: not valid JSON`);
      return;
    }
    const writer = typeof line["writer"] === "string" ? line["writer"] : "";
    if (writer === "" || typeof line["wseq"] !== "number" || typeof line["prev"] !== "string" || typeof line["h"] !== "string") {
      problems.push(`${at}: missing writer, wseq, prev or h`);
      return;
    }
    const w = (writers[writer] ??= { lines: 0, lastWseq: 0, lastH: GENESIS_HASH });
    if (line["wseq"] !== w.lastWseq + 1) problems.push(`${at}: writer ${writer} wseq ${String(line["wseq"])} follows ${w.lastWseq} (a line is missing, repeated or reordered)`);
    if (line["prev"] !== w.lastH) problems.push(`${at}: writer ${writer} prev does not match the previous line's hash`);
    if (lineHash(line["prev"], line) !== line["h"]) problems.push(`${at}: writer ${writer} hash mismatch (the line was edited)`);
    w.lines++;
    w.lastWseq = line["wseq"];
    w.lastH = line["h"];
  });
  const out: ChainReport["writers"] = {};
  for (const [k, v] of Object.entries(writers)) out[k] = { lines: v.lines, lastWseq: v.lastWseq };
  return { ok: problems.length === 0, lines: n, problems, writers: out };
}
