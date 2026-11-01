/**
 * Integration rig (S6): the REAL startup sequence (`startAgent`: lock, config, secrets, Harness on a temp SQLite file,
 * `a7` extension, Telegram bridge) over a fake OpenAI-compatible runner and a fake Telegram API. Nothing here
 * contacts Telegram or a real model runner. A "restart" is `stop()` then `start()` on the same directory.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgent } from "../../src/agent/harness.js";
import type { AgentHandle, StartOptions } from "../../src/agent/harness.js";
import type { DefaultsEnv } from "../../src/config/schema.js";
import { startFakeOpenAi } from "../helpers/fakeOpenAi.js";
import type { Behavior, BehaviorInput, FakeServer } from "../helpers/fakeOpenAi.js";
import { createFakeTelegram, FAKE_TOKEN, textUpdate, callbackUpdate, USER_ID, waitFor } from "../telegram/helpers/fakeTelegram.js";
import type { FakeTelegram } from "../telegram/helpers/fakeTelegram.js";

export const MODEL_ID = "fake-model";
export const LM_TOKEN = "lm-test-token-123456";
export { USER_ID, waitFor };

export interface Dirs {
  root: string;
  notes: string;
  configPath: string;
  secretsPath: string;
  env: DefaultsEnv;
  /** Resolved config paths (all inside `root`). */
  data: string;
  programData: string;
}

export function makeDirs(): Dirs {
  const root = mkdtempSync(join(tmpdir(), "a7-int-"));
  const notes = join(root, "notes");
  const programData = join(root, "pd");
  const data = join(root, "data");
  mkdirSync(notes, { recursive: true });
  mkdirSync(join(programData, "config"), { recursive: true });
  writeFileSync(join(notes, "a.txt"), "alpha file in the notes folder\n");
  writeFileSync(join(programData, "config", "USER.md"), "The user likes tea.\n");
  const env: DefaultsEnv = { localAppData: join(root, "local"), programData, mainUserProfile: join(root, "profile") };
  return { root, notes, configPath: join(root, "config.json"), secretsPath: join(root, "secrets.json"), env, data, programData };
}

export interface ConfigInput {
  baseUrl: string;
  modelId?: string;
  /** Default lmstudio. */
  runner?: "lmstudio" | "strata";
  /** The runner key for secrets.json (LM Studio token or Strata key). Default: the fake's token. */
  apiKey?: string | undefined;
  contextWindow?: number;
  maxTokens?: number;
  allowedUserIds?: number[];
  shell?: Record<string, unknown>;
  retry?: Record<string, unknown>;
  streamTimeoutMs?: number;
  /** Phase 2 blocks written into config.json (jobs, mcp, flow, secondOpinion). */
  phase2?: Record<string, unknown>;
  /** Extra secrets (ipcHmacKey, mcpTokens). */
  secrets?: Record<string, unknown>;
}

export function writeConfig(d: Dirs, c: ConfigInput): void {
  const cfg = {
    telegram: { allowedUserIds: c.allowedUserIds ?? [USER_ID] },
    model: {
      runner: c.runner ?? "lmstudio",
      runners: { [c.runner ?? "lmstudio"]: { baseUrl: c.baseUrl, modelId: c.modelId ?? MODEL_ID, contextWindow: c.contextWindow ?? 8192, maxTokens: c.maxTokens ?? 512 } },
      streamTimeoutMs: c.streamTimeoutMs ?? 20_000,
      retry: { enabled: true, maxRetries: 200, baseDelayMs: 20, maxAgentDelayMs: 100, ...(c.retry ?? {}) },
    },
    folders: { allow: [{ alias: "notes", path: d.notes }], deny: [] },
    shell: { enabled: true, approvalTimeoutSec: 600, ...(c.shell ?? {}) },
    paths: {
      programDataDir: d.programData,
      dataDir: d.data,
      stateDir: join(d.data, "state"),
      workspaceDir: join(d.data, "workspace"),
      memoryFile: join(d.data, "memory", "MEMORY.md"),
      userFile: join(d.programData, "config", "USER.md"),
      logsDir: join(d.data, "logs"),
      auditDir: join(d.data, "audit"),
      controlDir: join(d.data, "control"),
      runDir: join(d.data, "run"),
    },
    mainUserProfile: join(d.root, "profile"),
    ...(c.phase2 ?? {}),
  };
  writeFileSync(d.configPath, JSON.stringify(cfg, null, 2));
  const key = "apiKey" in c ? c.apiKey : LM_TOKEN;
  const keyName = (c.runner ?? "lmstudio") === "strata" ? "strataApiKey" : "lmStudioApiToken";
  writeFileSync(d.secretsPath, JSON.stringify({ telegramBotToken: FAKE_TOKEN, ...(key ? { [keyName]: key } : {}), ...(c.secrets ?? {}) }));
}

