/**
 * Stall-based wait for the S4 resumed run. A fixed ceiling cannot tell "still streaming" from "hung": the run fails only
 * when NO new progress (a new durable revision) is seen for `stallMs`, with `hardCapMs` as an absolute backstop.
 *
 * `progress()` returns a number that grows whenever the run commits something (S4 uses the row count of the SQLite
 * `document_revisions` table). Pure apart from the timers; the clock and the sleep are injectable for the offline test.
 */
export interface StallWaitOptions {
  /** Fail when `progress()` has not changed for this long. */
  stallMs: number;
  /** Fail after this long in total, progress or not. */
  hardCapMs: number;
  /** How often `progress()` is read. Default 1000. */
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface StallWaitStats {
  /** Longest time (ms) between two progress changes (or from the start to the first one / to the end). */
  longestStallMs: number;
  /** Number of distinct progress changes seen. */
  progressSteps: number;
  elapsedMs: number;
}

export class StallError extends Error {
  readonly kind: "stall" | "hardcap";
  readonly stats: StallWaitStats;
  constructor(kind: "stall" | "hardcap", label: string, o: StallWaitOptions, stats: StallWaitStats) {
    super(kind === "stall" ? `${label}: no progress for ${o.stallMs} ms (stalled after ${stats.elapsedMs} ms)` : `${label}: hard cap of ${o.hardCapMs} ms reached`);
    this.name = "StallError";
    this.kind = kind;
    this.stats = stats;
  }
}

export async function waitWithStall<T>(p: Promise<T>, progress: () => number, label: string, o: StallWaitOptions): Promise<{ value: T; stats: StallWaitStats }> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? 1000;
  const t0 = now();
  let last = safeProgress(progress, -1);
  let lastChange = t0;
  let longest = 0;
  let steps = 0;
  let settled = false;
  const outcome = p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  void outcome.then(() => {
    settled = true;
  });
  const stats = (): StallWaitStats => ({ longestStallMs: Math.max(longest, now() - lastChange), progressSteps: steps, elapsedMs: now() - t0 });
  for (;;) {
    const winner = await Promise.race([outcome, sleep(pollMs).then(() => undefined)]);
    if (winner !== undefined || settled) {
      const r = winner ?? (await outcome);
      const s = stats();
      if (r.ok) return { value: r.value, stats: s };
      throw r.error;
    }
    const t = now();
    const cur = safeProgress(progress, last);
    if (cur !== last) {
      longest = Math.max(longest, t - lastChange);
      last = cur;
      lastChange = t;
      steps++;
    }
    if (t - lastChange >= o.stallMs) throw new StallError("stall", label, o, stats());
    if (t - t0 >= o.hardCapMs) throw new StallError("hardcap", label, o, stats());
  }
}

function safeProgress(progress: () => number, fallback: number): number {
  try {
    return progress();
  } catch {
    return fallback; // a locked or missing file means "no information", not progress
  }
}
