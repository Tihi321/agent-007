/**
 * Phase 4 integration rig (S26): the REAL startup sequence (`startAgent`) on a MIGRATED fixture install whose `security.json` has a
 * `bots` block, so the multi-bot host starts: a `BotManager`, one real Harness (SQLite) and one grammY `Bot` per bot (each over its own
 * fake Telegram API), the real bus and router, the local gate and the proxy brain. Models are a fake OpenAI-compatible server (the local
 * runner) and, when asked, a second one standing in for the proxy. Nothing contacts Telegram, a real model, the real proxy, Strata or
 * LM Studio; every directory is under the temp folder.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMigration } from "../../scripts/migrate-settings.js";
import { startAgent } from "../../src/agent/harness.js";
import type { AgentHandle, StartOptions } from "../../src/agent/harness.js";
import { MAIN_DEFAULT_TOOLS } from "../../src/bots/schema.js";
import type { FetchLike } from "../../src/proxy/health.js";
import { startFakeOpenAi } from "../helpers/fakeOpenAi.js";
import type { Behavior, FakeServer } from "../helpers/fakeOpenAi.js";
import { BOT_INFO, callbackUpdate, createFakeTelegram, textUpdate, waitFor } from "../telegram/helpers/fakeTelegram.js";
import type { FakeTelegram } from "../telegram/helpers/fakeTelegram.js";
import { LM_TOKEN, MODEL_ID, USER_ID, makeDirs, viaToolSearch, writeConfig } from "./rig.js";
import type { Card, Dirs } from "./rig.js";

export { USER_ID, waitFor, viaToolSearch, MODEL_ID, LM_TOKEN };

export const PROXY_KEY = "px-test-key-7f3a9c1e5b2d4a60";
export const MIRROR_TOKEN = "999999:MIRROR-test-token-aaaaaaaaaaaaaaaaaaaaaaaa";
export const RESEARCH_TOKEN = "222222:RESEARCH-test-token-bbbbbbbbbbbbbbbbbbbbbb";
export const OPS_TOKEN = "333333:OPS-test-token-cccccccccccccccccccccccccc";

export const PEER_ALLOW = ["tool_search", "read_file", "list_dir", "ask_user"];

export interface BotSpecInput {
  /** Overrides merged into the bot's block in `security.json`. */
  over?: Record<string, unknown>;
}

export interface Phase4RigOptions {
  /** The model of the local runner (every bot's brain unless a preset says otherwise). */
  behavior: Behavior;
  /** Bot blocks to add besides `main`; default `research`. */
  bots?: Record<string, Record<string, unknown>>;
  /** Overrides for the `main` block. */
  main?: Record<string, unknown>;
  /** Extra top-level `security.json` keys (`presets` are appended, the others replace). */
  security?: Record<string, unknown>;
  presets?: Record<string, unknown>[];
  /** A fake model server standing in for the proxy; the rig points acp presets at it. */
  proxyBehavior?: Behavior;
  secrets?: Record<string, unknown>;
  start?: Partial<StartOptions>;
  proxyFetch?: FetchLike;
  /** S27.1: point the local runner at another OpenAI-compatible server (the multi-bot eval's live gateway) instead of the built-in fake. */
  runner?: { baseUrl: string; apiKey?: string; modelId?: string; contextWindow?: number; maxTokens?: number; streamTimeoutMs?: number };
  mirrorApi?: { sendMessage: (chatId: number, text: string, o?: unknown) => Promise<unknown> };
}

export class Phase4Rig {
  readonly tgs = new Map<string, FakeTelegram>();
  agent!: AgentHandle;

  private constructor(
    readonly dirs: Dirs,
    readonly fake: FakeServer,
    readonly proxyFake: FakeServer | undefined,
    private readonly o: Phase4RigOptions,
  ) {}

