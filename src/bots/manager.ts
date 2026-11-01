/**
 * BotManager (S20.2, I30, U49, U50): owns every bot of the host. Each bot is a runtime made by a factory (a Pi `Harness` on its own
 * SQLite file with its own `resume()`, and one grammY `Bot` on its own token with its own `bot.start()`); the manager adds the rules
 * around them:
 *
 *   - a failed bot does not stop the others (each start, stop and failure is isolated and recorded as a status);
 *   - a 409 (a second poller on the token) is reported as "token in use elsewhere", at start or later from the long poll;
 *   - each runtime is given only its OWN token (the factory context has one `token`, never the secrets map), and a token that two
 *     bots resolve to is refused for the second bot (the loader already refuses two refs; this catches two refs with one value);
 *   - ONE kill switch for the host: the same handle goes to every runtime, so `/killshell` in any bot turns shell off in every bot;
 *   - one single-instance lock for the host (`lockPath`, or a `lock` the entry point already holds);
 *   - `/new`, `/stop` and `/status` are per bot because each runtime has its own bridge, conversations and Harness.
 *
 * Pure of Pi: the factory is injected (`createHarnessBotFactory` in `runtime.ts` is the real one; tests pass fakes).
 */
import type { KillSwitch, Logger } from "../contracts.js";
import type { Redactor } from "../logging/redact.js";
import { acquireLock } from "../runtime/lock.js";
import type { Lock, LockOptions } from "../runtime/lock.js";
import { isTokenInUse } from "../telegram/bot.js";
import type { PollingFailure } from "../telegram/bot.js";
import type { ResolvedBot } from "./schema.js";

export type BotState = "stopped" | "starting" | "running" | "failed";
export type BotFailure = "token_in_use" | "no_token" | "duplicate_token" | "not_migrated" | "error";

export interface BotStatus {
  id: string;
  state: BotState;
  reason?: BotFailure;
  /** A short redacted text for `/status` and the log; never a token. */
  detail?: string;
}

/** What a runtime offers the manager. */
export interface BotLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface BotRuntimeContext {
  spec: ResolvedBot;
  /** ONLY this bot's token. */
  token: string;
  /** The host's one kill switch (shared by every bot). */
  killSwitch: KillSwitch;
  /** The host logger with `bot: <id>` added to every line. */
  logger: Logger;
  /** The runtime calls this when its long poll fails after it had started (a 409 is `token_in_use`). */
  reportFailure(failure: PollingFailure): void;
}

export type BotFactory = (ctx: BotRuntimeContext) => Promise<BotLifecycle>;

export interface BotManagerOptions {
  bots: readonly ResolvedBot[];
  /** Resolves `telegramTokenRef` to a token (`botTokenFor` over the secrets). */
  tokenFor(ref: string): string | undefined;
  factory: BotFactory;
  killSwitch: KillSwitch;
  logger: Logger;
  redact?: Redactor;
  /** The host's single-instance lock file; the manager takes it in `start()` and releases it in `stop()`. */
  lockPath?: string;
  /** Test seam for the lock (pid, liveness). */
  lockOptions?: LockOptions;
  /** A lock the entry point already holds (the manager then does not take another). */
  lock?: Lock;
  /** A start-up check per bot; a returned text refuses that bot only (for example the `main` migration check). */
  preflight?: (bot: ResolvedBot) => string | undefined;
}

/** The host logger with a fixed `bot` field on every line. */
export function botLogger(base: Logger, id: string): Logger {
  const add = (fields?: object): object => ({ bot: id, ...(fields ?? {}) });
  return {
    debug: (e, f) => base.debug(e, add(f)),
    info: (e, f) => base.info(e, add(f)),
    warn: (e, f) => base.warn(e, add(f)),
    error: (e, f) => base.error(e, add(f)),
  };
}

export class BotManager {
  readonly #o: BotManagerOptions;
  readonly #status = new Map<string, BotStatus>();
  readonly #runtimes = new Map<string, BotLifecycle>();
  readonly #bots = new Map<string, ResolvedBot>();
  #lock: Lock | undefined;
  #hostLock = false;

  constructor(opts: BotManagerOptions) {
    this.#o = opts;
    for (const b of opts.bots) {
      this.#bots.set(b.id, b);
      this.#status.set(b.id, { id: b.id, state: "stopped" });
    }
  }

