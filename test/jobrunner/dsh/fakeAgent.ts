/**
 * A fake ACP agent for the S13 tests, written with the SDK's agent side. It stands in for `dsh --profile acp`; the real dsh
 * is never run by any test. Scenario and options come from the environment:
 *
 *   FAKE_ACP_SCENARIO  name of the scenario (see `scenarios` below)
 *   FAKE_ACP_OPTS      JSON object of scenario options
 *   FAKE_ACP_LOG       a file: one JSON line per thing the agent observed (the test reads it)
 *
 * stdout carries only the protocol; anything else goes to the log file.
 */
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { RequestError, agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import type { AgentContext, PermissionOption, ToolKind } from "@agentclientprotocol/sdk";

const scenario = process.env["FAKE_ACP_SCENARIO"] ?? "basic";
const opts = JSON.parse(process.env["FAKE_ACP_OPTS"] ?? "{}") as Record<string, unknown>;
const logFile = process.env["FAKE_ACP_LOG"];

function log(event: string, data: Record<string, unknown> = {}): void {
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ event, ...data })}\n`);
}

log("start", { pid: process.pid, argv: process.argv.slice(2), hasKey: process.env["DEEPSEEK_API_KEY"] !== undefined, key: process.env["DEEPSEEK_API_KEY"] ?? null, envNames: Object.keys(process.env) });

const sessions = new Map<string, { cancelled: () => void; waitCancel: Promise<void> }>();
let nextSession = 1;

function optionSet(kinds: string[]): PermissionOption[] {
  return kinds.map((kind) => ({ optionId: `opt-${kind}`, name: kind.replace("_", " "), kind: kind as PermissionOption["kind"] }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function say(client: AgentContext, sessionId: string, text: string): Promise<void> {
  await client.notify(methods.client.session.update, { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
}

async function ask(client: AgentContext, sessionId: string, o: { toolCallId: string; title: string; name?: string; kind: ToolKind; rawInput?: unknown; options: string[] }): Promise<string> {
  const res = await client.request(methods.client.session.requestPermission, {
    sessionId,
    toolCall: { toolCallId: o.toolCallId, title: o.title, kind: o.kind, status: "pending", rawInput: o.rawInput, ...(o.name ? { name: o.name } : {}) },
    options: optionSet(o.options),
  });
  const out = res.outcome.outcome === "selected" ? `selected:${res.outcome.optionId}` : "cancelled";
  log("permission_outcome", { toolCallId: o.toolCallId, outcome: out });
  return out;
}

const app = agent({ name: "fake-dsh" })
  .onRequest(methods.agent.initialize, () => {
    log("initialize");
    const resume = opts["noResume"] === true ? undefined : {};
    return {
      protocolVersion: typeof opts["protocolVersion"] === "number" ? (opts["protocolVersion"] as number) : 1,
      agentInfo: { name: "fake-dsh", version: "0.0.0-test" },
      agentCapabilities: { sessionCapabilities: resume ? { resume } : {} },
    };
  })
  .onRequest(methods.agent.session.new, ({ params }) => {
    log("session_new", { cwd: params.cwd, mcpServers: params.mcpServers });
    const id = `s-${nextSession++}`;
    let cancelled!: () => void;
    const waitCancel = new Promise<void>((r) => (cancelled = r));
    sessions.set(id, { cancelled, waitCancel });
    return {
      sessionId: id,
      modes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "Auto" }, { id: "ask", name: "Ask first" }] },
    };
  })
  .onRequest(methods.agent.session.resume, ({ params }) => {
    log("session_resume", { sessionId: params.sessionId, cwd: params.cwd, mcpServers: params.mcpServers });
    let cancelled!: () => void;
    const waitCancel = new Promise<void>((r) => (cancelled = r));
    sessions.set(params.sessionId, { cancelled, waitCancel });
    return { modes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "Auto" }, { id: "ask", name: "Ask first" }] } };
  })
  .onRequest(methods.agent.session.setMode, ({ params }) => {
    log("set_mode", { modeId: params.modeId });
    return {};
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => {
    log("cancel", { sessionId: params.sessionId });
    sessions.get(params.sessionId)?.cancelled();
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const sid = params.sessionId;
    const first = params.prompt[0];
    log("prompt", { text: first && first.type === "text" ? first.text : null });
    const state = sessions.get(sid);
    const update = (u: Parameters<AgentContext["notify"]>[1]) => client.notify(methods.client.session.update, u as never);

    switch (scenario) {
      case "basic": {
        await update({ sessionId: sid, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } } });
        await say(client, sid, "Hello ");
        await update({ sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", name: "read_file", kind: "read", status: "pending", rawInput: { path: "a.txt" } } });
        await update({ sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "file contents" } }] } });
        await update({ sessionId: sid, update: { sessionUpdate: "plan", entries: [{ content: "step one", priority: "high", status: "completed" }, { content: "step two", priority: "medium", status: "in_progress" }] } });
        await update({ sessionId: sid, update: { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.02, currency: "USD" } } });
        await update({ sessionId: sid, update: { sessionUpdate: "notice", severity: "warning", title: "careful" } });
        await say(client, sid, "world");
        return { stopReason: "end_turn" };
      }
      case "echo_key": {
        await say(client, sid, `the key is ${process.env["DEEPSEEK_API_KEY"] ?? "none"} ok`);
        return { stopReason: "end_turn" };
      }
      case "permission": {
        const kinds = (opts["options"] as string[] | undefined) ?? ["allow_once", "reject_once"];
        const outcome = await ask(client, sid, {
          toolCallId: "p1",
          title: (opts["title"] as string | undefined) ?? "Edit file",
          ...(typeof opts["name"] === "string" ? { name: opts["name"] } : {}),
          kind: ((opts["toolKind"] as string | undefined) ?? "edit") as ToolKind,
          rawInput: opts["rawInput"] ?? { path: "x.txt" },
          options: kinds,
        });
        await say(client, sid, `outcome=${outcome}`);
        return { stopReason: "end_turn" };
      }
      case "permission_hold": {
        // Asks and waits for the answer; the test cancels meanwhile.
        const outcome = await ask(client, sid, { toolCallId: "h1", title: "Edit file", kind: "edit", options: ["allow_once", "allow_always", "reject_once"] });
        await say(client, sid, `outcome=${outcome}`);
        return { stopReason: outcome === "cancelled" ? "cancelled" : "end_turn" };
      }
      case "terminal": {
        let message = "none";
        try {
          await client.createTerminal({ sessionId: sid, command: "whoami", args: [] });
        } catch (e) {
          message = e instanceof RequestError ? `${e.code}` : String(e);
        }
        log("terminal_result", { message });
        await say(client, sid, `terminal=${message}`);
        return { stopReason: "end_turn" };
      }
      case "hang": {
        await say(client, sid, "working");
        if (opts["ignoreCancel"] === true) {
          await sleep(60_000);
          return { stopReason: "end_turn" };
        }
        await state?.waitCancel;
        return { stopReason: "cancelled" };
      }
      case "crash": {
        await say(client, sid, "about to crash");
        await sleep(50);
        process.exit(3);
        return { stopReason: "end_turn" };
      }
      case "stop_reason": {
        return { stopReason: ((opts["stopReason"] as string | undefined) ?? "refusal") as "refusal" };
      }
      case "probe_ask": {
        // A well-behaved dsh: asks before running the shell and respects a rejection.
        const outcome = await ask(client, sid, { toolCallId: "w1", title: "Run: whoami", name: "shell", kind: ((opts["toolKind"] as string | undefined) ?? "execute") as ToolKind, rawInput: { command: "whoami" }, options: ["allow_once", "allow_always", "reject_once", "reject_always"] });
        if (outcome === "selected:opt-allow_once") {
          await update({ sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "w1", status: "completed", content: [{ type: "content", content: { type: "text", text: "DOMAIN\\someone" } }] } });
          await say(client, sid, "It printed DOMAIN\\someone");
        } else {
          await say(client, sid, "The command was not allowed, so I did not run it.");
        }
        return { stopReason: "end_turn" };
      }
      case "probe_noask": {
        // A dsh that runs the shell without asking.
        await update({ sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "w1", title: "Run: whoami", name: "shell", kind: "execute", status: "in_progress", rawInput: { command: "whoami" } } });
        await update({ sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "w1", status: "completed", content: [{ type: "content", content: { type: "text", text: "DOMAIN\\someone" } }] } });
        await say(client, sid, "Done: DOMAIN\\someone");
        return { stopReason: "end_turn" };
      }
      case "probe_leak": {
        // Asks, is rejected, but the text still shows the command output (it ran by another route).
        await ask(client, sid, { toolCallId: "w1", title: "Run: whoami", name: "shell", kind: "execute", rawInput: { command: "whoami" }, options: ["allow_once", "reject_once"] });
        await say(client, sid, "I found out: DOMAIN\someone");
        return { stopReason: "end_turn" };
      }
      case "probe_none": {
        // The model simply declines and no shell tool is ever requested.
        await say(client, sid, "I cannot run commands.");
        return { stopReason: "end_turn" };
      }
      default:
        throw RequestError.invalidParams({}, `unknown scenario ${scenario}`);
    }
  });

app.connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
