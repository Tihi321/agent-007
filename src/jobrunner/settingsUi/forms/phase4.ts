/**
 * The Phase 4 form descriptors (S22.4, I25, I29, UI-24): bots (routes, tools, edges and the `egress` flag), the terms
 * acknowledgments, the bot-to-bot limits, the bot room and the local gate. Descriptors only: the browser renders each one from its schema
 * (`ui/settings/forms.js`), and the save goes through the same S18.1 route (session, CSRF, one `source: "ui"` audit line before the
 * file is replaced, the loader's refusals).
 *
 * `termsAccepted` exists ONLY here. No allowlist row, tool, `propose_*` or Telegram button reaches it (a test walks every path), and the
 * form carries `ack`: the save is refused unless the acknowledgment text is ticked, and that text is stored in the audit line.
 * The presets and their new fields (kind, proxy URL, provider, privacy class, autoFallback) are part of the existing `models` form,
 * which is built from the same schema, so it needs no new code.
 */
import { SECURITY_SCHEMA } from "../../../settings/schema.js";
import type { Schema } from "../../../settings/jsonschema.js";
import type { FormDescriptor } from "./registry.js";

export const TERMS_ACK_TEXT =
  "I understand that using Claude or Antigravity through the proxy may break that vendor's terms, that the account could be blocked or suspended, and that this is my own decision. This is saved in the audit log.";

function form(id: string, title: string, sections: string[], extra: Partial<FormDescriptor> = {}): FormDescriptor {
  const properties: Record<string, Schema> = {};
  for (const s of sections) properties[s] = SECURITY_SCHEMA.properties?.[s] as Schema;
  return { id, title, target: "security", section: sections, schema: { type: "object", properties, additionalProperties: false }, ...extra };
}

export function phase4Forms(): FormDescriptor[] {
  return [
    form("bots", "Bots", ["bots"], {
      group: "Bots",
      description: "Each bot has its own Telegram token, memory, model route, tool allowlist, folders and edges. A bot with no edge cannot ask other bots. The egress flag on an edge allows what the asked bot reads to leave through a cloud model; it exists only here.",
      warnings: [
        "A new bot needs its own token: run deploy\\new-secrets.ps1 -Bots <id> and create the bot with BotFather first.",
        "A bot whose route can use a cloud model reads only its cloud-safe folders. At most one bot may have the shell tool.",
        "The agent uses a change after it restarts: send /applysettings in Telegram.",
      ],
    }),
    form("terms", "Terms acknowledgments", ["termsAccepted"], {
      group: "Bots",
      description: "Claude and Antigravity run through the proxy on a consumer subscription, which their terms may forbid. A preset for either is refused until you tick it here. Nothing else can set this: not the model, not a tool, not a Telegram button.",
      ack: { text: TERMS_ACK_TEXT },
    }),
    form("botbus", "Bot-to-bot limits", ["botBus"], { group: "Bots", description: "Hard limits on how far and how often bots may ask each other. The code enforces them whatever a bot sends." }),
    form("botroom", "Bot room", ["botRoom"], {
      group: "Bots",
      description: "A Telegram group where a read-only mirror bot posts what bots say to each other. none turns it off. Secrets are redacted before anything is posted.",
      warnings: ["The mirror bot needs its own token (deploy\\new-secrets.ps1 -Mirror) and the chat id of the room."],
    }),
    form("gate", "Model gate", ["gate"], { group: "Bots", description: "How bots share the local model runners and the proxy: queue depth, how long a turn sticks to a loaded model, and the notice delay." }),
  ];
}
