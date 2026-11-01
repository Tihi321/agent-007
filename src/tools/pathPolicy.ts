/**
 * In-process path policy (S2.1): the primary control for folder access (NTFS is only a backstop, plan 4.2).
 *
 * Order of checks for every path a tool receives:
 *  1. Reject by syntax, before touching the filesystem: `\\?\`, `\\.\`, UNC, rooted-without-drive, device names,
 *     alternate data streams (any `:` after the drive), trailing dots or spaces in a segment, NUL and control characters.
 *  2. `path.resolve` against the alias root, then a lexical containment check (so `..` escapes never reach the disk).
 *  3. `realpathSync.native` of the target; for a target that does not exist yet (a write), the nearest existing parent
 *     plus the remaining segments. Junctions, symlinks and 8.3 names are expanded here.
 *  4. Case-insensitive containment of the real path in the real root, with a separator boundary.
 *  5. Deny list (built-in groups (a) and (b) from `config/paths.ts`, which already carries `folders.deny`), compared
 *     in BOTH the lexical and the real form, case-insensitively. Deny wins over allow.
 *  6. Walks use `readDirSafe`, which `lstat`s every entry and never follows symlinks or junctions.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { win32 } from "node:path";
import type { BuiltinDenies } from "../config/paths.js";
import { builtinDenies, isSameOrUnder, normalizeWin } from "../config/paths.js";
import type { Config } from "../config/schema.js";

export type PathPolicyErrorCode = "invalid" | "unknown_alias" | "outside" | "denied" | "unavailable";

/** A refusal whose message is safe to show to the model. */
export class PathPolicyError extends Error {
  readonly code: PathPolicyErrorCode;
  constructor(code: PathPolicyErrorCode, message: string) {
    super(message);
    this.name = "PathPolicyError";
    this.code = code;
  }
}

export interface PolicyRoot {
  alias: string;
  path: string;
}

export interface ResolvedPath {
  /** The raw input the model gave. */
  input: string;
  root: PolicyRoot;
  /** Real (canonical) path of the root. */
  rootReal: string;
  /** Lexical absolute path (after `path.resolve`, before symlink expansion). */
  lexical: string;
  /** Real path of the target, or nearest existing parent plus the missing tail. Use this for every filesystem call. */
  real: string;
  /** True if the target itself exists. */
  exists: boolean;
  /** Path relative to the real root, forward slashes, `""` for the root itself. */
  rel: string;
  /** Display form `alias:rel`. */
  display: string;
}

export type DenyMatcher = (absPath: string) => boolean;

export interface PathPolicy {
  readonly roots: readonly PolicyRoot[];
  /** Validates, resolves and checks a path. Throws `PathPolicyError`. */
  resolve(input: string): ResolvedPath;
  /** A deny check over a snapshot of the deny list (real forms are computed now). Cheap to call per entry. */
  denyMatcher(): DenyMatcher;
  /** Alias display form of a real path inside `resolved`'s root. */
  displayFor(resolved: ResolvedPath, realChild: string): string;
}

// ---------------------------------------------------------------------------------------------
// Syntax checks (no filesystem)
// ---------------------------------------------------------------------------------------------

