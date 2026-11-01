/**
 * The permission helper (S12.3, I19, I28): a hand-written stdio MCP server with one tool, `decide`, that Claude Code
 * starts for a job (`--mcp-config` adds it, `--permission-prompt-tool mcp__a7perm__decide` points at it). No MCP SDK.
 *
 * Claude calls `decide {tool_name, input, tool_use_id}` for every tool use that is not already allowed. The helper
 * forwards `{requestId, jobId, tool, input}` to the job runner on 127.0.0.1 as a `permission_request` signed with the
 * per-job token (the S9.3 framing, token as HMAC key) and answers Claude with the result Claude Code expects, as JSON
 * text: `{"behavior":"allow","updatedInput":<input>}` or `{"behavior":"deny","message":"..."}`.
 *
 * Environment (written only into the job-scoped mcp-config file, never into the runner's env): `A7_JOB_ID`,
 * `A7_JOB_TOKEN` (base64url, 32 bytes), `A7_JOB_PORT`. The token is never printed. Everything fails closed: a missing
 * variable, a refused connection, a timeout or an odd reply is a deny. Stdout carries JSON-RPC only.
 *
 * Wire: MCP over stdio is one JSON-RPC message per line.
 */
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { IpcKey, randomToken } from "../ipc/hmac.js";
import { CLIENT_ACCEPTS, IPC_HOST, LineSplitter, NonceCache, decodeLine, encodeLine, signMessage } from "../ipc/protocol.js";
import type { JsonObject, PermissionHelperReply, PermissionHelperRequest } from "../jobs/contracts.js";
import type { Json } from "../jobs/contracts.js";

export const HELPER_SERVER_NAME = "a7perm";
export const HELPER_TOOL_NAME = "decide";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
/** A little more than the default approval timeout (1800 s), so the runner's own timeout answers first. */
export const DEFAULT_HELPER_TIMEOUT_MS = 1_860_000;

export interface HelperEnv {
  jobId: string;
  key: IpcKey;
  port: number;
}

/** Reads and validates the three variables. Throws a message that never contains the token. */
export function readHelperEnv(env: NodeJS.ProcessEnv): HelperEnv {
  const jobId = env["A7_JOB_ID"];
  const token = env["A7_JOB_TOKEN"];
  const portText = env["A7_JOB_PORT"];
  if (jobId === undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) throw new Error("A7_JOB_ID is missing or malformed");
  if (token === undefined) throw new Error("A7_JOB_TOKEN is missing");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("A7_JOB_PORT is missing or malformed");
  let key: IpcKey;
  try {
    key = IpcKey.fromBase64Url(token);
  } catch {
    throw new Error("A7_JOB_TOKEN is malformed");
  }
  return { jobId, key, port };
}

export interface DecisionRequestOptions {
  port: number;
  host?: string;
  key: IpcKey;
  request: PermissionHelperRequest;
  timeoutMs?: number;
}

/** One signed `permission_request` over a fresh connection; resolves with the runner's reply data or rejects (caller denies). */
export function requestDecision(opts: DecisionRequestOptions): Promise<PermissionHelperReply> {
  return new Promise((resolvePromise, reject) => {
    const host = opts.host ?? IPC_HOST;
    if (host !== IPC_HOST) {
      reject(new Error("the job runner is only reachable on 127.0.0.1"));
      return;
    }
    let msg;
    let line: Buffer;
    try {
      msg = signMessage(opts.key, "permission_request", opts.request as unknown as JsonObject);
      line = encodeLine(msg);
    } catch (e) {
      reject(new Error(`request could not be encoded: ${e instanceof Error ? e.message : "error"}`));
      return;
    }
    const socket = connect({ port: opts.port, host });
    const splitter = new LineSplitter();
    const nonces = new NonceCache();
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error("timed out waiting for the job runner"))), opts.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS);
    timer.unref();
    socket.on("connect", () => socket.write(line));
    socket.on("error", () => done(() => reject(new Error("could not reach the job runner"))));
    socket.on("close", () => done(() => reject(new Error("the job runner closed the connection"))));
    socket.on("data", (chunk) => {
      let lines: string[];
      try {
        lines = splitter.push(chunk);
      } catch {
        return done(() => reject(new Error("reply too long")));
      }
      for (const l of lines) {
        if (l === "") continue;
        try {
          const d = decodeLine(l, { keys: () => [{ key: opts.key, principal: "runner" }], nonces, accepts: CLIENT_ACCEPTS });
          if (d.msg.type !== "reply" || d.msg.body["replyTo"] !== msg.id) continue;
          const body = d.msg.body as { ok?: unknown; data?: unknown; error?: { message?: unknown } };
          if (body.ok === true && typeof body.data === "object" && body.data !== null) {
            const data = body.data as { decision?: unknown; message?: unknown };
            if (data.decision === "allow_once" || data.decision === "deny") {
              const reply: PermissionHelperReply = { decision: data.decision };
              if (typeof data.message === "string") reply.message = data.message;
              return done(() => resolvePromise(reply));
            }
          }
          const why = typeof body.error?.message === "string" ? body.error.message : "refused";
          return done(() => reject(new Error(`the job runner refused the request: ${why}`)));
        } catch {
          return done(() => reject(new Error("the reply could not be verified")));
        }
      }
    });
  });
}

