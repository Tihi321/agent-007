/**
 * Shared helpers for the smoke scripts: a Harness over a SQLite file plus the configured runner's provider.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT, Harness, createRegistry, createRunnerModels, openNodeSqliteStorage } from "../../src/pi/adapter.js";
import type { Conversation, EntryRecord, HarnessSettings, SettledSubmissionRecord } from "../../src/pi/adapter.js";
import type { SmokeRunnerConfig } from "./config.js";

export const ctx = BACKGROUND_CONTEXT;

/** Extension type as the registry accepts it. */
export type RegistryOf = ReturnType<typeof createRegistry>;
export type InstallArg = Parameters<RegistryOf["install"]>[0];

export interface RigOptions {
  storagePath: string;
  cfg: SmokeRunnerConfig;
  /** Extensions to install (tools, hooks). */
  extensions?: InstallArg[];
  settings?: HarnessSettings | undefined;
  /** Replace the key (wrong-key and no-key runs). `null` = send no key. */
  apiKeyOverride?: string | null | undefined;
  /** Override the provider base URL (the S7 proxy). */
  baseUrl?: string | undefined;
  /** Call `harness.resume()` right after opening (the restart cases). */
  resume?: boolean;
}

export interface Rig {
  harness: Harness;
  root: Conversation;
  modelRef: { provider: string; modelId: string };
  close(): Promise<void>;
}

export async function openRig(o: RigOptions): Promise<Rig> {
  mkdirSync(dirname(o.storagePath), { recursive: true });
  const key = o.apiKeyOverride === undefined ? o.cfg.apiKey : (o.apiKeyOverride ?? undefined);
  const { models } = createRunnerModels({
    id: o.cfg.runner,
    baseUrl: o.baseUrl ?? o.cfg.baseUrl,
    modelId: o.cfg.modelId,
    apiKey: key,
    contextWindow: o.cfg.contextWindow,
    maxTokens: o.cfg.maxTokens,
    compat: o.cfg.compat,
  });
  const registry = createRegistry();
  for (const e of o.extensions ?? []) registry.install(e);
  const storage = await openNodeSqliteStorage(o.storagePath);
  const harness = await Harness.open(storage, { models, registry, ...(o.settings ? { settings: o.settings } : {}) }, ctx);
  const modelRef = { provider: o.cfg.runner, modelId: o.cfg.modelId };
  const root = await harness.root(ctx, { agent: { model: modelRef } });
  if (o.resume) harness.resume();
  return { harness, root, modelRef, close: () => harness.close(ctx) };
}

/** Text blocks of an entry's model messages with the given role. */
export function entryText(entry: EntryRecord, role: "assistant" | "user" | "toolResult" = "assistant"): string {
  const parts: string[] = [];
  for (const m of entry.model ?? []) {
    const msg = m as unknown as { role?: string; content?: unknown };
    if (msg.role !== role) continue;
    if (typeof msg.content === "string") parts.push(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const b of msg.content as { type?: string; text?: string }[]) if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}

/** True if the entry's assistant message contains a tool call. */
export function entryHasToolCall(entry: EntryRecord): boolean {
  for (const m of entry.model ?? []) {
    const msg = m as unknown as { role?: string; content?: unknown };
    if (msg.role === "assistant" && Array.isArray(msg.content) && (msg.content as { type?: string }[]).some((b) => b.type === "toolCall")) return true;
  }
  return false;
}

/** The stop reason of the entry's assistant message ("stop", "toolUse", "aborted", "error", ...), if any. */
export function entryStopReason(entry: EntryRecord): string | undefined {
  for (const m of entry.model ?? []) {
    const msg = m as unknown as { role?: string; stopReason?: string };
    if (msg.role === "assistant") return msg.stopReason;
  }
  return undefined;
}

/** All committed entries, oldest first. */
export async function allEntries(conv: Conversation): Promise<EntryRecord[]> {
  const out: EntryRecord[] = [];
  let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
  for (let i = 0; i < 50; i++) {
    const page = await conv.entries({ order: "ascending" }, 200, cursor, ctx);
    out.push(...page.items);
    if (!page.next) break;
    cursor = page.next;
  }
  return out;
}

/** The text of the answer entry of a settled `done` submission. */
export async function answerText(conv: Conversation, settled: SettledSubmissionRecord): Promise<string> {
  if (settled.type !== "input" || settled.status !== "done") return "";
  const entries = await allEntries(conv);
  const hit = entries.find((e) => e.id === settled.answer);
  return hit ? entryText(hit) : "";
}

/** Submit input and wait for it to settle. */
export async function ask(conv: Conversation, content: string, requestId?: string): Promise<{ settled: SettledSubmissionRecord; text: string; ms: number }> {
  const t0 = Date.now();
  const sub = await conv.submit({ type: "input", content, ...(requestId ? { requestId } : {}) }, ctx);
  const settled = await sub.wait(ctx);
  return { settled, text: await answerText(conv, settled), ms: Date.now() - t0 };
}

/** Compact, secret-free description of a settled submission for result JSON. */
export function describeSettled(s: SettledSubmissionRecord): { status: string; reason?: string; detail?: unknown } {
  const base: { status: string; reason?: string; detail?: unknown } = { status: s.status };
  if (s.status === "unanswered") {
    base.reason = s.reason;
    if (s.detail !== undefined) base.detail = s.detail;
  }
  return base;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
