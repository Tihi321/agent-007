/**
 * Stub tools for the bake-off (P0.5): the REAL schemas from `src/tools/schemas.ts`, returning fixtures from
 * `scripts/bakeoff/fixtures/`. `shell` goes through a stub approval hook that auto-denies. Every stub error starts with
 * `STUB:` so the runner can tell a deliberate refusal from a harness-level validation failure (a tool-call format failure).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, defineTool, hook, section, ToolTask } from "../../src/pi/adapter.js";
import { TOOL_SPECS } from "../../src/tools/schemas.js";
import { repoRoot } from "../smoke/config.js";

export function fixturesDir(): string {
  return process.env["A7_BAKEOFF_FIXTURES"] ?? join(repoRoot(), "scripts", "bakeoff", "fixtures");
}

export function preamblePath(): string {
  return join(repoRoot(), "prompts", "preamble.md");
}

export const DENY_PATTERN = /pixotope/i;
export const STUB_PREFIX = "STUB:";
export const SHELL_DENIED = `${STUB_PREFIX} The user denied this command in Telegram.`;

const ALIASES: Record<string, string> = { notes: "notes" };

function stubError(msg: string): Error {
  return new Error(`${STUB_PREFIX} ${msg}`);
}

/** Resolves `alias:relative` (or refuses an absolute or denied path) to a file or folder inside the fixtures. */
function resolveFixturePath(p: string): { abs: string; display: string } {
  if (DENY_PATTERN.test(p)) throw stubError("access denied: this path is on the deny list.");
  const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(p);
  const alias = m?.[1] !== undefined && m[1].length > 1 ? m[1].toLowerCase() : undefined; // `C:` is a drive, not an alias
  if (!alias || ALIASES[alias] === undefined) throw stubError(`access denied: ${p || "(empty)"} is not inside an allowed folder. Allowed aliases: notes.`);
  const rel = (m?.[2] ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (rel.split("/").includes("..")) throw stubError("access denied: path escapes the allowed folder.");
  const abs = join(fixturesDir(), ALIASES[alias] as string, rel);
  return { abs, display: `${alias}:${rel}` };
}

function listTree(abs: string, display: string, depth: number, out: string[]): void {
  for (const name of readdirSync(abs).sort()) {
    const full = join(abs, name);
    const isDir = statSync(full).isDirectory();
    const shown = `${display}${display.endsWith(":") || display.endsWith("/") ? "" : "/"}${name}`;
    out.push(isDir ? `${shown}/` : `${shown}  (${statSync(full).size} bytes)`);
    if (isDir && depth > 0) listTree(full, shown, depth - 1, out);
  }
}

function sysFact(args: { fact: string; filter?: string | undefined; limit?: number | undefined }): string {
  const known: Record<string, string> = { disks: "disks.json", processes: "processes.json", uptime: "uptime.json", memory: "memory.json" };
  const file = known[args.fact];
  if (!file) return JSON.stringify({ fact: args.fact, note: "not available in the bake-off fixture" });
  const data = JSON.parse(readFileSync(join(fixturesDir(), "system", file), "utf8")) as Record<string, unknown>;
  if (args.fact === "processes") {
    let rows = data["processes"] as { name: string }[];
    if (args.filter) rows = rows.filter((r) => r.name.toLowerCase().includes(args.filter?.toLowerCase() ?? ""));
    if (args.limit) rows = rows.slice(0, args.limit);
    return JSON.stringify({ processes: rows });
  }
  return JSON.stringify(data);
}

function searchFixtures(path: string, contains: string | undefined, nameGlob: string | undefined, max: number): string {
  const { abs, display } = resolveFixturePath(path);
  const hits: string[] = [];
  const walk = (dir: string, shown: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const here = `${shown}${shown.endsWith(":") || shown.endsWith("/") ? "" : "/"}${name}`;
      if (statSync(full).isDirectory()) walk(full, here);
      else {
        if (nameGlob && !new RegExp("^" + nameGlob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i").test(name)) continue;
        const text = readFileSync(full, "utf8");
        if (!contains || text.toLowerCase().includes(contains.toLowerCase())) {
          const line = contains ? (text.split("\n").find((l) => l.toLowerCase().includes(contains.toLowerCase())) ?? "") : "";
          hits.push(`${here}${line ? `: ${line.trim()}` : ""}`);
        }
      }
    }
  };
  if (!existsSync(abs)) throw stubError(`folder not found: ${display}`);
  walk(abs, display);
  return hits.length ? hits.slice(0, max).join("\n") : "No matches.";
}

type Args = Record<string, unknown>;

/** Runs one stub tool. Throws `STUB:` errors for refusals. */
export function stubExecute(name: string, args: Args): string {
  switch (name) {
    case "system_facts":
      return sysFact(args as { fact: string; filter?: string; limit?: number });
    case "list_dir": {
      const p = String(args["path"] ?? "");
      if (p.trim() === "") return "Allowed roots:\nnotes:  (the notes folder)";
      const { abs, display } = resolveFixturePath(p);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) throw stubError(`not a folder: ${display}`);
      const out: string[] = [];
      listTree(abs, display, Number(args["depth"] ?? 0), out);
      return out.join("\n") || "(empty)";
    }
    case "read_file": {
      const { abs, display } = resolveFixturePath(String(args["path"] ?? ""));
      if (!existsSync(abs) || !statSync(abs).isFile()) throw stubError(`file not found: ${display}`);
      const lines = readFileSync(abs, "utf8").split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      const start = Math.max(1, Number(args["startLine"] ?? 1));
      const max = Math.min(2000, Number(args["maxLines"] ?? 200));
      const slice = lines.slice(start - 1, start - 1 + max);
      return `<untrusted_content source="file:${display}">\n${slice.map((l, i) => `${start + i}: ${l}`).join("\n")}\n</untrusted_content>`;
    }
    case "search_files":
      return `<untrusted_content source="search">\n${searchFixtures(String(args["path"] ?? ""), args["contains"] as string | undefined, args["nameGlob"] as string | undefined, Number(args["maxResults"] ?? 50))}\n</untrusted_content>`;
    case "write_file":
      return "Written to the workspace (bake-off stub; nothing was written).";
    case "remember":
      return "Saved to memory (bake-off stub). The user was told.";
    case "shell":
      return `${STUB_PREFIX} the shell stub never runs commands.`;
    default:
      throw stubError(`unknown tool ${name}`);
  }
}

/** The bake-off extension: preamble section, the seven stub tools, and the auto-deny approval hook. */
export function buildBakeoffExtension(preamble: string) {
  const tools = TOOL_SPECS.map((spec) =>
    defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      execute: async (args: Args) => ({ output: [{ type: "text" as const, text: stubExecute(spec.name, args) }] }),
    }),
  );
  const approvalStub = hook(ToolTask, {
    beforeTool: (call) => (call.name === "shell" ? { block: SHELL_DENIED } : undefined),
  });
  return defineExtension({ name: "bakeoff", tools, sections: [section("preamble", () => preamble, { tag: false })], hooks: [approvalStub] });
}
