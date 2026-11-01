/** Fixtures for the S22 model tests. Not a test file. */
import { join } from "node:path";
import { botRows } from "../../src/bots/rows.js";
import type { BotRoute, PresetConfig, ResolvedBot, TermsAccepted } from "../../src/bots/schema.js";
import { BACKGROUND_CONTEXT, Harness, ToolTask, Type, createBotModels, createRegistry, defineExtension, defineTool, hook, openNodeSqliteStorage } from "../../src/pi/adapter.js";
import type { Conversation, Extension, Models } from "../../src/pi/adapter.js";
import { DEFAULT_ROWS, withRows } from "../../src/settings/allowlist.js";
import { createSettingsAudit, readAuditTail } from "../../src/settings/audit.js";
import type { ProposalCard, ProposalTransport } from "../../src/settings/contracts.js";
import { PrefsStore } from "../../src/settings/prefs.js";
import { DEFAULT_LIMITS, ProposalEngine, memoryProposalStore } from "../../src/settings/proposals.js";
import { ModelSwitcher } from "../../src/models/switch.js";
import type { SwitcherDeps } from "../../src/models/switch.js";
import { providersForBot, routePresets } from "../../src/bots/runtime.js";
import { memoryLogger } from "../telegram/helpers/fakeTelegram.js";
import { tempDir, writeJson } from "../settings/helpers.js";

export const USER = 4242;
export const CHAT = 4242;

const base = { contextWindow: 100000, maxTokens: 4096, autoFallback: false } as const;
export const LM: PresetConfig = { id: "lmstudio", kind: "local", runner: "lmstudio", modelId: "lm-model", label: "LM Studio", privacy: "local", ...base, contextWindow: 8192, maxTokens: 512, autoFallback: true };
export const STRATA: PresetConfig = { id: "strata", kind: "local", runner: "strata", modelId: "strata-model", label: "Strata", privacy: "local", ...base, contextWindow: 122880, autoFallback: true };
const acp = { kind: "acp", baseUrl: "http://127.0.0.1:8787/v1", apiKeyRef: "proxyApiKey", privacy: "cloud", ...base } as const;
export const CODEX: PresetConfig = { ...acp, id: "codex", providerId: "codex", modelId: "codex/gpt", label: "Codex", autoFallback: true };
export const CODEX2: PresetConfig = { ...acp, id: "codex2", providerId: "codex", modelId: "codex/mini", label: "Codex mini" };
export const CLAUDE: PresetConfig = { ...acp, id: "claude", providerId: "claude", modelId: "claude/sonnet", label: "Claude", autoFallback: true };
export const ANTI: PresetConfig = { ...acp, id: "anti", providerId: "antigravity", modelId: "antigravity/x", label: "Antigravity", autoFallback: true };
export const ALL_PRESETS: PresetConfig[] = [LM, STRATA, CODEX, CODEX2, CLAUDE, ANTI];

export const NO_TERMS: TermsAccepted = { claude: false, antigravity: false };
export const ALL_TERMS: TermsAccepted = { claude: true, antigravity: true };

export function route(over: Partial<BotRoute> = {}): BotRoute {
  return { primary: "lmstudio", allowed: ["lmstudio", "strata", "codex", "codex2", "claude"], fallback: [], onAuthRequired: "fallback", ...over };
}

export function botOf(over: Partial<Pick<ResolvedBot, "id" | "tools" | "relax">> & { route?: Partial<BotRoute> } = {}): Pick<ResolvedBot, "id" | "route" | "tools" | "relax"> {
  return { id: over.id ?? "main", route: route(over.route), tools: over.tools ?? ["read_file"], relax: over.relax ?? { privateRoots: false, privilegedTools: false } };
}

class FakeTransport implements ProposalTransport {
  cards: ProposalCard[] = [];
  updates: { id: string; text: string }[] = [];
  async present(card: ProposalCard): Promise<{ messageId: number }> {
    this.cards.push(card);
    return { messageId: 100 + this.cards.length };
  }
  async update(id: string, text: string): Promise<void> {
    this.updates.push({ id, text });
  }
  onDecision(): void {}
}

