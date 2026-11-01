/**
 * Pre-flight (S12.1), read-only. Before each Claude job the project's `.claude/settings.json` and `settings.local.json`
 * (and any extra settings file the caller names) are read. The job is refused when they hold a permission allow rule for
 * a shell tool, a bare or tool-level wildcard that is not on the reviewed list, or when a file cannot be parsed (fail
 * closed: those files merge into `-p` runs [U33]). Hooks are reported as warnings, not refused: they run the project's
 * own commands, and U33 records whether `--setting-sources` can exclude them.
 *
 * The job runner never sets `ANTHROPIC_API_KEY` and never uses `--bare` (argv.ts); auth is the user's own `/login`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isShellRule } from "./argv.js";

export interface PreflightOptions {
  cwd: string;
  /** Allow rules that are reviewed and accepted even though they contain a wildcard (exact match). Default none. */
  reviewedAllow?: readonly string[];
  /** More settings files to read, for example the main user's `~/.claude/settings.json` (not read by default). */
  extraSettingsFiles?: readonly string[];
  /** Injected for tests. */
  readText?: (path: string) => Promise<string | undefined>;
}

export interface PreflightResult {
  ok: boolean;
  /** One line per refusal reason. */
  reasons: string[];
  warnings: string[];
  /** The files that existed and were read. */
  filesRead: string[];
}

async function defaultRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** A rule with no argument list that contains `*`: `*`, `mcp__*`, `mcp__flow-music-mcp__*`. */
function isWildcardToolRule(rule: string): boolean {
  return !rule.includes("(") && rule.includes("*");
}

export async function claudePreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const read = opts.readText ?? defaultRead;
  const reviewed = new Set(opts.reviewedAllow ?? []);
  const files = [
    join(opts.cwd, ".claude", "settings.json"),
    join(opts.cwd, ".claude", "settings.local.json"),
    ...(opts.extraSettingsFiles ?? []),
  ];
  const reasons: string[] = [];
  const warnings: string[] = [];
  const filesRead: string[] = [];
  for (const file of files) {
    let text: string | undefined;
    try {
      text = await read(file);
    } catch (e) {
      reasons.push(`${file}: cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      continue;
    }
    if (text === undefined) continue;
    filesRead.push(file);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      reasons.push(`${file}: is not valid JSON`);
      continue;
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      reasons.push(`${file}: is not a JSON object`);
      continue;
    }
    const root = json as Record<string, unknown>;
    const perms = root["permissions"];
    if (typeof perms === "object" && perms !== null && !Array.isArray(perms)) {
      const allow = (perms as Record<string, unknown>)["allow"];
      if (allow !== undefined && !Array.isArray(allow)) reasons.push(`${file}: permissions.allow is not an array`);
      else
        for (const rule of (allow as unknown[] | undefined) ?? []) {
          if (typeof rule !== "string") {
            reasons.push(`${file}: a permissions.allow entry is not a string`);
            continue;
          }
          if (reviewed.has(rule)) continue;
          if (isShellRule(rule)) reasons.push(`${file}: allow rule for a shell tool: ${rule}`);
          else if (isWildcardToolRule(rule)) reasons.push(`${file}: wildcard allow rule not on the reviewed list: ${rule}`);
        }
      const mode = (perms as Record<string, unknown>)["defaultMode"];
      if (typeof mode === "string" && ["bypassPermissions", "auto", "acceptEdits"].includes(mode)) {
        warnings.push(`${file}: permissions.defaultMode is ${mode} (the job's --permission-mode flag is expected to win; U33)`);
      }
    } else if (perms !== undefined) reasons.push(`${file}: permissions is not an object`);
    if (root["hooks"] !== undefined) warnings.push(`${file}: defines hooks, which run in -p jobs (U33)`);
  }
  return { ok: reasons.length === 0, reasons, warnings, filesRead };
}
