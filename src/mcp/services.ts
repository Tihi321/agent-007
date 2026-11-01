/**
 * S10.4: creative-hub service status and start.
 *
 *  - `hub_status` (the ONE always-loaded S10 tool, I27) reads which configured servers answer: a TCP connect plus MCP
 *    `initialize`. It calls no tool and starts nothing. A down server is named, with the offer of `hub_start`.
 *  - `hub_start {service}` (deferred) NEVER starts anything itself. It asks the user (a Telegram card through
 *    `JobApprovalTransport.requestHubStartApproval`), and only after an explicit approval sends the `hub_start` IPC message to
 *    the job runner, which runs its fixed `hub.ps1 start <service>` template. No approval decision, no IPC.
 *  - Scriptorium always gets its own card text with the creative-hub warning, an explicit `scriptoriumApproved` flag in the
 *    IPC body, and is started only by its own `hub_start` call (the tool takes one service per call and no job starts it).
 *  - agent-007 does not change VN Studio's autostart. A VN Studio job card says what VN Studio may start (`autostartNotice`).
 */
import type { Logger } from "../contracts.js";
import type { HubStartBody, HubStartCard, JobApprovalTransport, JobRunnerClient } from "../jobs/contracts.js";
import { Type, defineTool } from "../pi/adapter.js";
import type { DeferredToolRegistration, ToolExecutionResult, ToolRegistration } from "../pi/adapter.js";
import { describeMcpError, probeMcpServer } from "./client.js";
import type { ProbeResult, ProbeState } from "./client.js";
import { toolError, toolText, wrapUntrustedContent } from "./untrusted.js";

export const SCRIPTORIUM_ID = "scriptorium";

/** The card text for Scriptorium (creative-hub `services.json` warning, plus the paid-model line). Always shown for it. */
export const SCRIPTORIUM_WARNING =
  "Scriptorium: starting its engine resumes the whole book factory. It starts writing every open idea in ~/Scriptorium/ideas, user ideas first, and may spend on paid models (budget in config/budget.md). agent-007 does not estimate or cap that spend.";

/** What a VN Studio job may start on its own (creative-hub README and autostart.md). Shown on its approval card (S14.3). */
export const VN_STUDIO_AUTOSTART_LINE = "VN Studio may start Pixel Studio, Chiptune Studio and ComfyUI";

const AUTOSTART_NAMES: Record<string, string> = {
  "pixel-studio": "Pixel Studio",
  "chiptune-studio": "Chiptune Studio",
  comfyui: "ComfyUI",
};

/** "VN Studio may start Pixel Studio, Chiptune Studio and ComfyUI" for a template's `autostart` list; `undefined` when empty. */
export function autostartNotice(autostart: readonly string[]): string | undefined {
  if (autostart.length === 0) return undefined;
  const names = autostart.map((id) => AUTOSTART_NAMES[id] ?? id);
  const list = names.length === 1 ? (names[0] as string) : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `VN Studio may start ${list}`;
}

export function isScriptorium(service: string): boolean {
  return service.toLowerCase() === SCRIPTORIUM_ID;
}

/** The `hub_start` approval card. Scriptorium always carries its warning. */
export function buildHubStartCard(service: string, conversationId: string, timeoutSec: number, now: number): HubStartCard {
  const scriptorium = isScriptorium(service);
  return {
    conversationId,
    service,
    scriptorium,
    ...(scriptorium ? { warning: SCRIPTORIUM_WARNING } : {}),
    timeoutSec,
    deadline: now + timeoutSec * 1000,
  };
}

/** The plain text of a `hub_start` card (the S14 card UI may render it as it likes; this is the content it must carry). */
export function renderHubStartCardText(card: HubStartCard): string {
  const lines = [`Start the creative-hub service "${card.service}" on this PC?`, "It starts through the job runner's fixed start script, only after you approve."];
  if (card.scriptorium) lines.push("", card.warning ?? SCRIPTORIUM_WARNING);
  lines.push("", `Approve within ${Math.round(card.timeoutSec / 60)} min, or it is rejected.`);
  return lines.join("\n");
}

// ---- hub_status ------------------------------------------------------------------------------------

