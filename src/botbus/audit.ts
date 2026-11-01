/**
 * The bus audit log (S21.5, I45): append-only, hash-chained JSONL `bus-YYYYMM.jsonl` in its OWN folder (the settings audit is not
 * touched; only its chain helpers are imported). One line per bus message with `{ts, chain_id, from, to, hop, origin, taint,
 * body_sha256, decision, reason}` and NO body. Model switches, fallbacks and breaker trips are `type: "note"` lines in the same file.
 *
 * Appending only: `openSync(path, "a")` and ONE `writeSync` per line (the U48 pattern); there is no API that rewrites a line.
 * A write failure throws, and the bus then refuses the message (fail closed). Any `reason` or note text that looks like a secret is
 * replaced; text passes `redact` first.
 */
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { GENESIS_HASH, lineHash } from "../settings/chain.js";
import { looksSecret } from "../settings/secretShape.js";
import type { BusEvent, BusNote } from "./contracts.js";

export const BUS_AUDIT_WRITER = "bus";
export const BUS_AUDIT_FILE_PATTERN = /^bus-\d{6}\.jsonl$/;
export const MAX_AUDIT_LINE_BYTES = 8 * 1024;
const OMITTED = "[secret-shaped text omitted]";

export const busAuditFileName = (d: Date): string => `bus-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`;

/** What the bus writes to; `BusAudit` is the file implementation, tests may pass a memory one. */
export interface BusAuditSink {
  record(event: BusEvent): void;
  note(note: BusNote, ts: string): void;
}

export interface BusAuditOptions {
  dir: string;
  now?: () => Date;
  redact?: (text: string) => string;
  /** Test seam: the one append of a line. */
  appendLine?: (path: string, line: string) => void;
}

function nodeAppend(path: string, line: string): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

export class BusAudit implements BusAuditSink {
  private readonly now: () => Date;
  private readonly redact: (t: string) => string;
  private readonly append: (path: string, line: string) => void;
  private readonly states = new Map<string, { wseq: number; h: string }>();
  constructor(private readonly o: BusAuditOptions) {
    this.now = o.now ?? (() => new Date());
    this.redact = o.redact ?? ((s) => s);
    this.append = o.appendLine ?? nodeAppend;
  }

  fileFor(d: Date = this.now()): string {
    return join(this.o.dir, busAuditFileName(d));
  }

  private clean(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;
    const t = this.redact(text).slice(0, 200);
    return looksSecret(t) ? OMITTED : t;
  }

  private state(path: string): { wseq: number; h: string } {
    const known = this.states.get(path);
    if (known) return known;
    let s = { wseq: 0, h: GENESIS_HASH };
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const raw of text.split("\n")) {
      if (raw.trim() === "") continue;
      try {
        const l = JSON.parse(raw) as { wseq?: number; h?: string };
        if (typeof l.wseq === "number" && typeof l.h === "string") s = { wseq: l.wseq, h: l.h };
      } catch {
        /* a broken line is the verifier's finding */
      }
    }
    this.states.set(path, s);
    return s;
  }

  private write(at: Date, fields: Record<string, unknown>): void {
    mkdirSync(this.o.dir, { recursive: true });
    const path = this.fileFor(at);
    const st = this.state(path);
    const body: Record<string, unknown> = { v: 1, ts: at.toISOString(), writer: BUS_AUDIT_WRITER, wseq: st.wseq + 1, prev: st.h, ...fields };
    const h = lineHash(st.h, body);
    const text = JSON.stringify({ ...body, h });
    if (Buffer.byteLength(text, "utf8") + 1 > MAX_AUDIT_LINE_BYTES) throw new Error("audit line too large");
    this.append(path, `${text}\n`);
    this.states.set(path, { wseq: st.wseq + 1, h });
  }

  record(e: BusEvent): void {
    const reason = this.clean(e.reason);
    this.write(new Date(e.ts), {
      type: e.type,
      chain_id: e.chainId,
      from: e.from,
      to: e.to,
      hop: e.hop,
      origin: e.origin,
      taint: e.taint,
      body_sha256: e.bodySha256,
      decision: e.decision,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  note(n: BusNote, ts: string): void {
    this.write(new Date(ts), { type: "note", event: n.event, bot: n.bot, detail: this.clean(n.detail) ?? "" });
  }
}
