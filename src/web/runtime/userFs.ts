/**
 * The file area of one user bot (S33, I52, T5). Two roots only: the bot's `workspace\` (read and write) and the user's `uploads\` (read
 * only). A path is `alias:relative` (alias `workspace` or `uploads`, default workspace). Absolute paths, drive letters, UNC and `\\?\`
 * prefixes, `..`, alternate data streams (`:`), reserved device names, trailing dots or spaces and wildcard characters are refused
 * before the file system is touched; then the deepest existing ancestor is resolved with `realpath` and must still be inside the root, so a
 * symlink or junction pointing out is refused too. Owner allowlist folders are not reachable from here at all.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export class UserFsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFsError";
  }
}

export interface FsRoot {
  alias: "workspace" | "uploads";
  dir: string;
  writable: boolean;
}

export interface UserFsLimits {
  readBytes: number;
  writeBytes: number;
  listEntries: number;
  searchFiles: number;
  searchResults: number;
  /** Total bytes the workspace may hold (the user's `storageMB`). */
  quotaBytes: number;
}

export const DEFAULT_FS_LIMITS: UserFsLimits = { readBytes: 32 * 1024, writeBytes: 256 * 1024, listEntries: 200, searchFiles: 2000, searchResults: 50, quotaBytes: 200 * 1024 * 1024 };

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i;

