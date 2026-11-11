/**
 * REQ-0014 browser support: the IPC contract between the agent's browser tools and the job runner's browser engine.
 * Types and constants only. `contracts.ts` imports `BROWSER_TOOL_NAMES` from here; this file imports only types from there.
 */
import type { ArtifactRef } from "./contracts.js";

export const BROWSER_TOOL_NAMES = [
  "browser_goto",
  "browser_back",
  "browser_read",
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_press",
  "browser_screenshot",
  "browser_done",
] as const;
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export const BROWSER_KEYS = ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", "Backspace"] as const;
export type BrowserKey = (typeof BROWSER_KEYS)[number];

/** `ref` = an element id from the last `read`, /^e\d{1,5}$/. */
export type BrowserAction =
  | { op: "goto"; url: string } // http(s) only, <= 2048 chars
  | { op: "back" }
  | { op: "read"; maxChars?: number } // default 12000, 1000..40000
  | { op: "click"; ref: string }
  | { op: "type"; ref: string; text: string; clear?: boolean } // text <= 2000
  | { op: "fill"; fields: { ref: string; value: string }[] } // 1..20 fields, value <= 2000; <select> takes the option label or value
  | { op: "press"; key: BrowserKey; ref?: string }
  | { op: "screenshot"; fullPage?: boolean } // fullPage is clipped to 1280x4000
  | { op: "done"; summary: string }; // <= 2000

/** `callId` matches /^[A-Za-z0-9_.:-]{1,100}$/. */
export interface BrowserActionBody {
  jobId: string;
  callId: string;
  action: BrowserAction;
}

/** denied = the user said no or timed out; refused = a rule said no, nobody was asked. */
export type BrowserOutcome = "done" | "denied" | "refused" | "error";

export interface BrowserActionReply {
  outcome: BrowserOutcome;
  /** Full URL of the page after the action (only the model sees it). */
  url?: string;
  title?: string;
  /** Untrusted page content (read), or a one-line result; <= 40000 chars. */
  text?: string;
  shot?: ArtifactRef;
  /** Why (denied, refused, error), plain text for the model. */
  message?: string;
}