export interface HubServerRef {
  id: string;
  url: string;
}

export interface HubStatusRow {
  id: string;
  state: ProbeState;
  detail: string;
}

export type ProbeFn = (serverId: string, opts: { url: string; token?: string | undefined }) => Promise<ProbeResult>;

export interface HubStatusDeps {
  servers: readonly HubServerRef[];
  tokens?: Readonly<Record<string, string>> | undefined;
  probe?: ProbeFn | undefined;
  logger?: Logger | undefined;
}

/** Probes every configured server in parallel (TCP connect plus `initialize`; no tool call). Also used by `/status` (S15.2). */
export async function checkHubStatus(deps: HubStatusDeps): Promise<HubStatusRow[]> {
  const probe: ProbeFn = deps.probe ?? probeMcpServer;
  return Promise.all(
    deps.servers.map(async (s): Promise<HubStatusRow> => {
      try {
        const r = await probe(s.id, { url: s.url, token: deps.tokens?.[s.id] });
        return { id: s.id, state: r.state, detail: r.detail };
      } catch (e) {
        deps.logger?.warn("hub.probe_failed", { server: s.id, error: e instanceof Error ? e.name : "Error" });
        return { id: s.id, state: "down", detail: describeMcpError(e, s.id).message };
      }
    }),
  );
}

export function formatHubStatus(rows: readonly HubStatusRow[]): string {
  if (rows.length === 0) return "No creative-hub servers are configured.";
  const lines = ["creative-hub servers:"];
  for (const r of rows) lines.push(`- ${r.id}: ${r.state === "up" ? "up" : `NOT AVAILABLE (${r.detail})`}`);
  const bad = rows.filter((r) => r.state !== "up");
  if (bad.length > 0) {
    lines.push(
      "",
      `Not answering: ${bad.map((r) => r.id).join(", ")}.`,
      "agent-007 never starts a service itself. To start one, load hub_start with tool_search and call hub_start with the service name: the user is asked to approve in Telegram first, then the job runner starts it. Scriptorium has its own warning and is started only by its own hub_start call.",
    );
  }
  return lines.join("\n");
}

export function createHubStatusTool(deps: HubStatusDeps): ToolRegistration {
  const tool = defineTool({
    name: "hub_status",
    description:
      "Check which creative-hub servers are up (vibetts, chiptune-studio, comfy-mcp, scriptorium, ...). Only checks that each one answers; calls no tool and starts nothing. Say which are down and offer hub_start.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(): Promise<ToolExecutionResult> {
      const rows = await checkHubStatus(deps);
      deps.logger?.info("hub.status", { up: rows.filter((r) => r.state === "up").length, total: rows.length });
      return toolText(formatHubStatus(rows));
    },
  });
  return tool as unknown as ToolRegistration;
}

// ---- hub_start -------------------------------------------------------------------------------------

export interface HubStartDeps {
  /** The services `hub_start` accepts: the configured MCP servers (the job runner re-checks against creative-hub's `services.json`). */
  servers: readonly HubServerRef[];
  /** More fixed service names that may be started (default none). */
  extraServices?: readonly string[] | undefined;
  tokens?: Readonly<Record<string, string>> | undefined;
  runner: Pick<JobRunnerClient, "hubStart">;
  approvals: Pick<JobApprovalTransport, "requestHubStartApproval">;
  approvalTimeoutSec: number;
  /** IPC budget for the start itself (the job runner waits for the service's start timeout). */
  startTimeoutMs?: number | undefined;
  probe?: ProbeFn | undefined;
  logger?: Logger | undefined;
  /** Called after a successful start (S15 can re-list that server's tools). Errors are ignored. */
  onStarted?: ((service: string) => void | Promise<void>) | undefined;
  /** Test seam. */
  now?: (() => number) | undefined;
}

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

