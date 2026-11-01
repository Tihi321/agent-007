/**
 * S10.1 and S10.2: the creative-hub MCP tool registry.
 *
 * For each configured server: connect (loopback only), `listTools`, keep ONLY the tools in the server's `allowTools`, and wrap
 * each as a `defineTool` named `mcp__<server>__<tool>` (sanitised to 64 characters), `replay: "unsafe"`, `deferred: true`
 * (found through `tool_search`, I27), a per-call timeout from config, progress forwarded as tool progress, and a result that is
 * always wrapped as untrusted content (S10.5).
 *
 * What S10 registers, in total: the MCP tools and the macros (all deferred), `hub_start` (deferred) and `hub_status` (the one
 * non-deferred tool). `McpHub.tools()` lists them; `checkToolCap(hub.tools(), { subset: true })` is the registry test.
 *
 * A server that is down at start registers no tools (its schemas are unknown) and is reported as such; after `hub_start`
 * succeeds, `refreshServer(id)` lists it again and returns the registrations that are new, which S15 may install.
 */
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import type { Logger } from "../contracts.js";
import type { McpServerConfig } from "../config/schema.js";
import type { JobApprovalTransport, JobRunnerClient } from "../jobs/contracts.js";
import { defineExtension, defineTool, jsonSchemaParameters } from "../pi/adapter.js";
import type { DeferredToolRegistration, Extension, McpTool, ToolExecutionResult, ToolRegistration } from "../pi/adapter.js";
import { HubClient, McpUrlRefusedError, describeMcpError } from "./client.js";
import type { HubCallOptions, HubClientOptions } from "./client.js";
import { MACROS, buildMacroTool, defaultMacroContext } from "./macros.js";
import type { MacroContext } from "./macros.js";
import { checkHubStatus, createHubStartTool, createHubStatusTool } from "./services.js";
import type { HubStatusRow, ProbeFn } from "./services.js";
import { reduceMcpResult, toolError } from "./untrusted.js";

export const MCP_EXTENSION_NAME = "mcp";
export const MAX_TOOL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_CHARS = 700;
const MAX_PROGRESS_EVENTS = 200;

// ---- names -----------------------------------------------------------------------------------------

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/**
 * `mcp__<server>__<tool>`, characters other than letters, digits, `_` and `-` replaced by `_`, at most 64 characters.
 * A name that does not fit is cut and ends in `_` plus 8 hex digits of the full name, so two long names stay distinct.
 */
export function mcpToolName(serverId: string, tool: string): string {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = `mcp__${clean(serverId)}__${clean(tool)}`;
  if (full.length <= MAX_TOOL_NAME_LENGTH) return full;
  return `${full.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${shortHash(`${serverId}\u0000${tool}`)}`;
}

/** True for a name of the form this registry makes (the Flow guard of S14.4 matches `mcp__<flow server>__`). */
export function isMcpToolName(name: string, serverId?: string): boolean {
  return serverId === undefined ? name.startsWith("mcp__") : name.startsWith(`mcp__${serverId}__`);
}

function describeTool(serverId: string, t: McpTool): string {
  // eslint-disable-next-line no-control-regex
  const flat = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const head = `[creative-hub MCP, server ${serverId}, tool ${t.name}]`;
  const title = t.title ? flat(t.title) : "";
  const body = flat(t.description ?? "");
  let text = [head, title, body].filter((x) => x !== "").join(" ");
  if (text.length > MAX_DESCRIPTION_CHARS) text = `${text.slice(0, MAX_DESCRIPTION_CHARS)}...`;
  return text;
}

function inputSchemaOf(t: McpTool): Record<string, unknown> {
  const s = t.inputSchema;
  if (typeof s === "object" && s !== null && !Array.isArray(s) && s["type"] === "object") return s;
  return { type: "object", properties: {} };
}

// ---- one MCP tool ----------------------------------------------------------------------------------

export interface McpToolDeps {
  serverId: string;
  client: Pick<HubClient, "callTool">;
  timeoutMs: number;
  logger?: Logger | undefined;
}

/** The deferred registration for one allowlisted MCP tool. */
export function buildMcpTool(deps: McpToolDeps, t: McpTool, name: string): DeferredToolRegistration {
  const tool = defineTool({
    name,
    description: describeTool(deps.serverId, t),
    parameters: jsonSchemaParameters(inputSchemaOf(t)),
    deferred: true,
    // The call may spend credits or change state on the server: it is never rerun after a restart (plan S10.1).
    replay: "unsafe",
    async execute(args, api, context): Promise<ToolExecutionResult> {
      let progressEvents = 0;
      const callOpts: HubCallOptions = {
        signal: context.abortSignal,
        timeoutMs: deps.timeoutMs,
        onProgress: (p) => {
          if (++progressEvents > MAX_PROGRESS_EVENTS) return;
          const msg = typeof p.message === "string" ? ` ${p.message.replace(/[\r\n]+/g, " ").slice(0, 160)}` : "";
          api.output(`[progress ${p.progress}${p.total !== undefined ? `/${p.total}` : ""}${msg}]\n`);
        },
      };
      try {
        const result = await deps.client.callTool(t.name, (args ?? {}) as Record<string, unknown>, callOpts);
        const reduced = reduceMcpResult(deps.serverId, t.name, result);
        return reduced.isError ? { isError: true, output: [{ type: "text", text: reduced.text }] } : { output: [{ type: "text", text: reduced.text }] };
      } catch (e) {
        const d = describeMcpError(e, deps.serverId);
        deps.logger?.info("mcp.tool_failed", { server: deps.serverId, tool: t.name, kind: d.kind });
        return toolError(d.message);
      }
    },
  });
  return tool as unknown as DeferredToolRegistration;
}

