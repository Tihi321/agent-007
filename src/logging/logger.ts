/**
 * JSONL logger (S1.4): `logs\agent-YYYY-MM-DD.jsonl`, 14 days kept. Message text is logged only at `debug`
 * (off by default): fields named `text`, `content` or `message` are dropped at other levels. Every line goes
 * through the redactor.
 */
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Logger, LogLevel } from "../contracts.js";
import type { Redactor } from "./redact.js";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const TEXT_FIELDS = new Set(["text", "content", "message"]);
const FILE_RE = /^agent-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

export interface LoggerOptions {
  dir: string;
  level?: LogLevel;
  redact: Redactor;
  retentionDays?: number;
  /** Test seam. */
  now?: () => Date;
}

export function logFileName(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `agent-${y}-${m}-${day}.jsonl`;
}

/** Deletes `agent-*.jsonl` files older than `retentionDays`. Returns the names removed. */
export function pruneLogs(dir: string, now: Date, retentionDays: number): string[] {
  const removed: string[] = [];
  const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - retentionDays * 86_400_000;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (t < cutoff) {
      try {
        unlinkSync(join(dir, name));
        removed.push(name);
      } catch {
        /* a file in use stays until next time */
      }
    }
  }
  return removed;
}

export function createLogger(opts: LoggerOptions): Logger {
  const level = opts.level ?? "info";
  const now = opts.now ?? (() => new Date());
  const retention = opts.retentionDays ?? 14;
  let lastDay = "";
  mkdirSync(opts.dir, { recursive: true });

  const write = (lvl: LogLevel, event: string, fields?: object): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    const d = now();
    const file = logFileName(d);
    if (file !== lastDay) {
      lastDay = file;
      pruneLogs(opts.dir, d, retention);
    }
    const base: Record<string, unknown> = { ts: d.toISOString(), level: lvl, event };
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (TEXT_FIELDS.has(k) && level !== "debug") continue;
        base[k] = v;
      }
    }
    let line: string;
    try {
      line = JSON.stringify(base);
    } catch {
      line = JSON.stringify({ ts: base["ts"], level: lvl, event, note: "unserialisable fields dropped" });
    }
    try {
      appendFileSync(join(opts.dir, file), opts.redact(line) + "\n", "utf8");
    } catch {
      /* logging must never take the agent down */
    }
  };

  return {
    debug: (e, f) => write("debug", e, f),
    info: (e, f) => write("info", e, f),
    warn: (e, f) => write("warn", e, f),
    error: (e, f) => write("error", e, f),
  };
}

/** A logger that records into memory, for tests of other modules. */
export function createMemoryLogger(): Logger & { lines: { level: LogLevel; event: string; fields?: object }[] } {
  const lines: { level: LogLevel; event: string; fields?: object }[] = [];
  const add = (level: LogLevel) => (event: string, fields?: object) => {
    lines.push(fields === undefined ? { level, event } : { level, event, fields });
  };
  return { lines, debug: add("debug"), info: add("info"), warn: add("warn"), error: add("error") };
}