  ids(): string[] {
    return [...this.#bots.keys()];
  }

  /** The status of one bot, or of every bot. */
  status(): BotStatus[];
  status(id: string): BotStatus | undefined;
  status(id?: string): BotStatus[] | BotStatus | undefined {
    if (id !== undefined) {
      const s = this.#status.get(id);
      return s ? { ...s } : undefined;
    }
    return [...this.#status.values()].map((s) => ({ ...s }));
  }

  /** The running runtime of a bot (for the host wiring and tests). */
  runtime(id: string): BotLifecycle | undefined {
    return this.#runtimes.get(id);
  }

  running(): string[] {
    return [...this.#status.values()].filter((s) => s.state === "running").map((s) => s.id);
  }

  /** Takes the host lock (throws `LockHeldError` when another agent holds it), then starts every bot; a failing bot does not stop the others. */
  async start(): Promise<BotStatus[]> {
    if (!this.#lock) {
      if (this.#o.lock) {
        this.#lock = this.#o.lock;
        this.#hostLock = true;
      } else if (this.#o.lockPath) this.#lock = acquireLock(this.#o.lockPath, this.#o.lockOptions);
    }
    // A token that two bots resolve to goes to the first bot only.
    const owner = new Map<string, string>();
    const duplicates = new Set<string>();
    for (const b of this.#bots.values()) {
      const tok = this.#o.tokenFor(b.telegramTokenRef);
      if (tok === undefined) continue;
      const prev = owner.get(tok);
      if (prev !== undefined) duplicates.add(b.id);
      else owner.set(tok, b.id);
    }
    await Promise.allSettled([...this.#bots.values()].map((b) => this.#startOne(b, duplicates.has(b.id))));
    return this.status();
  }

  /** Starts (or restarts) one bot. */
  async startBot(id: string): Promise<BotStatus> {
    const b = this.#bots.get(id);
    if (!b) throw new Error(`unknown bot "${id}"`);
    if (this.#status.get(id)?.state === "running") return this.status(id) as BotStatus;
    await this.#startOne(b, false);
    return this.status(id) as BotStatus;
  }

  /** Stops one bot; the others keep running. */
  async stopBot(id: string): Promise<void> {
    const rt = this.#runtimes.get(id);
    this.#runtimes.delete(id);
    this.#status.set(id, { id, state: "stopped" });
    if (!rt) return;
    try {
      await rt.stop();
    } catch (e) {
      this.#o.logger.warn("bots.stop_failed", { bot: id, error: this.#text(e) });
    }
  }

  /** Stops every bot (each failure is logged, none stops the others) and releases the lock. */
  async stop(): Promise<void> {
    await Promise.allSettled([...this.#runtimes.keys()].map((id) => this.stopBot(id)));
    if (this.#lock && !this.#hostLock) this.#lock.release();
    this.#lock = undefined;
    this.#hostLock = false;
  }

  /** `/killshell` in any bot: one flag, so shell is off in every bot. */
  async engageKillSwitch(by: string): Promise<void> {
    await this.#o.killSwitch.turnOn(by);
  }

  #text(e: unknown): string {
    const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return (this.#o.redact ? this.#o.redact(raw) : raw).slice(0, 300);
  }

  #fail(id: string, reason: BotFailure, detail: string): void {
    this.#status.set(id, { id, state: "failed", reason, detail });
    this.#o.logger.error("bots.bot_failed", { bot: id, reason, detail });
  }

  async #startOne(bot: ResolvedBot, duplicate: boolean): Promise<void> {
    const id = bot.id;
    if (duplicate) return this.#fail(id, "duplicate_token", "another bot already uses this token; it was not started");
    const problem = this.#o.preflight?.(bot);
    if (problem) return this.#fail(id, "not_migrated", problem);
    const token = this.#o.tokenFor(bot.telegramTokenRef);
    if (token === undefined || token === "") return this.#fail(id, "no_token", `no token for the reference "${bot.telegramTokenRef}" in secrets.json`);
    this.#status.set(id, { id, state: "starting" });
    let rt: BotLifecycle | undefined;
    try {
      rt = await this.#o.factory({
        spec: bot,
        token,
        killSwitch: this.#o.killSwitch,
        logger: botLogger(this.#o.logger, id),
        reportFailure: (f) => {
          if (this.#status.get(id)?.state === "stopped") return;
          if (f.kind === "token_in_use") this.#fail(id, "token_in_use", "token in use elsewhere: another process is polling this bot's token");
          else this.#fail(id, "error", this.#text(f.error));
        },
      });
      this.#runtimes.set(id, rt);
      await rt.start();
      if (this.#status.get(id)?.state === "starting") this.#status.set(id, { id, state: "running" });
      this.#o.logger.info("bots.bot_started", { bot: id });
    } catch (e) {
      this.#runtimes.delete(id);
      if (rt) await rt.stop().catch(() => undefined);
      if (isTokenInUse(e)) this.#fail(id, "token_in_use", "token in use elsewhere: another process is polling this bot's token");
      else this.#fail(id, "error", this.#text(e));
    }
  }
}
