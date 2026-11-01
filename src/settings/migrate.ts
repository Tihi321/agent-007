/**
 * Migration planning (S17.1): the pure part of `migrate-settings`. The I/O (backup, `securityWriter`, rollback) lives in
 * `scripts/migrate-settings.ts`, the only place besides the settings UI that may import `securityWriter`.
 *
 * The plan REFUSES (fail closed) when: a top-level key is not in the split table; a string value in the old config looks like a
 * secret (the refusal names the KEY only, never the value); the resulting `security.json` is not valid (non-loopback URL,
 * empty allowlist, unknown runner, missing runner block, duplicate alias, a missing folder).
 *
 * Pure subset.
 */
import { defaultsFromEnv } from "../config/schema.js";
import type { DefaultsEnv } from "../config/schema.js";
import type { FsProbe } from "../config/validate.js";
import { secretShapedKeys } from "./secretShape.js";
import { validateSecurityDoc } from "./schema.js";
import { splitConfig, splitTable, UnclassifiedKeyError } from "./split.js";

export interface MigrationPlan {
  /** True when `config.json` already says `schemaVersion: 2` (a second `--apply` is a no-op). */
  alreadyMigrated: boolean;
  refusals: string[];
  warnings: string[];
  table: { key: string; goes: string }[];
  bootstrap?: Record<string, unknown>;
  security?: Record<string, unknown>;
}

export interface PlanOptions {
  settingsDir: string;
  env?: DefaultsEnv;
  fs?: FsProbe;
}

export function planMigration(configText: string, o: PlanOptions): MigrationPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(configText);
  } catch (e) {
    return { alreadyMigrated: false, refusals: [`config.json is not valid JSON: ${(e as Error).message}`], warnings: [], table: [] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { alreadyMigrated: false, refusals: ["config.json must be a JSON object"], warnings: [], table: [] };
  const cfg = raw as Record<string, unknown>;
  if (cfg["schemaVersion"] === 2) return { alreadyMigrated: true, refusals: [], warnings: [], table: splitTable(cfg) };
  if (cfg["schemaVersion"] !== undefined && cfg["schemaVersion"] !== 1) return { alreadyMigrated: false, refusals: [`config.json schemaVersion ${JSON.stringify(cfg["schemaVersion"])} is not supported`], warnings: [], table: [] };

  const table = splitTable(cfg);
  const refusals: string[] = [];
  const secretKeys = secretShapedKeys(cfg);
  for (const k of secretKeys) refusals.push(`${k}: the value looks like a secret; move it to secrets.json (the value is not shown)`);
  let bootstrap: Record<string, unknown> | undefined;
  let security: Record<string, unknown> | undefined;
  try {
    ({ bootstrap, security } = splitConfig(cfg, o.settingsDir));
  } catch (e) {
    if (e instanceof UnclassifiedKeyError) refusals.push(e.message);
    else throw e;
  }
  const warnings: string[] = [];
  if (security) {
    const v = validateSecurityDoc(security, { env: o.env ?? defaultsFromEnv(), ...(o.fs ? { fs: o.fs } : {}) });
    refusals.push(...v.issues.map((i) => `security.json would not be valid: ${i}`));
    warnings.push(...v.warnings);
  }
  return { alreadyMigrated: false, refusals, warnings, table, ...(bootstrap ? { bootstrap } : {}), ...(security ? { security } : {}) };
}

/** The printable dry run: the split table, then refusals or "ready". */
export function formatPlan(plan: MigrationPlan): string[] {
  const lines: string[] = [];
  if (plan.alreadyMigrated) {
    lines.push("config.json already has schemaVersion 2: nothing to do.");
    return lines;
  }
  lines.push("Where each top-level key of config.json goes:");
  for (const r of plan.table) lines.push(`  ${r.key.padEnd(18)} -> ${r.goes}`);
  if (plan.security) lines.push(`  (security.json will also get: presets, budgets, proposals and model.defaultPreset; prefs.json starts from the defaults)`);
  for (const w of plan.warnings) lines.push(`warning: ${w}`);
  if (plan.refusals.length > 0) {
    lines.push("REFUSED:");
    for (const r of plan.refusals) lines.push(`  - ${r}`);
  } else lines.push("Ready. Run again with --apply (elevated) to migrate.");
  return lines;
}

const BACKUP_MARK = ".pre-phase3-";

export function backupFileName(configFileName: string, now: Date): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${configFileName}${BACKUP_MARK}${ts}`;
}

/** The newest backup among directory entries (the timestamp sorts as text). */
export function newestBackup(configFileName: string, names: readonly string[]): string | undefined {
  return names
    .filter((n) => n.startsWith(`${configFileName}${BACKUP_MARK}`))
    .sort()
    .pop();
}
