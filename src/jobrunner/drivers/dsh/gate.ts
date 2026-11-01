/**
 * The U39 gate (S13.2). DeepSeek jobs are REFUSED until a live probe proved, for this exact dsh path and version, that
 *   - dsh asks (`session/request_permission`) before it runs a shell command (ask-first),
 *   - the request is labelled `kind: "execute"` (so the job runner's execute rule applies),
 *   - the command did not run after the rejection, and no new `whoami.exe` process appeared,
 *   - the shell is off (attested from dsh's config) or always asks (observed).
 * The user's own switch `dsh.verified` must also be true. With no evidence file, or evidence that does not hold up, or a
 * dsh version that changed since the probe (the S13.4 version guard), the answer is "refused".
 * Evidence read from disk is untrusted: `passed` in the file is ignored and everything is re-checked here.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DshEvidenceStore, DshProbeEvidence, ProcessCheckResult, ShellState } from "./types.js";

const SHELL_STATES: readonly ShellState[] = ["always_ask", "off", "unknown"];
const PROCESS_CHECKS: readonly ProcessCheckResult[] = ["pass", "fail", "not_run"];

/** Reasons the evidence does not prove ask-first and shell-off. Empty = it does. */
export function evidenceProblems(e: DshProbeEvidence): string[] {
  const p: string[] = [];
  if (e.protocolVersion !== 1) p.push(`ACP protocol version ${e.protocolVersion} (the driver speaks v1)`);
  if (!e.permissionRequestSeen) p.push("dsh did not ask permission before the shell command (not ask-first)");
  if (!e.executeKindLabelled) p.push('the shell permission request was not labelled kind "execute"');
  if (!e.rejected) p.push("the probe did not reject the shell request");
  if (e.executedAnyway) p.push("the shell command ran (or appeared to run) after the rejection");
  if (e.shell.state !== "always_ask" && e.shell.state !== "off") p.push("shell state unknown (neither always-ask nor off)");
  if (e.processCheck !== "pass") p.push(`process check for a new whoami process: ${e.processCheck}`);
  return p;
}

export interface GateInput {
  /** `dsh.verified` in `jobrunner.json`. */
  configVerified: boolean;
  evidence: DshProbeEvidence | undefined;
  currentVersion: string;
  currentPath: string;
}

export interface GateVerdict {
  allowed: boolean;
  reasons: string[];
}

export function evaluateGate(input: GateInput): GateVerdict {
  const reasons: string[] = [];
  if (!input.configVerified) reasons.push("dsh.verified is false in jobrunner.json");
  const e = input.evidence;
  if (e === undefined) {
    reasons.push("no probe evidence (run the live U39 probe)");
  } else {
    if (e.dshVersion !== input.currentVersion) reasons.push(`dsh version changed since the probe ("${e.dshVersion}" then, "${input.currentVersion}" now): run the probe again`);
    if (e.dshPath.toLowerCase() !== input.currentPath.toLowerCase()) reasons.push("dsh path differs from the probed one: run the probe again");
    reasons.push(...evidenceProblems(e));
  }
  return { allowed: reasons.length === 0, reasons };
}

// ---- parsing and storage ---------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strict parse of the stored evidence. Anything malformed is "no evidence". */
export function parseEvidence(value: unknown): DshProbeEvidence | undefined {
  if (!isRecord(value) || value["schema"] !== 1) return undefined;
  const v = value;
  const shell = v["shell"];
  if (!isRecord(shell) || !SHELL_STATES.includes(shell["state"] as ShellState) || typeof shell["how"] !== "string") return undefined;
  const bools = ["permissionRequestSeen", "executeKindLabelled", "rejected", "executedAnyway", "passed"] as const;
  for (const k of bools) if (typeof v[k] !== "boolean") return undefined;
  if (typeof v["probedAt"] !== "string" || typeof v["dshVersion"] !== "string" || typeof v["dshPath"] !== "string") return undefined;
  if (typeof v["protocolVersion"] !== "number" || typeof v["terminalRequests"] !== "number") return undefined;
  if (!PROCESS_CHECKS.includes(v["processCheck"] as ProcessCheckResult)) return undefined;
  if (!Array.isArray(v["reasons"]) || !v["reasons"].every((r) => typeof r === "string")) return undefined;
  const out: DshProbeEvidence = {
    schema: 1,
    probedAt: v["probedAt"],
    dshVersion: v["dshVersion"],
    dshPath: v["dshPath"],
    protocolVersion: v["protocolVersion"],
    permissionRequestSeen: v["permissionRequestSeen"] as boolean,
    executeKindLabelled: v["executeKindLabelled"] as boolean,
    rejected: v["rejected"] as boolean,
    executedAnyway: v["executedAnyway"] as boolean,
    shell: { state: shell["state"] as ShellState, how: shell["how"] },
    processCheck: v["processCheck"] as ProcessCheckResult,
    terminalRequests: v["terminalRequests"],
    passed: v["passed"] as boolean,
    reasons: v["reasons"] as string[],
  };
  if (typeof v["modeId"] === "string") out.modeId = v["modeId"];
  return out;
}

/** The evidence as a JSON file (in the job runner's main-user-only folder). A missing or invalid file reads as `undefined`. */
export class FileEvidenceStore implements DshEvidenceStore {
  constructor(private readonly path: string) {}

  async read(): Promise<DshProbeEvidence | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return undefined;
    }
    try {
      return parseEvidence(JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  async write(evidence: DshProbeEvidence): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await rename(tmp, this.path);
  }
}

/** For tests and for a job runner that keeps the evidence in memory. */
export class MemoryEvidenceStore implements DshEvidenceStore {
  constructor(public value?: DshProbeEvidence) {}
  async read(): Promise<DshProbeEvidence | undefined> {
    return this.value;
  }
  async write(evidence: DshProbeEvidence): Promise<void> {
    this.value = evidence;
  }
}