/** Validates a relative path lexically. Returns the segments. */
export function safeSegments(rel: string): string[] {
  if (rel.includes("\0")) throw new UserFsError("the path is not valid");
  if (rel.length > 240) throw new UserFsError("the path is too long");
  if (/^[\\/]/.test(rel)) throw new UserFsError("absolute paths are not allowed");
  if (/^[a-zA-Z]:/.test(rel)) throw new UserFsError("drive paths are not allowed");
  if (rel.includes(":")) throw new UserFsError("a colon is not allowed in a path");
  if (/[<>"|?*]/.test(rel)) throw new UserFsError("wildcard or reserved characters are not allowed");
  const segs = rel.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  for (const s of segs) {
    if (s === "..") throw new UserFsError("`..` is not allowed");
    if (/[. ]$/.test(s)) throw new UserFsError("a name may not end with a dot or a space");
    if (RESERVED.test(s)) throw new UserFsError("that name is reserved by Windows");
    if (/[\u0000-\u001f]/.test(s)) throw new UserFsError("control characters are not allowed");
  }
  return segs;
}

export class UserFs {
  readonly #roots: Map<string, FsRoot>;
  readonly limits: UserFsLimits;

  constructor(roots: FsRoot[], limits: Partial<UserFsLimits> = {}) {
    this.#roots = new Map(roots.map((r) => [r.alias, r]));
    this.limits = { ...DEFAULT_FS_LIMITS, ...limits };
    for (const r of roots) mkdirSync(r.dir, { recursive: true });
  }

  /** `workspace:notes/a.txt`, `uploads:x.pdf`, or a bare relative path (workspace). */
  resolve(spec: string, forWrite = false): { root: FsRoot; abs: string; rel: string } {
    if (typeof spec !== "string") throw new UserFsError("the path must be text");
    const m = /^(workspace|uploads):(.*)$/s.exec(spec);
    const root = this.#roots.get(m ? (m[1] as string) : "workspace");
    if (!root) throw new UserFsError("unknown folder");
    const rel = m ? (m[2] as string) : spec;
    if (m === null && /^[a-zA-Z]:/.test(spec)) throw new UserFsError("drive paths are not allowed");
    const segs = safeSegments(rel);
    if (forWrite && !root.writable) throw new UserFsError("that folder is read only");
    const base = resolve(root.dir);
    const abs = resolve(base, ...segs);
    if (abs !== base && !abs.startsWith(base + sep)) throw new UserFsError("the path leaves the folder");
    // resolve the deepest existing ancestor: a symlink or junction pointing out is refused
    const realBase = realpathSync(base);
    let probe = abs;
    while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
    const realProbe = realpathSync(probe);
    if (realProbe !== realBase && !realProbe.startsWith(realBase + sep)) throw new UserFsError("the path leaves the folder");
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new UserFsError("links are not followed");
    return { root, abs, rel: segs.join("/") };
  }

  list(spec: string): { name: string; type: "file" | "dir"; size?: number }[] {
    const { abs } = this.resolve(spec === "" ? "workspace:" : spec);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new UserFsError("not a folder");
    const out: { name: string; type: "file" | "dir"; size?: number }[] = [];
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      if (out.length >= this.limits.listEntries) break;
      out.push(e.isDirectory() ? { name: e.name, type: "dir" } : { name: e.name, type: "file", size: statSync(resolve(abs, e.name)).size });
    }
    return out;
  }

  read(spec: string, maxBytes = this.limits.readBytes): { text: string; truncated: boolean } {
    const { abs } = this.resolve(spec);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new UserFsError("not a file");
    const cap = Math.min(maxBytes, this.limits.readBytes);
    const fd = openSync(abs, "r");
    try {
      const buf = Buffer.alloc(cap + 1);
      const n = readSync(fd, buf, 0, cap + 1, 0);
      const slice = buf.subarray(0, Math.min(n, cap));
      if (slice.includes(0)) throw new UserFsError("that looks like a binary file");
      return { text: slice.toString("utf8"), truncated: n > cap };
    } finally {
      closeSync(fd);
    }
  }

  /** Total size of everything under a root (for the quota). */
  usedBytes(alias: "workspace" | "uploads" = "workspace"): number {
    const root = this.#roots.get(alias);
    if (!root) return 0;
    const walk = (dir: string): number => {
      let n = 0;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        const p = resolve(dir, e.name);
        n += e.isDirectory() ? walk(p) : statSync(p).size;
      }
      return n;
    };
    return walk(root.dir);
  }

  write(spec: string, content: string): { bytes: number } {
    const { abs, rel } = this.resolve(spec, true);
    if (rel === "") throw new UserFsError("give a file name");
    if (typeof content !== "string") throw new UserFsError("the content must be text");
    const bytes = Buffer.byteLength(content);
    if (bytes > this.limits.writeBytes) throw new UserFsError(`a file may be at most ${Math.floor(this.limits.writeBytes / 1024)} KB`);
    const existing = existsSync(abs) ? statSync(abs).size : 0;
    if (this.usedBytes("workspace") - existing + bytes > this.limits.quotaBytes) throw new UserFsError("the storage quota is used up");
    mkdirSync(dirname(abs), { recursive: true });
    // the parent may have just been created: check again that it is inside the root
    this.resolve(spec, true);
    writeFileSync(abs, content, "utf8");
    return { bytes };
  }

  search(query: string, spec = "workspace:"): { path: string; line?: number; text?: string }[] {
    const q = String(query).toLowerCase();
    if (q.length < 1 || q.length > 200) throw new UserFsError("give a search text of 1 to 200 characters");
    const { root, abs, rel } = this.resolve(spec === "" ? "workspace:" : spec);
    const out: { path: string; line?: number; text?: string }[] = [];
    let files = 0;
    const walk = (dir: string, relDir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= this.limits.searchResults || files >= this.limits.searchFiles) return;
        if (e.isSymbolicLink()) continue;
        const p = resolve(dir, e.name);
        const r = relDir === "" ? e.name : `${relDir}/${e.name}`;
        if (e.isDirectory()) {
          walk(p, r);
          continue;
        }
        files++;
        if (e.name.toLowerCase().includes(q)) out.push({ path: `${root.alias}:${r}` });
        if (statSync(p).size > this.limits.readBytes * 4) continue;
        const buf = readFileSync(p);
        if (buf.includes(0)) continue;
        buf.toString("utf8").split(/\r?\n/).some((line, i) => {
          if (line.toLowerCase().includes(q) && out.length < this.limits.searchResults) {
            out.push({ path: `${root.alias}:${r}`, line: i + 1, text: line.slice(0, 200) });
            return true;
          }
          return false;
        });
      }
    };
    if (existsSync(abs) && statSync(abs).isDirectory()) walk(abs, rel);
    return out;
  }
}
