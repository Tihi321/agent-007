/**
 * Per-bot folders and the shared, read-only folder (S20.1, S20.3, I43).
 *
 *   <dataDir>\bots\<botId>\state\agent.sqlite*   that bot's Pi storage (its own Harness)
 *                         memory\MEMORY.md       `remember` writes here and nowhere else
 *                         skills\                read by the bot; written only through `propose_*`
 *                         workspace\ logs\ prefs\
 *   <programDataDir>\shared\FACTS.md, skills\    written only by the user or an admin (agent R, no W); read by bots with shared.read
 *
 * The implicit `main` of a Phase 1 to 3 install keeps `layout: "legacy"`: its folders are the data root's own `state\`, `memory\`,
 * `workspace\`, `logs\` and `prefs\`, so a one-bot install behaves exactly as before until the user runs the migration (`migrate.ts`).
 *
 * Pure: `node:path` only.
 */
import { win32 } from "node:path";
import { normalizeWin } from "../config/paths.js";
import type { BotPathScope } from "../tools/pathPolicy.js";
import type { ResolvedBot } from "./schema.js";

export interface BotPaths {
  id: string;
  layout: "legacy" | "bots";
  root: string;
  stateDir: string;
  /** `state\agent.sqlite` (the `-wal` and `-shm` files sit next to it). */
  storageFile: string;
  memoryDir: string;
  memoryFile: string;
  skillsDir: string;
  workspaceDir: string;
  logsDir: string;
  prefsDir: string;
  prefsFile: string;
}

export function botsRootDir(dataDir: string): string {
  return win32.join(dataDir, "bots");
}

export function botPaths(dataDir: string, id: string, layout: "legacy" | "bots" = "bots"): BotPaths {
  const root = layout === "legacy" ? dataDir : win32.join(botsRootDir(dataDir), id);
  const stateDir = win32.join(root, "state");
  const memoryDir = win32.join(root, "memory");
  const prefsDir = win32.join(root, "prefs");
  return {
    id,
    layout,
    root,
    stateDir,
    storageFile: win32.join(stateDir, "agent.sqlite"),
    memoryDir,
    memoryFile: win32.join(memoryDir, "MEMORY.md"),
    skillsDir: win32.join(root, "skills"),
    workspaceDir: win32.join(root, "workspace"),
    logsDir: win32.join(root, "logs"),
    prefsDir,
    prefsFile: win32.join(prefsDir, "prefs.json"),
  };
}

export interface SharedPaths {
  dir: string;
  factsFile: string;
  skillsDir: string;
}

/** `C:\ProgramData\agent-007\shared`: the ACL is the `config\` pattern (agent R, no W); `check-acl.ps1` reports a writable one. */
export function sharedPaths(programDataDir: string): SharedPaths {
  const dir = win32.join(programDataDir, "shared");
  return { dir, factsFile: win32.join(dir, "FACTS.md"), skillsDir: win32.join(dir, "skills") };
}

/** Every folder a bot owns and creates at start (not `shared`, which an admin owns). */
export function botDirs(p: BotPaths): string[] {
  return [p.root, p.stateDir, p.memoryDir, p.skillsDir, p.workspaceDir, p.logsDir, p.prefsDir];
}

/** True if two bots would use the same storage file (never true for distinct ids; a guard for hand-edited paths). */
export function sameStorage(a: BotPaths, b: BotPaths): boolean {
  return normalizeWin(a.storageFile) === normalizeWin(b.storageFile);
}

/**
 * What the path policy needs about one bot (S20.3). `extraDeny` carries the settings folder and the secrets folder when they are
 * not under `programDataDir` (a hand-edited layout); inside it they are denied already.
 */
export function botPathScope(dataDir: string, programDataDir: string, bot: Pick<ResolvedBot, "id" | "layout" | "shared">, extraDeny: readonly string[] = []): BotPathScope {
  const p = botPaths(dataDir, bot.id, bot.layout);
  return {
    botId: bot.id,
    botsRoot: botsRootDir(dataDir),
    ownRoot: p.root,
    workspaceDir: p.workspaceDir,
    skillsDir: p.skillsDir,
    ...(bot.shared.read ? { sharedDir: sharedPaths(programDataDir).dir } : {}),
    extraDeny: [...extraDeny],
  };
}
