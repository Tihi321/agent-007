/**
 * The settings ACL refusal (S17.2, section 4.2): at start and hourly, `icacls` on `security.json`, the `settings\` folder and
 * `settings\personas\` must show the agent user with READ ONLY (no write-data, append, delete, change-permissions or
 * ownership, and no `DELETE_CHILD` on a folder), and no `Everyone` / `Users` / `Authenticated Users` write. The audit folder
 * must show the agent with read plus append only (the folder may carry `WD`, add file, so a new monthly file can be created;
 * the audit FILES may not carry `WD`).
 *
 * A violation refuses start (hourly: the host logs `error` and freezes proposals). Pure parsing over `icacls` output; the real
 * `icacls` call is `runIcacls` from `config/secrets.ts`. Pure subset.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isForbiddenPrincipal, parseIcacls, runIcacls } from "../config/secrets.js";
import type { AclEntry, IcaclsRunner } from "../config/secrets.js";
import { AUDIT_FILE_PATTERN } from "./audit.js";
import type { SettingsPaths } from "./store.js";

/** icacls rights tokens that grant a change of content, existence or permissions. */
export const WRITE_TOKENS: ReadonlySet<string> = new Set(["F", "M", "W", "WD", "AD", "DC", "D", "WDAC", "WO", "GA", "GW"]);
/** On the audit folder the agent may add files, but never delete, overwrite or re-ACL. */
const AUDIT_FOLDER_FORBIDDEN: ReadonlySet<string> = new Set(["F", "M", "W", "DC", "D", "WDAC", "WO", "GA", "GW"]);
/** On an audit file the agent may append (AD) but never write data. */
const AUDIT_FILE_FORBIDDEN: ReadonlySet<string> = new Set(["F", "M", "W", "WD", "DC", "D", "WDAC", "WO", "GA", "GW"]);

function rightsOf(e: AclEntry): string[] {
  const out: string[] = [];
  for (const f of e.flags) {
    for (const t of f.split(",")) {
      const tok = t.trim().toUpperCase();
      if (tok === "" || ["OI", "CI", "IO", "NP", "I", "DENY"].includes(tok)) continue;
      out.push(tok);
    }
  }
  return out;
}

export function isAgentPrincipal(principal: string, agentUser: string): boolean {
  const p = principal.trim().toLowerCase();
  const a = agentUser.trim().toLowerCase();
  return p === a || p.endsWith(`\\${a}`);
}

/** Problems of one path's ACL entries (empty = fine). `forbidden` is the set an agent grant may not contain. */
export function aclProblems(entries: readonly AclEntry[], agentUser: string, label: string, forbidden: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const e of entries) {
    if (e.deny) continue;
    const bad = rightsOf(e).filter((t) => WRITE_TOKENS.has(t));
    if (bad.length === 0) continue;
    if (isAgentPrincipal(e.principal, agentUser)) {
      const worse = bad.filter((t) => forbidden.has(t));
      if (worse.length > 0) problems.push(`${label}: the agent user (${e.principal}) has ${worse.join(",")} (read only is required${forbidden === AUDIT_FOLDER_FORBIDDEN || forbidden === AUDIT_FILE_FORBIDDEN ? ", plus append on the audit log" : ""})`);
    } else if (isForbiddenPrincipal(e.principal)) {
      problems.push(`${label}: ${e.principal} has write access (${bad.join(",")})`);
    }
  }
  return problems;
}

export interface SettingsAclOptions {
  paths: SettingsPaths;
  agentUser: string;
  icacls?: IcaclsRunner;
  /** Test seam: the audit files to check (default: the `settings-*.jsonl` files in the audit folder). */
  listAuditFiles?: (dir: string) => string[];
}

function entriesOf(run: IcaclsRunner, path: string): { entries: AclEntry[]; error?: string } {
  try {
    const out = run(path);
    const entries = parseIcacls(out, path);
    return entries.length === 0 ? { entries, error: "icacls returned no ACL entries" } : { entries };
  } catch (e) {
    return { entries: [], error: `cannot check the ACL (${(e as Error).message.split("\n")[0]})` };
  }
}

/** Every settings ACL violation (empty = compliant). */
export function checkSettingsAcl(o: SettingsAclOptions): string[] {
  const run = o.icacls ?? runIcacls;
  const problems: string[] = [];
  const readOnly: [string, string][] = [
    [o.paths.securityFile, "security.json"],
    [o.paths.settingsDir, "settings folder"],
    [o.paths.userPersonasDir, "settings\\personas folder"],
  ];
  for (const [p, label] of readOnly) {
    const r = entriesOf(run, p);
    if (r.error) problems.push(`${label}: ${r.error}`);
    else problems.push(...aclProblems(r.entries, o.agentUser, label, WRITE_TOKENS));
  }
  const auditDir = entriesOf(run, o.paths.auditDir);
  if (auditDir.error) problems.push(`audit folder: ${auditDir.error}`);
  else problems.push(...aclProblems(auditDir.entries, o.agentUser, "audit folder", AUDIT_FOLDER_FORBIDDEN));
  const files = (o.listAuditFiles ?? defaultListAuditFiles)(o.paths.auditDir);
  for (const f of files) {
    const r = entriesOf(run, f);
    if (r.error) problems.push(`audit file ${f}: ${r.error}`);
    else problems.push(...aclProblems(r.entries, o.agentUser, `audit file ${f}`, AUDIT_FILE_FORBIDDEN));
  }
  return problems;
}

function defaultListAuditFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => AUDIT_FILE_PATTERN.test(n))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

export class SettingsAclError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`the settings folder ACLs are not as required; refusing to start: ${problems.join("; ")}`);
    this.name = "SettingsAclError";
    this.problems = problems;
  }
}

export function assertSettingsAcl(o: SettingsAclOptions): void {
  const problems = checkSettingsAcl(o);
  if (problems.length > 0) throw new SettingsAclError(problems);
}