// ---- the hub ---------------------------------------------------------------------------------------

export type ServerLoadState = "loaded" | "down" | "refused";

export interface ServerReport {
  id: string;
  state: ServerLoadState;
  /** Why it is not loaded. Safe to log. */
  error?: string;
  /** The model-facing names of the MCP tools registered for this server. */
  tools: string[];
  /** Tools the server lists that are not in `allowTools` (dropped, never exposed). */
  droppedCount: number;
  /** `allowTools` entries the server does not list. */
  missingAllowed: string[];
  /** Macros registered on this server. */
  macros: string[];
  /** Config macros that were not registered (unknown name, or the server lacks a tool the macro needs). */
  skippedMacros: string[];
}

export interface McpLoadReport {
  servers: ServerReport[];
}

export interface McpHubDeps {
  servers: readonly McpServerConfig[];
  /** `mcp.callTimeoutSec` (default 300). */
  callTimeoutSec?: number | undefined;
  /** `secrets.mcpTokens` by server id (UI-18). Sent as a bearer token, never logged. */
  tokens?: Readonly<Record<string, string>> | undefined;
  logger?: Logger | undefined;
  /** The job runner (hub_start goes through it, over IPC, after an approval). */
  runner: Pick<JobRunnerClient, "hubStart">;
  /** The Telegram side (S14 implements it, S15 wires it): the `hub_start` approval card. */
  approvals: Pick<JobApprovalTransport, "requestHubStartApproval">;
  /** `jobs.approvalTimeoutSec`. */
  approvalTimeoutSec: number;
  /** The main user's profile (`config.mainUserProfile`), the base of the default Chiptune Studio output folder. */
  mainUserProfile?: string | undefined;
  /** Overrides the `render_audio` output folder of the `chiptune_loop` macro. */
  chiptuneDir?: string | undefined;
  /** Test seams. */
  createClient?: ((opts: HubClientOptions) => Pick<HubClient, "id" | "listTools" | "callTool" | "close">) | undefined;
  probe?: ProbeFn | undefined;
  macroContext?: MacroContext | undefined;
  connectTimeoutMs?: number | undefined;
  now?: (() => number) | undefined;
  /** Called after `hub_start` started a service, with its id. */
  onServiceStarted?: ((service: string) => void | Promise<void>) | undefined;
}

type ClientLike = Pick<HubClient, "id" | "listTools" | "callTool" | "close">;

export class McpHub {
  private readonly deps: McpHubDeps;
  private readonly clients = new Map<string, ClientLike>();
  private readonly byServer = new Map<string, ToolRegistration[]>();
  private readonly reports = new Map<string, ServerReport>();
  private readonly status: ToolRegistration;
  private readonly start: DeferredToolRegistration;

  constructor(deps: McpHubDeps) {
    this.deps = deps;
    const refs = deps.servers.map((s) => ({ id: s.id, url: s.url }));
    this.status = createHubStatusTool({ servers: refs, tokens: deps.tokens, probe: deps.probe, logger: deps.logger });
    this.start = createHubStartTool({
      servers: refs,
      tokens: deps.tokens,
      runner: deps.runner,
      approvals: deps.approvals,
      approvalTimeoutSec: deps.approvalTimeoutSec,
      probe: deps.probe,
      logger: deps.logger,
      now: deps.now,
      onStarted: deps.onServiceStarted,
    });
  }

  private timeoutMsFor(server: McpServerConfig): number {
    return Math.round((server.callTimeoutSec ?? this.deps.callTimeoutSec ?? 300) * 1000);
  }

  private chiptuneDir(): string {
    return this.deps.chiptuneDir ?? win32.join(this.deps.mainUserProfile ?? "C:\\Users\\Public", "ChiptuneStudio", "agent-007");
  }

  private clientFor(server: McpServerConfig): ClientLike {
    const existing = this.clients.get(server.id);
    if (existing) return existing;
    const opts: HubClientOptions = {
      id: server.id,
      url: server.url,
      token: this.deps.tokens?.[server.id],
      logger: this.deps.logger,
      connectTimeoutMs: this.deps.connectTimeoutMs,
    };
    const client = this.deps.createClient ? this.deps.createClient(opts) : new HubClient(opts);
    this.clients.set(server.id, client);
    return client;
  }

