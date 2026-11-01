/**
 * DeepSeek Harness driver (S13): shared types. Nothing here imports the ACP SDK.
 *
 * `dsh` is DeepSeek's developer preview (nightly channel, compatibility-breaking changes announced). Every job is gated by
 * the U39 probe evidence (gate.ts): until a live probe proved ask-first and shell-off, the driver refuses.
 */
import type { Logger } from "../../../contracts.js";

/** What to execute: the plan's `dsh --profile acp`, or on Windows `cmd.exe /d /s /c ""...\dsh.cmd" --profile acp"`. */
export interface DshLaunch {
  file: string;
  args: string[];
  /** Windows only: pass `args` to CreateProcess unquoted (used for the `cmd.exe /c` wrapper of a `.cmd` file). */
  windowsVerbatimArguments?: boolean;
}

/** Builds the launch for the given dsh arguments (`["--profile","acp"]`, `["--version"]`). Tests inject a fake agent here. */
export type LaunchFn = (args: readonly string[]) => DshLaunch;

/** An MCP server handed to `session/new`: always an HTTP server on loopback (creative-hub), with optional headers. */
export interface DshMcpServer {
  name: string;
  url: string;
  headers?: Array<{ name: string; value: string }>;
}

// ---- the U39 probe evidence ---------------------------------------------------------------------------------

export type ProcessCheckResult = "pass" | "fail" | "not_run";
export type ShellState = "always_ask" | "off" | "unknown";

/**
 * What the live probe (probe.ts) saw. Stored by the job runner (main-user-only folder) and re-checked before every job.
 * `passed` is NOT trusted when read back: the gate recomputes it from the fields (`evidenceProblems`).
 */
export interface DshProbeEvidence {
  schema: 1;
  /** ISO time. */
  probedAt: string;
  dshVersion: string;
  dshPath: string;
  /** Negotiated ACP protocol version (the driver speaks v1). */
  protocolVersion: number;
  /** A `session/request_permission` arrived for the shell command `whoami` before anything ran. */
  permissionRequestSeen: boolean;
  /** The request was labelled `kind: "execute"` (otherwise the job runner's execute rule would not catch the shell). */
  executeKindLabelled: boolean;
  /** The probe answered `reject_once` (or `cancelled`); the driver never allows in the probe. */
  rejected: boolean;
  /** Any sign the command ran anyway: a completed execute tool call, or the user name in the output. */
  executedAnyway: boolean;
  /** `always_ask` = observed (the shell asked); `off` = attested by the operator from dsh's config; else `unknown`. */
  shell: { state: ShellState; how: string };
  /** The session mode forced before the probe, if the driver was configured with one. */
  modeId?: string;
  /** Result of watching for a new `whoami.exe` process while the probe ran. */
  processCheck: ProcessCheckResult;
  /** `terminal/*` requests dsh sent (the driver refuses them; informational). */
  terminalRequests: number;
  /** Computed by the probe for the operator's convenience only. */
  passed: boolean;
  reasons: string[];
}

/** Where the evidence lives. The real one is a JSON file (gate.ts); tests use a memory store. */
export interface DshEvidenceStore {
  read(): Promise<DshProbeEvidence | undefined>;
  write(evidence: DshProbeEvidence): Promise<void>;
}

// ---- errors ---------------------------------------------------------------------------------------------------

/** The U39 gate (or the one-job limit, or a bad spec) refused the job. No process was started. */
export class DshRefusedError extends Error {
  readonly code: "dsh_unverified" | "dsh_busy" | "dsh_bad_spec";
  readonly reasons: string[];
  constructor(code: DshRefusedError["code"], reasons: string[]) {
    super(`DeepSeek Harness job refused: ${reasons.join("; ")}`);
    this.name = "DshRefusedError";
    this.code = code;
    this.reasons = reasons;
  }
}

/** dsh could not be started or did not complete the ACP handshake (initialize / session/new / session/resume). */
export class DshStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DshStartError";
  }
}

/** `session/resume` is not offered by this dsh build. */
export class DshUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DshUnsupportedError";
  }
}

// ---- driver options -------------------------------------------------------------------------------------------

export interface DshDriverOptions {
  /** Absolute path of `dsh.cmd` / `dsh.exe` (S13.1). */
  dshPath: string;
  /** `dsh.verified` from `jobrunner.json`: the user's own switch, set only after the live probe passed. */
  verified: boolean;
  evidence: DshEvidenceStore;
  logger: Logger;
  /** From the job runner's secrets (UI-14). Passed only in the child's environment. */
  deepseekApiKey?: string;
  /** Override the launch (tests). Default: `buildLaunch(dshPath, args)`. */
  launch?: LaunchFn;
  /** Read `dsh --version`. Default: run `launch(["--version"])` and take the first line. Tests inject a fixed string. */
  readVersion?: () => Promise<string>;
  /** The parent environment the child's environment is filtered from (default `process.env`). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Extra variables for the child (for example a dsh option that turns auto-update off, if U39 finds one). */
  extraEnv?: Record<string, string>;
  /** If set: `session/set_mode` to this id after `session/new`; a mode the agent does not list fails the job (fail closed). */
  askFirstModeId?: string;
  /** Maps a template's `mcpServers` ids to the servers for `session/new`. Required when a template names any. */
  resolveMcpServers?: (ids: readonly string[]) => DshMcpServer[];
  /** After `session/cancel`, how long to wait before the tree kill. Default 5000. */
  cancelGraceMs?: number;
  /** Shown on permission cards. Default 1800 (the config's `jobs.approvalTimeoutSec`). */
  approvalTimeoutSec?: number;
  /** Agent text is sent as `text` events in chunks: flushed at this size or at the next non-text update or the end. Default 1500. */
  textFlushChars?: number;
  /** Cap on the job's collected result text. Default 20000. */
  maxResultChars?: number;
  /** Version lookups are cached for this long. Default 30000. */
  versionTtlMs?: number;
  now?: () => number;
}

export type { Logger };
