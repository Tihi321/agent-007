/**
 * `verify-audit` (S17.4, I29a): READ-ONLY check of the settings audit log's hash chains.
 *
 *   node dist/scripts/settings/verify-audit.js <audit folder | one settings-YYYYMM.jsonl file>
 *
 * Walks every writer's chain in every file and prints gaps (a line missing, repeated or reordered) and edits (a hash that no
 * longer matches). Exit 0 = every chain is intact, exit 1 = a break, exit 2 = bad usage. It detects an edit or a deletion in the
 * middle; it cannot see the removal of the LAST lines of a chain (a trim candidate, plan section 11).
 */
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditFiles } from "../../src/settings/audit.js";
import { verifyAuditText } from "../../src/settings/chain.js";

export interface VerifyResult {
  exitCode: 0 | 1 | 2;
  lines: string[];
}

export function verifyPath(target: string): VerifyResult {
  const out: string[] = [];
  let files: string[];
  try {
    files = statSync(target).isDirectory() ? auditFiles(target) : [target];
  } catch {
    return { exitCode: 2, lines: [`cannot read ${target}`] };
  }
  if (files.length === 0) return { exitCode: 0, lines: [`no settings-*.jsonl files in ${target}`] };
  let ok = true;
  for (const f of files) {
    const r = verifyAuditText(readFileSync(f, "utf8"), basename(f));
    const writers = Object.entries(r.writers)
      .map(([w, s]) => `${w}: ${s.lines} lines`)
      .join(", ");
    out.push(`${basename(f)}: ${r.lines} lines (${writers || "no lines"}) ${r.ok ? "OK" : "BROKEN"}`);
    for (const p of r.problems) out.push(`  - ${p}`);
    if (!r.ok) ok = false;
  }
  return { exitCode: ok ? 0 : 1, lines: out };
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write("usage: verify-audit <audit folder | settings-YYYYMM.jsonl>\n");
    process.exit(2);
  }
  const r = verifyPath(resolve(target));
  for (const l of r.lines) process.stdout.write(`${l}\n`);
  process.exit(r.exitCode);
}