// ---- the MCP server ----------------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export const DECIDE_TOOL = {
  name: HELPER_TOOL_NAME,
  description: "Permission prompt tool: asks the job runner whether Claude Code may use a tool. Called by Claude Code itself, never by the model.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string", description: "The tool Claude wants to use." },
      input: { type: "object", description: "The input of that tool use." },
      tool_use_id: { type: "string", description: "The id of the tool use." },
    },
    required: ["tool_name", "input"],
  },
} as const;

export interface PermissionMcpOptions {
  /** `undefined` when the environment was invalid: every `decide` then denies. */
  env: HelperEnv | undefined;
  envError?: string;
  host?: string;
  timeoutMs?: number;
  /** Injected for tests. */
  decide?: (opts: DecisionRequestOptions) => Promise<PermissionHelperReply>;
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export class PermissionMcpServer {
  constructor(private readonly opts: PermissionMcpOptions) {}

  /** Handles one line. Returns the reply line, or `undefined` for a notification. */
  async handleLine(line: string): Promise<string | undefined> {
    let req: RpcRequest;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return rpcError(null, -32600, "invalid request");
      req = parsed as RpcRequest;
    } catch {
      return rpcError(null, -32700, "parse error");
    }
    const isNotification = req.id === undefined;
    if (typeof req.method !== "string") return isNotification ? undefined : rpcError(req.id, -32600, "invalid request");
    switch (req.method) {
      case "initialize": {
        const p = (req.params ?? {}) as { protocolVersion?: unknown };
        const version = typeof p.protocolVersion === "string" && SUPPORTED_PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : SUPPORTED_PROTOCOLS[0];
        return rpcResult(req.id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: HELPER_SERVER_NAME, version: "1.0.0" } });
      }
      case "ping":
        return isNotification ? undefined : rpcResult(req.id, {});
      case "tools/list":
        return rpcResult(req.id, { tools: [DECIDE_TOOL] });
      case "tools/call":
        return rpcResult(req.id, await this.call(req.params));
      default:
        return isNotification ? undefined : rpcError(req.id, -32601, `method not found: ${req.method}`);
    }
  }

  private async call(params: unknown): Promise<unknown> {
    const p = (typeof params === "object" && params !== null ? params : {}) as { name?: unknown; arguments?: unknown };
    if (p.name !== HELPER_TOOL_NAME) return this.text(`unknown tool`, true);
    const a = (typeof p.arguments === "object" && p.arguments !== null ? p.arguments : {}) as { tool_name?: unknown; input?: unknown; tool_use_id?: unknown };
    if (typeof a.tool_name !== "string" || a.tool_name === "") return this.deny("the request had no tool_name");
    const input = (typeof a.input === "object" && a.input !== null && !Array.isArray(a.input) ? a.input : {}) as JsonObject;
    const env = this.opts.env;
    if (!env) return this.deny(this.opts.envError ?? "the helper is not configured");
    const request: PermissionHelperRequest = {
      requestId: typeof a.tool_use_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(a.tool_use_id) ? a.tool_use_id : randomToken(),
      jobId: env.jobId,
      tool: a.tool_name,
      input: input as Json,
    };
    try {
      const decide = this.opts.decide ?? requestDecision;
      const dopts: DecisionRequestOptions = { port: env.port, key: env.key, request };
      if (this.opts.host !== undefined) dopts.host = this.opts.host;
      if (this.opts.timeoutMs !== undefined) dopts.timeoutMs = this.opts.timeoutMs;
      const reply = await decide(dopts);
      if (reply.decision === "allow_once") return this.text(JSON.stringify({ behavior: "allow", updatedInput: input }), false);
      return this.deny(reply.message ?? "denied");
    } catch (e) {
      return this.deny(e instanceof Error ? e.message : "permission check failed");
    }
  }

  private deny(message: string): unknown {
    return this.text(JSON.stringify({ behavior: "deny", message }), false);
  }

  private text(text: string, isError: boolean): unknown {
    return { content: [{ type: "text", text }], isError };
  }
}

/** Reads stdin line by line until it closes. */
export async function runStdio(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let opts: PermissionMcpOptions;
  try {
    opts = { env: readHelperEnv(env) };
  } catch (e) {
    process.stderr.write(`a7perm: ${e instanceof Error ? e.message : "bad environment"}\n`);
    opts = { env: undefined, envError: e instanceof Error ? e.message : "bad environment" };
  }
  const server = new PermissionMcpServer(opts);
  let buffer = "";
  const pending = new Set<Promise<void>>();
  const handle = (line: string): void => {
    const p = server.handleLine(line).then((out) => {
      if (out !== undefined) process.stdout.write(out + "\n");
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };
  process.stdin.setEncoding("utf8");
  await new Promise<void>((done) => {
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line !== "") handle(line);
      }
    });
    process.stdin.on("end", done);
  });
  await Promise.allSettled([...pending]);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runStdio().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