function lines(s: string, max = 500): string {
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

export function createHubStartTool(deps: HubStartDeps): DeferredToolRegistration {
  const startable = new Map<string, string>();
  for (const s of deps.servers) startable.set(s.id.toLowerCase(), s.id);
  for (const s of deps.extraServices ?? []) startable.set(s.toLowerCase(), s);
  const now = deps.now ?? Date.now;

  const tool = defineTool({
    name: "hub_start",
    description:
      "Ask to start one creative-hub service that is down (see hub_status). The user must approve in Telegram first; then the job runner starts it with its fixed start script. Nothing starts without that approval. Scriptorium shows its own warning (it resumes its whole book factory and may spend on paid models).",
    parameters: Type.Object({
      service: Type.String({ minLength: 1, maxLength: 32, description: "The service id, for example vibetts, chiptune-studio, comfy-mcp, scriptorium." }),
    }),
    deferred: true,
    replay: "unsafe",
    async execute(args, api, context): Promise<ToolExecutionResult> {
      const asked = typeof args.service === "string" ? args.service.trim() : "";
      const service = SERVICE_NAME.test(asked) ? startable.get(asked.toLowerCase()) : undefined;
      if (service === undefined) {
        return toolError(`hub_start: unknown service. Startable services: ${[...startable.values()].join(", ") || "(none configured)"}. Nothing was started.`);
      }

      // Already answering: nothing to approve or start.
      const probe: ProbeFn = deps.probe ?? probeMcpServer;
      const ref = deps.servers.find((s) => s.id === service);
      if (ref) {
        try {
          const p = await probe(service, { url: ref.url, token: deps.tokens?.[service] });
          if (p.state === "up") return toolText(`${service} is already answering. Nothing was started.`);
        } catch {
          // a failed probe is treated as down; the user still decides below
        }
      }

      const card = buildHubStartCard(service, String(api.conversationId),deps.approvalTimeoutSec, now());
      const controller = new AbortController();
      const outer = context.abortSignal;
      const onAbort = (): void => controller.abort();
      if (outer?.aborted) controller.abort();
      else outer?.addEventListener("abort", onAbort, { once: true });
      let decision;
      try {
        decision = await deps.approvals.requestHubStartApproval(card, controller.signal);
      } catch (e) {
        deps.logger?.warn("hub.start_approval_failed", { service, error: e instanceof Error ? e.name : "Error" });
        return toolError(`hub_start: the approval could not be asked (${e instanceof Error ? e.name : "error"}). Nothing was started.`);
      } finally {
        outer?.removeEventListener("abort", onAbort);
      }

      if (!decision.approved) {
        deps.logger?.info("hub.start_declined", { service, by: decision.by });
        return toolError(`hub_start: the user did not approve starting ${service} (${decision.by}). Nothing was started. Do not ask again unless the user says so.`);
      }
      if (typeof decision.userId !== "number") {
        return toolError("hub_start: the approval carried no user id, so it was not sent to the job runner. Nothing was started.");
      }

      const body: HubStartBody = {
        service,
        ...(card.scriptorium ? { scriptoriumApproved: true } : {}),
        approval: { userId: decision.userId, at: decision.at },
      };
      try {
        const reply = await deps.runner.hubStart(body, { signal: context.abortSignal, timeoutMs: deps.startTimeoutMs ?? 180_000 });
        deps.logger?.info("hub.started", { service, started: reply.started, alreadyUp: reply.alreadyUp === true });
        if (reply.started || reply.alreadyUp) {
          try {
            await deps.onStarted?.(service);
          } catch {
            // best effort
          }
        }
        const headline = reply.alreadyUp ? `${service} was already up.` : reply.started ? `${service} was started by the job runner.` : `${service} was NOT started.`;
        const note = reply.message ? `\n${wrapUntrustedContent(`hub:${service}`, lines(reply.message))}` : "";
        const out = `${headline}${note}`;
        return reply.started || reply.alreadyUp ? toolText(out) : toolError(out);
      } catch (e) {
        const name = e instanceof Error ? e.name : "Error";
        if (name === "IpcOfflineError") return toolError("hub_start: the job runner is offline, so nothing was started. The user approved; try again when it is back.");
        const code = (e as { code?: unknown }).code;
        return toolError(`hub_start: the job runner did not start ${service} (${typeof code === "string" ? code : name}).`);
      }
    },
  });
  return tool as unknown as DeferredToolRegistration;
}
