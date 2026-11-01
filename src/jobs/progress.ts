/**
 * Job progress and the untrusted wrapper (S14.3 progress, S14.6).
 *
 * Everything a job produces (streamed text, tool calls and results, the final result, permission inputs, artifact lists,
 * transcript excerpts) is wrapped in `<untrusted_content source="job:<jobId>/<engine>">` before the local model sees it,
 * with the same 20 KB trim as the MCP wrapper (S10.5). Telegram progress messages show plain text to the user; the model
 * only ever gets the wrapped form.
 *
 * `ProgressAggregator` folds `JobEvent`s into one short status text. `ProgressPoster` posts it at most once per interval
 * (the UI-12 progress interval) and never throws: a failed post is logged and the next one tries again.
 */
import type { Logger } from "../contracts.js";
import type { Json, JobEvent, JobProgressUpdate, JobState, PermissionRequest } from "./contracts.js";
import { isTerminalJobState } from "./contracts.js";

/** Same trim as S10.5. */
export const MAX_UNTRUSTED_CHARS = 20_000;
export const TRIM_MARKER = "\n[... trimmed: the rest of this text was cut at 20 KB ...]";

function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1; // never end inside a surrogate pair
  return text.slice(0, end);
}

/** `job:<jobId>/<engine>`, with anything that could break the attribute removed. */
export function jobSource(jobId: string, engine: string): string {
  return `job:${jobId}/${engine}`.replace(/[^A-Za-z0-9_.:/-]/g, "_").slice(0, 200);
}

/** A tag lookalike inside job text is defused, so the text cannot close the wrapper or fake another one. */
export function defuseTags(text: string): string {
  return text.replace(/<(\s*)(\/?)(\s*)untrusted_content/gi, "<\\$2untrusted_content");
}

/**
 * Wraps job-originated text for the model: `<untrusted_content source="job:<jobId>/<engine>">...</untrusted_content>`.
 * Text over 20 KB is trimmed with a marker; a closing tag inside the text is defused.
 */
