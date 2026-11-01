/**
 * `migrate-settings` (S17.1): splits the Phase 1/2 `config.json` into the bootstrap `config.json` (schemaVersion 2), `security.json`
 * and `prefs.json`. The USER runs it, elevated, on the real install [GO] [ADMIN], after reviewing the printed split table.
 *
 *   node dist/scripts/migrate-settings.js --config <config.json> [--settings-dir <dir>] [--agent-user agent007]   dry run (default)
 *   ... --apply       back up config.json as config.json.pre-phase3-<ts>, write security.json (through securityWriter, one
 *                     audit line `source: "migrate"`), write prefs.json, rewrite config.json. A second --apply is a no-op.
 *   ... --rollback    restore the newest backup; the new files are renamed to *.rolledback-<ts>.
 *
 * `--apply` refuses to run when the settings folder does not exist or its ACLs are not as section 4.2 requires (run
 * `scripts\settings\setup-settings-acl.ps1` first). A secret-looking value in the old config is refused, naming the key only.
 * One of the two places that may import `securityWriter` (the other is the settings UI): the boundary test enforces it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultsFromEnv } from "../src/config/schema.js";
import type { DefaultsEnv } from "../src/config/schema.js";
import type { FsProbe } from "../src/config/validate.js";
import { checkSettingsAcl } from "../src/settings/acl.js";
import { createSettingsAudit } from "../src/settings/audit.js";
import { backupFileName, formatPlan, newestBackup, planMigration } from "../src/settings/migrate.js";
import { defaultPrefs } from "../src/settings/prefs.js";
import { saveJsonAudited, saveSecurity, serialize } from "../src/settings/securityWriter.js";
import { fileRevision, settingsPaths } from "../src/settings/store.js";
import type { SettingsPaths } from "../src/settings/store.js";

export interface MigrateArgs {
  config: string;
  settingsDir?: string;
  agentUser: string;
  apply: boolean;
  rollback: boolean;
}

export interface MigrateIo {
  out: (line: string) => void;
  now?: () => Date;
  env?: DefaultsEnv;
  fs?: FsProbe;
  /** Problems with the settings ACLs; the default runs `icacls`. Return `[]` to accept. */
  checkAcl?: (paths: SettingsPaths, agentUser: string) => string[];
}

export function parseArgs(argv: readonly string[]): MigrateArgs {
  const a: MigrateArgs = { config: "", agentUser: "agent007", apply: false, rollback: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i] as string;
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === "--config") a.config = val();
    else if (k === "--settings-dir") a.settingsDir = val();
    else if (k === "--agent-user") a.agentUser = val();
    else if (k === "--apply") a.apply = true;
    else if (k === "--rollback") a.rollback = true;
    else throw new Error(`unknown argument ${JSON.stringify(k)}`);
  }
  if (a.config === "") throw new Error("--config <path to config.json> is required");
  if (a.apply && a.rollback) throw new Error("use either --apply or --rollback");
  return a;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Returns the exit code: 0 done or nothing to do, 1 refused or failed. */