  static async open(o: Phase4RigOptions): Promise<Phase4Rig> {
    const dirs = makeDirs();
    const fake = await startFakeOpenAi({ behavior: o.behavior, modelId: MODEL_ID, requireKey: LM_TOKEN });
    const proxyFake = o.proxyBehavior ? await startFakeOpenAi({ behavior: o.proxyBehavior, modelId: "codex/gpt-x", requireKey: PROXY_KEY }) : undefined;
    const rig = new Phase4Rig(dirs, fake, proxyFake, o);
    try {
      writeConfig(dirs, { baseUrl: o.runner?.baseUrl ?? fake.baseUrl, ...(o.runner ? { apiKey: o.runner.apiKey, ...(o.runner.modelId ? { modelId: o.runner.modelId } : {}), ...(o.runner.contextWindow ? { contextWindow: o.runner.contextWindow } : {}), ...(o.runner.maxTokens ? { maxTokens: o.runner.maxTokens } : {}), ...(o.runner.streamTimeoutMs ? { streamTimeoutMs: o.runner.streamTimeoutMs } : {}) } : {}), secrets: { botTokens: { research: RESEARCH_TOKEN, ops: OPS_TOKEN }, ...(proxyFake ? { proxyApiKey: PROXY_KEY } : {}), mirrorBotToken: MIRROR_TOKEN, ...(o.secrets ?? {}) } });
      mkdirSync(join(dirs.programData, "settings", "audit"), { recursive: true });
      const out: string[] = [];
      const code = await runMigration({ config: dirs.configPath, agentUser: "agent007", apply: true, rollback: false }, { out: (l) => void out.push(l), env: dirs.env, checkAcl: () => [] });
      if (code !== 0) throw new Error(`migration failed: ${out.join("\n")}`);
      rig.writeSecurity();
      await rig.start();
    } catch (e) {
      await rig.close();
      throw e;
    }
    return rig;
  }

  /** `security.json` with the `bots` block added to the migrated document. */
  private writeSecurity(): void {
    const file = join(this.dirs.programData, "settings", "security.json");
    const sec = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const extra = this.o.presets ?? [];
    const acp = this.proxyFake
      ? [{ id: "codex", kind: "acp", label: "Codex", providerId: "codex", baseUrl: this.proxyFake.baseUrl, apiKeyRef: "proxyApiKey", modelId: "codex/gpt-x", contextWindow: 100000, maxTokens: 4096, privacy: "cloud", autoFallback: true }]
      : [];
    sec["presets"] = [...(sec["presets"] as unknown[]), ...acp, ...extra];
    const base = (token: string, tools: string[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
      description: `the ${token} bot`,
      telegramTokenRef: token,
      route: { primary: "lmstudio", allowed: ["lmstudio"], fallback: [], onAuthRequired: "fallback" },
      tools,
      readRoots: [{ alias: "notes", path: this.dirs.notes }],
      cloudSafeRoots: [],
      shared: { read: false },
      edges: [],
      ...over,
    });
    const bots = this.o.bots ?? { research: {} };
    const doc: Record<string, unknown> = {
      main: base("main", [...MAIN_DEFAULT_TOOLS, "ask_bot", "list_bots"], { description: "the main bot", edges: [{ to: "research", allow: PEER_ALLOW, egress: false }], ...(this.o.main ?? {}) }),
    };
    for (const [id, over] of Object.entries(bots)) doc[id] = base(id, ["tool_search", "system_facts", "list_dir", "read_file", "search_files", "ask_user"], { description: `the ${id} bot`, ...over });
    sec["bots"] = doc;
    // no gap between asks: the tests send two asks a moment apart (the 5 s default is tested in test/botbus)
    sec["botBus"] = { edgeMinGapSec: 0 };
    for (const [k, v] of Object.entries(this.o.security ?? {})) sec[k] = v;
    writeFileSync(file, JSON.stringify(sec, null, 2));
  }

  tg(id: string): FakeTelegram {
    const t = this.tgs.get(id);
    if (!t) throw new Error(`no fake Telegram for bot ${id}`);
    return t;
  }

