/**
 * The ONLY module that imports `@earendil-works/*` or `typebox`.
 * Everything else in agent-007 imports from here (plan section 4.1, adapter rule).
 *
 * Export locations were checked against the installed 1.4.0 `.d.ts` files (P0.2, S1.0, U7/U11):
 *  - pi-durable root:                 Harness, createRegistry, defineExtension, defineTool, defineTask,
 *                                     defineDoc, section, hook, ToolTask, watchEvents, and the types
 *  - pi-durable/storage/sqlite/node:  openNodeSqliteStorage
 *  - chord/context:                   BACKGROUND_CONTEXT, Context
 *  - pi-ai root:                      Type (re-exported from typebox), createProvider, createModels,
 *                                     Model, JsonValue
 *  - pi-ai/api/openai-completions.lazy: openAICompletionsApi
 *
 * Phase 2 (S9.2), checked against the installed 1.4.0 .d.ts files (U36, U45):
 *  - pi-mcp root:                     McpClient, StreamableHttpTransport, toLlmContent, the MCP errors and types.
 *                                     `callTool(name, args, { signal, timeoutMs, onProgress })`. The MCP `Tool` type is
 *                                     exported as `McpTool`.
 *  - pi-durable/tool-search:          createToolSearchExtension, createToolSearchTool, TOOL_SEARCH_TOOL_NAME,
 *                                     DEFAULT_TOOL_SEARCH_LIMIT. A deferred tool is `defineTool({ ..., deferred: true })`.
 *  - pi-durable root (tasks):         `defineTask` and `TaskRuntime` were already exported. `waitForTask` is NOT a function
 *                                     export: it is a method of `Harness` and of `TaskRuntime`. `tx.createTask(task,
 *                                     input, TaskOptions)` takes the `TaskOptions` type exported below.
 */
