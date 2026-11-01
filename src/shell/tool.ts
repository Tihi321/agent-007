/**
 * The `shell` tool (S3.4). `replay: "unsafe"` (never rerun after a crash) and `executionMode: "sequential"`.
 * Execute: re-check the kill switch, consume the one-shot approval token for this call and command (defence in
 * depth if the `beforeTool` hook were ever skipped, footgun 30), run, audit started and finished, and return the exit
 * code, duration and truncated output wrapped in `<untrusted_content source="shell">`.
 */
import { createHash } from "node:crypto";
import type { AuditLog, KillSwitch, Logger } from "../contracts.js";
import type { ApprovalTokens } from "../approval/tokens.js";
import type { ShellConfig } from "../config/schema.js";
import { defineTool } from "../pi/adapter.js";
import { shellParameters, TOOL_SPECS } from "../tools/schemas.js";
import { effectiveTimeoutSec } from "./runner.js";
import type { ShellRunner } from "./runner.js";

export interface ShellToolDeps {
  runner: ShellRunner;
  approvals: ApprovalTokens;
  killSwitch: KillSwitch & { blockReason?: () => "killswitch" | "disabled" };
  audit: AuditLog;
  getShellConfig: () => ShellConfig;
  /** Working directory shown in the audit (the workspace). */
  cwd: string;
  logger?: Logger;
  /** Removes secrets from the output before the model sees it. */
  redact?: (text: string) => string;
  now?: () => Date;
}

const SHELL_DESCRIPTION = TOOL_SPECS.find((t) => t.name === "shell")?.description ?? "Run a Windows PowerShell command.";

export function sha256Command(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

/** The id used by the audit, the memo names and the approval token: `<conversationId>:<callId>`. */
export function approvalKey(conversationId: string, callId: string): string {
  return `${conversationId}:${callId}`;
}

export function wrapShellOutput(body: string): string {
  // The closing tag is escaped so command output cannot end the untrusted block early.
  return `<untrusted_content source="shell">\n${body.replace(/<\/untrusted_content>/gi, "<\\/untrusted_content>")}\n</untrusted_content>`;
}

function text(t: string, isError = false) {
  return { output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

export function createShellTool(deps: ShellToolDeps) {
  const now = deps.now ?? (() => new Date());
  const redact = deps.redact ?? ((s: string) => s);
  return defineTool({
    name: "shell",
    description: SHELL_DESCRIPTION,
    parameters: shellParameters,
    replay: "unsafe",
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const key = approvalKey(String(api.conversationId), api.callId);
      const command = args.command;

      // 1. kill switch
      if (deps.killSwitch.isOn()) {
        const reason = deps.killSwitch.blockReason?.() ?? "killswitch";
        deps.audit.write({ event: "blocked", ts: now().toISOString(), id: key, command, reason });
        return text("Shell is disabled (kill switch). The command was not run.", true);
      }

      // 2. one-shot approval token
      if (!deps.approvals.consume(key, sha256Command(command))) {
        deps.logger?.warn("shell.no_token", { key });
        return text("Refused: this command has no valid approval. It was not run.", true);
      }

      // 3. run
      const cfg = deps.getShellConfig();
      const timeoutSec = effectiveTimeoutSec(args.timeoutSec, cfg);
      deps.audit.write({ event: "started", ts: now().toISOString(), id: key, command, cwd: deps.cwd, timeoutSec });
      try {
        const res = await deps.runner.run({ key, command, timeoutSec, signal: context.abortSignal });
        deps.audit.write({
          event: "finished",
          ts: now().toISOString(),
          id: key,
          exitCode: res.exitCode,
          durationMs: res.durationMs,
          bytes: res.totalBytes,
          sha256: res.sha256,
          ...(res.timedOut ? { timedOut: true } : {}),
        });
        const lines = [
          res.timedOut ? `Timed out after ${timeoutSec} s and was killed.` : res.aborted ? "Cancelled and killed." : `Exit code: ${res.exitCode}`,
          `Duration: ${res.durationMs} ms`,
        ];
        if (res.totalBytes > res.storedBytes) lines.push(`Output exceeded the capture limit: ${res.totalBytes - res.storedBytes} bytes were not saved.`);
        const body = `${lines.join("\n")}\n---\n${redact(res.output)}`;
        return text(wrapShellOutput(body), res.timedOut || res.aborted || (res.exitCode !== null && res.exitCode !== 0));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        deps.logger?.error("shell.run_failed", { key, error: message });
        deps.audit.write({ event: "finished", ts: now().toISOString(), id: key, exitCode: null, durationMs: 0, bytes: 0, sha256: createHash("sha256").digest("hex") });
        return text(`The command could not be started: ${redact(message)}`, true);
      }
    },
  });
}
