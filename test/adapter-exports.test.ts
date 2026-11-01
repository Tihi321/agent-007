/**
 * S1.0 done-check: every adapter export that Slices 2 to 7 need exists. Values get a runtime check;
 * types get an annotated reference, so `npm run build` fails if one disappears.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as adapter from "../src/pi/adapter.js";
import type {
  AgentChange,
  AgentState,
  BeforeToolHandler,
  Context,
  Conversation,
  ConversationRecord,
  Extension,
  HarnessOptions,
  HarnessSettings,
  HookApi,
  DeferredToolRegistration,
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
  Model,
  Models,
  NextTaskState,
  OpenAICompatModelInput,
  OpenAICompatProviderInput,
  PhaseHandler,
  Provider,
  Registry,
  ReportInfo,
  RunningTask,
  SettledTask,
  StreamableHttpTransportOptions,
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
  Tx,
} from "../src/pi/adapter.js";

const VALUE_EXPORTS = [
  "Harness",
  "createRegistry",
  "defineExtension",
  "defineTool",
  "defineTask",
  "defineDoc",
  "section",
  "hook",
  "ToolTask",
  "watchEvents",
  "openNodeSqliteStorage",
  "BACKGROUND_CONTEXT",
  "Type",
  "createProvider",
  "createModels",
  "openAICompletionsApi",
  // Phase 2 (S9.2): pi-mcp, tool search, JSON-schema parameters
  "McpClient",
  "StreamableHttpTransport",
  "toLlmContent",
  "McpError",
  "McpAbortError",
  "McpTimeoutError",
  "McpConnectionClosedError",
  "McpHttpError",
  "McpAuthRequiredError",
  "McpSessionExpiredError",
  "LATEST_PROTOCOL_VERSION",
  "createToolSearchExtension",
  "createToolSearchTool",
  "TOOL_SEARCH_TOOL_NAME",
  "DEFAULT_TOOL_SEARCH_LIMIT",
  "jsonSchemaParameters",
  // agent-007 helpers that keep pi-ai details inside the adapter
  "createRunnerProvider",
  "createRunnerModels",
  "runnerAuth",
  "runnerModel",
  "KEYLESS_PLACEHOLDER_KEY",
  "DEFAULT_RUNNER_COMPAT",
  // Phase 4 (S20): the generic OpenAI-compatible provider factory
  "createOpenAICompatProvider",
  "createBotModels",
  "openAICompatModel",
] as const;

test("every value export is defined", () => {
  const bag = adapter as unknown as Record<string, unknown>;
  for (const name of VALUE_EXPORTS) assert.notEqual(bag[name], undefined, `adapter export ${name} is undefined`);
});

test("value exports have the expected kind", () => {
  assert.equal(typeof adapter.Harness.open, "function");
  assert.equal(typeof adapter.createRegistry, "function");
  assert.equal(typeof adapter.defineTool, "function");
  assert.equal(typeof adapter.defineExtension, "function");
  assert.equal(typeof adapter.defineTask, "function");
  assert.equal(typeof adapter.defineDoc, "function");
  assert.equal(typeof adapter.section, "function");
  assert.equal(typeof adapter.hook, "function");
  assert.equal(typeof adapter.watchEvents, "function");
  assert.equal(typeof adapter.openNodeSqliteStorage, "function");
  assert.equal(typeof adapter.createProvider, "function");
  assert.equal(typeof adapter.createModels, "function");
  assert.equal(typeof adapter.openAICompletionsApi, "function");
  assert.equal(typeof adapter.Type.Object, "function");
  assert.equal(typeof adapter.BACKGROUND_CONTEXT.value, "function");
  assert.equal(typeof adapter.ToolTask, "object"); // a task definition token, usable with `hook(ToolTask, ...)`
});

// ---- types: each is referenced so the compiler checks it exists --------------------------------
// The `satisfies`/annotated forms below only need to compile.
type TypeBag = {
  context: Context;
  conversation: Conversation;
  submission: Submission;
  tx: Tx;
  record: ConversationRecord;
  hookApi: HookApi;
  call: ToolHookCall;
  hooks: ToolHooks;
  before: BeforeToolHandler;
  exec: ToolExecutionApi;
  result: ToolExecutionResult;
  settings: HarnessSettings;
  state: AgentState;
  change: AgentChange;
  runtime: TaskRuntime<unknown, unknown, unknown, object>;
  model: Model<"openai-completions">;
  json: JsonValue;
  extension: Extension;
  options: HarnessOptions;
  registry: Registry;
  report: ReportInfo;
  // Phase 2 (S9.2)
  mcpTool: McpTool;
  mcpResult: McpCallToolResult;
  mcpBlock: McpContentBlock;
  mcpInit: McpInitializeResult;
  mcpProgress: McpProgressNotification;
  mcpRequest: McpRequestOptions;
  mcpClientOptions: McpClientOptions;
  mcpTransport: McpTransport;
  httpTransportOptions: StreamableHttpTransportOptions;
  llm: LlmContent;
  deferred: DeferredToolRegistration;
  taskOptions: TaskOptions;
  taskOwnership: TaskOwnership;
  joinPolicy: JoinPolicy;
  taskId: TaskId<string>;
  taskRecord: TaskRecord<unknown, unknown, string>;
  taskOutcome: TaskOutcome<string>;
  settledTask: SettledTask<string>;
  taskState: TaskState<{ phase: string }, string>;
  nextTaskState: NextTaskState<{ phase: string }, string>;
  runningTask: RunningTask<unknown, { phase: string }, string>;
  phaseHandler: PhaseHandler<unknown, { phase: "a" }, { phase: "a" }, string, object>;
  task: Task<unknown, { phase: "a" }, string, object>;
  taskDefinition: TaskDefinition<unknown, { phase: "a" }, string, object>;
  control: ToolControl;
  // Phase 4 (S20)
  models: Models;
  provider: Provider;
  compatModel: OpenAICompatModelInput;
  compatProvider: OpenAICompatProviderInput;
};
test("type exports compile", () => {
  const probe: Partial<TypeBag> = {};
  const createConversation: Tx["createConversation"] | undefined = undefined;
  const watch: Conversation["watch"] | undefined = undefined;
  const beforeTool: ToolHooks["beforeTool"] | undefined = undefined;
  assert.equal(Object.keys(probe).length, 0);
  assert.equal(createConversation, undefined);
  assert.equal(watch, undefined);
  assert.equal(beforeTool, undefined);
});

test("runner provider options carry the key as the API key, or no auth", async () => {
  const withKey = adapter.createRunnerModels({ id: "strata", baseUrl: "http://127.0.0.1:8080/v1", modelId: "m", apiKey: "k-123456", contextWindow: 8192, maxTokens: 512 });
  const auth = await withKey.models.getAuth("strata");
  assert.equal(auth?.auth.apiKey, "k-123456");
  const noKey = adapter.createRunnerModels({ id: "strata", baseUrl: "http://127.0.0.1:8080/v1", modelId: "m", contextWindow: 8192, maxTokens: 512 });
  const auth2 = await noKey.models.getAuth("strata");
  // U21: the README keyless shape ({ auth: {} }) fails at 1.4.0 ("No API key for provider"), so a placeholder is sent.
  assert.equal(auth2?.auth.apiKey, adapter.KEYLESS_PLACEHOLDER_KEY);
  assert.equal(noKey.model.compat?.supportsDeveloperRole, false);
  assert.equal(noKey.model.compat?.maxTokensField, "max_tokens");
});

// ---- Phase 2 (S9.2) -------------------------------------------------------------------------------

test("S9.2 pi-mcp exports have the expected kinds (U36)", () => {
  assert.equal(typeof adapter.McpClient, "function");
  assert.equal(typeof adapter.StreamableHttpTransport, "function");
  assert.equal(typeof adapter.toLlmContent, "function");
  for (const err of [adapter.McpError, adapter.McpAbortError, adapter.McpTimeoutError, adapter.McpConnectionClosedError, adapter.McpHttpError, adapter.McpAuthRequiredError, adapter.McpSessionExpiredError]) {
    assert.equal(typeof err, "function");
  }
  // the client methods S10 relies on exist on the prototype: list, call with {signal, timeoutMs, onProgress}, close
  for (const m of ["connect", "listTools", "callTool", "close", "ping", "onClose", "onError", "request"]) {
    assert.equal(typeof (adapter.McpClient.prototype as unknown as Record<string, unknown>)[m], "function", "McpClient." + m);
  }
  // a transport implements start/send/close (McpTransport)
  for (const m of ["start", "send", "close", "onMessage", "onError", "onClose"]) {
    assert.equal(typeof (adapter.StreamableHttpTransport.prototype as unknown as Record<string, unknown>)[m], "function", "StreamableHttpTransport." + m);
  }
  assert.equal(typeof adapter.LATEST_PROTOCOL_VERSION, "string");
});

test("S9.2 toLlmContent maps text, an image and an audio placeholder", () => {
  const out = adapter.toLlmContent({
    content: [
      { type: "text", text: "hello" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "audio", data: "BBBB", mimeType: "audio/wav" },
    ],
  });
  assert.equal(out[0]?.type, "text");
  assert.equal(out[1]?.type, "image");
  assert.equal(out[2]?.type, "text", "audio becomes a short text placeholder");
});

test("S9.2 McpClient and StreamableHttpTransport build without connecting; the URL is kept", () => {
  const client = new adapter.McpClient({ name: "agent-007", version: "0.1.0" });
  assert.equal(client.connectionState, "idle");
  const transport = new adapter.StreamableHttpTransport({ url: "http://127.0.0.1:1/mcp" });
  assert.equal(transport.url.hostname, "127.0.0.1");
});

test("S9.2 tool search exports (U36): the extension carries tool_search; a deferred registration type exists", () => {
  assert.equal(adapter.TOOL_SEARCH_TOOL_NAME, "tool_search");
  assert.equal(adapter.DEFAULT_TOOL_SEARCH_LIMIT, 8);
  const ext = adapter.createToolSearchExtension();
  assert.equal(ext.name, "tool-search");
  assert.deepEqual((ext.tools ?? []).map((t) => t.name), ["tool_search"]);
  assert.equal(adapter.createToolSearchTool().name, "tool_search");
  const deferred = adapter.defineTool({ name: "x_tool", description: "d", parameters: adapter.Type.Object({}), deferred: true, execute: async () => ({ output: [] }) });
  const typed = deferred as DeferredToolRegistration;
  assert.equal(typed.deferred, true);
});

test("S9.2 jsonSchemaParameters wraps an MCP inputSchema without changing it", () => {
  const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.jsonSchemaParameters(schema))), schema);
});

test("S9.2 U45: waitForTask is a method, not a function export; the createTask option types exist", () => {
  assert.equal((adapter as unknown as Record<string, unknown>)["waitForTask"], undefined);
  // compile-time: the methods the Job task uses
  const wait: Awaited<ReturnType<typeof adapter.Harness.open>>["waitForTask"] | undefined = undefined;
  const create: Tx["createTask"] | undefined = undefined;
  assert.equal(wait, undefined);
  assert.equal(create, undefined);
  const opts: TaskOptions = { ownership: { kind: "conversation" }, background: true };
  assert.equal(opts.background, true);
});

test("S9.2 no name is exported twice from the adapter", () => {
  const here = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
  const src = readFileSync(resolve(here, "src", "pi", "adapter.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const names: string[] = [];
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) names.push(n);
    }
  }
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) names.push(m[1] ?? "");
  assert.ok(names.length > 60, "the scan found the exports");
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const n of names) {
    if (seen.has(n)) dups.push(n);
    seen.add(n);
  }
  assert.deepEqual(dups, []);
});

// ---- Phase 4 (S20): the generic provider factory ------------------------------------------------------

test("S20 createBotModels: one provider with several models, a key per provider, a fresh registry per call, no sampling parameter", async () => {
  const a = adapter.createBotModels([
    {
      id: "acp-codex",
      baseUrl: "http://127.0.0.1:8787/v1",
      apiKey: "proxy-key-123456",
      models: [
        { modelId: "codex/one", contextWindow: 100000, maxTokens: 4096 },
        { modelId: "codex/two", name: "Two", contextWindow: 50000, maxTokens: 2048 },
      ],
    },
    { id: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", models: [{ modelId: "local", contextWindow: 8192, maxTokens: 512 }] },
  ]);
  assert.equal((await a.getAuth("acp-codex"))?.auth.apiKey, "proxy-key-123456");
  assert.equal((await a.getAuth("lmstudio"))?.auth.apiKey, adapter.KEYLESS_PLACEHOLDER_KEY);
  const m = adapter.openAICompatModel({ id: "acp-codex", baseUrl: "http://127.0.0.1:8787/v1" }, { modelId: "codex/two", name: "Two", contextWindow: 50000, maxTokens: 2048 });
  assert.equal(m.provider, "acp-codex");
  assert.equal(m.name, "Two");
  assert.equal(m.compat?.supportsStore, false);
  assert.equal(m.compat?.supportsDeveloperRole, false);
  assert.equal(JSON.stringify(m).includes("temperature"), false);
  // two registries are independent: a provider set in one is not in the other
  const b = adapter.createBotModels([{ id: "strata", baseUrl: "http://127.0.0.1:8080/v1", models: [{ modelId: "s", contextWindow: 8192, maxTokens: 512 }] }]);
  assert.equal(await b.getAuth("acp-codex"), undefined);
  assert.throws(() => adapter.createOpenAICompatProvider({ id: "x", baseUrl: "http://127.0.0.1:1/v1", models: [] }), /at least one model/);
});
