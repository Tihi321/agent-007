/**
 * The job journal (S11.4): one append-only JSONL file per job in the job runner's own data folder
 * (`%LOCALAPPDATA%\agent-007-jobrunner\journal\<jobId>.jsonl`, main user only). It is the job runner's memory across a
 * restart: the state transitions (as `state` events), the child PID, the engine session id and version (from the
 * `init` event), the Flow credits charged, the events themselves (so `status {sinceSeq}` works after a restart) and the
 * final `JobDone`.
 *
 * Entries are written BEFORE the in-memory state changes (write-ahead), synchronously. Replay tolerates a torn last
 * line (a crash in the middle of a write) and skips unreadable lines, counting them.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalProof, JobDone, JobEngine, JobEvent, JobRequest, JobState } from "../jobs/contracts.js";
import { isTerminalJobState } from "../jobs/contracts.js";
import { redactDeep } from "../logging/redact.js";
import type { Redactor } from "../logging/redact.js";

export const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type JournalEntry =
  | { t: "job"; at: number; jobId: string; templateId: string; engine: JobEngine; request: JobRequest; approval: ApprovalProof; flowBudgetCredits?: number; cwd: string }
  | { t: "event"; at: number; jobId: string; event: JobEvent }
  | { t: "pid"; at: number; jobId: string; pid: number }
  | { t: "version"; at: number; jobId: string; engineVersion: string }
  | { t: "flow"; at: number; jobId: string; charged: number }
  | { t: "resume"; at: number; jobId: string; count: number }
  | { t: "done"; at: number; jobId: string; done: JobDone };

/** What a replay of a job's file gives. The job manager keeps working on this same object. */
export interface JobRecord {
  jobId: string;
  templateId: string;
  engine: JobEngine;
  request: JobRequest;
  approval: ApprovalProof;
  flowBudgetCredits?: number;
  cwd: string;
  createdAt: number;
  state: JobState;
  startedAt?: number;
  finishedAt?: number;
  /** The child PID the driver reported (informational: it is not killed after a restart, see JobManager.recover). */
  pid?: number;
  engineSessionId?: string;
  engineVersion?: string;
  lastSeq: number;
  events: JobEvent[];
  /** Sum of the `max_credits` of the allowed Flow calls. */
  flowCharged: number;
  resumeCount: number;
  done?: JobDone;
}

/** Applies one entry to a record (also used live, so replay and the running state cannot drift apart). */
export function applyEntry(rec: JobRecord, entry: JournalEntry): void {
  switch (entry.t) {
    case "event": {
      const ev = entry.event;
      rec.events.push(ev);
      if (ev.seq > rec.lastSeq) rec.lastSeq = ev.seq;
      if (ev.kind === "state") {
        rec.state = ev.state;
        if (ev.state === "running" && rec.startedAt === undefined) rec.startedAt = ev.ts;
        if (isTerminalJobState(ev.state)) rec.finishedAt = ev.ts;
      } else if (ev.kind === "init") {
        if (ev.engineSessionId !== undefined) rec.engineSessionId = ev.engineSessionId;
        if (ev.engineVersion !== undefined) rec.engineVersion = ev.engineVersion;
      }
      return;
    }
    case "pid":
      rec.pid = entry.pid;
      return;
    case "version":
      rec.engineVersion = entry.engineVersion;
      return;
    case "flow":
      rec.flowCharged = entry.charged;
      return;
    case "resume":
      rec.resumeCount = entry.count;
      return;
    case "done":
      rec.done = entry.done;
      if (rec.finishedAt === undefined) rec.finishedAt = entry.at;
      return;
    case "job":
      return;
  }
}

export function newRecord(entry: Extract<JournalEntry, { t: "job" }>): JobRecord {
  const rec: JobRecord = {
    jobId: entry.jobId,
    templateId: entry.templateId,
    engine: entry.engine,
    request: entry.request,
    approval: entry.approval,
    cwd: entry.cwd,
    createdAt: entry.at,
    state: "queued",
    lastSeq: 0,
    events: [],
    flowCharged: 0,
    resumeCount: 0,
  };
  if (entry.flowBudgetCredits !== undefined) rec.flowBudgetCredits = entry.flowBudgetCredits;
  return rec;
}

export interface JournalOptions {
  dir: string;
  /** Applied to `event` entries (tool output may hold a secret). The request itself is stored as sent. */
  redact?: Redactor;
}

export interface ReplayResult {
  records: Map<string, JobRecord>;
  /** Lines that could not be parsed (a torn last line counts). */
  corruptLines: number;
}

export class Journal {
  constructor(private readonly opts: JournalOptions) {
    mkdirSync(opts.dir, { recursive: true });
  }

  get dir(): string {
    return this.opts.dir;
  }

  private file(jobId: string): string {
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error("not a valid job id");
    return join(this.opts.dir, `${jobId}.jsonl`);
  }

  /** Appends one entry (synchronously, so it is on disk before the caller goes on). */
  append(entry: JournalEntry): void {
    const e = entry.t === "event" && this.opts.redact ? { ...entry, event: redactDeep(entry.event, this.opts.redact) } : entry;
    appendFileSync(this.file(entry.jobId), JSON.stringify(e) + "\n", { encoding: "utf8", flag: "a" });
  }

  /** Rebuilds every job from its file. */
  replay(): ReplayResult {
    const records = new Map<string, JobRecord>();
    let corrupt = 0;
    let names: string[] = [];
    try {
      names = readdirSync(this.opts.dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      return { records, corruptLines: 0 };
    }
    for (const name of names.sort()) {
      const jobId = name.slice(0, -".jsonl".length);
      if (!JOB_ID_PATTERN.test(jobId)) continue;
      let text: string;
      try {
        text = readFileSync(join(this.opts.dir, name), "utf8");
      } catch {
        continue;
      }
      let rec: JobRecord | undefined;
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        let entry: JournalEntry;
        try {
          entry = JSON.parse(line) as JournalEntry;
          if (typeof entry !== "object" || entry === null || typeof entry.t !== "string") throw new Error("shape");
        } catch {
          corrupt++;
          continue;
        }
        if (entry.t === "job") {
          if (rec === undefined) rec = newRecord(entry);
          continue;
        }
        if (rec !== undefined && entry.jobId === jobId) applyEntry(rec, entry);
      }
      if (rec !== undefined) records.set(jobId, rec);
    }
    return { records, corruptLines: corrupt };
  }

  /** Deletes the files of jobs that ended more than `retentionDays` ago. Returns the job ids removed. */
  prune(records: Iterable<JobRecord>, now: number, retentionDays: number): string[] {
    const removed: string[] = [];
    const cutoff = now - retentionDays * 86_400_000;
    for (const r of records) {
      if (!isTerminalJobState(r.state) || (r.finishedAt ?? now) >= cutoff) continue;
      try {
        const f = this.file(r.jobId);
        if (existsSync(f) && statSync(f).isFile()) {
          unlinkSync(f);
          removed.push(r.jobId);
        }
      } catch {
        /* a file in use stays until next time */
      }
    }
    return removed;
  }
}
