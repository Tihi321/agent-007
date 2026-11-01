/**
 * The non-owner tool registry (S33, I50). `buildUserToolbox` returns the tools of ONE user bot: the names that exist are exactly
 * `bot.tools` intersected with `USER_TOOL_UNIVERSE`. A host tool (shell, jobs, Flow, hub, MCP, peers, settings) has no entry anywhere in
 * this module, so asking for one is "no such tool", not "denied by policy" (the registry test enumerates the names and the module's own
 * imports). Every file tool goes through `UserFs`, so the roots are the bot's workspace and the user's uploads and nothing else.
 *
 * Tools are plain async functions that return text; the chat engine adapter wraps them for the model. Each result is returned as DATA
 * (the engine wraps it in the untrusted-content markers), and a failure is a sentence, never a stack or a path outside the roots.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { USER_ALWAYS_LOADED_MAX, USER_TOOL_UNIVERSE } from "../capabilities.js";
import type { RuntimeUserBot } from "./userBots.js";
import { UserFs, UserFsError } from "./userFs.js";
import type { UserFsLimits } from "./userFs.js";

export interface ToolResult {
  ok: boolean;
  text: string;
  /** `ask_user`: the question to show; the turn stops. */
  question?: string;
}

export interface UserTool {
  name: string;
  description: string;
  /** JSON schema of the arguments, for the model. */
  parameters: Record<string, unknown>;
  call(args: Record<string, unknown>): ToolResult;
}

const str = (v: unknown, max: number, what: string): string => {
  if (typeof v !== "string" || v.length > max) throw new UserFsError(`${what} must be text of at most ${max} characters`);
  return v;
};

const SECRET_LIKE = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b)/;

/** `caps.tools`, when given, is the CURRENT allowance of the user: a tool the bot was saved with but the owner has since taken away does not exist (M1). */
export function buildUserToolbox(bot: RuntimeUserBot, caps: { storageMB: number; tools?: readonly string[] }, limits: Partial<UserFsLimits> = {}): { tools: UserTool[]; names(): string[]; call(name: string, args: unknown): ToolResult } {
  const fs = new UserFs([...bot.readRoots], { quotaBytes: caps.storageMB * 1024 * 1024, ...limits });
  const memoryFile = bot.memoryFile;
  const wanted = new Set(bot.tools.filter((t) => USER_TOOL_UNIVERSE.includes(t) && (caps.tools === undefined || caps.tools.includes(t))).slice(0, USER_ALWAYS_LOADED_MAX));
  const all: Record<string, UserTool> = {
    tool_search: {
      name: "tool_search",
      description: "List the tools this bot has.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      call: () => ({ ok: true, text: [...wanted].filter((n) => n !== "tool_search").join(", ") || "no other tools" }),
    },
    ask_user: {
      name: "ask_user",
      description: "Ask the user one short question and stop.",
      parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
      call: (a) => ({ ok: true, text: "asked", question: str(a["question"], 300, "question") }),
    },
    list_dir: {
      name: "list_dir",
      description: "List a folder: `workspace:` (your files) or `uploads:` (files the user uploaded).",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      call: (a) => ({ ok: true, text: fs.list(a["path"] === undefined ? "workspace:" : str(a["path"], 240, "path")).map((e) => `${e.type === "dir" ? "[dir] " : ""}${e.name}${e.size !== undefined ? ` (${e.size} bytes)` : ""}`).join("\n") || "(empty)" }),
    },
    read_file: {
      name: "read_file",
      description: "Read a text file from `workspace:` or `uploads:`.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      call: (a) => {
        const r = fs.read(str(a["path"], 240, "path"));
        return { ok: true, text: r.truncated ? `${r.text}\n[truncated]` : r.text };
      },
    },
    search_files: {
      name: "search_files",
      description: "Find files by name or text in `workspace:` or `uploads:`.",
      parameters: { type: "object", properties: { contains: { type: "string" }, path: { type: "string" } }, required: ["contains"] },
      call: (a) => ({ ok: true, text: fs.search(str(a["contains"], 200, "contains"), a["path"] === undefined ? "workspace:" : str(a["path"], 240, "path")).map((r) => (r.line ? `${r.path}:${r.line}: ${r.text}` : r.path)).join("\n") || "no matches" }),
    },
    write_file: {
      name: "write_file",
      description: "Write a text file in your own `workspace:` (never anywhere else).",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      call: (a) => ({ ok: true, text: `wrote ${fs.write(str(a["path"], 240, "path"), str(a["content"], 262_144, "content")).bytes} bytes` }),
    },
    remember: {
      name: "remember",
      description: "Save one durable note about the user in THIS bot's own memory.",
      parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
      call: (a) => {
        if (!bot.memory) return { ok: false, text: "memory is off for this bot" };
        const note = str(a["note"], 500, "note").replace(/\s+/g, " ").trim();
        if (note.length < 3) return { ok: false, text: "the note is empty" };
        if (SECRET_LIKE.test(note)) return { ok: false, text: "that looks like a secret; it was not saved" };
        mkdirSync(dirname(memoryFile), { recursive: true });
        const existing = existsSync(memoryFile) ? readFileSync(memoryFile, "utf8").length : 0;
        if (existing > 32_000) return { ok: false, text: "the memory is full" };
        appendFileSync(memoryFile, `- ${note}\n`, "utf8");
        return { ok: true, text: "saved" };
      },
    },
  };
  const tools = Object.values(all).filter((t) => wanted.has(t.name));
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  return {
    tools,
    names: () => tools.map((t) => t.name),
    call(name, args) {
      const t = byName.get(name);
      if (!t) return { ok: false, text: `no such tool: ${name.slice(0, 40)}` };
      try {
        return t.call(typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {});
      } catch (e) {
        if (e instanceof UserFsError) return { ok: false, text: e.message };
        return { ok: false, text: "the tool failed" };
      }
    },
  };
}
