/**
 * The job runner's own permission rules (`JobRunnerPolicy`, S11 implements, S12 and S13 use). They run BEFORE any user is
 * asked, for both engines:
 *
 *   - shell tools (`Bash`, `PowerShell`, ACP `execute`) are denied: creative jobs have no shell (I19, S13.2);
 *   - a Scriptorium start is always denied inside a job (only the agent's approved `hub_start` can start it);
 *   - a Flow tool call (I21) is allowed with NO Telegram tap only when it carries a `max_credits` that fits the credits the
 *     user approved for this job (budget minus what earlier calls reserved); otherwise it is denied. Every Flow decision
 *     is a `flow_call` event and an audit line. The credits are reserved at the moment of the check, so concurrent calls
 *     cannot both fit into the same remainder;
 *   - everything else is `ask`.
 */
import type { Json, JobRef, JobRunnerPolicy, PermissionKind, PolicyVerdict } from "../jobs/contracts.js";
import { isFreeFlowTool, sceneCreditsTotal } from "../jobs/flowCredits.js";
import { isFlowToolName } from "./templates.js";

export interface PolicyJobView {
  flowEnabled: boolean;
  flowBudget: number | undefined;
  flowCharged: number;
}

export interface FlowCallInfo {
  tool: string;
  maxCredits: number;
  allowed: boolean;
  chargedTotal: number;
  remaining: number;
}

export interface PolicyDeps {
  flowServerId: string;
  /** The live state of a running job, or undefined for an unknown or finished job (everything is then denied). */
  getJob(jobId: string): PolicyJobView | undefined;
  /** Reserves credits; returns the new total charged. */
  chargeFlow(jobId: string, credits: number): number;
  onFlowCall(jobId: string, info: FlowCallInfo): void;
}

const SHELL_NAME = /^(bash|powershell|pwsh|shell|cmd|terminal|execute|exec|run_command|run_terminal_cmd)(\(.*\))?$/i;
const READ_NAME = /^(read|glob|grep|ls|list|search|view|notebookread|websearch|webfetch)/i;
const EDIT_NAME = /^(edit|write|multiedit|notebookedit|create|delete|move|patch)/i;

export function isShellTool(tool: string): boolean {
  return SHELL_NAME.test(tool.trim());
}

/** A rough kind for a tool name, used when the helper path has no kind of its own. */
export function kindOfTool(tool: string, flowServerId: string): PermissionKind {
  if (isShellTool(tool)) return "execute";
  if (isFlowToolName(tool, flowServerId)) return "flow";
  if (EDIT_NAME.test(tool)) return "edit";
  if (READ_NAME.test(tool)) return "read";
  return "other";
}

function inputText(input: Json): string {
  try {
    return JSON.stringify(input)?.slice(0, 20_000).toLowerCase() ?? "";
  } catch {
    return "";
  }
}

/** True for an attempt to start Scriptorium: a tool whose name says so, `hub_start {service: scriptorium}`, or `hub.ps1 start scriptorium`. */
export function isScriptoriumStart(tool: string, input: Json): boolean {
  const t = tool.toLowerCase();
  const text = inputText(input);
  if (t.includes("scriptorium") && /(start|resume|launch|boot|run_factory|factory)/.test(t)) return true;
  if (t.includes("hub_start") && text.includes("scriptorium")) return true;
  if (text.includes("scriptorium") && text.includes("hub.ps1") && /\bstart\b/.test(text)) return true;
  return false;
}

/**
 * Reads the credit cap of a Flow call's input: a top-level `max_credits` (or `maxCredits`) above zero, or the sum of the
 * `scenes[].max_credits` of `flow_generate` (every scene must carry one; a sum of 0 is a call of free images, which is
 * allowed inside an approved Flow job and charges nothing).
 */
export function flowMaxCredits(input: Json): number | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  if (input["max_credits"] === undefined && input["maxCredits"] === undefined) {
    const scenes = sceneCreditsTotal(input);
    return scenes?.ok ? scenes.total : undefined;
  }
  const v = input["max_credits"] ?? input["maxCredits"];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

export class CorePolicy implements JobRunnerPolicy {
  constructor(private readonly deps: PolicyDeps) {}

  checkPermission(job: JobRef, tool: string, input: Json): PolicyVerdict {
    const state = this.deps.getJob(job.jobId);
    if (state === undefined) return "deny";
    if (typeof tool !== "string" || tool === "") return "deny";
    if (isShellTool(tool)) return "deny";
    if (isScriptoriumStart(tool, input)) return "deny";
    if (isFlowToolName(tool, this.deps.flowServerId)) return this.flow(job.jobId, state, tool, input);
    return "ask";
  }

  private flow(jobId: string, state: PolicyJobView, tool: string, input: Json): PolicyVerdict {
    const budget = state.flowBudget ?? 0;
    if (isFreeFlowTool(tool, this.deps.flowServerId)) {
      // dev 153a: a free tool needs an approved, enabled Flow job with a budget, and charges nothing
      const ok = state.flowEnabled && budget > 0;
      const remaining = Math.max(0, budget - state.flowCharged);
      this.deps.onFlowCall(jobId, { tool, maxCredits: 0, allowed: ok, chargedTotal: state.flowCharged, remaining });
      return ok ? "allow" : "deny";
    }
    const max = flowMaxCredits(input);
    const remaining = Math.max(0, budget - state.flowCharged);
    if (!state.flowEnabled || budget <= 0 || max === undefined || max > remaining) {
      this.deps.onFlowCall(jobId, { tool, maxCredits: max ?? 0, allowed: false, chargedTotal: state.flowCharged, remaining });
      return "deny";
    }
    const total = this.deps.chargeFlow(jobId, max);
    this.deps.onFlowCall(jobId, { tool, maxCredits: max, allowed: true, chargedTotal: total, remaining: Math.max(0, budget - total) });
    return "allow";
  }
}