const guardTool = defineTool({ name: "read_file", description: "read", parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text" as const, text: "ok" }] }) });

export interface SwitchRig {
  dir: string;
  switcher: ModelSwitcher;
  conv: Conversation;
  convId: string;
  harness: Harness;
  models: Models;
  engine: ProposalEngine;
  transport: FakeTransport;
  prefs: PrefsStore;
  prefsFile: string;
  auditDir: string;
  configureCalls: unknown[];
  /** The conversation as the switcher sees it (a spy over the real one). */
  spy: Conversation;
  log: ReturnType<typeof memoryLogger>;
  audits(): ReturnType<typeof readAuditTail>;
  tap(proposalId: string, over?: Partial<{ userId: number; chatId: number }>): ReturnType<ProposalEngine["decide"]>;
  close(): Promise<void>;
}

export async function switchRig(o: { route?: Partial<BotRoute>; terms?: TermsAccepted; presets?: PresetConfig[]; stored?: string; up?: (p: PresetConfig) => Promise<boolean>; noPropose?: boolean; startOn?: PresetConfig } = {}): Promise<SwitchRig> {
  const dir = tempDir("a7-models-");
  const presets = o.presets ?? ALL_PRESETS;
  const bot = botOf({ route: o.route });
  const terms = o.terms ?? ALL_TERMS;
  const prefsFile = join(dir, "prefs", "prefs.json");
  if (o.stored) writeJson(prefsFile, { bots: { main: { activePreset: o.stored } } });
  const prefs = new PrefsStore(prefsFile);
  const auditDir = join(dir, "audit");
  const audit = createSettingsAudit({ dir: auditDir, writer: "agent" });
  const transport = new FakeTransport();
  const rows = withRows(DEFAULT_ROWS, botRows({ bots: [bot as ResolvedBot], presets }));
  const engine = new ProposalEngine({ store: memoryProposalStore(), audit, prefs, prefsFile, rows, allowedUserIds: [USER], limits: () => ({ ...DEFAULT_LIMITS, maxPending: 5, perHour: 50 }), transport });
  const config = { model: { runners: { lmstudio: { baseUrl: "http://127.0.0.1:9/v1" }, strata: { baseUrl: "http://127.0.0.1:8/v1" } } } } as never;
  const models = createBotModels(providersForBot({ route: bot.route }, presets, config, { proxyApiKey: "proxy-key-123456" }));
  const registry = createRegistry();
  registry.install(defineExtension({ name: "a7", tools: [guardTool], hooks: [hook(ToolTask, { beforeTool: async () => undefined })] }) as Extension);
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "a.sqlite")), { models, registry, settings: {} }, BACKGROUND_CONTEXT);
  const start = o.startOn ?? routePresets({ route: bot.route }, presets)[0]!;
  const sp = start.kind === "local" ? (start.runner as string) : `acp-${start.providerId}`;
  const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: sp, modelId: start.modelId } } }, BACKGROUND_CONTEXT);
  const configureCalls: unknown[] = [];
  const spy = {
    id: conv.id,
    agent: (c: typeof BACKGROUND_CONTEXT) => conv.agent(c),
    configure: (change: unknown, c: typeof BACKGROUND_CONTEXT) => {
      configureCalls.push(change);
      return conv.configure(change as never, c);
    },
  } as unknown as Conversation;
  const log = memoryLogger();
  const deps: SwitcherDeps = {
    bot,
    presets,
    terms: () => terms,
    prefs,
    audit,
    ...(o.noPropose ? {} : { propose: (input: { path: string; value: string; reason: string }, ctx: { conversationId: string; chatId: number }) => engine.propose("setting", input, ctx) }),
    models: () => models,
    ...(o.up ? { up: o.up } : {}),
    guardExtension: "a7",
    logger: log,
  };
  const switcher = new ModelSwitcher(deps);
  return {
    dir,
    switcher,
    conv,
    convId: String(conv.id),
    harness,
    models,
    engine,
    transport,
    prefs,
    prefsFile,
    auditDir,
    configureCalls,
    spy,
    log,
    audits: () => readAuditTail(auditDir, 500),
    tap: (proposalId, over = {}) => engine.decide({ proposalId, decision: "approve", userId: USER, chatId: CHAT, messageId: 101, ...over }),
    close: () => harness.close(BACKGROUND_CONTEXT),
  };
}
