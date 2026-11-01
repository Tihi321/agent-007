/**
 * Windows path helpers and the built-in deny lists (S1.2).
 *
 * The lists are exported separately because S7 treats them differently:
 *  - (a) `ntfs`: user-data paths. In-process deny PLUS an NTFS Deny Read ACE.
 *  - (b) `inProcessOnly`: paths the agent process or the Strata task must still read.
 *        In-process deny only, never an NTFS Deny Read.
 * The path policy itself (canonicalisation, junctions, deny-wins) is Slice 2; it consumes these lists.
 */
import { win32 } from "node:path";
import type { Config } from "./schema.js";

export interface BuiltinDenies {
  /** (a) In-process deny plus NTFS Deny Read ACE. Includes `folders.deny` (UI-2). */
  ntfs: string[];
  /** (b) In-process deny only. Never an NTFS Deny Read. */
  inProcessOnly: string[];
  /** Carve-outs inside list (b): the agent data root is denied except these (the workspace). */
  inProcessOnlyExceptions: string[];
}

/** Lower-cased, resolved, no trailing separator: the comparison form for Windows paths. */
export function normalizeWin(p: string): string {
  let r = win32.resolve(p);
  while (r.length > 3 && (r.endsWith("\\") || r.endsWith("/"))) r = r.slice(0, -1);
  return r.toLowerCase();
}

/** True if `child` equals `parent` or is inside it (case-insensitive, separator-aware). */
export function isSameOrUnder(child: string, parent: string): boolean {
  const c = normalizeWin(child);
  const p = normalizeWin(parent);
  if (c === p) return true;
  const prefix = p.endsWith("\\") ? p : p + "\\";
  return c.startsWith(prefix);
}

export function builtinDenies(config: Config): BuiltinDenies {
  const strata = config.model.runners.strata;
  const ntfs = dedupe([win32.join(config.mainUserProfile, ".lmstudio"), ...config.folders.deny]);
  const inProcessOnly = dedupe([
    config.paths.programDataDir, // config dir, secrets dir, Strata config copy (holds the key), Strata log dir
    config.paths.dataDir, // agent data root (state, logs, audit, control, run, memory), except the workspace
    strata?.installDir ?? "D:\\Strata",
    strata?.dataDir ?? "D:\\Strata-data",
    strata?.configFile ?? win32.join(config.paths.programDataDir, "strata", "strata.json"),
    strata?.logDir ?? win32.join(config.paths.programDataDir, "logs"),
  ]);
  return { ntfs, inProcessOnly, inProcessOnlyExceptions: [config.paths.workspaceDir] };
}

/** True if the two lists share an entry (they must not). */
export function denyListsOverlap(d: BuiltinDenies): boolean {
  const a = new Set(d.ntfs.map(normalizeWin));
  return d.inProcessOnly.some((p) => a.has(normalizeWin(p)));
}

/**
 * True if `candidate` is refused by the built-in denies, with `folders.deny` included in list (a).
 * List (b) honours its exceptions; list (a) never does (deny wins).
 */
export function isBuiltinDenied(candidate: string, d: BuiltinDenies): boolean {
  if (d.ntfs.some((p) => isSameOrUnder(candidate, p))) return true;
  const hit = d.inProcessOnly.some((p) => isSameOrUnder(candidate, p));
  if (!hit) return false;
  return !d.inProcessOnlyExceptions.some((e) => isSameOrUnder(candidate, e));
}

/** Hostname of a URL is loopback: `127.0.0.1`, `localhost` (the plan also refuses everything else). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost";
  } catch {
    return false;
  }
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    const k = normalizeWin(i);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(i);
    }
  }
  return out;
}
