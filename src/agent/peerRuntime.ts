/**
 * The `BotRuntime` of one bot (S26.1, I34, I36): how a peer's ask becomes a turn of THIS bot, on top of its own Harness.
 *
 *   - One peer conversation per sender, `peer:<sender>`, created on first use in the bot's own storage; the key to conversation map
 *     is a durable doc, so the same sender gets the same conversation after a restart.
 *   - Before the turn the conversation is narrowed with `configure({ tools })` to exactly the tools `caps` permits, the model is the
 *     bot's current preset, and the result is READ BACK: the guard extension's hook must still be there and nothing outside `caps` may be
 *     offered, or the turn is refused (fail closed). `extensions` is never passed (footgun 30).
 *   - `ctx.bind(conversationId)` is called BEFORE the text is submitted, so the guard and `noteToolUse` find the chain from the first tool.
 *   - The text is `ctx.text`, the `<peer_message>` block, submitted as a user-role message (data, never a system prompt).
 *   - The turn runs under a gate priority hint (P1 inside a chain the user started, P2 otherwise), and the asker's stickiness hold on the
 *     local runner is dropped so a peer on the same runner is not made to wait for it.
 *   - The reply is the answer's text; `toolsUsed` and `tokens` are reported so the bus can taint and budget.
 */
import type { Logger } from "../contracts.js";
import type { BotRuntime, Envelope, PeerCaps, PeerReply, PeerTurnContext } from "../botbus/contracts.js";
import { BusError } from "../botbus/contracts.js";
import type { ChainStore } from "../botbus/chains.js";
import { BACKGROUND_CONTEXT, defineDoc } from "../pi/adapter.js";
import type { Conversation, Harness, Registry, ToolRegistration } from "../pi/adapter.js";
import { P1, P2 } from "../gate/queue.js";
import type { LocalGate } from "../gate/gate.js";
import type { PriorityHints } from "../gate/hints.js";
import type { ModelSwitcher } from "../models/switch.js";
import type { ModelRef } from "../models/presets.js";
import { toConversationId } from "../telegram/conversations.js";

export type PeerConvValue = { convs: Record<string, string> };

