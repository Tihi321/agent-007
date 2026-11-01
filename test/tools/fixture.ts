/** Shared fixtures for the Slice 2 tests: a temp tree under `.claude/temp`, junction and symlink helpers. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BuiltinDenies } from "../../src/config/paths.js";
import type { LimitsConfig } from "../../src/config/schema.js";

export function tempBase(prefix: string): string {
  const parent = resolve(process.cwd(), ".claude", "temp");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, `${prefix}-`));
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // best effort
  }
}

export function put(path: string, content: string | Buffer = "x"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** `mklink /J link target`: needs no admin. Node reports it as a symbolic link. */
export function junction(link: string, target: string): void {
  mkdirSync(dirname(link), { recursive: true });
  execFileSync("cmd.exe", ["/d", "/c", "mklink", "/J", link, target], { stdio: "ignore", windowsHide: true });
}

/** Returns false (instead of throwing) when symlinks are not permitted (no developer mode). */
export function trySymlink(link: string, target: string, type: "file" | "dir"): boolean {
  try {
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, type);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return false;
    throw e;
  }
}

/** The 8.3 short form of an existing path, or undefined when the volume has no 8.3 names. */
export function shortPath(path: string): string | undefined {
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"for %I in ("${path}") do @echo %~sI"`], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
  const out = (r.stdout ?? "").trim();
  return r.status === 0 && out.includes("~") ? out : undefined;
}

export const NO_DENIES: BuiltinDenies = { ntfs: [], inProcessOnly: [], inProcessOnlyExceptions: [] };

export const LIMITS: LimitsConfig = { readFileBytes: 32768, searchMaxFiles: 5000, listMaxEntries: 500, searchMaxResults: 200 };
