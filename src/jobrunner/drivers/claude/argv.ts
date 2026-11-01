/**
 * The Claude Code command line (S12.2). Pure functions: no spawn, no file access.
 *
 *   claude -p --output-format stream-json --verbose --permission-mode <default|dontAsk> [--model m] [--resume id]
 *     --allowedTools <template list> --disallowedTools <shell tools, Flow unless enabled, UI-2 path rules, template list>
 *     --permission-prompt-tool mcp__a7perm__decide --mcp-config <job-scoped file>
 *
 * The brief goes on stdin, never in argv. `bypassPermissions`, `auto` and `acceptEdits` are not representable: the mode is
 * checked against a two-entry allowlist and `assertSafeArgv` re-checks the finished argv (a test pins both).
 */
import type { JobTemplate } from "../../../jobs/contracts.js";

/** The only permission modes a job may use. */
export const ALLOWED_PERMISSION_MODES = ["default", "dontAsk"] as const;
export type ClaudePermissionMode = (typeof ALLOWED_PERMISSION_MODES)[number];

export const PERMISSION_SERVER_NAME = "a7perm";
export const PERMISSION_TOOL = `mcp__${PERMISSION_SERVER_NAME}__decide`;
export const DEFAULT_FLOW_SERVER_ID = "flow-music-mcp";

/** Shell tools of Claude Code on native Windows (U32): Git Bash and PowerShell. Always disallowed, never allowed. */
export const SHELL_TOOLS = ["Bash", "PowerShell"] as const;

/** Flags and values that must never appear in a job's argv. */
const FORBIDDEN_FLAGS = ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--bare", "--settings"];
const FORBIDDEN_MODES = ["bypassPermissions", "auto", "acceptEdits", "plan"];

export class ClaudeArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeArgvError";
  }
}

export function assertPermissionMode(mode: unknown): asserts mode is ClaudePermissionMode {
  if (typeof mode !== "string" || !(ALLOWED_PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new ClaudeArgvError(`permission mode "${String(mode)}" is not allowed (only ${ALLOWED_PERMISSION_MODES.join(" or ")})`);
  }
}

/** The tool name of a permission rule: `Bash(git log *)` gives `Bash`. */
export function ruleToolName(rule: string): string {
  const i = rule.indexOf("(");
  return (i === -1 ? rule : rule.slice(0, i)).trim();
}

export function isShellRule(rule: string): boolean {
  const name = ruleToolName(rule).toLowerCase();
  return SHELL_TOOLS.some((t) => t.toLowerCase() === name);
}

export function isFlowRule(rule: string, flowServerId: string = DEFAULT_FLOW_SERVER_ID): boolean {
  const name = ruleToolName(rule).toLowerCase();
  const prefix = `mcp__${flowServerId}`.toLowerCase();
  return name === prefix || name.startsWith(`${prefix}__`);
}

/**
 * A Windows path as a Claude Code absolute-path rule pattern (U46): `C:\Pixotope\x` becomes `//c/Pixotope/x/**`.
 * UNC and relative paths are refused (fail closed: the job does not start). The form is from Claude Code's permission
 * documentation and has not been probed live (S12.2's [GO] probe records U46).
 */
export function claudePathPattern(winPath: string): string {
  let p = winPath.trim().replace(/\\/g, "/");
  if (p === "") throw new ClaudeArgvError("empty deny path");
  p = p.replace(/\/\*\*$/, "").replace(/\/+$/, "");
  const m = /^([A-Za-z]):(?:\/(.*))?$/.exec(p);
  if (!m) throw new ClaudeArgvError(`deny path is not an absolute drive path: ${winPath}`);
  const rest = (m[2] ?? "").replace(/\/+/g, "/");
  return rest === "" ? `//${m[1]!.toLowerCase()}/**` : `//${m[1]!.toLowerCase()}/${rest}/**`;
}

export const PATH_DENY_TOOLS = ["Read", "Edit", "Write"] as const;

/** One `Read(...)`, `Edit(...)` and `Write(...)` deny rule per path, in path order. Built from config, so a new path adds rules. */
export function denyRulesForPaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const pattern = claudePathPattern(path);
    for (const tool of PATH_DENY_TOOLS) out.push(`${tool}(${pattern})`);
  }
  return out;
}

