/**
 * Permission mapping (S13.3), pure functions. `session/request_permission` options of kind `allow_once` and `reject_once`
 * are the only ones ever shown or selected; `allow_always` and `reject_always` are dropped (I19). If an agent offers no
 * usable reject option the answer is `cancelled`, which every agent must treat as "do not run".
 */
import type { PermissionKind } from "../../../jobs/contracts.js";
import type { Json } from "../../../jobs/contracts.js";
import type { RequestPermissionRequest, RequestPermissionResponse } from "./session.js";

type Option = RequestPermissionRequest["options"][number];

/** The two kinds the user can ever be offered. */
export function shownOptions(options: readonly Option[]): Option[] {
  return options.filter((o) => o.kind === "allow_once" || o.kind === "reject_once");
}

export function allowOnceOption(options: readonly Option[]): Option | undefined {
  return options.find((o) => o.kind === "allow_once");
}

export function rejectOnceOption(options: readonly Option[]): Option | undefined {
  return options.find((o) => o.kind === "reject_once");
}

export const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

export function selectOutcome(option: Option): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

/** `reject_once` if offered, else `cancelled`. Never an "always" option. */
export function rejectOutcome(options: readonly Option[]): RequestPermissionResponse {
  const o = rejectOnceOption(options);
  return o ? selectOutcome(o) : CANCELLED;
}

/** `allow_once` if offered, else a rejection (we never pick anything else to "make it work"). */
export function allowOutcome(options: readonly Option[]): RequestPermissionResponse {
  const o = allowOnceOption(options);
  return o ? selectOutcome(o) : rejectOutcome(options);
}

const SHELL_NAME = /(^|[^a-z])(shell|bash|sh|zsh|pwsh|powershell|cmd|terminal|exec|execute|run_command|run_terminal|command)([^a-z]|$)/i;

/**
 * ACP `ToolKind` to the job runner's kinds. A tool whose name looks like a shell counts as `execute` even if dsh labelled it
 * `other` (the probe also requires the label, so this is a second net, not the first).
 */
export function permissionKind(kind: string | null | undefined, name: string): PermissionKind {
  if (kind === "execute") return "execute";
  if (SHELL_NAME.test(name)) return "execute";
  switch (kind) {
    case "read":
    case "search":
      return "read";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    default:
      return "other";
  }
}

const MAX_INPUT_CHARS = 4000;

/** `rawInput` as JSON for the card: round-tripped, capped, never a thrown error. */
export function toJsonInput(raw: unknown): Json {
  if (raw === undefined) return {};
  try {
    const text = JSON.stringify(raw);
    if (text === undefined) return {};
    if (text.length <= MAX_INPUT_CHARS) return JSON.parse(text) as Json;
    return { truncated: true, preview: text.slice(0, MAX_INPUT_CHARS) };
  } catch {
    return { unserializable: true };
  }
}

export function toolNameOf(tc: { name?: string | null; title?: string | null }): string {
  const name = (tc.name ?? "").trim();
  if (name !== "") return name;
  const title = (tc.title ?? "").trim();
  return title !== "" ? title : "tool";
}
