/**
 * Settings folders, revisions and the audited file replace (S17.2, I25d).
 *
 * `SettingsPaths` is built from folders passed in (not hard-coded), so Phase 4 can relocate `main`'s prefs into `bots\main\`
 * without changing logic. The revision of a document is `sha256(file text)`; an absent file has the revision of the empty text.
 *
 * `replaceAudited` is THE save protocol, shared by every writer (the UI's security saves, persona saves, `jobrunner.json`, and
 * the agent's approved prefs): check `baseRevision`, write a temp file in the same folder, append the audit line, THEN rename the
 * temp file over the target (retry on EBUSY or EPERM, 5 x 50 ms). An audit failure leaves file and log unchanged; a rename failure
 * leaves the file unchanged and adds exactly one `apply_failed` line.
 *
 * Pure subset: node:fs, node:path and node:crypto only.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sha256Text } from "./chain.js";
import { SettingsError } from "./contracts.js";
import type { AuditDecision, AuditEntryInput, DiffEntry, SettingsAudit } from "./contracts.js";

export interface SettingsPaths {
  settingsDir: string;
  /** `settings\security.json`: written only by the job runner's UI and the migration. */
  securityFile: string;
  /** `settings\personas\`: user-authored personas (agent R). */
  userPersonasDir: string;
  /** `settings\audit\`: the append-only audit log. */
  auditDir: string;
  /** `%LOCALAPPDATA%\agent-007\prefs\`. */
  prefsDir: string;
  prefsFile: string;
  /** `prefs\personas\`: model-proposed personas (agent F). */
  modelPersonasDir: string;
}

export function settingsPaths(programDataDir: string, dataDir: string, settingsDir?: string): SettingsPaths {
  const sdir = settingsDir ?? join(programDataDir, "settings");
  const prefsDir = join(dataDir, "prefs");
  return {
    settingsDir: sdir,
    securityFile: join(sdir, "security.json"),
    userPersonasDir: join(sdir, "personas"),
    auditDir: join(sdir, "audit"),
    prefsDir,
    prefsFile: join(prefsDir, "prefs.json"),
    modelPersonasDir: join(prefsDir, "personas"),
  };
}

export const ABSENT_REVISION = sha256Text("");

/** `sha256(file text)`; `undefined` (no file) has the revision of the empty text. */
export function revisionOf(text: string | undefined): string {
  return sha256Text(text ?? "");
}