export function readAudit(d: Dirs): Record<string, unknown>[] {
  const dir = join(d.data, "audit");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => /^shell-\d{6}\.jsonl$/.test(n)).sort();
  } catch {
    return [];
  }
  return names.flatMap((n) =>
    readFileSync(join(dir, n), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  );
}

export function readLogs(d: Dirs): Record<string, unknown>[] {
  const dir = join(d.data, "logs");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  return names.flatMap((n) =>
    readFileSync(join(dir, n), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  );
}

const DEFERRED_PHASE1 = new Set(["search_files", "write_file", "remember", "shell"]);

function lastCalledTool(input: BehaviorInput): string | undefined {
  const msgs = input.request.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    const first = (m.tool_calls as { function?: { name?: string } }[])[0];
    return first?.function?.name;
  }
  return undefined;
}

/**
 * Phase 2 (I27): `search_files`, `write_file`, `remember` and `shell` are deferred, so a model must load them with
 * `tool_search` first. This wraps a scripted behaviour the way a real model behaves: a call to a deferred tool that is not
 * offered yet becomes a `tool_search` call, and after the search the script runs again as if for the first time.
 */
export function viaToolSearch(inner: Behavior, opts: { extraDeferred?: (name: string) => boolean; queries?: Record<string, string> } = {}): Behavior {
  const isDeferred = (n: string): boolean => DEFERRED_PHASE1.has(n) || (opts.extraDeferred?.(n) ?? false);
  return (i) => {
    const afterSearch = i.afterTool && lastCalledTool(i) === "tool_search";
    const view: BehaviorInput = afterSearch ? { ...i, afterTool: false, lastToolText: "" } : i;
    const reply = inner(view);
    if (reply.type !== "tool_calls") return reply;
    const offered = new Set((i.request.tools ?? []).map((t) => t.function?.name ?? ""));
    const missing = reply.calls.find((c) => isDeferred(c.name) && !offered.has(c.name));
    if (missing) return { type: "tool_calls", calls: [{ name: "tool_search", args: { query: opts.queries?.[missing.name] ?? `${missing.name} tool` } }] };
    return reply;
  };
}

/** A scripted model: tool calls for a few keywords, an echo otherwise. */
export const e2eBehavior: Behavior = viaToolSearch(({ lastUser, afterTool, lastToolText }) => {
  if (afterTool) {
    if (/Wrote \d+ bytes/.test(lastToolText)) return { type: "tool_calls", calls: [{ name: "read_file", args: { path: "workspace:hello.txt" } }] };
    return { type: "text", text: `After the tool: ${lastToolText}` };
  }
  if (/\bwhoami\b/i.test(lastUser)) return { type: "tool_calls", calls: [{ name: "shell", args: { command: "whoami", reason: "Check which user the agent runs as." } }] };
  if (/\bremember tea\b/i.test(lastUser)) return { type: "tool_calls", calls: [{ name: "remember", args: { note: "The user's favourite drink is tea." } }] };
  if (/\blist notes\b/i.test(lastUser)) return { type: "tool_calls", calls: [{ name: "list_dir", args: { path: "notes:" } }] };
  if (/\bwrite hello\b/i.test(lastUser)) return { type: "tool_calls", calls: [{ name: "write_file", args: { path: "hello.txt", content: "hello from the agent", mode: "create" } }] };
  if (/\bread secrets\b/i.test(lastUser)) return { type: "tool_calls", calls: [{ name: "read_file", args: { path: "C:\\Windows\\System32\\drivers\\etc\\hosts" } }] };
  return { type: "text", text: `echo: ${lastUser}` };
});

export interface Card {
  /** `callback_data` of the Approve and Deny buttons. */
  approve: string;
  deny: string;
  text: string;
}

export class E2e {
  readonly dirs: Dirs;
  private fakeServer: FakeServer | undefined;
  tgs: FakeTelegram[] = [];
  agent!: AgentHandle;
  private readonly startExtra: Partial<StartOptions>;

  private constructor(dirs: Dirs, fake: FakeServer | undefined, startExtra: Partial<StartOptions>) {
    this.dirs = dirs;
    this.fakeServer = fake;
    this.startExtra = startExtra;
  }

