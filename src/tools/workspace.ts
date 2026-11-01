/**
 * Workspace write (S2.4): `write_file` writes inside the agent workspace only, through the write path policy
 * (root = `paths.workspaceDir`). Modes create, overwrite, append. At most 1 MB per file. There is no delete or rename tool.
 * `replay: "unsafe"` (the default): an interrupted write is never rerun after a restart.
 */
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import type { Logger } from "../contracts.js";
import { defineTool } from "../pi/adapter.js";
import type { Static } from "../pi/adapter.js";
import { ToolRefusal, guarded, toolDescription } from "./folders.js";
import type { PathPolicy } from "./pathPolicy.js";
import { writeFileParameters } from "./schemas.js";

export const WORKSPACE_MAX_FILE_BYTES = 1024 * 1024;

export interface WorkspaceDeps {
  /** The write policy (`writePolicyFromConfig`): one root, the workspace. */
  policy: PathPolicy;
  maxFileBytes?: number;
  logger?: Logger | undefined;
}

export type WriteMode = "create" | "overwrite" | "append";

export function writeWorkspaceFile(deps: WorkspaceDeps, args: { path: string; content: string; mode: WriteMode }): string {
  const max = deps.maxFileBytes ?? WORKSPACE_MAX_FILE_BYTES;
  if (args.mode !== "create" && args.mode !== "overwrite" && args.mode !== "append") throw new ToolRefusal("mode must be create, overwrite or append.");
  if (args.content.includes("\u0000")) throw new ToolRefusal("content contains a NUL byte; only text can be written.");
  const bytes = Buffer.byteLength(args.content, "utf8");
  if (bytes > max) throw new ToolRefusal(`content is ${bytes} bytes; the limit is ${max} bytes (1 MB).`);

  const r = deps.policy.resolve(args.path);
  if (r.rel === "") throw new ToolRefusal("the path is the workspace folder itself; give a file name.");

  let existingSize = 0;
  if (r.exists) {
    const st = lstatSync(r.real);
    if (st.isDirectory()) throw new ToolRefusal(`${r.display} is a folder, not a file.`);
    if (!st.isFile()) throw new ToolRefusal(`${r.display} is not a regular file.`);
    if (args.mode === "create") throw new ToolRefusal(`${r.display} already exists; use mode overwrite or append.`);
    existingSize = st.size;
  }
  if (args.mode === "append" && existingSize + bytes > max) {
    throw new ToolRefusal(`appending would make ${r.display} larger than ${max} bytes (1 MB).`);
  }

  // The real path is already inside the real workspace root; create the missing folders under it.
  mkdirSync(win32.dirname(r.real), { recursive: true });
  // Re-resolve after creating folders: if anything was swapped for a link in between, the policy refuses now.
  const again = deps.policy.resolve(args.path);
  if (again.real.toLowerCase() !== r.real.toLowerCase()) throw new ToolRefusal("the path changed while writing; nothing was written.");

  const flag = args.mode === "create" ? "wx" : args.mode === "append" ? "a" : "w";
  try {
    writeFileSync(r.real, args.content, { encoding: "utf8", flag });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ToolRefusal(`${r.display} already exists; use mode overwrite or append.`);
    throw e;
  }
  deps.logger?.info("workspace.write", { mode: args.mode, bytes });
  return `Wrote ${bytes} bytes to ${r.display} (${args.mode}).`;
}

export function createWriteFileTool(deps: WorkspaceDeps) {
  return defineTool({
    name: "write_file",
    description: toolDescription("write_file"),
    parameters: writeFileParameters,
    replay: "unsafe",
    execute: (args: Static<typeof writeFileParameters>) => guarded("write_file", deps.logger, () => writeWorkspaceFile(deps, args)),
  });
}
