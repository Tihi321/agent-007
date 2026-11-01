/**
 * "Model offline, queued" UX (S4.6, option A of plan 4.4). When the runner health goes `down`, each chat that has
 * an in-flight message gets ONE notice per outage; a chat that sends a message during the outage gets one too.
 * Nothing repeats within the outage, and a recovery clears the memory. A slow answer because Strata is busy with
 * another sequence is not an outage: the health monitor reports that as UP, so nothing is sent.
 */
import type { Api } from "grammy";
import type { Logger } from "../contracts.js";
import type { RunnerName } from "../config/schema.js";
import type { HealthStatus } from "../runtime/health.js";

export interface HealthLike {
  status(): HealthStatus;
  onChange(cb: (s: HealthStatus) => void): void;
}

export function runnerLabel(runner: RunnerName): string {
  return runner === "strata" ? "Strata" : "LM Studio";
}

export function offlineNotice(runner: RunnerName): string {
  return `The model is offline (${runnerLabel(runner)} not running). Your message is queued and will be answered when it is back.`;
}

export interface OfflineNotifierOptions {
  api: Pick<Api, "sendMessage">;
  health: HealthLike;
  runner: RunnerName;
  /** Chats with a message in flight (delivery not finished). */
  inFlightChats: () => number[];
  logger: Logger;
}

export class OfflineNotifier {
  readonly #o: OfflineNotifierOptions;
  readonly #notified = new Set<number>();
  #down = false;

  constructor(opts: OfflineNotifierOptions) {
    this.#o = opts;
    this.#down = isDown(opts.health.status());
    opts.health.onChange((s) => {
      const down = isDown(s);
      if (down && !this.#down) {
        this.#down = true;
        this.#notified.clear();
        for (const chatId of this.#o.inFlightChats()) void this.#notify(chatId);
      } else if (!down && this.#down) {
        this.#down = false;
        this.#notified.clear();
      }
    });
  }

  /** Call after a message has been admitted for `chatId`. */
  noteMessage(chatId: number): void {
    if (!this.#down) this.#down = isDown(this.#o.health.status());
    if (this.#down) void this.#notify(chatId);
  }

  async #notify(chatId: number): Promise<void> {
    if (this.#notified.has(chatId)) return;
    this.#notified.add(chatId);
    try {
      await this.#o.api.sendMessage(chatId, offlineNotice(this.#o.runner));
    } catch (e) {
      this.#notified.delete(chatId);
      this.#o.logger.warn("telegram.offline_notice_failed", { chatId, error: (e as Error).name });
    }
  }
}

/** Down only after the first probe: "not checked yet" is not an outage. */
function isDown(s: HealthStatus): boolean {
  return s.lastCheckedAt > 0 && !s.up;
}