export interface ClaudeArgvOptions {
  template: JobTemplate;
  /** The job-scoped `--mcp-config` file (adds the a7perm helper). */
  mcpConfigPath: string;
  /** The UI-2 paths plus the agent's own folders (S12.2 "Pixotope defence in depth"). */
  denyPaths: readonly string[];
  /** `--resume <session id>`. */
  resumeSessionId?: string;
  /** Default `flow-music-mcp`. */
  flowServerId?: string;
}

export interface ClaudeArgvResult {
  args: string[];
  allowedTools: string[];
  disallowedTools: string[];
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function checkRule(rule: unknown, what: string): asserts rule is string {
  if (typeof rule !== "string" || rule.trim() === "" || rule.startsWith("-")) throw new ClaudeArgvError(`bad ${what} entry: ${String(rule)}`);
}

export function buildClaudeArgs(opts: ClaudeArgvOptions): ClaudeArgvResult {
  const { template } = opts;
  const flowId = opts.flowServerId ?? DEFAULT_FLOW_SERVER_ID;
  assertPermissionMode(template.permissionMode);
  if (opts.resumeSessionId !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(opts.resumeSessionId)) throw new ClaudeArgvError("session id has unexpected characters");

  const allowedTools = dedupe(template.allowedTools);
  for (const rule of allowedTools) {
    checkRule(rule, "allowedTools");
    if (isShellRule(rule)) throw new ClaudeArgvError(`allowedTools may not contain a shell tool: ${rule}`);
    if (isFlowRule(rule, flowId)) throw new ClaudeArgvError(`allowedTools may not contain a Flow tool (Flow goes through the permission tool): ${rule}`);
    if (ruleToolName(rule) === "*") throw new ClaudeArgvError("allowedTools may not be a bare wildcard");
  }

  const disallowedTools = dedupe([
    ...SHELL_TOOLS,
    ...(template.flow.enabled ? [] : [`mcp__${flowId}__*`]),
    ...denyRulesForPaths(opts.denyPaths),
    ...template.disallowedTools,
  ]);
  for (const rule of disallowedTools) checkRule(rule, "disallowedTools");

  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", template.permissionMode];
  if (template.model !== undefined && template.model !== "") {
    if (!/^[A-Za-z0-9._:[\]-]{1,100}$/.test(template.model)) throw new ClaudeArgvError("model name has unexpected characters");
    args.push("--model", template.model);
  }
  if (opts.resumeSessionId !== undefined) args.push("--resume", opts.resumeSessionId);
  if (allowedTools.length > 0) args.push("--allowedTools", ...allowedTools);
  args.push("--disallowedTools", ...disallowedTools);
  args.push("--permission-prompt-tool", PERMISSION_TOOL, "--mcp-config", opts.mcpConfigPath);
  assertSafeArgv(args);
  return { args, allowedTools, disallowedTools };
}

/** Last line of defence: the finished argv holds no forbidden flag and a permission mode from the allowlist. */
export function assertSafeArgv(args: readonly string[]): void {
  for (const a of args) {
    if (FORBIDDEN_FLAGS.includes(a)) throw new ClaudeArgvError(`forbidden flag ${a}`);
  }
  if (args.filter((a) => a === "--permission-mode").length !== 1) throw new ClaudeArgvError("--permission-mode must be given exactly once");
  const mode = args[args.indexOf("--permission-mode") + 1];
  if (mode === undefined || FORBIDDEN_MODES.includes(mode)) throw new ClaudeArgvError(`forbidden permission mode ${String(mode)}`);
  assertPermissionMode(mode);
}

/** Env vars removed from the child so the user's own `/login` is used and nothing is redirected (S12.2, notes 3.2). */
const STRIPPED_PREFIXES = ["ANTHROPIC_"];
const STRIPPED_NAMES = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

/** The main user's env with every `ANTHROPIC_*` variable (any case; Windows env names are case-insensitive) removed. */
export function buildClaudeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    const up = name.toUpperCase();
    if (STRIPPED_PREFIXES.some((p) => up.startsWith(p))) continue;
    if (STRIPPED_NAMES.includes(up)) continue;
    // The helper's per-job variables are file-scoped (I28), never inherited from the runner's env.
    if (up.startsWith("A7_JOB_")) continue;
    out[name] = value;
  }
  return out;
}
