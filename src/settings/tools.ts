/**
 * The five Phase 3 model tools (S17.7, I27a), ALL `deferred: true`: `get_settings`, `list_personas`, `propose_setting`,
 * `propose_persona`, `switch_persona`. The always-loaded list (`ALWAYS_LOADED`, 10 names) is not touched; the model finds these
 * through `tool_search` (the descriptions carry the words "settings", "preference", "tone", "persona").
 *
 * `propose_*` never block: they return `{status: "pending", proposalId}` or a typed error. The user's decision arrives later as
 * a card result. `get_settings` returns the prefs in full and a REDACTED security view (folder aliases, never paths; no user
 * ids, no token references), wrapped as untrusted content. There is no tool that can change a security setting.
 *
 * `switch_persona`: equal or narrower applies at once; broader or incomparable produces ONE card listing what is added (the
 * proposal engine's `switch` kind). The user's own `/persona` applies at once (S19.3).
 */
import type { ChatLookup, Logger } from "../contracts.js";
import type { Config } from "../config/schema.js";
import { Type, defineExtension, defineTool } from "../pi/adapter.js";
import type { Context, Extension, Static, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "../pi/adapter.js";
import { errorResult, textResult, wrapUntrusted } from "../tools/folders.js";
import { compare, appliesWithoutCard } from "./compare.js";
import { SettingsError } from "./contracts.js";
import type { PersonaRuntime, SettingsAudit } from "./contracts.js";
import type { PrefsStore } from "./prefs.js";
import type { ProposalEngine } from "./proposals.js";
import { sha256Text } from "./chain.js";

export const SETTINGS_EXTENSION_NAME = "a7-settings";
export const SETTINGS_TOOL_NAMES = ["get_settings", "list_personas", "propose_setting", "propose_persona", "switch_persona"] as const;

export const getSettingsParameters = Type.Object({
  scope: Type.Optional(Type.Enum(["prefs", "security", "personas"], { description: "Which settings to show: prefs (tone, verbosity, language), a redacted security summary, or the personas. Default prefs." })),
});
export const listPersonasParameters = Type.Object({});
export const proposeSettingParameters = Type.Object({
  path: Type.String({ maxLength: 100, description: "The preference to change, for example style.verbosity or style.tone. Only preferences can be proposed; security settings cannot." }),
  value: Type.String({ maxLength: 500, description: "The new value as text, for example short, normal or detailed." }),
  reason: Type.String({ maxLength: 300, description: "One sentence for the user: why this preference should change." }),
});
export const proposePersonaParameters = Type.Object({
  draft: Type.Object({
    id: Type.String({ maxLength: 24, description: "Lowercase letters, digits and dashes, starting with a letter." }),
    name: Type.String({ maxLength: 60 }),
    description: Type.Optional(Type.String({ maxLength: 200 })),
    prompt: Type.String({ maxLength: 4000, description: "Plain text added to the system prompt. It cannot grant any permission." }),
    toolAllow: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 60, description: "Tool names this persona may use. It can only narrow what is already allowed." }),
    mcpAllow: Type.Array(Type.Object({ server: Type.String({ maxLength: 32 }), tools: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 100 }) }), { maxItems: 30 }),
    jobTemplates: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 50 }),
    modelPreset: Type.String({ maxLength: 24 }),
    memory: Type.Object({
      write: Type.Enum(["shared", "scope", "none"]),
      scope: Type.Optional(Type.String({ maxLength: 24 })),
      sharedRead: Type.Boolean(),
    }),
    maxJobsPerDay: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
  }),
  reason: Type.String({ maxLength: 300, description: "One sentence for the user: why this persona is useful." }),
});
export const switchPersonaParameters = Type.Object({
  id: Type.String({ maxLength: 24, description: "The persona id from list_personas." }),
  reason: Type.Optional(Type.String({ maxLength: 300 })),
});

/** A redacted view of the security settings: aliases not paths, counts not entries, no user ids, no secret references. */
export function redactedSecurityView(config: Config, extra: { presets?: { id: string; label?: string; runner?: string; modelId?: string }[]; budgets?: unknown; proposals?: unknown } = {}): Record<string, unknown> {
  const runners: Record<string, unknown> = {};
  for (const [name, b] of Object.entries(config.model.runners)) {
    if (!b) continue;
    runners[name] = { baseUrl: b.baseUrl, modelId: b.modelId, contextWindow: b.contextWindow, maxTokens: b.maxTokens };
  }
  return {
    shell: { enabled: config.shell.enabled, approvalTimeoutSec: config.shell.approvalTimeoutSec, execTimeoutSec: config.shell.execTimeoutSec, maxExecTimeoutSec: config.shell.maxExecTimeoutSec },
    folders: { allowedAliases: config.folders.allow.map((f) => f.alias), denyEntries: config.folders.deny.length },
    model: { runner: config.model.runner, runners },
    ...(extra.presets ? { presets: extra.presets.map((p) => ({ id: p.id, label: p.label, runner: p.runner, modelId: p.modelId })) } : {}),
    limits: { ...config.limits },
    jobs: { approvalTimeoutSec: config.jobs.approvalTimeoutSec, progressIntervalSec: config.jobs.progressIntervalSec },
    mcp: { servers: config.mcp.servers.map((s) => ({ id: s.id, url: s.url, allowedToolCount: s.allowTools.length, macros: s.macros })) },
    flow: { serverId: config.flow.serverId },
    ...(extra.budgets !== undefined ? { budgets: extra.budgets } : {}),
    ...(extra.proposals !== undefined ? { proposals: extra.proposals } : {}),
    note: "Security settings are changed only by the user in the local settings UI. You cannot change them.",
  };
}