export async function runMigration(args: MigrateArgs, io: MigrateIo): Promise<number> {
  const now = io.now ?? (() => new Date());
  const env = io.env ?? defaultsFromEnv();
  const configPath = resolve(args.config);
  const folder = dirname(configPath);
  const name = basename(configPath);

  if (args.rollback) {
    const backup = newestBackup(name, readdirSync(folder));
    if (!backup) {
      io.out(`No backup named ${name}.pre-phase3-* found next to ${configPath}; nothing to roll back.`);
      return 1;
    }
    const ts = stamp(now());
    copyFileSync(join(folder, backup), configPath);
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch {
      /* the restored file is what it is */
    }
    const paths = resolvePaths(cfg, env, args.settingsDir);
    for (const f of [paths.securityFile, paths.prefsFile]) {
      if (existsSync(f)) renameSync(f, `${f}.rolledback-${ts}`);
    }
    io.out(`Restored ${configPath} from ${backup}. security.json and prefs.json were renamed to *.rolledback-${ts}.`);
    return 0;
  }

  const text = readFileSync(configPath, "utf8");
  let early: Record<string, unknown> = {};
  try {
    early = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* planMigration reports it */
  }
  const paths = resolvePaths(early, env, args.settingsDir);
  const plan = planMigration(text, { settingsDir: paths.settingsDir, env, ...(io.fs ? { fs: io.fs } : {}) });
  for (const l of formatPlan(plan)) io.out(l);
  if (plan.alreadyMigrated) return 0;
  if (plan.refusals.length > 0) return 1;
  if (!args.apply) return 0;

  // ---- apply ----
  if (!existsSync(paths.settingsDir) || !existsSync(paths.auditDir)) {
    io.out(`The settings folder (${paths.settingsDir}) or its audit folder does not exist. Run scripts\\settings\\setup-settings-acl.ps1 first (elevated). Nothing was changed.`);
    return 1;
  }
  const aclProblems = (io.checkAcl ?? ((p, u) => checkSettingsAcl({ paths: p, agentUser: u })))(paths, args.agentUser);
  if (aclProblems.length > 0) {
    io.out("WARNING: the settings folder ACLs are not as required, so --apply did not run. Fix them with scripts\\settings\\setup-settings-acl.ps1:");
    for (const p of aclProblems) io.out(`  - ${p}`);
    return 1;
  }
  const audit = createSettingsAudit({ dir: paths.auditDir, writer: "jobrunner", now });
  const backup = join(folder, backupFileName(name, now()));
  copyFileSync(configPath, backup);
  io.out(`Backed up config.json to ${backup}`);
  try {
    await saveSecurity({
      securityFile: paths.securityFile,
      doc: plan.security,
      baseRevision: fileRevision(paths.securityFile),
      audit,
      source: "migrate",
      section: "(migration)",
      validation: { env, ...(io.fs ? { fs: io.fs } : {}) },
    });
    io.out(`Wrote ${paths.securityFile}`);
    if (!existsSync(paths.prefsFile)) {
      mkdirSync(paths.prefsDir, { recursive: true });
      await saveJsonAudited({
        file: paths.prefsFile,
        doc: defaultPrefs(),
        baseRevision: fileRevision(paths.prefsFile),
        audit,
        entry: { source: "migrate", kind: "setting", target: { file: "prefs.json", path: "(document)" } },
      });
      io.out(`Wrote ${paths.prefsFile}`);
    }
    const tmp = `${configPath}.${process.pid}.tmp`;
    writeFileSync(tmp, serialize(plan.bootstrap), "utf8");
    renameSync(tmp, configPath);
    io.out(`Rewrote ${configPath} (schemaVersion 2). Restart the agent to use it. To undo: --rollback.`);
    return 0;
  } catch (e) {
    rmSync(`${configPath}.${process.pid}.tmp`, { force: true });
    io.out(`FAILED: ${(e as Error).message}. config.json was not rewritten; rerun --apply after fixing the cause (or --rollback).`);
    return 1;
  }
}

function resolvePaths(cfg: Record<string, unknown>, env: DefaultsEnv, settingsDir: string | undefined): SettingsPaths {
  const p = (typeof cfg["paths"] === "object" && cfg["paths"] !== null ? cfg["paths"] : {}) as Record<string, unknown>;
  const programData = typeof p["programDataDir"] === "string" ? p["programDataDir"] : join(env.programData, "agent-007");
  const dataDir = typeof p["dataDir"] === "string" ? p["dataDir"] : join(env.localAppData, "agent-007");
  const s = (typeof cfg["settings"] === "object" && cfg["settings"] !== null ? cfg["settings"] : {}) as Record<string, unknown>;
  const dir = settingsDir ?? (typeof s["dir"] === "string" ? s["dir"] : undefined);
  return settingsPaths(programData, dataDir, dir);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  let code = 1;
  try {
    code = await runMigration(parseArgs(process.argv.slice(2)), { out: (l) => void process.stdout.write(`${l}\n`) });
  } catch (e) {
    process.stderr.write(`migrate-settings: ${(e as Error).message}\n`);
  }
  process.exit(code);
}
