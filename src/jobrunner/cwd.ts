/**
 * The cwd allowlist (S11.3, I22). A job's working directory must REALPATH-EQUAL an entry of the allowlist (default: the
 * creative-hub folder only). Not "under": equal. So:
 *   - a sibling that shares a prefix (`creative-hub2`) is refused;
 *   - a junction or symlink inside the hub that points elsewhere is refused (the real path differs);
 *   - anything under a deny path (Pixotope and work paths, the agent's own folders) is refused, and the deny list wins
 *     even over an allowlist entry;
 *   - relative paths, UNC and `\\?\` / `\\.\` paths, alternate data streams, device names and `..` segments are refused
 *     before the file system is touched.
 */
import { realpathSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { isSameOrUnder, normalizeWin } from "../config/paths.js";

export interface CwdPolicy {
  allowlist: readonly string[];
  denyPaths: readonly string[];
}

export type CwdCheck = { ok: true; cwd: string } | { ok: false; reason: string };

export interface CwdFs {
  realpath(p: string): string;
  isDirectory(p: string): boolean;
}

export const nodeCwdFs: CwdFs = {
  realpath: (p) => stripVerbatim(realpathSync.native(p)),
  isDirectory: (p) => statSync(p).isDirectory(),
};

const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

function stripVerbatim(p: string): string {
  return p.startsWith("\\\\?\\") && !p.startsWith("\\\\?\\UNC\\") ? p.slice(4) : p;
}

/** Syntax checks that need no file system. Returns the reason, or undefined when the text is acceptable. */
export function cwdSyntaxProblem(cwd: string): string | undefined {
  if (typeof cwd !== "string" || cwd === "") return "the cwd is empty";
  if (cwd.includes("\0")) return "the cwd contains a NUL character";
  if (cwd.startsWith("\\\\") || cwd.startsWith("//")) return "UNC, \\\\?\\ and \\\\.\\ paths are refused";
  if (!win32.isAbsolute(cwd) || !/^[A-Za-z]:[\\/]/.test(cwd)) return "the cwd must be an absolute path on a local drive";
  if (cwd.indexOf(":", 2) !== -1) return "alternate data streams are refused";
  const parts = cwd.slice(3).split(/[\\/]+/).filter((s) => s !== "");
  for (const part of parts) {
    if (part === "..") return 'the cwd must not contain ".." segments';
    if (DEVICE_NAME.test(part)) return "device names are refused";
    if (/[<>"|?*]/.test(part)) return "the cwd contains characters that are not allowed in a path";
  }
  return undefined;
}

/**
 * Checks `cwd` against the policy. On success `cwd` is the real path (what the job is started in). On failure `reason`
 * says why, without listing the allowlist.
 */
export function checkCwd(cwd: string, policy: CwdPolicy, fs: CwdFs = nodeCwdFs): CwdCheck {
  const syntax = cwdSyntaxProblem(cwd);
  if (syntax) return { ok: false, reason: syntax };

  // The deny list is checked on the text AND on the real path, so a link into a denied folder cannot hide.
  for (const d of policy.denyPaths) if (isSameOrUnder(cwd, d)) return { ok: false, reason: "the cwd is under a denied path" };

  let real: string;
  try {
    real = fs.realpath(cwd);
  } catch {
    return { ok: false, reason: "the cwd does not exist" };
  }
  try {
    if (!fs.isDirectory(real)) return { ok: false, reason: "the cwd is not a folder" };
  } catch {
    return { ok: false, reason: "the cwd cannot be read" };
  }
  for (const d of policy.denyPaths) {
    if (isSameOrUnder(real, d)) return { ok: false, reason: "the cwd resolves to a denied path" };
    let denyReal: string | undefined;
    try {
      denyReal = fs.realpath(d);
    } catch {
      denyReal = undefined;
    }
    if (denyReal !== undefined && isSameOrUnder(real, denyReal)) return { ok: false, reason: "the cwd resolves to a denied path" };
  }

  const want = normalizeWin(real);
  for (const entry of policy.allowlist) {
    let entryReal: string;
    try {
      entryReal = fs.realpath(entry);
    } catch {
      continue; // an allowlist entry that does not exist matches nothing
    }
    if (normalizeWin(entryReal) === want) return { ok: true, cwd: real };
  }
  return { ok: false, reason: "the cwd is not in the job runner's cwd allowlist" };
}
