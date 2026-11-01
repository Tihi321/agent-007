/**
 * Folder tools (S2.2): `list_dir`, `read_file`, `search_files`. All access goes through the path policy (S2.1);
 * all results are wrapped in `<untrusted_content>` markers; all three are `replay: "safe"`.
 *
 * The cores (`listDir`, `readFile`, `searchFiles`) take plain arguments and return text, so they are tested without a
 * Harness. `createFolderTools` wraps them with `defineTool` and the frozen schemas from `schemas.ts`.
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { Stats } from "node:fs";
import { Worker } from "node:worker_threads";
import type { Logger } from "../contracts.js";
import type { LimitsConfig } from "../config/schema.js";
import { defineTool } from "../pi/adapter.js";
import type { Static, ToolExecutionResult } from "../pi/adapter.js";
import { PathPolicyError, readDirSafe } from "./pathPolicy.js";
import type { PathPolicy, ResolvedPath } from "./pathPolicy.js";
import { TOOL_SPECS, listDirParameters, readFileParameters, searchFilesParameters } from "./schemas.js";

// ---------------------------------------------------------------------------------------------
// Shared helpers (also used by workspace.ts, memory.ts and systemFacts.ts)
// ---------------------------------------------------------------------------------------------

/** A refusal whose message is safe to show to the model. */
export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRefusal";
  }
}

export function textResult(text: string): ToolExecutionResult {
  return { output: [{ type: "text", text }] };
}

export function errorResult(text: string): ToolExecutionResult {
  return { isError: true, output: [{ type: "text", text }] };
}

