/**
 * The ACP client side (S13.2): the only place that talks to the SDK's `client()` API.
 *
 * Client capabilities are deliberately empty: no `terminal/*`, no `fs/*`, no elicitation. Those requests, and any other
 * method this client has no handler for, are refused with "method not found" and counted (`onRefused`). Permission requests
 * go to the handler the caller supplies; session updates go to `onUpdate`.
 */
import { Readable, Writable } from "node:stream";
import { PROTOCOL_VERSION, RequestError, client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  ClientConnection,
  InitializeResponse,
  McpServer,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { DshChild } from "./launch.js";
import type { DshMcpServer } from "./types.js";

export type { InitializeResponse, NewSessionResponse, PromptResponse, RequestPermissionRequest, RequestPermissionResponse, SessionUpdate };

export interface AcpHandlers {
  /** Updates for the (single) session of this connection. */
  onUpdate(update: SessionUpdate): void;
  onPermission(req: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  /** A request the client does not implement (`terminal/create`, `fs/read_text_file`, ...). Already refused. */
  onRefused(method: string): void;
}

export const CLIENT_NAME = "agent-007-jobrunner";

/** `McpServer` entries for `session/new` (HTTP, with headers; `type` is the SDK's discriminator). */
export function toAcpMcpServers(servers: readonly DshMcpServer[]): McpServer[] {
  return servers.map((s) => ({ type: "http" as const, name: s.name, url: s.url, headers: (s.headers ?? []).map((h) => ({ name: h.name, value: h.value })) }));
}

export class AcpConnection {
  private constructor(
    private readonly conn: ClientConnection,
    /** Resolves when the connection (the child's stdio) closed. */
    readonly closed: Promise<void>,
  ) {}

  static open(child: DshChild, handlers: AcpHandlers): AcpConnection {
    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const app = client({ name: CLIENT_NAME })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => handlers.onPermission(params))
      .onNotification(methods.client.session.update, ({ params }) => {
        handlers.onUpdate(params.update);
      })
      // Everything else (terminal/*, fs/*, elicitation/*, unknown methods) is refused. No handler is ever written for them.
      .onRequest("*", ({ method }) => {
        handlers.onRefused(method);
        throw RequestError.methodNotFound(method);
      });
    const conn = app.connect(stream);
    return new AcpConnection(conn, conn.closed.catch(() => {}));
  }

  async initialize(clientVersion: string): Promise<InitializeResponse> {
    return this.conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: CLIENT_NAME, version: clientVersion },
    });
  }

  newSession(cwd: string, mcpServers: readonly DshMcpServer[]): Promise<NewSessionResponse> {
    return this.conn.agent.request(methods.agent.session.new, { cwd, mcpServers: toAcpMcpServers(mcpServers) });
  }

  resumeSession(sessionId: string, cwd: string, mcpServers: readonly DshMcpServer[]): Promise<ResumeSessionResponse> {
    return this.conn.agent.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: toAcpMcpServers(mcpServers) });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.conn.agent.request(methods.agent.session.setMode, { sessionId, modeId });
  }

  prompt(sessionId: string, text: string): Promise<PromptResponse> {
    return this.conn.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
  }

  /** `session/cancel` is a notification. */
  cancel(sessionId: string): Promise<void> {
    return this.conn.agent.notify(methods.agent.session.cancel, { sessionId });
  }

  close(): void {
    try {
      this.conn.close();
    } catch {
      /* already closed */
    }
  }
}
