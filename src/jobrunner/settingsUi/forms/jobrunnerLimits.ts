/**
 * The "jobs" form's second part (S18.2, UI-19d): the limits of the job runner's own `jobrunner.json`. Only `limits` is editable
 * here (never the cwd allowlist, the engines, the hub or the ports). The same descriptors validate and render.
 */
import type { Schema } from "../../../settings/jsonschema.js";

const int = (min: number, max: number, def: number, label: string, help?: string): Schema => ({ type: "integer", minimum: min, maximum: max, default: def, "x-ui": { widget: "number", label, ...(help ? { help } : {}) } });

export const JOBRUNNER_LIMITS_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limits: {
      type: "object",
      additionalProperties: false,
      "x-ui": { label: "Job runner limits" },
      properties: {
        dailyJobCap: int(0, 10_000, 20, "Jobs per day"),
        dailyCreditCap: int(0, 10_000_000, 0, "Flow credits per day", "0 means no Flow job may run (there is no default budget)."),
        perTemplateMaxCredits: { type: "object", additionalProperties: { type: "integer", minimum: 0, maximum: 1_000_000 }, "x-ui": { widget: "map", label: "Credit cap per template", help: "Template id to credits. Can only lower a template's own cap." } },
        maxConcurrent: {
          type: "object",
          additionalProperties: false,
          "x-ui": { label: "Jobs running at once" },
          properties: { claude: int(1, 4, 1, "Claude Code"), dsh: int(1, 4, 1, "DeepSeek"), hub: int(1, 4, 1, "Hub services") },
        },
        maxDurationMin: int(1, 1440, 360, "Longest job (minutes)"),
        outputCapBytes: int(1024, 512 * 1024 * 1024, 5 * 1024 * 1024, "Output cap (bytes)"),
        maxEventTextChars: int(100, 1_000_000, 8000, "Event text cap (characters)"),
        permissionTimeoutSec: int(1, 86_400, 1800, "Permission prompt timeout (s)"),
        cancelGraceSec: int(0, 600, 10, "Cancel grace (s)"),
      },
    },
  },
};