export function wrapJobText(jobId: string, engine: string, text: string, max: number = MAX_UNTRUSTED_CHARS): string {
  const trimmed = text.length > max ? cutAt(text, max) + TRIM_MARKER : text;
  return `<untrusted_content source="${jobSource(jobId, engine)}">\n${defuseTags(trimmed)}\n</untrusted_content>`;
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

function jsonText(v: Json | undefined, max: number): string {
  if (v === undefined) return "";
  try {
    return clip(typeof v === "string" ? v : JSON.stringify(v), max);
  } catch {
    return "";
  }
}

/** One line per event (plain text). Used for the user's progress message and, wrapped, for the model's excerpts. */
export function eventLine(e: JobEvent): string {
  switch (e.kind) {
    case "state":
      return `state: ${e.state}${e.detail ? ` (${clip(e.detail, 120)})` : ""}`;
    case "init":
      return `started${e.engineVersion ? ` (${clip(e.engineVersion, 60)})` : ""}`;
    case "text":
      return `text: ${clip(e.text, 200)}`;
    case "tool_call":
      return `tool ${e.tool}: ${jsonText(e.input, 160)}`;
    case "tool_result":
      return `result of ${e.tool}: ${e.ok ? "ok" : "failed"}${e.text ? ` ${clip(e.text, 160)}` : ""}`;
    case "progress":
      return `${clip(e.message, 200)}${e.fraction !== undefined ? ` (${Math.round(e.fraction * 100)}%)` : ""}`;
    case "retry":
      return `retry ${e.attempt}: ${clip(e.reason, 120)}`;
    case "flow_call":
      return `flow call ${e.tool}: max_credits ${e.maxCredits} ${e.allowed ? "allowed" : "blocked"} (charged ${e.chargedTotal}, ${e.remaining} left)`;
    case "result":
      return `result: ${clip(e.text, 200)}`;
  }
}

export interface AggregatorOptions {
  jobId: string;
  /** Shown on the status line (template title); defaults to the job id. */
  title?: string;
  /** How many recent lines the status message keeps. */
  recent?: number;
}

/** Folds events into the user's status text. Events at or below the last seen `seq` are ignored. */
export class ProgressAggregator {
  readonly jobId: string;
  state: JobState = "queued";
  lastSeq = 0;
  eventCount = 0;
  readonly #title: string;
  readonly #recentMax: number;
  readonly #recent: string[] = [];
  #fraction: number | undefined;

  constructor(opts: AggregatorOptions) {
    this.jobId = opts.jobId;
    this.#title = opts.title ?? opts.jobId;
    this.#recentMax = opts.recent ?? 6;
  }

  /** Returns true when the event was new. */
  apply(e: JobEvent): boolean {
    if (e.seq <= this.lastSeq) return false;
    this.lastSeq = e.seq;
    this.eventCount++;
    if (e.kind === "state") this.state = e.state;
    if (e.kind === "progress" && e.fraction !== undefined) this.#fraction = e.fraction;
    if (e.kind !== "state" && e.kind !== "init") {
      this.#recent.push(eventLine(e));
      while (this.#recent.length > this.#recentMax) this.#recent.shift();
    }
    return true;
  }

  get terminal(): boolean {
    return isTerminalJobState(this.state);
  }

  /** Plain text for Telegram. */
  text(): string {
    const lines = [`Job ${this.#title}: ${this.state}${this.#fraction !== undefined ? ` (${Math.round(this.#fraction * 100)}%)` : ""}`, `Events: ${this.eventCount}`];
    if (this.#recent.length > 0) {
      lines.push("Latest:");
      for (const l of this.#recent) lines.push(`- ${l}`);
    }
    return lines.join("\n");
  }

  update(conversationId: string): JobProgressUpdate {
    return { jobId: this.jobId, conversationId, state: this.state, text: this.text(), eventCount: this.eventCount };
  }
}

/** The last events as one wrapped block, for `job_status` (the model never gets this text unwrapped). */
export function wrapEventExcerpt(jobId: string, engine: string, events: readonly JobEvent[], max = 12): string {
  const tail = events.slice(-max);
  const body = tail.length === 0 ? "(no events yet)" : tail.map((e) => `#${e.seq} ${eventLine(e)}`).join("\n");
  return wrapJobText(jobId, engine, body);
}

/** A permission request as the model may see it: fixed fields outside the wrapper, job-supplied text inside. */
export function describePermissionForModel(req: PermissionRequest): string {
  const inside = [`tool: ${req.tool}`, `input: ${jsonText(req.input, 1500)}`, ...(req.summary ? [`summary: ${clip(req.summary, 300)}`] : [])].join("\n");
  return `Pending permission request ${req.requestId} (kind ${req.kind}, cwd ${req.cwd}):\n${wrapJobText(req.jobId, req.engine, inside)}`;
}

export interface ProgressPosterOptions {
  post: (update: JobProgressUpdate) => Promise<void>;
  /** Minimum time between two posts (UI-12 progress interval). */
  intervalMs: number;
  logger?: Logger | undefined;
  now?: (() => number) | undefined;
}

/**
 * Posts the newest update at most once per interval. A terminal update, or `flush()`, goes out at once. A newer update
 * replaces one that is still waiting for its slot.
 */
export class ProgressPoster {
  readonly #o: ProgressPosterOptions;
  readonly #now: () => number;
  #last = Number.NEGATIVE_INFINITY;
  #waiting: JobProgressUpdate | undefined;
  #timer: NodeJS.Timeout | undefined;
  #chain: Promise<void> = Promise.resolve();
  #disposed = false;
  posts = 0;

  constructor(opts: ProgressPosterOptions) {
    this.#o = opts;
    this.#now = opts.now ?? Date.now;
  }

  offer(update: JobProgressUpdate): void {
    if (this.#disposed) return;
    const force = isTerminalJobState(update.state);
    const wait = this.#last + this.#o.intervalMs - this.#now();
    if (force || wait <= 0) {
      this.#clearTimer();
      this.#waiting = undefined;
      this.#send(update);
      return;
    }
    this.#waiting = update;
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        const u = this.#waiting;
        this.#waiting = undefined;
        if (u && !this.#disposed) this.#send(u);
      }, wait);
      this.#timer.unref?.();
    }
  }

  /** Sends a waiting update now and resolves when every send so far is done. */
  async flush(): Promise<void> {
    this.#clearTimer();
    const u = this.#waiting;
    this.#waiting = undefined;
    if (u && !this.#disposed) this.#send(u);
    await this.#chain;
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimer();
    this.#waiting = undefined;
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #send(update: JobProgressUpdate): void {
    this.#last = this.#now();
    this.posts++;
    this.#chain = this.#chain.then(() =>
      this.#o.post(update).catch((e: unknown) => {
        this.#o.logger?.warn("jobs.progress_post_failed", { jobId: update.jobId, error: e instanceof Error ? e.name : "error" });
      }),
    );
  }
}
