/**
 * Version guard (S12.5). A `claude --version` string the guard has not approved holds the next job until both
 * (1) the stream-json parser smoke has passed on the recorded fixtures and (2) one harmless live probe job has
 * succeeded under that version. State is per version string and may be persisted to a small JSON file in the job runner's
 * own data folder.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type GuardRequirement = "parser_smoke" | "live_job";

export interface GuardCheck {
  held: boolean;
  /** What is still missing for this version (empty when approved). */
  missing: GuardRequirement[];
}

interface VersionState {
  parserSmoke: boolean;
  liveJob: boolean;
}

export class ClaudeVersionHeldError extends Error {
  readonly version: string;
  readonly missing: GuardRequirement[];
  constructor(version: string, missing: GuardRequirement[]) {
    super(`claude version "${version}" is new: held until ${missing.join(" and ")} pass`);
    this.name = "ClaudeVersionHeldError";
    this.version = version;
    this.missing = missing;
  }
}

export interface VersionGuardOptions {
  /** Versions that are approved from the start (tests, or a seeded install). */
  approved?: readonly string[];
  /** Persisted state. Missing or unreadable means empty. */
  file?: string;
}

export class ClaudeVersionGuard {
  private readonly versions = new Map<string, VersionState>();
  private readonly file: string | undefined;

  constructor(opts: VersionGuardOptions = {}) {
    this.file = opts.file;
    for (const v of opts.approved ?? []) this.versions.set(v, { parserSmoke: true, liveJob: true });
    if (this.file !== undefined) this.load(this.file);
  }

  check(version: string): GuardCheck {
    const s = this.versions.get(version);
    const missing: GuardRequirement[] = [];
    if (!s?.parserSmoke) missing.push("parser_smoke");
    if (!s?.liveJob) missing.push("live_job");
    return { held: missing.length > 0, missing };
  }

  isApproved(version: string): boolean {
    return !this.check(version).held;
  }

  recordParserSmoke(version: string, ok: boolean): void {
    this.state(version).parserSmoke = ok;
    this.save();
  }

  recordLiveJob(version: string, ok: boolean): void {
    this.state(version).liveJob = ok;
    this.save();
  }

  private state(version: string): VersionState {
    let s = this.versions.get(version);
    if (!s) {
      s = { parserSmoke: false, liveJob: false };
      this.versions.set(version, s);
    }
    return s;
  }

  private load(file: string): void {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { versions?: Record<string, Partial<VersionState>> };
      for (const [v, s] of Object.entries(raw.versions ?? {})) this.versions.set(v, { parserSmoke: s.parserSmoke === true, liveJob: s.liveJob === true });
    } catch {
      /* absent or unreadable: start empty (everything held) */
    }
  }

  private save(): void {
    if (this.file === undefined) return;
    const versions: Record<string, VersionState> = {};
    for (const [v, s] of this.versions) versions[v] = s;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ versions }, null, 2));
  }
}
