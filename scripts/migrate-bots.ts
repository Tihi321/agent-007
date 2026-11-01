/**
 * `migrate-bots` (S20.1, I30, I43): COPIES the Phase 1 to 3 state of the one agent into `<data>\bots\main\` and leaves the old files
 * where they are. The USER runs it as the AGENT user [GO], with the agent stopped (it takes the agent's single-instance lock).
 *
 *   node dist/scripts/migrate-bots.js --config <config.json>             dry run (default): the copy plan and the bots.main block
 *   node dist/scripts/migrate-bots.js --config <config.json> --apply     back up the SQLite set, copy, check, print what to do next
 *
 * It does NOT write `security.json` (only the settings UI does, I25): it prints the `bots.main` block to enter there. Until that block
 * exists the agent keeps using the old folders, so nothing changes by running this. Nothing is deleted: remove the old `state\`,
 * `memory\`, `workspace\` and `prefs\` yourself once the migrated bot has run well.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyBotMigration, formatBotMigrationPlan, mainBotDoc, planBotMigration } from "../src/bots/migrate.js";
import { parseBots } from "../src/bots/schema.js";
import { ConfigError, defaultsFromEnv, parseConfig } from "../src/config/schema.js";
import type { DefaultsEnv } from "../src/config/schema.js";
import { composeRawConfig } from "../src/settings/load.js";

export interface BotMigrateArgs {
  config: string;
  apply: boolean;
}

export function parseArgs(argv: readonly string[]): BotMigrateArgs {
  const a: BotMigrateArgs = { config: "", apply: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i] as string;
    if (k === "--config") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error("--config needs a value");
      a.config = v;
    } else if (k === "--apply") a.apply = true;
    else throw new Error(`unknown argument ${JSON.stringify(k)}`);
  }
  if (a.config === "") throw new Error("--config <path to config.json> is required");
  return a;
}

export interface BotMigrateIo {
  out: (line: string) => void;
  now?: () => Date;
  env?: DefaultsEnv;
  /** Test seam: the text of config.json (default: read from disk). */
  readConfig?: (path: string) => string;
  readFile?: (path: string) => string;
}

/** Returns the exit code: 0 done or nothing to do, 1 refused or failed. */
export async function runBotMigration(args: BotMigrateArgs, io: BotMigrateIo): Promise<number> {
  const env = io.env ?? defaultsFromEnv();
  const read = io.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let composed;
  let config;
  try {
    composed = composeRawConfig((io.readConfig ?? read)(resolve(args.config)), { env, readFile: read });
    config = parseConfig(composed.raw, env);
  } catch (e) {
    io.out(`REFUSED: ${e instanceof ConfigError ? e.message : (e as Error).message}`);
    return 1;
  }
  const sec = composed.security;
  const model = (sec?.["model"] ?? {}) as { defaultPreset?: string; runner?: string };
  const defaultPreset = model.defaultPreset ?? config.model.runner;
  const main = parseBots(sec, { folderAllow: config.folders.allow, derivedPresets: [], defaultPreset }).bots.find((b) => b.id === "main");
  const plan = planBotMigration({ dataDir: config.paths.dataDir, runDir: config.paths.runDir, ...(io.now ? { now: io.now } : {}) });
  for (const l of formatBotMigrationPlan(plan)) io.out(l);
  if (main && !plan.alreadyMigrated) {
    const doc = mainBotDoc(main.route.allowed.length > 0 ? main : { ...main, route: { ...main.route, allowed: [main.route.primary] } });
    io.out("");
    io.out("After the copy, enter this as bots.main in the settings UI (the agent then uses bots\\main; until then nothing changes):");
    io.out(JSON.stringify({ bots: { main: doc } }, null, 2));
  }
  if (plan.refusals.length > 0) return 1;
  if (!args.apply) {
    if (!plan.alreadyMigrated) io.out("Dry run: nothing was copied.");
    return 0;
  }
  try {
    const r = await applyBotMigration(plan, { dataDir: config.paths.dataDir, runDir: config.paths.runDir, ...(io.now ? { now: io.now } : {}) });
    io.out(`${r.copied.length} item(s) copied${r.integrity ? `; PRAGMA integrity_check: ${r.integrity}` : ""}. ${r.note}`);
    return 0;
  } catch (e) {
    io.out(`FAILED: ${(e as Error).message}. The old files were not changed; a partial copy under ${plan.target.root} may be deleted by hand before trying again.`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let args: BotMigrateArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`migrate-bots: ${(e as Error).message}\n`);
    process.exit(2);
  }
  runBotMigration(args, { out: (l) => void process.stdout.write(`${l}\n`) }).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`migrate-bots: ${String(e)}\n`);
      process.exit(1);
    },
  );
}