export interface SettingsToolsDeps {
  engine: ProposalEngine;
  prefs: PrefsStore;
  runtime: PersonaRuntime;
  /** The security view, built at start. */
  securityView: () => Record<string, unknown>;
  chats: ChatLookup;
  audit: SettingsAudit;
  logger?: Logger | undefined;
}

function reply(v: unknown): ToolExecutionResult {
  return textResult(typeof v === "string" ? v : JSON.stringify(v));
}

function failed(e: unknown, logger: Logger | undefined): ToolExecutionResult {
  if (e instanceof SettingsError) {
    logger?.info("settings.tool_refused", { code: e.code });
    return errorResult(`${e.code}: ${e.message}`);
  }
  logger?.warn("settings.tool_error", { error: String((e as Error)?.message ?? e) });
  return errorResult("settings tool failed.");
}

const PENDING_NOTE = "The user was asked to approve this in Telegram. Tell the user to look at the card and stop. Do not propose it again; if it is rejected or expires, accept that.";

export function createSettingsTools(deps: SettingsToolsDeps): ToolRegistration[] {
  const chatOf = (api: ToolExecutionApi): { conversationId: string; chatId: number } => {
    const conversationId = String(api.conversationId);
    const chatId = deps.chats.chatForConversation(conversationId);
    if (chatId === undefined) throw new SettingsError("not_allowed", "this conversation is not linked to a chat");
    return { conversationId, chatId };
  };

  const getSettings = defineTool({
    name: "get_settings",
    description: "Read the current settings: the preferences (tone, verbosity, language), a redacted summary of the security settings, or the available personas. Read-only. Use it before proposing a settings or preference change.",
    parameters: getSettingsParameters,
    replay: "safe",
    deferred: true,
    execute: async (args: Static<typeof getSettingsParameters>): Promise<ToolExecutionResult> => {
      try {
        const scope = args.scope ?? "prefs";
        if (scope === "prefs") return reply(wrapUntrusted("settings:prefs", JSON.stringify(deps.prefs.get().prefs, null, 2)));
        if (scope === "security") return reply(wrapUntrusted("settings:security", JSON.stringify(deps.securityView(), null, 2)));
        return reply(wrapUntrusted("settings:personas", JSON.stringify(deps.runtime.list().map((p) => ({ id: p.id, name: p.name, valid: p.valid, summary: p.summary })), null, 2)));
      } catch (e) {
        return failed(e, deps.logger);
      }
    },
  });

  const listPersonas = defineTool({
    name: "list_personas",
    description: "List the personas (modes with a narrower tool set): id, name, description, whether it is valid (with the reason if not) and a capability summary. Never shows the persona prompt text.",
    parameters: listPersonasParameters,
    replay: "safe",
    deferred: true,
    execute: async (_args: Static<typeof listPersonasParameters>, api: ToolExecutionApi): Promise<ToolExecutionResult> => {
      try {
        const current = deps.runtime.current(String(api.conversationId));
        return reply(
          wrapUntrusted("settings:personas", JSON.stringify({ current, personas: deps.runtime.list().map((p) => ({ id: p.id, name: p.name, description: p.description, source: p.source, valid: p.valid, ...(p.valid ? {} : { reasons: p.reasons }), summary: p.summary })) }, null, 2)),
        );
      } catch (e) {
        return failed(e, deps.logger);
      }
    },
  });

  const proposeSetting = defineTool({
    name: "propose_setting",
    description:
      "Propose a change to a preference setting (for example tone, verbosity or language) when the user asks to change how you answer. The user must approve it in Telegram; this returns at once with a proposal id. Only preferences can be proposed: allowed folders, shell, users and model settings are never changeable by you.",
    parameters: proposeSettingParameters,
    replay: "unsafe",
    deferred: true,
    execute: async (args: Static<typeof proposeSettingParameters>, api: ToolExecutionApi, _ctx: Context): Promise<ToolExecutionResult> => {
      try {
        const ctx = chatOf(api);
        const r = await deps.engine.propose("setting", { path: args.path, value: args.value, reason: args.reason }, ctx);
        return reply(r.status === "pending" ? { status: "pending", proposalId: r.proposalId, note: PENDING_NOTE } : { status: "applied", note: r.summary });
      } catch (e) {
        return failed(e, deps.logger);
      }
    },
  });

  const proposePersona = defineTool({
    name: "propose_persona",
    description:
      "Propose a new persona (a mode with its own prompt and a narrower set of tools, job templates and memory) when the user asks for one. A persona can only narrow what is allowed; a draft that asks for more is refused. The user sees the full draft and must approve it in Telegram.",
    parameters: proposePersonaParameters,
    replay: "unsafe",
    deferred: true,
    execute: async (args: Static<typeof proposePersonaParameters>, api: ToolExecutionApi): Promise<ToolExecutionResult> => {
      try {
        const ctx = chatOf(api);
        const d = args.draft;
        const draft = {
          id: d.id,
          name: d.name,
          ...(d.description !== undefined ? { description: d.description } : {}),
          prompt: d.prompt,
          toolAllow: d.toolAllow,
          mcpAllow: Object.fromEntries(d.mcpAllow.map((m) => [m.server, m.tools])),
          jobTemplates: d.jobTemplates,
          modelPreset: d.modelPreset,
          memory: { write: d.memory.write, sharedRead: d.memory.sharedRead, ...(d.memory.scope !== undefined ? { scope: d.memory.scope } : {}) },
          budgets: d.maxJobsPerDay !== undefined ? { maxJobsPerDay: d.maxJobsPerDay } : {},
        };
        const r = await deps.engine.propose("persona", { draft, reason: args.reason }, ctx);
        return reply(r.status === "pending" ? { status: "pending", proposalId: r.proposalId, note: PENDING_NOTE } : { status: "applied", note: r.summary });
      } catch (e) {
        if (e instanceof SettingsError && e.code === "not_found") return failed(new SettingsError("personas_not_active", "personas are not active on this install yet"), deps.logger);
        return failed(e, deps.logger);
      }
    },
  });

  const switchPersona = defineTool({
    name: "switch_persona",
    description:
      "Switch this chat to another persona (a mode with a different tool set). Switching to an equal or narrower persona happens at once; switching to a broader one asks the user to approve it in Telegram first. Use list_personas to see the ids.",
    parameters: switchPersonaParameters,
    replay: "unsafe",
    deferred: true,
    execute: async (args: Static<typeof switchPersonaParameters>, api: ToolExecutionApi): Promise<ToolExecutionResult> => {
      try {
        const ctx = chatOf(api);
        const runtime = deps.runtime;
        const target = runtime.list().find((p) => p.id === args.id);
        if (!target) throw new SettingsError("unknown_persona", `there is no persona called ${JSON.stringify(args.id).slice(0, 40)}; use list_personas`);
        if (!target.valid) throw new SettingsError("persona_invalid", `that persona is not usable: ${target.reasons.join("; ")}`);
        const fromId = runtime.current(ctx.conversationId);
        if (fromId === args.id) return reply({ status: "unchanged", note: `Already using the ${args.id} persona.` });
        const from = runtime.effectiveOf(fromId);
        const to = runtime.effectiveOf(args.id);
        if (!from || !to) throw new SettingsError("persona_invalid", "that persona is not usable");
        const cmp = compare(from, to);
        if (appliesWithoutCard(cmp.relation)) {
          await runtime.apply(ctx.conversationId, args.id);
          try {
            deps.audit.append({
              source: "propose",
              kind: "switch",
              persona: args.id,
              conversationId: ctx.conversationId,
              target: { file: "personas/active", path: ctx.conversationId },
              diff: [{ path: "activePersona", op: "replace", before: fromId, after: args.id }],
              decision: "auto",
              baseRevision: sha256Text(`persona:${fromId}`),
              afterRevision: sha256Text(`persona:${args.id}`),
              note: cmp.relation,
            });
          } catch (e) {
            deps.logger?.warn("settings.audit_failed", { error: String((e as Error).message) });
          }
          return reply({ status: "applied", note: `Switched to the ${args.id} persona (${cmp.relation}). It applies from the next message.` });
        }
        const r = await deps.engine.propose("switch", { personaId: args.id, added: cmp.added, reason: args.reason ?? "" }, ctx);
        return reply(r.status === "pending" ? { status: "pending", proposalId: r.proposalId, note: PENDING_NOTE } : { status: "applied", note: r.summary });
      } catch (e) {
        return failed(e, deps.logger);
      }
    },
  });

  return [getSettings, listPersonas, proposeSetting, proposePersona, switchPersona] as unknown as ToolRegistration[];
}

export function createSettingsExtension(deps: SettingsToolsDeps): Extension {
  return defineExtension({ name: SETTINGS_EXTENSION_NAME, tools: createSettingsTools(deps) });
}
