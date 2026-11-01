/**
 * The form framework of the settings UI (S18.2). A form is a DESCRIPTOR, not UI code: `registerForm({id, title, section, schema,
 * warnings?, ack?})`. The browser renders it generically from the schema (`ui/settings/forms.js`), so Phase 4's S22.4 adds
 * descriptors, not code. `ack` makes a form require a ticked acknowledgment whose text is stored in the audit line (Phase 4 uses
 * it for `termsAccepted`).
 *
 * `section` is the list of top-level `security.json` sections the form edits (or `jobrunner` for the limits of `jobrunner.json`).
 * `schema` is an object schema whose properties are exactly those sections.
 */
import { SECURITY_SCHEMA } from "../../../settings/schema.js";
import type { Schema } from "../../../settings/jsonschema.js";
import { JOBRUNNER_LIMITS_SCHEMA } from "./jobrunnerLimits.js";
import { phase4Forms } from "./phase4.js";

export interface FormDescriptor {
  id: string;
  title: string;
  description?: string;
  /** Where a save goes: `security.json` sections, or `jobrunner.json` limits. */
  target: "security" | "jobrunner";
  /** For `target: "security"`: the top-level sections the form edits. */
  section: string[];
  /** An object schema; its properties are the sections (or, for jobrunner, `limits`). */
  schema: Schema;
  warnings?: string[];
  /** The form needs a ticked acknowledgment; the text is stored in the audit line. */
  ack?: { text: string };
  /** Sidebar group. */
  group?: string;
}

export class FormRegistry {
  readonly #forms = new Map<string, FormDescriptor>();

  register(d: FormDescriptor): void {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(d.id)) throw new Error(`form id "${d.id}" is not valid`);
    if (this.#forms.has(d.id)) throw new Error(`form "${d.id}" is already registered`);
    if (d.target === "security") {
      for (const s of d.section) {
        if (!SECURITY_SCHEMA.properties?.[s] || s === "schemaVersion") throw new Error(`form "${d.id}" names an unknown security section "${s}"`);
      }
    }
    this.#forms.set(d.id, d);
  }

  get(id: string): FormDescriptor | undefined {
    return this.#forms.get(id);
  }

  list(): FormDescriptor[] {
    return [...this.#forms.values()];
  }
}

/** Convenience used by tests and by Phase 4: `registerForm(registry, descriptor)`. */
export function registerForm(registry: FormRegistry, d: FormDescriptor): void {
  registry.register(d);
}

function securityForm(id: string, title: string, sections: string[], extra: Partial<FormDescriptor> = {}): FormDescriptor {
  const properties: Record<string, Schema> = {};
  for (const s of sections) properties[s] = SECURITY_SCHEMA.properties?.[s] as Schema;
  return { id, title, target: "security", section: sections, schema: { type: "object", properties, additionalProperties: false }, ...extra };
}

/** The forms the UI ships (S18.2): Telegram ids, folders, shell and approvals, tool limits, models and presets, MCP and Flow, jobs, proposals. */
export function shippedForms(): FormRegistry {
  const r = new FormRegistry();
  r.register(securityForm("telegram", "Telegram access", ["telegram"], { group: "Access", description: "Only these Telegram accounts can talk to the agent and approve anything." }));
  r.register(
    securityForm("folders", "Folders", ["folders"], {
      group: "Access",
      description: "What the agent may read, and what is always refused. A deny path always wins and also reaches the next Claude job.",
      warnings: ["A new allowed folder also needs an NTFS read grant for the agent user. The UI never changes permissions: run deploy\\grant-folder-acls.ps1 for it."],
    }),
  );
  r.register(securityForm("shell", "Shell and approvals", ["shell"], { group: "Access", description: "Every shell command still needs your tap in Telegram. If the kill switch flag is present, shell stays off whatever this says; delete the flag locally to re-enable it." }));
  r.register(securityForm("limits", "Tool limits", ["limits"], { group: "Access" }));
  r.register(securityForm("models", "Model runners and presets", ["model", "presets"], { group: "Model", description: "Runner endpoints must be on this PC (127.0.0.1 or localhost). A persona can only pick one of the presets listed here. A preset of kind acp goes through the api-acp-proxy (also loopback) and counts as cloud; a per-token-billed API key is never a preset.", warnings: ["A claude or antigravity preset is refused until you tick its acknowledgment in the Terms form."] }));
  r.register(securityForm("mcp", "MCP servers and Flow", ["mcp", "flow"], { group: "Jobs", description: "creative-hub servers on this PC and the allowlist of their tools. Servers must be loopback URLs." }));
  r.register(securityForm("jobs", "Jobs (agent side)", ["jobs", "budgets"], { group: "Jobs", description: "Approval timeouts and the daily job ceiling for personas. The job runner's own limits are in the next form." }));
  r.register({
    id: "jobrunner",
    title: "Job runner limits",
    target: "jobrunner",
    section: [],
    schema: JOBRUNNER_LIMITS_SCHEMA,
    group: "Jobs",
    description: "The job runner enforces these itself, whatever the agent sends. Saved to jobrunner.json; effective after the job runner restarts.",
    warnings: ["Restart the job runner (log off and on, or restart its scheduled task) after saving."],
  });
  r.register(securityForm("proposals", "Model proposals", ["proposals"], { group: "Personas and proposals", description: "How the model may propose preference changes, and whether tone and verbosity may change without a card." }));
  for (const d of phase4Forms()) r.register(d); // Phase 4 (S22.4): bots, terms, bot bus, bot room, gate
  return r;
}
