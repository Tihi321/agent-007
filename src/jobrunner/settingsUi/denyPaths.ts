/**
 * Deny-path propagation to jobs (S18.3, I22, S12.2). `effectiveDenyPaths()` is the union of `jobrunner.json`'s own deny list and
 * `security.json`'s `folders.deny`, read at EACH job start (both files belong to the main user). The cwd check (S11.3) and the
 * Read/Edit/Write deny rules in the Claude argv (S12.2) both call it, so a deny path added in the UI reaches the next Claude job,
 * and removing it removes the rules.
 *
 * Fail closed: if `security.json` exists but cannot be read or is not valid, this throws and the job runner refuses new jobs. A
 * missing `security.json` (a Phase 1/2 install that was never migrated) means only the job runner's own list applies.
 *
 * Pure subset: no adapter import.
 */
import { normalizeWin } from "../../config/paths.js";
import { validateSecurityDoc } from "../../settings/schema.js";
import { readTextIfExists } from "../../settings/store.js";

export class DenyPathsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DenyPathsUnavailableError";
  }
}

export interface DenyPathsOptions {
  /** The job runner's own `denyPaths`. */
  ownDeny: readonly string[];
  /** `settings\security.json`; when absent the own list alone applies. */
  securityFile?: string | undefined;
  /** Test seam: reads the file text (undefined = no file). */
  readText?: (file: string) => string | undefined;
}

export function effectiveDenyPaths(o: DenyPathsOptions): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    const k = normalizeWin(p);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  };
  for (const p of o.ownDeny) add(p);
  if (o.securityFile === undefined) return out;
  let text: string | undefined;
  try {
    text = (o.readText ?? readTextIfExists)(o.securityFile);
  } catch (e) {
    throw new DenyPathsUnavailableError(`security.json cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (text === undefined) return out;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new DenyPathsUnavailableError("security.json is not valid JSON");
  }
  const v = validateSecurityDoc(doc, { skipFolderExists: true });
  if (!v.ok) throw new DenyPathsUnavailableError(`security.json is not valid (${v.issues[0] ?? "unknown problem"})`);
  const deny = ((doc as { folders?: { deny?: unknown } }).folders?.deny ?? []) as string[];
  for (const p of deny) add(p);
  return out;
}

/** A function that re-reads both lists at each call (the job runner passes it to the manager and the Claude driver). */
export function denyPathSource(o: DenyPathsOptions): () => string[] {
  return () => effectiveDenyPaths(o);
}