  /** Lists one server and builds its registrations. A failure leaves the server `down` with no tools. */
  private async loadServer(server: McpServerConfig): Promise<{ report: ServerReport; tools: ToolRegistration[] }> {
    const report: ServerReport = { id: server.id, state: "down", tools: [], droppedCount: 0, missingAllowed: [], macros: [], skippedMacros: [] };
    let client: ClientLike;
    try {
      client = this.clientFor(server);
    } catch (e) {
      if (e instanceof McpUrlRefusedError) {
        this.deps.logger?.warn("mcp.server_refused", { server: server.id });
        return { report: { ...report, state: "refused", error: e.message }, tools: [] };
      }
      throw e;
    }
    let listed: McpTool[];
    try {
      listed = await client.listTools();
    } catch (e) {
      const d = describeMcpError(e, server.id);
      this.deps.logger?.warn("mcp.server_down", { server: server.id, kind: d.kind });
      return { report: { ...report, error: d.message }, tools: [] };
    }

    const timeoutMs = this.timeoutMsFor(server);
    const allow = new Set(server.allowTools);
    const used = new Set<string>();
    const tools: ToolRegistration[] = [];
    const listedNames = new Set(listed.map((t) => t.name));
    for (const t of listed) {
      if (!allow.has(t.name)) {
        report.droppedCount++;
        continue;
      }
      let name = mcpToolName(server.id, t.name);
      if (used.has(name)) name = `${name.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${shortHash(t.name)}`;
      used.add(name);
      tools.push(buildMcpTool({ serverId: server.id, client, timeoutMs, logger: this.deps.logger }, t, name));
      report.tools.push(name);
    }
    report.missingAllowed = server.allowTools.filter((n) => !listedNames.has(n));

    for (const macroId of server.macros) {
      const def = MACROS[macroId];
      if (!def || !def.requires.every((r) => listedNames.has(r))) {
        report.skippedMacros.push(macroId);
        continue;
      }
      tools.push(buildMacroTool(def, { serverId: server.id, client, ctx: this.deps.macroContext ?? defaultMacroContext(this.chiptuneDir()), timeoutMs, logger: this.deps.logger }));
      report.macros.push(macroId);
    }
    report.state = "loaded";
    this.deps.logger?.info("mcp.server_loaded", { server: server.id, tools: report.tools.length, dropped: report.droppedCount, macros: report.macros.length });
    return { report, tools };
  }

  /** Connects to every configured server (in parallel) and builds the registrations. Never throws for an unreachable server. */
  async load(): Promise<McpLoadReport> {
    const results = await Promise.all(this.deps.servers.map((s) => this.loadServer(s)));
    for (const [i, r] of results.entries()) {
      const id = (this.deps.servers[i] as McpServerConfig).id;
      this.byServer.set(id, r.tools);
      this.reports.set(id, r.report);
    }
    return this.report();
  }

  report(): McpLoadReport {
    return { servers: this.deps.servers.map((s) => this.reports.get(s.id) ?? { id: s.id, state: "down" as const, tools: [], droppedCount: 0, missingAllowed: [], macros: [], skippedMacros: [] }) };
  }

  /**
   * Lists one server again (after `hub_start`) and returns only the registrations whose names were not registered before.
   * The caller (S15) installs them if the registry accepts late tools; otherwise they appear at the next start.
   */
  async refreshServer(id: string): Promise<ToolRegistration[]> {
    const server = this.deps.servers.find((s) => s.id === id);
    if (!server) return [];
    const before = new Set((this.byServer.get(id) ?? []).map((t) => t.name));
    const { report, tools } = await this.loadServer(server);
    this.reports.set(id, report);
    if (report.state !== "loaded") return [];
    const fresh = tools.filter((t) => !before.has(t.name));
    this.byServer.set(id, [...(this.byServer.get(id) ?? []), ...fresh]);
    return fresh;
  }

  /** Every tool S10 registers: `hub_status` (non-deferred), `hub_start`, then each server's MCP tools and macros (deferred). */
  tools(): ToolRegistration[] {
    const out: ToolRegistration[] = [this.status, this.start];
    for (const s of this.deps.servers) out.push(...(this.byServer.get(s.id) ?? []));
    return out;
  }

  /** The tools as an extension (`registry.install(hub.extension())`), next to `createToolSearchExtension()`. */
  extension(): Extension {
    return defineExtension({ name: MCP_EXTENSION_NAME, tools: this.tools() });
  }

  /** The `hub_status` rows (also for `/status`, S15.2). */
  async serverStatus(): Promise<HubStatusRow[]> {
    return checkHubStatus({ servers: this.deps.servers.map((s) => ({ id: s.id, url: s.url })), tokens: this.deps.tokens, probe: this.deps.probe, logger: this.deps.logger });
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    this.clients.clear();
  }
}

/** Creates the hub and loads every server. */
export async function createMcpHub(deps: McpHubDeps): Promise<McpHub> {
  const hub = new McpHub(deps);
  await hub.load();
  return hub;
}
