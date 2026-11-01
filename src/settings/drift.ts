/**
 * Out-of-band edit detection (S17.2, I29b). At start the agent reads the audit tail for the last audited `afterRevision` of each
 * settings file (`security.json`, `prefs.json`, each persona file). A file whose hash differs gets ONE audit line
 * `source: "system", decision: "external_edit"` (the first sighting of a file is `loaded`). An approved shell command or an admin
 * can edit files; the audit then still tells the story. A `security.json` edit by hand is accepted if it is valid, and recorded.
 *
 * Pure subset.
 */
import { lastRevisions } from "./audit.js";
import type { AuditKind, AuditLine, SettingsAudit } from "./contracts.js";
import { ABSENT_REVISION } from "./store.js";

export interface TrackedFile {
  /** The audit `target.file` (`security.json`, `prefs.json`, `personas/<id>.json`). */
  file: string;
  kind: AuditKind;
  revision: string;
}

/** Appends a `loaded` or `external_edit` line for each file whose revision is not the last audited one. Returns the lines written. */
export function recordRevisions(audit: SettingsAudit, auditDir: string, files: readonly TrackedFile[]): AuditLine[] {
  const last = lastRevisions(auditDir);
  const out: AuditLine[] = [];
  for (const f of files) {
    const before = last[f.file];
    if (before === f.revision) continue;
    if (before === undefined && f.revision === ABSENT_REVISION) continue; // nothing there and nothing recorded
    out.push(
      audit.append({
        source: "system",
        kind: f.kind,
        target: { file: f.file, path: "(file)" },
        diff: [],
        decision: before === undefined ? "loaded" : "external_edit",
        baseRevision: before ?? ABSENT_REVISION,
        afterRevision: f.revision,
      }),
    );
  }
  return out;
}
