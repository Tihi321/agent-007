/**
 * The `main` migration (S20.1, I30, I43): COPIES the Phase 1 to 3 state of the one agent into `bots\main\` and leaves the old files
 * where they are until the user deletes them. Nothing is moved, rewritten or deleted.
 *
 *   old (legacy layout)                         new
 *   <data>\state\agent.sqlite(-wal,-shm)   ->   <data>\bots\main\state\agent.sqlite(-wal,-shm)   (after a backup copy)
 *   <data>\memory\MEMORY.md                ->   <data>\bots\main\memory\MEMORY.md
 *   <data>\workspace\                      ->   <data>\bots\main\workspace\
 *   <data>\prefs\ (prefs.json, personas)   ->   <data>\bots\main\prefs\
 *   <data>\skills\ (if any)                ->   <data>\bots\main\skills\
 *   logs, audit, control and run stay where they are (the audit, the kill-switch flag and the lock are host-wide).
 *
 * The agent must be stopped: the migration takes the single-instance lock for its whole run (a running agent makes it refuse, and
 * an agent started meanwhile exits with code 3). The SQLite files are copied as a set while nobody has them open, so the copy is
 * byte-identical (checked by SHA-256) and the old files are never opened, checkpointed or touched; the destination is then opened
 * once with `PRAGMA integrity_check`. A backup copy of the set is written into `<data>\state\pre-bots-<UTC time>\` first.
 *
 * Idempotent: a second run finds `bots\main\state\agent.sqlite` and does nothing.
 *
 * The migration does NOT write `security.json` (only the settings UI does, I25): `mainBotDoc` returns the `bots.main` block to
 * enter there; until it is entered the agent keeps the legacy layout (`parseBots` returns the implicit main).
 */
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import { acquireLock } from "../runtime/lock.js";
import { botDirs, botPaths } from "./paths.js";
import type { BotPaths } from "./paths.js";
import { MAIN_BOT_ID } from "./schema.js";
import type { ResolvedBot } from "./schema.js";

const SQLITE_SET = ["agent.sqlite", "agent.sqlite-wal", "agent.sqlite-shm"] as const;

export type MigrationStepKind = "backup-sqlite" | "copy-sqlite" | "copy-file" | "copy-dir" | "mkdir";

export interface MigrationStep {
  kind: MigrationStepKind;
  from?: string;
  to: string;
  note: string;
}

export interface BotMigrationPlan {
  /** `bots\main\state\agent.sqlite` already exists: nothing to do. */
  alreadyMigrated: boolean;
  refusals: string[];
  steps: MigrationStep[];
  source: BotPaths;
  target: BotPaths;
}

