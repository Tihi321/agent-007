/**
 * `securityWriter` (S17.2): the ONLY code that writes `security.json`. Only `src/jobrunner/settingsUi/**` and
 * `scripts/migrate-settings.ts` may import this file (`test/settings/boundary.test.ts` greps for it); no agent code can reach
 * it, and the agent user has read-only NTFS rights on the file anyway.
 *
 * A save is validated first (schema, structural and semantic refusals of the Phase 1/2 loader, preset cross-checks), then goes
 * through the audited replace of `store.ts` (I25d): `baseRevision` check (409 in the UI), temp file, audit line, rename.
 *
 * `saveJsonAudited` is the same protocol for the other files the UI may write (`settings\personas\<id>.json`, `jobrunner.json`,
 * `jobrunner\templates\*.json`); it validates nothing itself, the route does.
 *
 * Pure subset.
 */
import type { AuditApprover, AuditEntryInput, AuditSource, SettingsAudit } from "./contracts.js";
import { SettingsError } from "./contracts.js";
import { validateSecurityDoc } from "./schema.js";
import type { ValidateSecurityOptions } from "./schema.js";
import { diffValues, readTextIfExists, replaceAudited, serialize } from "./store.js";
import type { ReplaceFs, ReplaceResult } from "./store.js";

export class SecurityValidationError extends SettingsError {
  readonly issues: string[];
  constructor(issues: string[]) {
    super("invalid_value", `the security settings are not valid: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? `; and ${issues.length - 5} more` : ""}`);
    this.name = "SecurityValidationError";
    this.issues = issues;
  }
}

export interface SaveSecurityOptions {
  securityFile: string;
  doc: unknown;
  baseRevision: string;
  audit: SettingsAudit;
  source: Extract<AuditSource, "ui" | "migrate">;
  approver?: AuditApprover;
  /** Which form saved it (for the audit `target.path`); default "(document)". */
  section?: string;
  /** A fixed note for the audit line (an acknowledgment text, S18.2). */
  note?: string;
  validation?: ValidateSecurityOptions;
  fs?: ReplaceFs;
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
}

export { serialize };

function parseOrUndefined(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function saveSecurity(o: SaveSecurityOptions): Promise<ReplaceResult> {
  const v = validateSecurityDoc(o.doc, o.validation);
  if (!v.ok) throw new SecurityValidationError(v.issues);
  const current = (o.fs?.readText ?? readTextIfExists)(o.securityFile);
  const diff = diffValues(parseOrUndefined(current), o.doc);
  return replaceAudited({
    file: o.securityFile,
    newText: serialize(o.doc),
    baseRevision: o.baseRevision,
    audit: o.audit,
    entry: {
      source: o.source,
      kind: "security",
      target: { file: "security.json", path: o.section ?? "(document)" },
      diff,
      ...(o.approver ? { approver: o.approver } : {}),
      ...(o.note !== undefined ? { note: o.note } : {}),
    },
    ...(o.fs ? { fs: o.fs } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.retryDelayMs !== undefined ? { retryDelayMs: o.retryDelayMs } : {}),
  });
}

export interface SaveJsonOptions {
  file: string;
  doc: unknown;
  baseRevision: string;
  audit: SettingsAudit;
  entry: Omit<AuditEntryInput, "baseRevision" | "afterRevision" | "decision" | "diff"> & { decision?: AuditEntryInput["decision"] };
  fs?: ReplaceFs;
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
}

/** The save protocol for any other JSON file the UI may write. The caller has validated `doc`. */
export async function saveJsonAudited(o: SaveJsonOptions): Promise<ReplaceResult> {
  const current = (o.fs?.readText ?? readTextIfExists)(o.file);
  return replaceAudited({
    file: o.file,
    newText: serialize(o.doc),
    baseRevision: o.baseRevision,
    audit: o.audit,
    entry: { ...o.entry, diff: diffValues(parseOrUndefined(current), o.doc) },
    ...(o.fs ? { fs: o.fs } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.retryDelayMs !== undefined ? { retryDelayMs: o.retryDelayMs } : {}),
  });
}