  /** The fake model runner (absent when the rig runs against a real runner). */
  get fake(): FakeServer {
    if (!this.fakeServer) throw new Error("this rig runs against a real runner; there is no fake server");
    return this.fakeServer;
  }

  /** A rig over a REAL runner (the manual `@runner` suite): the real startup sequence, a fake Telegram. */
  static async openExternal(config: ConfigInput, start: Partial<StartOptions> = {}): Promise<E2e> {
    const dirs = makeDirs();
    writeConfig(dirs, config);
    const rig = new E2e(dirs, undefined, start);
    await rig.start();
    return rig;
  }

  static async open(o: { behavior?: Behavior; config?: Partial<ConfigInput>; start?: Partial<StartOptions>; fake?: FakeServer } = {}): Promise<E2e> {
    const dirs = makeDirs();
    const fake = o.fake ?? (await startFakeOpenAi({ behavior: o.behavior ?? e2eBehavior, modelId: MODEL_ID, requireKey: LM_TOKEN }));
    writeConfig(dirs, { baseUrl: fake.baseUrl, ...(o.config ?? {}) });
    const rig = new E2e(dirs, fake, o.start ?? {});
    await rig.start();
    return rig;
  }

  /** The Telegram fake of the current generation. */
  get tg(): FakeTelegram {
    return this.tgs[this.tgs.length - 1] as FakeTelegram;
  }

  async start(): Promise<void> {
    const tg = createFakeTelegram();
    this.tgs.push(tg);
    this.agent = await startAgent({
      configPath: this.dirs.configPath,
      secretsPath: this.dirs.secretsPath,
      checkAcl: false,
      env: this.dirs.env,
      bot: tg.bot,
      bridge: { editIntervalMs: 60, retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 }, redeliverDelayMs: 100_000, stopWaitMs: 5000 },
      gatePollMs: 50,
      healthIntervalMs: 3_600_000,
      ...this.startExtra,
    });
  }

  /** Stops the agent like a shutdown (the first half of a restart). */
  async stop(): Promise<void> {
    await this.agent.stop();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async close(): Promise<void> {
    await this.agent.stop().catch(() => undefined);
    await this.fakeServer?.close().catch(() => undefined);
  }

  /** The allowed user sends a text message (or a command). */
  async say(text: string, messageId?: number): Promise<void> {
    await this.tg.bot.handleUpdate(textUpdate(USER_ID, text, messageId !== undefined ? { messageId } : {}) as never);
  }

  /** Taps a button on a card (`data` is the card's `approve` or `deny` value). */
  async tap(data: string): Promise<void> {
    await this.tg.bot.handleUpdate(callbackUpdate(USER_ID, data) as never);
  }

  /** Approval cards sent so far by the current Telegram fake, oldest first. */
  cards(tg: FakeTelegram = this.tg): Card[] {
    return tg
      .of("sendMessage")
      .filter((c) => !c.failed && c.payload["reply_markup"] !== undefined)
      .map((c) => {
        const kb = (c.payload["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0] ?? [];
        return { approve: kb[0]?.callback_data ?? "", deny: kb[1]?.callback_data ?? "", text: String(c.payload["text"]) };
      });
  }

  /** Waits for the n-th (1-based) approval card of the current generation. */
  async card(n = 1): Promise<Card> {
    await waitFor(() => this.cards().length >= n, 15_000, `approval card ${n}`);
    return this.cards()[n - 1] as Card;
  }

  /** Current text of every message the user has seen from the current generation (edits applied). */
  texts(tg: FakeTelegram = this.tg): string[] {
    return tg.messageTexts().map((m) => m.text);
  }

  /** Waits until some message of the current generation satisfies `pred`. */
  async seen(pred: (t: string) => boolean, what: string, ms = 20_000): Promise<string> {
    let hit: string | undefined;
    await waitFor(
      () => {
        hit = this.texts().find(pred);
        return hit !== undefined;
      },
      ms,
      what,
    );
    return hit as string;
  }

  /** The system prompt of the last chat request the fake runner saw. */
  lastSystemPrompt(): string {
    const reqs = this.fake.chatRequests();
    const body = reqs[reqs.length - 1]?.body;
    const sys = body?.messages.find((m) => m.role === "system" || m.role === "developer");
    return typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
  }

  toolNamesOfLastRequest(): string[] {
    const reqs = this.fake.chatRequests();
    return (reqs[reqs.length - 1]?.body?.tools ?? []).map((t) => t.function?.name ?? "");
  }

  audit(): Record<string, unknown>[] {
    return readAudit(this.dirs);
  }
}