import {
  Harness,
  ToolTask,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  hook,
  section,
  watchEvents,
} from "@earendil-works/pi-durable";
import type {
  AgentChange,
  AgentState,
  Conversation,
  ConversationRecord,
  EntryRecord,
  Extension,
  HarnessOptions,
  HarnessSettings,
  HookApi,
  JoinPolicy,
  NextTaskState,
  PhaseHandler,
  Registry,
  ReportInfo,
  RunningTask,
  SettledSubmissionRecord,
  SettledTask,
  Submission,
  Task,
  TaskDefinition,
  TaskId,
  TaskOptions,
  TaskOutcome,
  TaskOwnership,
  TaskRecord,
  TaskRuntime,
  TaskState,
  ToolControl,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolHookCall,
  ToolHooks,
  ToolRegistration,
  Tx,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import { Type, createModels, createProvider } from "@earendil-works/pi-ai";
import {
  LATEST_PROTOCOL_VERSION,
  McpAbortError,
  McpAuthRequiredError,
  McpClient,
  McpConnectionClosedError,
  McpError,
  McpHttpError,
  McpSessionExpiredError,
  McpTimeoutError,
  StreamableHttpTransport,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import type {
  CallToolResult as McpCallToolResult,
  ContentBlock as McpContentBlock,
  InitializeResult as McpInitializeResult,
  LlmContent,
  McpClientOptions,
  McpRequestOptions,
  McpTransport,
  ProgressNotification as McpProgressNotification,
  StreamableHttpTransportOptions,
  Tool as McpTool,
} from "@earendil-works/pi-mcp";
import {
  DEFAULT_TOOL_SEARCH_LIMIT,
  TOOL_SEARCH_TOOL_NAME,
  createToolSearchExtension,
  createToolSearchTool,
} from "@earendil-works/pi-durable/tool-search";
import type {
  AssistantMessage,
  JsonValue,
  Message,
  Model,
  Models,
  OpenAICompletionsCompat,
  Provider,
  ProviderAuth,
  TSchema,
  Static,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export {
  BACKGROUND_CONTEXT,
  DEFAULT_TOOL_SEARCH_LIMIT,
  Harness,
  LATEST_PROTOCOL_VERSION,
  McpAbortError,
  McpAuthRequiredError,
  McpClient,
  McpConnectionClosedError,
  McpError,
  McpHttpError,
  McpSessionExpiredError,
  McpTimeoutError,
  StreamableHttpTransport,
  TOOL_SEARCH_TOOL_NAME,
  ToolTask,
  Type,
  createModels,
  createProvider,
  createRegistry,
  createToolSearchExtension,
  createToolSearchTool,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  hook,
  openAICompletionsApi,
  openNodeSqliteStorage,
  section,
  toLlmContent,
  watchEvents,
};

export type {
  AgentChange,
  AgentState,
  AssistantMessage,
  Context,
  Conversation,
  ConversationRecord,
  EntryRecord,
  Extension,
  HarnessOptions,
  HarnessSettings,
  HookApi,
  JoinPolicy,
  JsonValue,
  LlmContent,
  McpCallToolResult,
  McpClientOptions,
  McpContentBlock,
  McpInitializeResult,
  McpProgressNotification,
  McpRequestOptions,
  McpTool,
  McpTransport,
  Message,
  Model,
  Models,
  NextTaskState,
  OpenAICompletionsCompat,
  PhaseHandler,
  Provider,
  Registry,
  ReportInfo,
  RunningTask,
  SettledSubmissionRecord,
  SettledTask,
  Static,
  StreamableHttpTransportOptions,
  Submission,
  TSchema,
  Task,
  TaskDefinition,
  TaskId,
  TaskOptions,
  TaskOutcome,
  TaskOwnership,
  TaskRecord,
  TaskRuntime,
  TaskState,
  ToolControl,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolHookCall,
  ToolHooks,
  ToolRegistration,
  Tx,
};

/** The `beforeTool` handler type (the approval gate, S3). */
export type BeforeToolHandler = ToolHooks["beforeTool"];
/** The `afterTool` handler type (Phase 4: the bus guard's taint tracking). */
export type AfterToolHandler = ToolHooks["afterTool"];

/**
 * Phase 2 helpers that keep Pi and typebox details inside the adapter.
 *  - `jsonSchemaParameters`: wraps a JSON Schema object (an MCP tool's `inputSchema`) as tool parameters
 *    (typebox `Type.Unsafe`; it adds no validation of its own).
 *  - `DeferredToolRegistration`: a tool registration with `deferred: true` (S10 and S14 register such tools; the model
 *    only gets one after `tool_search` loaded it, I27).
 */
export function jsonSchemaParameters(schema: Record<string, unknown>): TSchema {
  return Type.Unsafe(schema);
}
export type DeferredToolRegistration = ToolRegistration & { readonly deferred: true };

// ---------------------------------------------------------------------------------------------
// Model runner provider (plan section 4.5, I13). Callers pass plain data; pi-ai details stay here.
// ---------------------------------------------------------------------------------------------

/** The compat flags both runners start with (plan 4.5). `supportsUsageInStreaming` and
 *  `requiresToolResultName` are decided per runner by smoke S2/S3 (U2, U19, U20). */
export const DEFAULT_RUNNER_COMPAT: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
};

export interface RunnerProviderInput {
  /** Provider id: the runner name ("lmstudio" | "strata"). */
  id: string;
  baseUrl: string;
  modelId: string;
  /** LM Studio token or Strata API key. Absent = keyless (P0.3b manual Strata test). */
  apiKey?: string | undefined;
  contextWindow: number;
  maxTokens: number;
  compat?: OpenAICompletionsCompat | undefined;
  /** Optional display name for the model entry. */
  modelName?: string | undefined;
}

/**
 * Placeholder key sent when a runner has no key (keyless Strata test, LM Studio with auth off).
 * Settled U21 against the 1.4.0 sources: the README's keyless shape `resolve: async () => ({ auth: {} })` makes the
 * openai-completions client throw "No API key for provider" (it needs an apiKey or an Authorization header), so a
 * keyless local runner gets this dummy bearer value. A runner with no key configured ignores it.
 */
export const KEYLESS_PLACEHOLDER_KEY = "no-key-needed";

/**
 * Builds the `ProviderAuth` for a runner. With a key: `{ auth: { apiKey } }` (U1 first choice).
 * Without: the same shape with `KEYLESS_PLACEHOLDER_KEY` (U21).
 */
export function runnerAuth(apiKey: string | undefined, label = "local runner"): ProviderAuth {
  return {
    apiKey: {
      name: `${label} API key`,
      resolve: async () =>
        apiKey ? { auth: { apiKey }, source: "agent-007 secrets" } : { auth: { apiKey: KEYLESS_PLACEHOLDER_KEY }, source: "keyless placeholder" },
    },
  };
}

/** One model entry for an OpenAI-compatible local runner. */
export function runnerModel(input: RunnerProviderInput): Model<"openai-completions"> {
  return {
    id: input.modelId,
    name: input.modelName ?? input.modelId,
    api: "openai-completions",
    provider: input.id,
    baseUrl: input.baseUrl,
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
    compat: { ...DEFAULT_RUNNER_COMPAT, ...(input.compat ?? {}) },
  };
}

/** Builds the provider (pi-ai `createProvider`) for one runner. */
export function createRunnerProvider(input: RunnerProviderInput) {
  return createProvider({
    id: input.id,
    name: input.id,
    baseUrl: input.baseUrl,
    auth: runnerAuth(input.apiKey, input.id),
    models: [runnerModel(input)],
    api: openAICompletionsApi(),
  });
}

/** A `Models` collection holding exactly one runner provider, plus the model entry to use. */
export function createRunnerModels(input: RunnerProviderInput) {
  const models = createModels();
  models.setProvider(createRunnerProvider(input));
  return { models, model: runnerModel(input) };
}

// ---------------------------------------------------------------------------------------------
// Phase 4 (S20): a generic OpenAI-compatible provider factory. One provider (one base URL, one key) carries SEVERAL model
// entries, which is what the ACP proxy needs (one `Model` per preset, S23.2) and what a bot's `Models` registry needs when its
// route lists several presets of one runner. Callers pass plain data; pi-ai details stay here. No sampling parameter is ever set
// by this code (the proxy answers 400 for them, U53).
// ---------------------------------------------------------------------------------------------

export interface OpenAICompatModelInput {
  /** The id sent to the server (`codex/gpt-...`, a local model id). */
  modelId: string;
  /** Display name; default the id. */
  name?: string | undefined;
  contextWindow: number;
  maxTokens: number;
  compat?: OpenAICompletionsCompat | undefined;
}

export interface OpenAICompatProviderInput {
  /** Provider id, unique inside one `Models` registry (`lmstudio`, `strata`, `acp-codex`, ...). */
  id: string;
  baseUrl: string;
  /** Absent = the keyless placeholder (see `KEYLESS_PLACEHOLDER_KEY`). The key is only ever held in the closure of `resolve`. */
  apiKey?: string | undefined;
  /** A label for the auth entry, never the key. */
  authLabel?: string | undefined;
  models: readonly OpenAICompatModelInput[];
}

/** One model entry for the provider. `provider` and `baseUrl` come from the provider input. */
export function openAICompatModel(provider: Pick<OpenAICompatProviderInput, "id" | "baseUrl">, m: OpenAICompatModelInput): Model<"openai-completions"> {
  return {
    id: m.modelId,
    name: m.name ?? m.modelId,
    api: "openai-completions",
    provider: provider.id,
    baseUrl: provider.baseUrl,
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    compat: { ...DEFAULT_RUNNER_COMPAT, ...(m.compat ?? {}) },
  };
}

/** Builds a provider with every model of the input (pi-ai `createProvider`). */
export function createOpenAICompatProvider(input: OpenAICompatProviderInput) {
  if (input.models.length === 0) throw new Error(`provider ${input.id}: at least one model is required`);
  return createProvider({
    id: input.id,
    name: input.id,
    baseUrl: input.baseUrl,
    auth: runnerAuth(input.apiKey, input.authLabel ?? input.id),
    models: input.models.map((m) => openAICompatModel(input, m)),
    api: openAICompletionsApi(),
  });
}

/** A fresh `Models` registry holding the given providers (one registry per bot, so no bot sees another bot's providers). */
export function createBotModels(providers: readonly OpenAICompatProviderInput[]) {
  const models = createModels();
  for (const p of providers) models.setProvider(createOpenAICompatProvider(p));
  return models;
}

/** Which auth mode the runner provider was built with, for logs and tests. */
export function describeRunnerAuth(apiKey: string | undefined): "api-key" | "none" {
  return apiKey ? "api-key" : "none";
}