export interface BotMigrationOptions {
  dataDir: string;
  /** The folder with `agent.lock` (`paths.runDir`). */
  runDir: string;
  now?: () => Date;
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export function planBotMigration(o: BotMigrationOptions): BotMigrationPlan {
  const source = botPaths(o.dataDir, MAIN_BOT_ID, "legacy");
  const target = botPaths(o.dataDir, MAIN_BOT_ID, "bots");
  const plan: BotMigrationPlan = { alreadyMigrated: false, refusals: [], steps: [], source, target };
  if (existsSync(target.storageFile)) {
    plan.alreadyMigrated = true;
    return plan;
  }
  const now = (o.now ?? (() => new Date()))();
  const backupDir = win32.join(source.stateDir, `pre-bots-${stamp(now)}`);
  const haveSqlite = existsSync(source.storageFile);
  for (const d of botDirs(target)) plan.steps.push({ kind: "mkdir", to: d, note: "create" });
  if (haveSqlite) {
    for (const f of SQLITE_SET) {
      const from = win32.join(source.stateDir, f);
      if (existsSync(from)) plan.steps.push({ kind: "backup-sqlite", from, to: win32.join(backupDir, f), note: "backup copy before the migration" });
    }
    for (const f of SQLITE_SET) {
      const from = win32.join(source.stateDir, f);
      if (existsSync(from)) plan.steps.push({ kind: "copy-sqlite", from, to: win32.join(target.stateDir, f), note: "byte copy, SHA-256 checked" });
    }
  } else {
    plan.steps.push({ kind: "mkdir", to: target.stateDir, note: "no Phase 1 to 3 storage found: a fresh one is created at start" });
  }
  if (existsSync(source.memoryFile)) plan.steps.push({ kind: "copy-file", from: source.memoryFile, to: target.memoryFile, note: "MEMORY.md" });
  for (const [from, to, note] of [
    [source.workspaceDir, target.workspaceDir, "workspace"],
    [source.prefsDir, target.prefsDir, "prefs and persona drafts"],
    [source.skillsDir, target.skillsDir, "skills"],
  ] as const) {
    if (existsSync(from) && statSync(from).isDirectory()) plan.steps.push({ kind: "copy-dir", from, to, note });
  }
  return plan;
}

export function formatBotMigrationPlan(plan: BotMigrationPlan): string[] {
  if (plan.alreadyMigrated) return [`bots\\main already has its storage (${plan.target.storageFile}): nothing to do.`];
  const lines = ["Copy plan (the old files stay where they are; nothing is deleted or changed):"];
  for (const s of plan.steps) lines.push(`  ${s.kind.padEnd(13)} ${s.from ? `${s.from} -> ` : ""}${s.to}  (${s.note})`);
  for (const r of plan.refusals) lines.push(`REFUSED: ${r}`);
  if (plan.refusals.length === 0) lines.push("Ready. Stop the agent, then run again with --apply.");
  return lines;
}

const sha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

export interface BotMigrationResult {
  copied: string[];
  integrity?: string;
  note: string;
}

/** Runs the plan. Throws on a failed hash or integrity check and leaves the old files untouched; the partial copy may be deleted by hand. */
export async function applyBotMigration(plan: BotMigrationPlan, o: BotMigrationOptions): Promise<BotMigrationResult> {
  if (plan.alreadyMigrated) return { copied: [], note: "already migrated" };
  if (plan.refusals.length > 0) throw new Error(`migration refused: ${plan.refusals.join("; ")}`);
  // Throws LockHeldError while an agent runs; an agent that starts meanwhile finds the lock and exits with code 3.
  const lock = acquireLock(win32.join(o.runDir, "agent.lock"));
  const copied: string[] = [];
  try {
    for (const s of plan.steps) {
      if (s.kind === "mkdir") {
        mkdirSync(s.to, { recursive: true });
      } else if (s.kind === "backup-sqlite" || s.kind === "copy-sqlite") {
        mkdirSync(win32.dirname(s.to), { recursive: true });
        if (existsSync(s.to)) throw new Error(`refusing to overwrite ${s.to}`);
        copyFileSync(s.from as string, s.to);
        if (sha(s.from as string) !== sha(s.to)) throw new Error(`the copy of ${s.from} does not match the original (SHA-256)`);
        copied.push(s.to);
      } else if (s.kind === "copy-file") {
        mkdirSync(win32.dirname(s.to), { recursive: true });
        if (existsSync(s.to)) throw new Error(`refusing to overwrite ${s.to}`);
        copyFileSync(s.from as string, s.to);
        copied.push(s.to);
      } else {
        // cpSync never follows a link out of the tree (`dereference` is false) and never overwrites (`force` is false).
        cpSync(s.from as string, s.to, { recursive: true, force: false, errorOnExist: true, dereference: false });
        copied.push(s.to);
      }
    }
    let integrity: string | undefined;
    if (existsSync(plan.target.storageFile)) {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(plan.target.storageFile);
      try {
        const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
        integrity = row?.integrity_check ?? "unknown";
      } finally {
        db.close();
      }
      if (integrity !== "ok") throw new Error(`the copied storage failed PRAGMA integrity_check: ${integrity}`);
    }
    writeFileSync(
      win32.join(plan.target.root, "migrated-from-phase3.json"),
      `${JSON.stringify({ at: (o.now ?? (() => new Date()))().toISOString(), from: plan.source.root, files: copied.length, integrity: integrity ?? "(no storage)" }, null, 2)}\n`,
    );
    return { copied, ...(integrity ? { integrity } : {}), note: "copied; the old files were left in place. Delete them yourself once you have checked the bots\\main bot." };
  } finally {
    lock.release();
  }
}

/**
 * The start-up guard of the manager: an install whose `security.json` has an explicit `bots.main` (layout `bots`) but whose Phase 1 to
 * 3 state has not been copied would start `main` with an EMPTY memory and conversations. Returns the refusal text, or undefined.
 */
export function checkMainMigrated(dataDir: string): string | undefined {
  const legacy = botPaths(dataDir, MAIN_BOT_ID, "legacy");
  const target = botPaths(dataDir, MAIN_BOT_ID, "bots");
  if (existsSync(legacy.storageFile) && !existsSync(target.storageFile)) {
    return `bot main has no storage at ${target.storageFile} but the Phase 1 to 3 storage exists at ${legacy.storageFile}: run scripts\\migrate-bots (copies it, leaves the old files) before starting`;
  }
  return undefined;
}

/** The `bots.main` block to enter in the settings UI for an install that has no `bots` yet (a copy of the implicit main). */
export function mainBotDoc(main: ResolvedBot): Record<string, unknown> {
  return {
    description: main.description,
    telegramTokenRef: main.telegramTokenRef,
    route: { primary: main.route.primary, allowed: [...main.route.allowed], fallback: [...main.route.fallback], onAuthRequired: main.route.onAuthRequired },
    tools: [...main.tools],
    readRoots: main.readRoots.map((r) => ({ ...r })),
    cloudSafeRoots: main.cloudSafeRoots.map((r) => ({ ...r })),
    shared: { read: main.shared.read },
    edges: [],
  };
}
