/**
 * REQ-0014: the Browser form. `browser.acknowledged` exists ONLY here (like the terms acknowledgments): no allowlist row, tool, `propose_*`
 * or Telegram button reaches `browser.*`, and the form carries `ack`, so the save is refused unless the text is ticked and the
 * text is stored in the audit line. The job runner treats the browser engine as disabled until `acknowledged` is true.
 */
import { SECURITY_SCHEMA } from "../../../settings/schema.js";
import type { Schema } from "../../../settings/jsonschema.js";
import type { FormDescriptor } from "./registry.js";

export const BROWSER_ACK_TEXT =
  "I understand that browser jobs act on real websites with the accounts I log into in the agent's browser profile, that risky steps ask me in Telegram but ordinary clicks do not, and that this is my own decision. This is saved in the audit log.";

export function browserForm(): FormDescriptor {
  const properties: Record<string, Schema> = { browser: SECURITY_SCHEMA.properties?.["browser"] as Schema };
  return {
    id: "browser",
    title: "Browser",
    target: "security",
    section: ["browser"],
    schema: { type: "object", properties, additionalProperties: false },
    group: "Jobs",
    description: "Lets the job runner drive an isolated Chromium for browser jobs. Credential fields are never typed by the agent; risky steps ask you in Telegram first. Nothing else can set the acknowledgment: not the model, not a tool, not a Telegram button.",
    warnings: ["Log in with: node dist\\src\\jobrunner\\main.js browser-login (desktop: tray > Browser login...)."],
    ack: { text: BROWSER_ACK_TEXT },
  };
}