  /** The start options every start uses (also for a test that starts through `runMain`). */
  startOptions(): Partial<StartOptions> {
    return {
      env: this.dirs.env,
      gatePollMs: 50,
      healthIntervalMs: 3_600_000,
      multi: {
        bridgeFor: (ctx) => {
          const t = createFakeTelegram();
          this.tgs.set(ctx.spec.id, t);
          return { bot: t.bot, botInfo: BOT_INFO, options: { editIntervalMs: 60, retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 }, redeliverDelayMs: 100_000, stopWaitMs: 5000 } };
        },
        ...(this.o.proxyFetch ? { proxyFetch: this.o.proxyFetch } : {}),
        ...(this.o.mirrorApi ? { botRoomApi: this.o.mirrorApi as never } : {}),
      },
      ...(this.o.start ?? {}),
    };
  }

  async start(): Promise<void> {
    this.tgs.clear();
    this.agent = await startAgent({ configPath: this.dirs.configPath, secretsPath: this.dirs.secretsPath, checkAcl: false, ...this.startOptions() });
  }

  async close(): Promise<void> {
    await this.agent?.stop().catch(() => undefined);
    await this.fake.close().catch(() => undefined);
    await this.proxyFake?.close().catch(() => undefined);
  }

  clean(): void {
    rmSync(this.dirs.root, { recursive: true, force: true });
  }

  async say(bot: string, text: string, messageId: number): Promise<void> {
    await this.tg(bot).bot.handleUpdate(textUpdate(USER_ID, text, { messageId }) as never);
  }

  async tap(bot: string, data: string, fromId = USER_ID): Promise<void> {
    await this.tg(bot).bot.handleUpdate(callbackUpdate(fromId, data) as never);
  }

  cards(bot: string): Card[] {
    return this.tg(bot)
      .of("sendMessage")
      .filter((c) => !c.failed && c.payload["reply_markup"] !== undefined)
      .map((c) => {
        const kb = (c.payload["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0] ?? [];
        return { approve: kb[0]?.callback_data ?? "", deny: kb[1]?.callback_data ?? "", text: String(c.payload["text"]) };
      });
  }

  async card(bot: string, n = 1): Promise<Card> {
    await waitFor(() => this.cards(bot).length >= n, 20_000, `approval card ${n} of ${bot}`);
    return this.cards(bot)[n - 1] as Card;
  }

  texts(bot: string): string[] {
    return this.tg(bot).messageTexts().map((m) => m.text);
  }

  async seen(bot: string, pred: (t: string) => boolean, what: string, ms = 20_000): Promise<string> {
    let hit: string | undefined;
    await waitFor(
      () => {
        hit = this.texts(bot).find(pred);
        return hit !== undefined;
      },
      ms,
      what,
    );
    return hit as string;
  }

  /** The bus audit lines (`bus-YYYYMM.jsonl`). */
  busAudit(): Record<string, unknown>[] {
    const dir = join(this.dirs.data, "bus-audit");
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => /^bus-\d{6}\.jsonl$/.test(n)).sort();
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

  /** Every file under the data folder as text (logs, audit, bus audit) for a "the secret never appears" grep. */
  allOutputText(): string {
    const out: string[] = [];
    const walk = (d: string): void => {
      let names: string[] = [];
      try {
        names = readdirSync(d, { withFileTypes: true }).map((e) => e.name);
      } catch {
        return;
      }
      for (const n of names) {
        const p = join(d, n);
        try {
          if (/\.(jsonl|json|log|txt)$/.test(n)) out.push(readFileSync(p, "utf8"));
          else walk(p);
        } catch {
          walk(p);
        }
      }
    };
    walk(join(this.dirs.data, "logs"));
    walk(join(this.dirs.data, "audit"));
    walk(join(this.dirs.data, "bus-audit"));
    walk(join(this.dirs.data, "bots"));
    return out.join("\n");
  }
}
