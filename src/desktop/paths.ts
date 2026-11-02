/**
 * Paths and launcher settings for the desktop launcher (no electron import).
 * Root: AGENT007_HOME, else the folder in `%LOCALAPPDATA%\agent-007\root.json`, else `%LOCALAPPDATA%\agent-007`.
 * The pointer file and the Electron userData folder always stay in the default location so the launcher can find them.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_GATEWAY_PORT = 47009;
export const JOBRUNNER_IPC_PORT = 47007;
export const JOBRUNNER_UI_PORT = 47008;

export interface LauncherSettings {
  port: number;
  telegram: boolean;
  jobrunner: boolean;
  launchAtLogin: boolean;
}

export const DEFAULT_LAUNCHER: LauncherSettings = { port: DEFAULT_GATEWAY_PORT, telegram: false, jobrunner: false, launchAtLogin: false };

/** `%LOCALAPPDATA%\agent-007` (the default root, and where the pointer file and Electron userData live). */
export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  const local = env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local");
  return join(local, "agent-007");
}

export function pointerFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultHome(env), "root.json");
}

export interface ResolvedRoot {
  root: string;
  source: "env" | "pointer" | "default";
}

export function resolveRoot(env: NodeJS.ProcessEnv = process.env): ResolvedRoot {
  const fromEnv = env["AGENT007_HOME"];
  if (fromEnv && isAbsolute(fromEnv)) return { root: resolve(fromEnv), source: "env" };
  try {
    const v = JSON.parse(readFileSync(pointerFile(env), "utf8")) as { root?: unknown };
    if (typeof v.root === "string" && isAbsolute(v.root)) return { root: resolve(v.root), source: "pointer" };
  } catch {
    /* no pointer, or unreadable: the default root */
  }
  return { root: defaultHome(env), source: "default" };
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/** Written only when the user picked a folder. */
export function writeRootPointer(root: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isAbsolute(root)) throw new Error("the data folder must be an absolute path");
  writeJsonAtomic(pointerFile(env), { root: resolve(root) });
}

export function launcherFile(root: string): string {
  return join(root, "launcher.json");
}

function validPort(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1024 && v <= 65535;
}

export function readLauncherSettings(root: string): LauncherSettings {
  const s: LauncherSettings = { ...DEFAULT_LAUNCHER };
  try {
    const v = JSON.parse(readFileSync(launcherFile(root), "utf8")) as Record<string, unknown>;
    if (validPort(v["port"])) s.port = v["port"];
    if (typeof v["telegram"] === "boolean") s.telegram = v["telegram"];
    if (typeof v["jobrunner"] === "boolean") s.jobrunner = v["jobrunner"];
    if (typeof v["launchAtLogin"] === "boolean") s.launchAtLogin = v["launchAtLogin"];
  } catch {
    /* missing or unreadable: defaults */
  }
  return s;
}

export function writeLauncherSettings(root: string, s: LauncherSettings): void {
  writeJsonAtomic(launcherFile(root), s);
}

/** Dev override of the gateway port (smoke tests). Ignored unless it is a valid port. */
export function portOverride(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const n = Number(env["AGENT007_PORT"]);
  return validPort(n) ? n : undefined;
}

export interface Layout {
  /** The folder with `dist\`, `prompts\`, `config\*.example.json`, `node_modules\` (repo root in dev, `resources\app` when packaged). */
  appDir: string;
  /** `node.exe` for the services. */
  nodeExe: string;
  /** Compiled launcher folder (`dist\src\desktop`): holds main.js and preload.cjs. */
  desktopDir: string;
  /** Tray icons: `<app>\assets\desktop` (inside app.asar when packaged: the build must list assets/desktop/** in `files`). */
  assetsDir: string;
  /** `dist\ui\desktop` (inside app.asar when packaged). */
  uiDir: string;
}

/**
 * @param o.desktopDir the folder of the compiled main.js (`dist/src/desktop`). The launcher's own files sit at the same relative
 * places in dev and in app.asar: `../../../assets/desktop` and `../../ui/desktop`.
 */
export function resolveLayout(o: { desktopDir: string; isPackaged: boolean; resourcesPath: string; env?: NodeJS.ProcessEnv }): Layout {
  const env = o.env ?? process.env;
  const base = {
    desktopDir: o.desktopDir,
    assetsDir: join(o.desktopDir, "..", "..", "..", "assets", "desktop"),
    uiDir: join(o.desktopDir, "..", "..", "ui", "desktop"),
  };
  if (o.isPackaged) {
    return { ...base, appDir: join(o.resourcesPath, "app"), nodeExe: join(o.resourcesPath, "node", "node.exe") };
  }
  const nodeExe = env["AGENT007_NODE"] || env["npm_node_execpath"] || "node";
  return { ...base, appDir: resolve(o.desktopDir, "..", "..", ".."), nodeExe };
}

export function servicePaths(layout: Layout): { web: string; webCli: string; agent: string; jobrunner: string } {
  const src = join(layout.appDir, "dist", "src");
  return { web: join(src, "web", "main.js"), webCli: join(src, "web", "cli.js"), agent: join(src, "main.js"), jobrunner: join(src, "jobrunner", "main.js") };
}

export function setupDone(root: string): boolean {
  return existsSync(join(root, "config", "config.json"));
}