/** Wraps data the model must treat as content, never as instructions. A closing marker inside the body is defused. */
export function wrapUntrusted(source: string, body: string): string {
  const safeSource = source.replace(/["\r\n<>]/g, "'").slice(0, 300);
  const safeBody = body.replace(/<\/untrusted_content/gi, "<\\/untrusted_content");
  return `<untrusted_content source="${safeSource}">\n${safeBody}\n</untrusted_content>`;
}

export function toolDescription(name: string): string {
  const spec = TOOL_SPECS.find((t) => t.name === name);
  if (!spec) throw new Error(`unknown tool spec ${name}`);
  return spec.description;
}

/** Runs a tool body and turns refusals and filesystem errors into an error result (never a throw, never a path). */
export async function guarded(tool: string, logger: Logger | undefined, body: () => Promise<string> | string): Promise<ToolExecutionResult> {
  try {
    return textResult(await body());
  } catch (e) {
    if (e instanceof PathPolicyError) {
      logger?.info("tool.refused", { tool, code: e.code });
      return errorResult(e.message);
    }
    if (e instanceof ToolRefusal) {
      logger?.info("tool.refused", { tool, code: "refusal" });
      return errorResult(e.message);
    }
    const code = (e as NodeJS.ErrnoException | undefined)?.code ?? "UNKNOWN";
    logger?.warn("tool.error", { tool, code });
    return errorResult(`${tool} failed (${code}).`);
  }
}

function joinDisplay(base: string, name: string): string {
  return base.endsWith(":") || base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}

function isoMinute(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

// ---------------------------------------------------------------------------------------------
// Text detection
// ---------------------------------------------------------------------------------------------

const SNIFF_BYTES = 8192;

type Encoding = "utf-8" | "utf-16le" | "utf-16be";

interface Detected {
  encoding: Encoding;
  /** Bytes to skip at the start (BOM). */
  skip: number;
  binary: boolean;
}

/** BOM first (UTF-8, UTF-16 LE/BE); otherwise a NUL byte in the first 8 KB means binary. */
export function detectText(head: Uint8Array): Detected {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: "utf-8", skip: 3, binary: false };
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return { encoding: "utf-16le", skip: 2, binary: false };
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return { encoding: "utf-16be", skip: 2, binary: false };
  const n = Math.min(head.length, SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (head[i] === 0) return { encoding: "utf-8", skip: 0, binary: true };
  return { encoding: "utf-8", skip: 0, binary: false };
}

function requireFile(r: ResolvedPath, what: string): Stats {
  if (!r.exists) throw new ToolRefusal(`not found: ${r.display}`);
  const st = lstatSync(r.real);
  if (st.isDirectory()) throw new ToolRefusal(`${r.display} is a folder; use list_dir.`);
  if (!st.isFile()) throw new ToolRefusal(`${r.display} is not a regular file; ${what} refused.`);
  return st;
}

// ---------------------------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------------------------

export interface FolderToolsDeps {
  policy: PathPolicy;
  limits: LimitsConfig;
  logger?: Logger | undefined;
  /** Test seams. */
  regexBudgetMs?: number;
  searchBudgetMs?: number;
}

const MAX_DEPTH = 3;

export function listDir(deps: FolderToolsDeps, args: { path: string; depth?: number | undefined }): string {
  const { policy, limits } = deps;
  if (args.path.trim() === "") {
    const lines = policy.roots.map((r) => {
      let note = "dir";
      try {
        policy.resolve(`${r.alias}:`);
      } catch {
        note = "unavailable";
      }
      return `${note.padEnd(11)} ${r.alias}:  (${r.path})`;
    });
    return wrapUntrusted("list_dir:roots", lines.length > 0 ? `Allowed folders:\n${lines.join("\n")}` : "No folders are allowed.");
  }

  const r = policy.resolve(args.path);
  if (!r.exists) throw new ToolRefusal(`not found: ${r.display}`);
  const top = lstatSync(r.real);
  if (!top.isDirectory()) throw new ToolRefusal(`${r.display} is not a folder; use read_file.`);

  const depth = Math.max(0, Math.min(MAX_DEPTH, Math.trunc(args.depth ?? 0)));
  const matcher = policy.denyMatcher();
  const lines: string[] = [];
  let count = 0;
  let truncated = false;

  const walk = (dirReal: string, display: string, level: number): void => {
    for (const e of readDirSafe(dirReal, matcher)) {
      if (count >= limits.listMaxEntries) {
        truncated = true;
        return;
      }
      const isDir = !e.link && e.stats.isDirectory();
      const type = e.link ? "link" : isDir ? "dir" : e.stats.isFile() ? "file" : "other";
      const size = isDir || e.link ? "-" : String(e.stats.size);
      const shown = joinDisplay(display, e.name);
      lines.push(`${type.padEnd(4)}  ${size.padStart(10)}  ${isoMinute(e.stats.mtime)}  ${shown}${isDir ? "/" : ""}`);
      count++;
      if (isDir && level < depth) {
        walk(e.full, shown, level + 1);
        if (truncated) return;
      }
    }
  };
  walk(r.real, r.display, 0);

  let body = lines.length > 0 ? lines.join("\n") : "(empty)";
  if (truncated) body += `\n[truncated at ${limits.listMaxEntries} entries; list a subfolder or lower the depth]`;
  return wrapUntrusted(`list_dir:${r.display}`, `Folder ${r.display} (${count} entries${truncated ? ", truncated" : ""}):\n${body}`);
}

// ---------------------------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------------------------

const DEFAULT_MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const CHUNK = 64 * 1024;

export function readFile(deps: FolderToolsDeps, args: { path: string; startLine?: number | undefined; maxLines?: number | undefined }): string {
  const r = deps.policy.resolve(args.path);
  requireFile(r, "read");
  const startLine = Math.max(1, Math.trunc(args.startLine ?? 1));
  const maxLines = Math.max(1, Math.min(2000, Math.trunc(args.maxLines ?? DEFAULT_MAX_LINES)));
  const byteCap = deps.limits.readFileBytes;

  const fd = openSync(r.real, "r");
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ToolRefusal(`${r.display} is not a regular file; read refused.`);
    if (st.size === 0) return wrapUntrusted(`file:${r.display}`, "(empty file)");

    const head = Buffer.alloc(Math.min(SNIFF_BYTES, st.size));
    const headRead = readSync(fd, head, 0, head.length, 0);
    const det = detectText(head.subarray(0, headRead));
    if (det.binary) throw new ToolRefusal(`${r.display} looks like a binary file; only text files can be read.`);

    const decoder = new TextDecoder(det.encoding, { fatal: false, ignoreBOM: true });
    const out: string[] = [];
    let outBytes = 0;
    let lineNo = 0;
    let pending = "";
    let position = det.skip;
    let scanned = 0;
    let stoppedAt: number | undefined; // first line NOT returned, when we stop early
    let eof = false;

    const take = (rawLine: string): boolean => {
      lineNo++;
      if (lineNo < startLine) return true;
      let text = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (text.length > MAX_LINE_CHARS) text = `${text.slice(0, MAX_LINE_CHARS)}...[line truncated]`;
      const entry = `${lineNo}: ${text}`;
      const bytes = Buffer.byteLength(entry) + 1;
      if (out.length >= maxLines || (out.length > 0 && outBytes + bytes > byteCap)) {
        stoppedAt = lineNo;
        return false;
      }
      out.push(entry);
      outBytes += bytes;
      return true;
    };

    const buf = Buffer.alloc(CHUNK);
    scan: for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, position);
      if (n === 0) {
        pending += decoder.decode();
        eof = true;
        break;
      }
      position += n;
      scanned += n;
      pending += decoder.decode(buf.subarray(0, n), { stream: true });
      let idx: number;
      while ((idx = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (!take(line)) break scan;
      }
      if (scanned > MAX_SCAN_BYTES) {
        throw new ToolRefusal(`${r.display}: startLine ${startLine} is too far into the file (scan limit ${MAX_SCAN_BYTES / (1024 * 1024)} MB).`);
      }
    }
    if (eof && stoppedAt === undefined && pending !== "") take(pending);

    if (out.length === 0) {
      const note = stoppedAt === undefined && eof ? `${r.display} has only ${lineNo} line${lineNo === 1 ? "" : "s"}.` : "(no lines)";
      return wrapUntrusted(`file:${r.display}`, note);
    }
    const first = startLine;
    const last = startLine + out.length - 1;
    let body = `File ${r.display}, lines ${first}-${last}${stoppedAt === undefined ? ` of ${lineNo}` : ""}:\n${out.join("\n")}`;
    if (stoppedAt !== undefined) body += `\n[more lines follow; call again with startLine=${stoppedAt}]`;
    return wrapUntrusted(`file:${r.display}`, body);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------------------------

const MAX_REGEX_LENGTH = 200;
const REGEX_BUDGET_MS = 2000;
const SEARCH_BUDGET_MS = 20_000;
const SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_HITS_PER_FILE = 3;
const SNIPPET_CHARS = 200;
const SEARCH_LINE_CHARS = 4000;

/** Name glob (`*`, `?`) to a case-insensitive anchored regex over the file name only. */
export function globToRegExp(glob: string): RegExp {
  const src = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${src}$`, "i");
}

const REGEX_WORKER = `
const { parentPort } = require("node:worker_threads");
let re;
parentPort.on("message", (m) => {
  if (m.type === "init") { re = new RegExp(m.pattern, "i"); return; }
  const hits = [];
  const lines = m.text.split("\\n");
  for (let i = 0; i < lines.length && hits.length < m.max; i++) {
    const l = lines[i].replace(/\\r$/, "").slice(0, m.lineChars);
    if (re.test(l)) hits.push({ n: i + 1, t: l });
  }
  parentPort.postMessage({ id: m.id, hits });
});
`;

interface Hit {
  n: number;
  t: string;
}

/** Regex matching runs in a worker so a catastrophic pattern cannot hang the agent: past the budget it is terminated. */
class RegexScanner {
  private worker: Worker | undefined;
  private seq = 0;
  constructor(
    private readonly pattern: string,
    private readonly budgetMs: number,
  ) {}

  private start(): Worker {
    const w = new Worker(REGEX_WORKER, { eval: true });
    w.unref();
    w.postMessage({ type: "init", pattern: this.pattern });
    this.worker = w;
    return w;
  }

  /** Hits, or `"timeout"` when the budget ran out (the worker is replaced on the next call). */
  scan(text: string, max: number): Promise<Hit[] | "timeout"> {
    const w = this.worker ?? this.start();
    const id = ++this.seq;
    return new Promise((resolve) => {
      const done = (v: Hit[] | "timeout"): void => {
        clearTimeout(timer);
        w.off("message", onMessage);
        w.off("error", onError);
        resolve(v);
      };
      const onMessage = (m: { id: number; hits: Hit[] }): void => {
        if (m.id === id) done(m.hits);
      };
      const onError = (): void => {
        if (this.worker === w) this.worker = undefined;
        done("timeout");
      };
      const timer = setTimeout(() => {
        if (this.worker === w) this.worker = undefined;
        void w.terminate();
        done("timeout");
      }, this.budgetMs);
      w.on("message", onMessage);
      w.on("error", onError);
      w.postMessage({ type: "scan", id, text, max, lineChars: SEARCH_LINE_CHARS });
    });
  }

  close(): void {
    const w = this.worker;
    this.worker = undefined;
    if (w) void w.terminate();
  }
}

/** The first `maxBytes` of a text file as a string; `undefined` for binary or unreadable files. */
function readTextHead(real: string, maxBytes: number): { text: string; partial: boolean } | undefined {
  let fd: number;
  try {
    fd = openSync(real, "r");
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    if (st.size === 0) return { text: "", partial: false };
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, 0);
    const det = detectText(buf.subarray(0, n));
    if (det.binary) return undefined;
    const text = new TextDecoder(det.encoding, { fatal: false, ignoreBOM: true }).decode(buf.subarray(det.skip, n));
    return { text, partial: st.size > maxBytes };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export async function searchFiles(
  deps: FolderToolsDeps,
  args: { path: string; nameGlob?: string | undefined; contains?: string | undefined; regex?: boolean | undefined; maxResults?: number | undefined },
): Promise<string> {
  const { policy, limits } = deps;
  const wantName = args.nameGlob !== undefined && args.nameGlob !== "";
  const wantText = args.contains !== undefined && args.contains !== "";
  if (!wantName && !wantText) throw new ToolRefusal("search_files needs nameGlob and/or contains.");

  const nameRe = wantName ? globToRegExp(args.nameGlob as string) : undefined;
  const needle = wantText ? (args.contains as string) : "";
  const useRegex = wantText && args.regex === true;
  if (useRegex) {
    if (needle.length > MAX_REGEX_LENGTH) throw new ToolRefusal(`regex too long (max ${MAX_REGEX_LENGTH} characters).`);
    try {
      new RegExp(needle, "i");
    } catch {
      throw new ToolRefusal("invalid regular expression.");
    }
  }
  const needleLower = needle.toLowerCase();
  const maxResults = Math.max(1, Math.min(limits.searchMaxResults, Math.trunc(args.maxResults ?? 50)));

  const starts: ResolvedPath[] = [];
  if (args.path.trim() === "") {
    for (const root of policy.roots) {
      try {
        const rr = policy.resolve(`${root.alias}:`);
        if (rr.exists) starts.push(rr);
      } catch {
        // an unavailable or denied root is skipped
      }
    }
  } else {
    const rr = policy.resolve(args.path);
    if (!rr.exists) throw new ToolRefusal(`not found: ${rr.display}`);
    if (!lstatSync(rr.real).isDirectory()) throw new ToolRefusal(`${rr.display} is not a folder.`);
    starts.push(rr);
  }

  const matcher = policy.denyMatcher();
  const scanner = useRegex ? new RegexScanner(needle, deps.regexBudgetMs ?? REGEX_BUDGET_MS) : undefined;
  const deadline = Date.now() + (deps.searchBudgetMs ?? SEARCH_BUDGET_MS);
  const results: string[] = [];
  let visitedFiles = 0;
  let skipped = 0;
  let regexTimeouts = 0;
  let stop: "results" | "files" | "time" | undefined;

  const snippet = (t: string): string => {
    const s = t.trim();
    return s.length > SNIPPET_CHARS ? `${s.slice(0, SNIPPET_CHARS)}...` : s;
  };

  const visitFile = async (full: string, shown: string): Promise<void> => {
    if (!wantText) {
      results.push(shown);
      return;
    }
    const head = readTextHead(full, SEARCH_FILE_BYTES);
    if (!head) {
      skipped++;
      return;
    }
    const room = Math.min(MAX_HITS_PER_FILE, maxResults - results.length);
    if (scanner) {
      const hits = await scanner.scan(head.text, room);
      if (hits === "timeout") {
        regexTimeouts++;
        return;
      }
      for (const h of hits) results.push(`${shown}:${h.n}: ${snippet(h.t)}`);
      return;
    }
    const lines = head.text.split("\n");
    let found = 0;
    for (let i = 0; i < lines.length && found < room; i++) {
      const line = (lines[i] as string).replace(/\r$/, "").slice(0, SEARCH_LINE_CHARS);
      if (line.toLowerCase().includes(needleLower)) {
        results.push(`${shown}:${i + 1}: ${snippet(line)}`);
        found++;
      }
    }
  };

  const walk = async (dirReal: string, display: string): Promise<void> => {
    for (const e of readDirSafe(dirReal, matcher)) {
      if (stop) return;
      if (e.link) continue; // never follow links or junctions
      const shown = joinDisplay(display, e.name);
      if (e.stats.isDirectory()) {
        await walk(e.full, shown);
        continue;
      }
      if (!e.stats.isFile()) continue;
      if (visitedFiles >= limits.searchMaxFiles) {
        stop = "files";
        return;
      }
      if (Date.now() > deadline) {
        stop = "time";
        return;
      }
      visitedFiles++;
      if (nameRe && !nameRe.test(e.name)) continue;
      await visitFile(e.full, shown);
      if (results.length >= maxResults) {
        stop = "results";
        return;
      }
    }
  };

  try {
    for (const s of starts) {
      if (stop) break;
      await walk(s.real, s.display);
    }
  } finally {
    scanner?.close();
  }

  const label = args.path.trim() === "" ? "all allowed folders" : (starts[0]?.display ?? args.path);
  let body = results.length > 0 ? results.join("\n") : "No matches.";
  const notes: string[] = [];
  if (stop === "results") notes.push(`stopped at ${maxResults} results`);
  if (stop === "files") notes.push(`stopped after scanning ${limits.searchMaxFiles} files`);
  if (stop === "time") notes.push("stopped: search time budget used up");
  if (skipped > 0) notes.push(`${skipped} binary or unreadable file${skipped === 1 ? "" : "s"} skipped`);
  if (regexTimeouts > 0) notes.push(`${regexTimeouts} file${regexTimeouts === 1 ? "" : "s"} skipped: the regex took over ${(deps.regexBudgetMs ?? REGEX_BUDGET_MS) / 1000} s`);
  if (notes.length > 0) body += `\n[${notes.join("; ")}]`;
  return wrapUntrusted(`search:${label}`, body);
}

// ---------------------------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------------------------

export function createFolderTools(deps: FolderToolsDeps) {
  const log = deps.logger;
  const listDirTool = defineTool({
    name: "list_dir",
    description: toolDescription("list_dir"),
    parameters: listDirParameters,
    replay: "safe",
    execute: (args: Static<typeof listDirParameters>) => guarded("list_dir", log, () => listDir(deps, args)),
  });
  const readFileTool = defineTool({
    name: "read_file",
    description: toolDescription("read_file"),
    parameters: readFileParameters,
    replay: "safe",
    execute: (args: Static<typeof readFileParameters>) => guarded("read_file", log, () => readFile(deps, args)),
  });
  const searchFilesTool = defineTool({
    name: "search_files",
    description: toolDescription("search_files"),
    parameters: searchFilesParameters,
    replay: "safe",
    execute: (args: Static<typeof searchFilesParameters>) => guarded("search_files", log, () => searchFiles(deps, args)),
  });
  return [listDirTool, readFileTool, searchFilesTool] as const;
}
