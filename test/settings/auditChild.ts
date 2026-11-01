/** Child process for the audit interleave test (U48b offline): appends N lines as one writer, then exits. Not a test. */
import { createSettingsAudit } from "../../src/settings/audit.js";
import type { AuditWriter } from "../../src/settings/contracts.js";

const [dir, writer, countText, big] = process.argv.slice(2) as [string, AuditWriter, string, string | undefined];
const audit = createSettingsAudit({ dir, writer });
const n = Number(countText);
for (let i = 0; i < n; i++) {
  audit.append({
    source: "system",
    kind: "setting",
    target: { file: "prefs.json", path: `style.n${i}` },
    diff: [{ path: "style.notes", op: "replace", before: "a", after: big === "big" ? "y".repeat(1500) : `line ${i}` }],
    decision: "applied",
    baseRevision: "a",
    afterRevision: "b",
  });
}