export function readTextIfExists(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Revision of a file on disk (the empty-text revision when it does not exist). */
export function fileRevision(file: string): string {
  return revisionOf(readTextIfExists(file));
}

/** The text written for a JSON document: two-space indent and a final newline. */
export function serialize(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}
`;
}

// ---- diff -------------------------------------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A deep diff of two JSON values at dotted paths. Arrays and scalars are compared as a whole. */
export function diffValues(before: unknown, after: unknown, path = ""): DiffEntry[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (isObj(before) && isObj(after)) {
    const out: DiffEntry[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of [...keys].sort()) out.push(...diffValues(before[k], after[k], path === "" ? k : `${path}.${k}`));
    return out;
  }
  const at = path === "" ? "(root)" : path;
  if (before === undefined) return [{ path: at, op: "add", after }];
  if (after === undefined) return [{ path: at, op: "remove", before }];
  return [{ path: at, op: "replace", before, after }];
}

// ---- the audited replace ----------------------------------------------------------------------------------------

export interface ReplaceFs {
  readText(file: string): string | undefined;
  writeText(file: string, text: string): void;
  rename(from: string, to: string): void;
  remove(file: string): void;
}

export const nodeReplaceFs: ReplaceFs = {
  readText: readTextIfExists,
  writeText: (file, text) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
  },
  rename: (from, to) => renameSync(from, to),
  remove: (file) => rmSync(file, { force: true }),
};

export interface ReplaceOptions {
  file: string;
  newText: string;
  baseRevision: string;
  audit: SettingsAudit;
  /** The audit line, without the revisions and (optionally) the decision (default `applied`). */
  entry: Omit<AuditEntryInput, "baseRevision" | "afterRevision" | "decision"> & { decision?: AuditDecision };
  fs?: ReplaceFs;
  retries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReplaceResult {
  beforeRevision: string;
  afterRevision: string;
}

const RETRYABLE = new Set(["EBUSY", "EPERM", "EACCES"]);

// ---- per-file write queue ---------------------------------------------------------------------------------------

const lockTails = new Map<string, Promise<unknown>>();

function lockKey(file: string): string {
  const r = resolve(file);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/**
 * Runs `fn` after every earlier `withFileLock` call for the same file path in this process has finished (success or failure), and
 * before any later one starts. Bots in one host share one `prefs.json`; this keeps their writes in line. Across processes it does
 * nothing (the base-revision check and the atomic rename still stop a torn file).
 */
export function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(file);
  const prev = lockTails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  lockTails.set(key, tail);
  void tail.then(() => {
    if (lockTails.get(key) === tail) lockTails.delete(key);
  });
  return run;
}

export interface UpdateOptions extends Omit<ReplaceOptions, "newText" | "baseRevision" | "entry"> {
  /**
   * Called under the lock with the file's CURRENT text (undefined: no file). Returns the new text and the audit line, or undefined for
   * "nothing to change". It must be synchronous and pure: it is the read-modify-write step.
   */
  compute(current: string | undefined): { newText: string; entry: ReplaceOptions["entry"] } | undefined;
}

/** Read-modify-write under the per-file lock: a concurrent writer is never lost and never gets `stale_base`. Resolves false when `compute` made no change. */
export function updateAudited(o: UpdateOptions): Promise<ReplaceResult | undefined> {
  return withFileLock(o.file, async () => {
    const fs = o.fs ?? nodeReplaceFs;
    const current = fs.readText(o.file);
    const plan = o.compute(current);
    if (!plan) return undefined;
    const { compute: _c, ...rest } = o;
    void _c;
    return replaceUnlocked({ ...rest, newText: plan.newText, entry: plan.entry, baseRevision: revisionOf(current) });
  });
}

export function replaceAudited(o: ReplaceOptions): Promise<ReplaceResult> {
  return withFileLock(o.file, () => replaceUnlocked(o));
}

async function replaceUnlocked(o: ReplaceOptions): Promise<ReplaceResult> {
  const fs = o.fs ?? nodeReplaceFs;
  const current = fs.readText(o.file);
  const beforeRevision = revisionOf(current);
  if (beforeRevision !== o.baseRevision) throw new SettingsError("stale_base", "the file changed since it was loaded; reload and try again");
  const afterRevision = revisionOf(o.newText);
  const tmp = `${o.file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeText(tmp, o.newText);
  } catch (e) {
    fs.remove(tmp);
    throw new SettingsError("apply_failed", `could not write the temporary file (${(e as NodeJS.ErrnoException).code ?? "error"}); nothing was changed`);
  }
  // The audit line goes in BEFORE the file is replaced: if it cannot be written, nothing changes.
  try {
    o.audit.append({ ...o.entry, decision: o.entry.decision ?? "applied", baseRevision: beforeRevision, afterRevision });
  } catch (e) {
    fs.remove(tmp);
    throw e instanceof SettingsError ? e : new SettingsError("audit_failed", "the audit line could not be written; nothing was changed");
  }
  const tries = o.retries ?? 5;
  const delay = o.retryDelayMs ?? 50;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastCode = "error";
  for (let i = 0; i < tries; i++) {
    try {
      fs.rename(tmp, o.file);
      return { beforeRevision, afterRevision };
    } catch (e) {
      lastCode = (e as NodeJS.ErrnoException).code ?? "error";
      if (!RETRYABLE.has(lastCode)) break;
      if (i < tries - 1) await sleep(delay);
    }
  }
  fs.remove(tmp);
  try {
    o.audit.append({ ...o.entry, decision: "apply_failed", baseRevision: beforeRevision, afterRevision: beforeRevision, note: `rename failed (${lastCode})` });
  } catch {
    /* the original change was already logged as intended; the log now lacks the failure line */
  }
  throw new SettingsError("apply_failed", `the file could not be replaced (${lastCode}); it is unchanged`);
}