export const peerConvDoc = defineDoc<PeerConvValue>({
  kind: "a7.peer.convs",
  version: 1,
  scope: "session",
  initial: () => ({ convs: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 25,
});

/** The tool names used per conversation since the last `take` (filled by the bus guard's `afterTool`). */
export class ToolUseLog {
  readonly #byConv = new Map<string, string[]>();
  note(conversationId: string, tool: string): void {
    const list = this.#byConv.get(conversationId) ?? [];
    if (list.length < 200) list.push(tool);
    this.#byConv.set(conversationId, list);
  }
  take(conversationId: string): string[] {
    const list = this.#byConv.get(conversationId) ?? [];
    this.#byConv.delete(conversationId);
    return list;
  }
}

export interface PeerRuntimeDeps {
  botId: string;
  harness: () => Harness;
  registry: () => Registry;
  /** The bot's model switcher: the peer conversation runs on the bot's current preset. */
  switcher?: ModelSwitcher | undefined;
  /** The model when there is no switcher. */
  modelRef: () => ModelRef;
  /** The host extension whose hook must survive `configure()` (the `a7` guard). */
  guardExtension: string;
  toolUse: ToolUseLog;
  chains: Pick<ChainStore, "getChain">;
  hints?: PriorityHints | undefined;
  gate?: Pick<LocalGate, "dropHold"> | undefined;
  logger?: Logger | undefined;
}

/** The text and token usage of the committed answer entry. */
async function readAnswer(conv: Conversation, answerId: string): Promise<{ text: string; tokens: number }> {
  let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
  for (let page = 0; page < 40; page++) {
    const res = await conv.entries({ order: "descending" }, 50, cursor, BACKGROUND_CONTEXT);
    const hit = res.items.find((e) => String(e.id) === answerId);
    if (hit) {
      const parts: string[] = [];
      let tokens = 0;
      for (const m of (hit as { model?: readonly unknown[] }).model ?? []) {
        const msg = m as { role?: string; content?: unknown; usage?: { totalTokens?: number } };
        if (msg.role !== "assistant") continue;
        if (typeof msg.usage?.totalTokens === "number") tokens += msg.usage.totalTokens;
        if (typeof msg.content === "string") parts.push(msg.content);
        else if (Array.isArray(msg.content)) for (const b of msg.content as { type?: string; text?: string }[]) if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
      return { text: parts.join(""), tokens };
    }
    if (!res.next) break;
    cursor = res.next;
  }
  return { text: "", tokens: 0 };
}

export function createPeerRuntime(deps: PeerRuntimeDeps): BotRuntime {
  const locks = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  };

  /** The peer conversation for `key` (`peer:<sender>`): the stored one, or a new one created together with its map entry. */
  async function conversationFor(key: string): Promise<Conversation> {
    return serial(key, async () => {
      const harness = deps.harness();
      const snap = await harness.snapshot(peerConvDoc, BACKGROUND_CONTEXT);
      const id = snap?.convs[key];
      if (id !== undefined) {
        const existing = await harness.conversation(toConversationId(id), BACKGROUND_CONTEXT);
        if (existing) return existing;
        deps.logger?.warn("bot.peer_conversation_missing", { bot: deps.botId });
      }
      const model = deps.switcher ? deps.switcher.modelRef() : deps.modelRef();
      return harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model },
          init: async (tx, conversationId) => {
            const doc = await tx.doc(peerConvDoc);
            doc.convs[key] = String(conversationId);
          },
        },
        BACKGROUND_CONTEXT,
      );
    });
  }

  /** Enables exactly the tools `caps` permits and checks it held. Throws when the guard hook or the narrowing did not hold. */
  async function narrow(conv: Conversation, caps: PeerCaps): Promise<void> {
    const registry = deps.registry();
    const byName = new Map<string, ToolRegistration>();
    for (const { tool } of registry.snapshot().tools()) if (!byName.has(tool.name)) byName.set(tool.name, tool);
    const regs = [...byName.values()].filter((t) => caps.permits(t.name));
    const model = deps.switcher ? deps.switcher.modelRef() : deps.modelRef();
    await conv.configure({ tools: regs, model }, BACKGROUND_CONTEXT);
    const agent = await conv.agent(BACKGROUND_CONTEXT);
    const guard = agent.extensions.find((e) => e.name === deps.guardExtension);
    const offered = [...agent.tools, ...agent.callable, ...agent.deferred].map((t) => t.name);
    const stray = offered.filter((n) => !caps.permits(n));
    if (!guard || (guard.hooks ?? []).length === 0 || stray.length > 0) {
      await conv.configure({ tools: [], model }, BACKGROUND_CONTEXT).catch(() => undefined);
      deps.logger?.error("bot.peer_narrow_readback_failed", { bot: deps.botId, guardPresent: Boolean(guard), stray: stray.slice(0, 5) });
      throw new BusError("unavailable", "turn_failed");
    }
  }

  return {
    async runPeerTurn(envelope: Envelope, caps: PeerCaps, ctx: PeerTurnContext): Promise<PeerReply> {
      const conv = await conversationFor(ctx.conversationKey);
      const conversationId = String(conv.id);
      ctx.bind(conversationId); // the guard answers from the chain record from the first tool on
      deps.toolUse.take(conversationId);
      if (deps.switcher) await deps.switcher.ensureApplied(conversationId, conv);
      await narrow(conv, caps);

      // the asker waits on this turn: its own stickiness hold on a shared runner must not block the peer
      deps.gate?.dropHold(envelope.from);
      const userChain = deps.chains.getChain(envelope.chainId)?.origin === "user";
      const end = deps.hints?.begin(deps.botId, { priority: userChain ? P1 : P2, conversationId }) ?? (() => undefined);
      try {
        if (ctx.signal.aborted) throw new BusError("timeout", "ask_timeout");
        const submission = await conv.submit({ type: "input", content: ctx.text, whenBusy: "followUp", requestId: `peer:${envelope.id}` }, BACKGROUND_CONTEXT);
        const stopped = new Promise<"aborted">((resolve) => {
          const onAbort = (): void => resolve("aborted");
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener("abort", onAbort, { once: true });
        });
        const settled = await Promise.race([submission.wait(BACKGROUND_CONTEXT), stopped]);
        if (settled === "aborted") {
          await conv.abort(BACKGROUND_CONTEXT).catch(() => undefined);
          throw new BusError("timeout", "ask_timeout");
        }
        if (settled.type !== "input" || settled.status !== "done") throw new BusError("unavailable", "turn_failed");
        const answer = await readAnswer(conv, String(settled.answer));
        return { text: answer.text, toolsUsed: deps.toolUse.take(conversationId), tokens: answer.tokens };
      } finally {
        end();
      }
    },
  };
}
