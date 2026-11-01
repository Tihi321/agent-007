/**
 * The settings audit writer (S17.4, I29, I29a, I29e): one append-only, hash-chained JSONL log, `settings-YYYYMM.jsonl`, shared by the
 * agent (`writer: "agent"`: every `propose_*` decision, Telegram changes, auto-apply, system lines) and the job runner
 * (`writer: "jobrunner"`: UI saves, migration). Each process only ever appends: `openSync(path, "a")` and ONE `writeSync` per
 * line (at most 8 KB, ending in `\n`), so two writers never interleave inside a line (U48b) and neither needs write-data.
 *
 * The caller appends the line BEFORE it replaces a file (I25d); if the append throws, the change is not applied.
 * Values pass through `redact` and `looksSecret` (a secret-shaped value is never written), and a value longer than 2 KB keeps
 * its sha256 and a truncated copy.
 *
 * Pure subset: node:fs and node:crypto only.
 */
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import { GENESIS_HASH, lineHash, sha256Text } from "./chain.js";
import type { AuditEntryInput, AuditLine, AuditWriter, DiffEntry, SettingsAudit } from "./contracts.js";
import { SettingsError } from "./contracts.js";
import { looksSecret } from "./secretShape.js";

export const MAX_LINE_BYTES = 8 * 1024;
export const MAX_VALUE_BYTES = 2 * 1024;
export const SECRET_PLACEHOLDER = "[secret-shaped value omitted]";

export function auditFileName(d: Date): string {
  return `settings-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`;
}

export const AUDIT_FILE_PATTERN = /^settings-\d{6}\.jsonl$/;

export type Redact = (text: string) => string;

export interface SettingsAuditOptions {
  dir: string;
  writer: AuditWriter;
  now?: () => Date;
  redact?: Redact;
  /** Test seam: the one append of a line (default `openSync(path, "a")` + one `writeSync`). */
  appendLine?: (path: string, line: string) => void;
}

export function nodeAppendLine(path: string, line: string): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

/** One value for the log: redacted, secret-shaped values omitted, long values truncated with their hash. */
export function sanitizeValue(v: unknown, redact: Redact): unknown {
  const walk = (x: unknown, depth: number): unknown => {
    if (typeof x === "string") return looksSecret(x) ? SECRET_PLACEHOLDER : redact(x);
    if (depth > 8 || x === null || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map((y) => walk(y, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, y] of Object.entries(x as Record<string, unknown>)) out[k] = walk(y, depth + 1);
    return out;
  };
  const clean = walk(v, 0);
  const text = JSON.stringify(clean) ?? "null";
  if (Buffer.byteLength(text, "utf8") <= MAX_VALUE_BYTES) return clean;
  return { truncated: text.slice(0, 200), sha256: sha256Text(text), bytes: Buffer.byteLength(text, "utf8") };
}

function sanitizeDiff(diff: DiffEntry[], redact: Redact): DiffEntry[] {
  return diff.map((d) => {
    const out: DiffEntry = { path: d.path, op: d.op };
    if ("before" in d) out.before = sanitizeValue(d.before, redact);
    if ("after" in d) out.after = sanitizeValue(d.after, redact);
    return out;
  });
}

export interface SettingsAuditWriter extends SettingsAudit {
  readonly dir: string;
  readonly writer: AuditWriter;
  fileFor(d?: Date): string;
}

interface ChainState {
  wseq: number;
  h: string;
}

/** Last chain state of `writer` in a file's text (its next line continues from here). */
function stateFromText(text: string, writer: AuditWriter): ChainState {
  let state: ChainState = { wseq: 0, h: GENESIS_HASH };
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const l = JSON.parse(raw) as { writer?: string; wseq?: number; h?: string };
      if (l.writer === writer && typeof l.wseq === "number" && typeof l.h === "string") state = { wseq: l.wseq, h: l.h };
    } catch {
      /* a broken line is the verifier's finding, not the writer's */
    }
  }
  return state;
}

export function createSettingsAudit(opts: SettingsAuditOptions): SettingsAuditWriter {
  const now = opts.now ?? (() => new Date());
  const redact = opts.redact ?? ((s: string) => s);
  const appendLine = opts.appendLine ?? nodeAppendLine;
  const states = new Map<string, ChainState>();

  const fileFor = (d: Date = now()): string => join(opts.dir, auditFileName(d));

  function stateOf(path: string): ChainState {
    const known = states.get(path);
    if (known) return known;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const s = stateFromText(text, opts.writer);
    states.set(path, s);
    return s;
  }

  return {
    dir: opts.dir,
    writer: opts.writer,
    fileFor,
    append(entry: AuditEntryInput): AuditLine {
      try {
        const at = now();
        mkdirSync(opts.dir, { recursive: true });
        const path = fileFor(at);
        const st = stateOf(path);
        const build = (diff: DiffEntry[]): AuditLine => {
          const body = {
            v: 1 as const,
            ts: at.toISOString(),
            writer: opts.writer,
            wseq: st.wseq + 1,
            prev: st.h,
            ...entry,
            target: { file: entry.target.file, path: String(sanitizeValue(entry.target.path.slice(0, 200), redact)) },
            diff,
            ...(entry.note !== undefined ? { note: redact(entry.note).slice(0, 200) } : {}),
          };
          return { ...body, h: lineHash(st.h, body) } as AuditLine;
        };
        let line = build(sanitizeDiff(entry.diff, redact));
        let text = JSON.stringify(line);
        if (Buffer.byteLength(text, "utf8") + 1 > MAX_LINE_BYTES) {
          // Too big for one safe write: keep only the paths and hashes of the values.
          const slim: DiffEntry[] = entry.diff.map((d) => ({
            path: d.path,
            op: d.op,
            before: { sha256: sha256Text(JSON.stringify(d.before ?? null)) },
            after: { sha256: sha256Text(JSON.stringify(d.after ?? null)) },
          }));
          line = build(slim);
          text = JSON.stringify(line);
        }
        appendLine(path, `${text}\n`);
        states.set(path, { wseq: line.wseq, h: line.h });
        return line;
      } catch (e) {
        if (e instanceof SettingsError) throw e;
        throw new SettingsError("audit_failed", `the settings audit log could not be written (${(e as NodeJS.ErrnoException).code ?? "error"}); nothing was changed`);
      }
    },
  };
}

// ---- reading (read-only helpers) --------------------------------------------------------------------------------

export function auditFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => AUDIT_FILE_PATTERN.test(n))
      .sort()
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/** The newest `limit` lines of the log, oldest first. Lines that are not JSON are skipped. */
export function readAuditTail(dir: string, limit = 50): AuditLine[] {
  const out: AuditLine[] = [];
  const files = auditFiles(dir).reverse();
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const lines: AuditLine[] = [];
    for (const raw of text.split("\n")) {
      if (raw.trim() === "") continue;
      try {
        lines.push(JSON.parse(raw) as AuditLine);
      } catch {
        /* skip */
      }
    }
    out.unshift(...lines);
    if (out.length >= limit) break;
  }
  return out.slice(-limit);
}

/** The `afterRevision` of the newest line per `target.file` (I29b: out-of-band edit detection reads this at start). */
export function lastRevisions(dir: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const f of auditFiles(dir)) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split("\n")) {
      if (raw.trim() === "") continue;
      try {
        const l = JSON.parse(raw) as Partial<AuditLine>;
        if (l.target && typeof l.target.file === "string" && typeof l.afterRevision === "string") map[l.target.file] = l.afterRevision;
      } catch {
        /* skip */
      }
    }
  }
  return map;
}
