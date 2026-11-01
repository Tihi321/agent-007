/**
 * A real Pi Harness (SQLite file) over a fake OpenAI-compatible runner, plus the Telegram bridge over a fake
 * Telegram API. Used by the bridge tests; "restart" = stop the bridge, close the Harness, reopen the same file.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, Harness, createRegistry, createRunnerModels, openNodeSqliteStorage } from "../../../src/pi/adapter.js";
import { createTelegramBridge } from "../../../src/telegram/bot.js";
import type { TelegramBridge, TelegramBridgeOptions } from "../../../src/telegram/bot.js";
import type { HealthLike } from "../../../src/telegram/offline.js";
import { createFakeTelegram, fakeKillSwitch, memoryLogger } from "./fakeTelegram.js";
import type { FakeTelegram } from "./fakeTelegram.js";
import { startFakeOpenAi } from "../../helpers/fakeOpenAi.js";
import type { Behavior, FakeServer } from "../../helpers/fakeOpenAi.js";

export const MODEL_ID = "fake-model";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "a7-tg-"));
}

export const echoBehavior: Behavior = ({ lastUser }) => ({ type: "text", text: `echo: ${lastUser}` });

export interface Rig {
  dir: string;
  fake: FakeServer;
  tg: FakeTelegram;
  harness: Harness;
  bridge: TelegramBridge;
  log: ReturnType<typeof memoryLogger>;
  killSwitch: ReturnType<typeof fakeKillSwitch>;
  /** Stop the bridge and close the Harness (a restart's first half). */
  shutdown(): Promise<void>;
}

export interface RigOptions {
  dir?: string;
  fake?: FakeServer;
  tg?: FakeTelegram;
  health?: HealthLike;
  bridge?: Partial<TelegramBridgeOptions>;
  /** Do not call `attach`/`start` (tests that drive pieces by hand). */
  noStart?: boolean;
  allowedUserIds?: number[];
}

export async function openRig(o: RigOptions = {}): Promise<Rig> {
  const dir = o.dir ?? tempDir();
  const fake = o.fake ?? (await startFakeOpenAi({ behavior: echoBehavior, modelId: MODEL_ID }));
  const tg = o.tg ?? createFakeTelegram();
  const log = memoryLogger();
  const killSwitch = fakeKillSwitch();
  const { models } = createRunnerModels({ id: "lmstudio", baseUrl: fake.baseUrl, modelId: MODEL_ID, apiKey: "k", contextWindow: 8192, maxTokens: 512 });
  const storage = await openNodeSqliteStorage(join(dir, "agent.sqlite"));
  const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { stream: { timeoutMs: 20_000 } } }, BACKGROUND_CONTEXT);
  harness.resume();
  const bridge = createTelegramBridge({
    bot: tg.bot,
    allowedUserIds: o.allowedUserIds ?? [4242],
    logger: log,
    runner: { name: "lmstudio", modelId: MODEL_ID },
    modelRef: { provider: "lmstudio", modelId: MODEL_ID },
    health: o.health,
    killSwitch,
    killFlagPath: "C:\\test\\killshell.flag",
    shellEnabled: true,
    editIntervalMs: 60,
    retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    redeliverDelayMs: 100_000,
    stopWaitMs: 5000,
    ...o.bridge,
  });
  let down = false;
  const shutdown = async () => {
    if (down) return;
    down = true;
    await bridge.stop();
    await harness.close(BACKGROUND_CONTEXT);
  };
  if (!o.noStart) {
    await bridge.attach(harness);
    await bridge.start();
  }
  return { dir, fake, tg, harness, bridge, log, killSwitch, shutdown };
}