const MAX_INPUT_LENGTH = 1024;
const ILLEGAL_CHARS = /[<>"|?*]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i;
const NTFS_METAFILE = /^\$(mft|mftmirr|logfile|volume|attrdef|bitmap|boot|badclus|secure|upcase|extend|recycle\.bin)(\.|$)/i;

export type ParsedPath =
  | { kind: "alias"; alias: string; segments: string[] }
  | { kind: "absolute"; drive: string; segments: string[] }
  | { kind: "relative"; segments: string[] };

function checkSegments(segments: string[], original: string): void {
  for (const seg of segments) {
    if (seg === "." || seg === "..") continue;
    if (seg.endsWith(".") || seg.endsWith(" ")) throw new PathPolicyError("invalid", `invalid path ${shorten(original)}: a name ends with a dot or a space.`);
    // Windows treats `NUL.txt` and `CON .txt` as the device too.
    const base = (seg.split(".")[0] ?? "").trimEnd();
    if (DEVICE_NAME.test(base)) throw new PathPolicyError("invalid", `invalid path ${shorten(original)}: device names are not allowed.`);
    if (NTFS_METAFILE.test(seg)) throw new PathPolicyError("invalid", `invalid path ${shorten(original)}: NTFS system names are not allowed.`);
  }
}

function shorten(s: string): string {
  const flat = s.replace(/[\u0000-\u001f\u007f]/g, "?");
  return JSON.stringify(flat.length > 120 ? `${flat.slice(0, 120)}...` : flat);
}

/**
 * Pure syntax validation and parsing. `aliases` are the configured aliases (case-insensitive); `allowRelative` is for the
 * write policy, where a plain relative path means "inside the default root". Never touches the filesystem.
 */
export function parseToolPath(input: unknown, aliases: readonly string[], allowRelative: boolean): ParsedPath {
  if (typeof input !== "string") throw new PathPolicyError("invalid", "invalid path: expected a string.");
  if (input.length > MAX_INPUT_LENGTH) throw new PathPolicyError("invalid", "invalid path: too long.");
  if (input.includes("\u0000")) throw new PathPolicyError("invalid", "invalid path: NUL byte.");
  if (CONTROL_CHARS.test(input)) throw new PathPolicyError("invalid", "invalid path: control characters.");
  if (ILLEGAL_CHARS.test(input)) throw new PathPolicyError("invalid", `invalid path ${shorten(input)}: wildcard or reserved characters are not allowed.`);

  const p = input.replace(/\//g, "\\");
  // `\\?\`, `\\.\`, `\\server\share` and the NT form `\??\` / any rooted path without a drive.
  if (p.startsWith("\\")) {
    throw new PathPolicyError("invalid", `invalid path ${shorten(input)}: UNC, device and rooted paths are not allowed. Use alias:relative or a drive path.`);
  }

  const split = (rest: string): string[] => rest.split("\\").filter((s) => s !== "");
  const noStream = (rest: string): void => {
    if (rest.includes(":")) throw new PathPolicyError("invalid", `invalid path ${shorten(input)}: alternate data streams are not allowed.`);
  };

  // Drive absolute: `C:\...`
  const drive = /^([A-Za-z]):\\(.*)$/s.exec(p);
  if (drive) {
    const rest = drive[2] ?? "";
    noStream(rest);
    const segments = split(rest);
    checkSegments(segments, input);
    return { kind: "absolute", drive: `${(drive[1] ?? "").toUpperCase()}:`, segments };
  }

  // `alias:rel` (a bare `C:` or `C:foo` is a drive-relative path, refused unless `C` is an alias).
  const alias = /^([A-Za-z0-9_-]+):(.*)$/s.exec(p);
  if (alias) {
    const name = alias[1] ?? "";
    const known = aliases.find((a) => a.toLowerCase() === name.toLowerCase());
    if (known === undefined) {
      const list = aliases.length > 0 ? ` Allowed aliases: ${aliases.join(", ")}.` : "";
      throw new PathPolicyError("unknown_alias", `access denied: ${shorten(input)} is not inside an allowed folder.${list}`);
    }
    const rest = alias[2] ?? "";
    noStream(rest);
    const segments = split(rest);
    checkSegments(segments, input);
    return { kind: "alias", alias: known, segments };
  }

  if (!allowRelative) {
    throw new PathPolicyError("invalid", `invalid path ${shorten(input)}: use alias:relative or an absolute drive path.`);
  }
  noStream(p);
  const segments = split(p);
  checkSegments(segments, input);
  return { kind: "relative", segments };
}

// ---------------------------------------------------------------------------------------------
// Real paths
// ---------------------------------------------------------------------------------------------

function stripExtendedPrefix(p: string): string {
  return p.startsWith("\\\\?\\") && /^[A-Za-z]:/.test(p.slice(4)) ? p.slice(4) : p;
}

/** `realpathSync.native` of the nearest existing ancestor plus the missing tail. */
export function realpathBest(p: string): { real: string; exists: boolean } {
  const abs = win32.resolve(p);
  try {
    return { real: stripExtendedPrefix(realpathSync.native(abs)), exists: true };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
  }
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    const parent = win32.dirname(cur);
    if (parent === cur) throw new PathPolicyError("unavailable", "the drive or folder is not available.");
    tail.unshift(win32.basename(cur));
    cur = parent;
    try {
      const real = stripExtendedPrefix(realpathSync.native(cur));
      return { real: win32.join(real, ...tail), exists: false };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
    }
  }
}

function tryRealpathBest(p: string): string | undefined {
  try {
    return realpathBest(p).real;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Deny matching
// ---------------------------------------------------------------------------------------------

interface DenyEntry {
  forms: string[];
  /** Carve-outs (group (b) only). */
  exceptions: string[];
}

function formsOf(p: string): string[] {
  const out = [normalizeWin(p)];
  const real = tryRealpathBest(p);
  if (real !== undefined) {
    const n = normalizeWin(real);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function buildDenyMatcher(denies: BuiltinDenies): DenyMatcher {
  const exceptions = denies.inProcessOnlyExceptions.flatMap(formsOf);
  const entries: DenyEntry[] = [
    ...denies.ntfs.map((p) => ({ forms: formsOf(p), exceptions: [] as string[] })),
    ...denies.inProcessOnly.map((p) => ({ forms: formsOf(p), exceptions })),
  ];
  return (candidate: string): boolean => {
    for (const e of entries) {
      for (const d of e.forms) {
        if (!isSameOrUnder(candidate, d)) continue;
        if (e.exceptions.some((x) => isSameOrUnder(candidate, x))) continue;
        return true;
      }
    }
    return false;
  };
}

// ---------------------------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------------------------

export interface PathPolicyOptions {
  roots: readonly PolicyRoot[];
  denies: BuiltinDenies;
  /** If set, a plain relative path resolves inside this alias's root (the workspace write policy). */
  defaultAlias?: string;
}

export function createPathPolicy(opts: PathPolicyOptions): PathPolicy {
  const roots = opts.roots.map((r) => ({ ...r }));
  const aliasNames = roots.map((r) => r.alias);
  const defaultRoot = opts.defaultAlias !== undefined ? roots.find((r) => r.alias === opts.defaultAlias) : undefined;
  if (opts.defaultAlias !== undefined && !defaultRoot) throw new Error(`defaultAlias ${opts.defaultAlias} is not a root`);

  const toRel = (rootReal: string, real: string): string => {
    const rel = win32.relative(rootReal, real);
    return rel === "" ? "" : rel.replace(/\\/g, "/");
  };

  const denyMatcher = (): DenyMatcher => buildDenyMatcher(opts.denies);

  return {
    roots,
    denyMatcher,
    displayFor(resolved, realChild) {
      return `${resolved.root.alias}:${toRel(resolved.rootReal, realChild)}`;
    },
    resolve(input: string): ResolvedPath {
      const parsed = parseToolPath(input, aliasNames, defaultRoot !== undefined);

      let candidates: PolicyRoot[];
      let lexical: string;
      if (parsed.kind === "alias") {
        const root = roots.find((r) => r.alias === parsed.alias);
        if (!root) throw new PathPolicyError("unknown_alias", `access denied: ${shorten(input)} is not inside an allowed folder.`);
        candidates = [root];
        lexical = win32.resolve(root.path, ...parsed.segments);
      } else if (parsed.kind === "relative") {
        const root = defaultRoot as PolicyRoot;
        candidates = [root];
        lexical = win32.resolve(root.path, ...parsed.segments);
      } else {
        candidates = roots;
        lexical = win32.resolve(`${parsed.drive}\\`, ...parsed.segments);
      }

      const matcher = denyMatcher();
      let outsideSeen = false;
      for (const root of candidates) {
        const rootReal = tryRealpathBest(root.path);
        if (rootReal === undefined) continue;
        // Lexical containment first for alias and relative input: `..` escapes are refused before the target is touched.
        // (An absolute input skips it: it may legitimately name the root by an 8.3 short name or another alias form,
        // so only the real-path check below decides.)
        if (parsed.kind !== "absolute" && !isSameOrUnder(lexical, root.path) && !isSameOrUnder(lexical, rootReal)) {
          outsideSeen = true;
          continue;
        }
        const target = realpathBest(lexical);
        if (!isSameOrUnder(target.real, rootReal)) {
          outsideSeen = true; // a junction or symlink inside the root that points out of it
          continue;
        }
        // Deny wins: check the lexical form AND the real form.
        if (matcher(lexical) || matcher(target.real)) {
          throw new PathPolicyError("denied", `access denied: ${shorten(input)} is on the deny list.`);
        }
        const rel = toRel(rootReal, target.real);
        return { input, root, rootReal, lexical, real: target.real, exists: target.exists, rel, display: `${root.alias}:${rel}` };
      }
      if (!outsideSeen && candidates.length > 0 && roots.length > 0) {
        // Every candidate root was unavailable.
        throw new PathPolicyError("unavailable", "the folder is not available.");
      }
      const list = aliasNames.length > 0 ? ` Allowed aliases: ${aliasNames.join(", ")}.` : "";
      throw new PathPolicyError("outside", `access denied: ${shorten(input)} is not inside an allowed folder.${list}`);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// From config
// ---------------------------------------------------------------------------------------------

export const WORKSPACE_ALIAS = "workspace";

/** Read policy: the `folders.allow` roots; built-in denies plus `folders.deny` always apply. */
export function readPolicyFromConfig(config: Config, opts: { includeWorkspace?: boolean } = {}): PathPolicy {
  const roots: PolicyRoot[] = config.folders.allow.map((f) => ({ alias: f.alias, path: f.path }));
  if (opts.includeWorkspace && !roots.some((r) => r.alias.toLowerCase() === WORKSPACE_ALIAS)) {
    roots.push({ alias: WORKSPACE_ALIAS, path: config.paths.workspaceDir });
  }
  return createPathPolicy({ roots, denies: builtinDenies(config) });
}

/** Write policy: the workspace only. A plain relative path means "inside the workspace". */
export function writePolicyFromConfig(config: Config): PathPolicy {
  return createPathPolicy({
    roots: [{ alias: WORKSPACE_ALIAS, path: config.paths.workspaceDir }],
    denies: builtinDenies(config),
    defaultAlias: WORKSPACE_ALIAS,
  });
}

// ---------------------------------------------------------------------------------------------
// Phase 4: per-bot scope (S20.3, I43)
// ---------------------------------------------------------------------------------------------

/** What one bot may touch besides its allowlisted roots. Built by `src/bots/paths.ts`. */
export interface BotPathScope {
  botId: string;
  /** `<dataDir>\bots`: every bot's directory is under it. */
  botsRoot: string;
  /** This bot's own directory. */
  ownRoot: string;
  workspaceDir: string;
  skillsDir: string;
  /** `<programDataDir>\shared`, present only for a bot with `shared.read` (read-only: no write policy ever includes it). */
  sharedDir?: string;
  /** More in-process denies: the settings folder and the secrets folder when they are outside `programDataDir`. */
  extraDeny?: readonly string[];
}

/**
 * The deny lists for one bot: the host's built-in lists (which carry `folders.deny` for EVERY bot, and deny the whole data root,
 * `programDataDir` with `secrets` and `settings`, and the Strata paths), plus the whole `bots` root and the extra folders, with
 * carve-outs for this bot's OWN workspace and skills (and the shared folder when it may read it). A sibling's `bots\<id>\`, its
 * sqlite files and its memory are therefore denied by two entries (the data root and the bots root) even if a hand-written root
 * contains them. A junction into a sibling resolves to a real path under the bots root and is refused by the real-path check.
 */
export function botDenies(config: Config, scope: BotPathScope): BuiltinDenies {
  const base = builtinDenies(config);
  const seen = new Set<string>();
  const dedupe = (items: readonly string[]): string[] =>
    items.filter((i) => {
      const k = normalizeWin(i);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const inProcessOnly = dedupe([...base.inProcessOnly, scope.botsRoot, ...(scope.extraDeny ?? [])]);
  seen.clear();
  const exceptions = dedupe([...base.inProcessOnlyExceptions, scope.workspaceDir, scope.skillsDir, ...(scope.sharedDir ? [scope.sharedDir] : [])]);
  return { ntfs: base.ntfs, inProcessOnly, inProcessOnlyExceptions: exceptions };
}

/** Read policy for one bot: `config` is the bot's own (`configForBot`); roots are its effective folders plus `workspace`, `skills` and `shared`. */
export function botReadPolicy(config: Config, scope: BotPathScope): PathPolicy {
  const roots: PolicyRoot[] = config.folders.allow.map((f) => ({ alias: f.alias, path: f.path }));
  const add = (alias: string, path: string): void => {
    if (!roots.some((r) => r.alias.toLowerCase() === alias)) roots.push({ alias, path });
  };
  add(WORKSPACE_ALIAS, scope.workspaceDir);
  add("skills", scope.skillsDir);
  if (scope.sharedDir) add("shared", scope.sharedDir);
  return createPathPolicy({ roots, denies: botDenies(config, scope) });
}

/** Write policy for one bot: its own workspace only. `shared` and every sibling are outside it, so a write there is refused. */
export function botWritePolicy(config: Config, scope: BotPathScope): PathPolicy {
  return createPathPolicy({ roots: [{ alias: WORKSPACE_ALIAS, path: scope.workspaceDir }], denies: botDenies(config, scope), defaultAlias: WORKSPACE_ALIAS });
}

// ---------------------------------------------------------------------------------------------
// Safe walking
// ---------------------------------------------------------------------------------------------

export function isLink(stats: Stats): boolean {
  // Node reports junctions (reparse points created by `mklink /J`) as symbolic links on Windows.
  return stats.isSymbolicLink();
}

export interface SafeEntry {
  name: string;
  /** Path under the (real) directory that was read; never followed through a link. */
  full: string;
  stats: Stats;
  link: boolean;
}

/**
 * Entries of a real directory, sorted by name, each `lstat`-ed (links are reported, never followed) and with denied
 * entries removed. Entries that cannot be stat-ed are skipped.
 */
export function readDirSafe(dirReal: string, isDenied: DenyMatcher): SafeEntry[] {
  const names = readdirSync(dirReal).sort((a, b) => a.localeCompare(b, "en"));
  const out: SafeEntry[] = [];
  for (const name of names) {
    const full = win32.join(dirReal, name);
    let stats: Stats;
    try {
      stats = lstatSync(full);
    } catch {
      continue;
    }
    if (isDenied(full)) continue;
    out.push({ name, full, stats, link: isLink(stats) });
  }
  return out;
}
