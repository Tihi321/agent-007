/**
 * S1 (P0.4): SQLite storage on Windows paths, including a path with spaces.
 * `openNodeSqliteStorage(<windows path>)`, `Harness.open` with no model, create the root conversation, commit an
 * entry, close, reopen, read the entry back. Also run once under `%LOCALAPPDATA%\agent-007-smoke\a7.sqlite`.
 * PASS: the entry reads back after reopen, `-wal`/`-shm` files appear, no throw. Any ExperimentalWarning is recorded.
 * Does not need a model runner.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, Harness, createModels, createRegistry, openNodeSqliteStorage } from "../../src/pi/adapter.js";
import { finish, isMain, loadSmokeRunner, parseArgs, smokeOutDir } from "./config.js";
import type { SmokeOutcome } from "./config.js";
import { allEntries, errMessage } from "./common.js";
import type { RunnerName } from "../../src/config/schema.js";

const ctx = BACKGROUND_CONTEXT;

async function onePath(path: string, warnings: string[]): Promise<{ path: string; ok: boolean; walSeen: boolean; shmSeen: boolean; note: string }> {
  mkdirSync(dirname(path), { recursive: true });
  for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
  const marker = `s1-marker-${Date.now()}`;
  let walSeen = false;
  let shmSeen = false;
  try {
    const open = async () => Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, ctx);
    const h1 = await open();
    const root1 = await h1.root(ctx);
    const sub = await root1.submit({ type: "write", entry: { kind: "app.note", data: marker } }, ctx);
    await sub.wait(ctx);
    walSeen = existsSync(`${path}-wal`);
    shmSeen = existsSync(`${path}-shm`);
    await h1.close(ctx);

    const h2 = await open();
    const root2 = await h2.root(ctx);
    const entries = await allEntries(root2);
    await h2.close(ctx);
    const found = entries.some((e) => e.kind === "app.note" && e.data === marker);
    return { path, ok: found && walSeen && shmSeen, walSeen, shmSeen, note: found ? "entry read back after reopen" : "entry NOT found after reopen" };
  } catch (e) {
    return { path, ok: false, walSeen, shmSeen, note: `threw: ${errMessage(e)}` };
  }
}

export interface S1Options {
  /** Directories under which to create the two databases. */
  withSpacesDir?: string;
  localAppDataDir?: string;
}

/** The ExperimentalWarning fires once, when node:sqlite is first loaded, so it is captured in a fresh process. */
function sqliteWarningText(): string {
  const r = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], { encoding: "utf8", windowsHide: true });
  const line = (r.stderr ?? "").split(String.fromCharCode(10)).find((l) => /ExperimentalWarning/.test(l));
  return line ? line.replace(/^\(node:\d+\) /, "") : "none";
}

export async function run(runner: RunnerName, opts: S1Options = {}): Promise<SmokeOutcome> {
  const warnings: string[] = [];
  const onWarning = (w: Error) => warnings.push(`${w.name}: ${w.message}`);
  process.on("warning", onWarning);
  const spaces = opts.withSpacesDir ?? join(smokeOutDir(), "dir with space");
  const local = opts.localAppDataDir ?? join(process.env["LOCALAPPDATA"] ?? smokeOutDir(), "agent-007-smoke");
  const results = [await onePath(join(spaces, "a7.sqlite"), warnings), await onePath(join(local, "a7.sqlite"), warnings)];
  await new Promise((r) => setTimeout(r, 50));
  process.off("warning", onWarning);
  const pass = results.every((r) => r.ok);
  return {
    id: "S1",
    runner,
    pass,
    reason: pass ? "entry read back after reopen on both paths; -wal/-shm appeared" : results.filter((r) => !r.ok).map((r) => `${r.path}: ${r.note} (wal=${r.walSeen}, shm=${r.shmSeen})`).join("; "),
    details: { results, warnings: [...new Set(warnings)], sqliteExperimentalWarning: sqliteWarningText(), node: process.version },
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  finish(await run(loadSmokeRunner(args).runner));
}
