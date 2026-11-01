/**
 * S6 (P0.4): stream timeout versus time to first token (TTFT) on large prompts.
 * With the model to be used loaded (LM Studio: the slower candidate; Strata: its model), send (a) a ~10K-token and
 * (b) a ~60K-token prompt, once with `settings.stream.timeoutMs = 5000` and once with `600000`
 * (`ConversationStreamOptions.timeoutMs`). TTFT is measured with a raw streaming request; the Harness runs show the
 * failure mode and retry behaviour at 5 s and the success at 600 s.
 * Strata variant (b2): a short request is sent while a 60K request is still running, to measure the FIFO queue wait.
 * PASS: the large value succeeds on the 60K prompt and the behaviour is documented. The result recommends a value of
 * at least 3x the observed 60K TTFT (on Strata, 3x (60K TTFT + the queued wait)).
 * Slow by design: the large prompts really are prefilled.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { checkRunnerReachable, failOutcome, finish, isMain, loadSmokeRunner, parseArgs, smokeOutDir, unreachableOutcome } from "./config.js";
import type { SmokeOutcome, SmokeRunnerConfig } from "./config.js";
import { ask, describeSettled, errMessage, openRig } from "./common.js";
import { withTimeout } from "./s2-roundtrip.js";
import { describeFetchError } from "../../src/runtime/health.js";

export interface S6Options {
  storageDir?: string;
  smallTokens?: number;
  largeTokens?: number;
  shortTimeoutMs?: number;
  longTimeoutMs?: number;
  /** Run the Strata FIFO queue measurement (default: only when the runner is strata). */
  queueTest?: boolean;
}

/** Deterministic filler of roughly `tokens` tokens (about 15 tokens per line), ending with the instruction. */
export function buildPrompt(tokens: number, needle = "S6-NEEDLE-4471"): string {
  const lines: string[] = [`Remember this code word: ${needle}.`];
  const n = Math.max(1, Math.round(tokens / 15));
  for (let i = 0; i < n; i++) lines.push(`Line ${i}: the quick brown fox jumps over the lazy dog ${(i * 7919) % 10007} times near gate ${(i * 31) % 97}.`);
  lines.push("Ignore everything above and reply with exactly: OK");
  return lines.join("\n");
}

export interface RawStreamResult {
  ok: boolean;
  status?: number;
  ttftMs?: number;
  totalMs: number;
  error?: string;
}

/** One raw streaming chat request; TTFT = time to the first SSE `data:` event. */
export async function rawStream(cfg: SmokeRunnerConfig, prompt: string, timeoutMs: number): Promise<RawStreamResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.modelId, messages: [{ role: "user", content: prompt }], max_tokens: 8, stream: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !res.body) return { ok: false, status: res.status, totalMs: Date.now() - t0, error: `HTTP ${res.status}` };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let ttft: number | undefined;
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (ttft === undefined && /(^|\n)data: /.test(buf)) ttft = Date.now() - t0;
    }
    const out: RawStreamResult = { ok: true, status: res.status, totalMs: Date.now() - t0 };
    if (ttft !== undefined) out.ttftMs = ttft;
    return out;
  } catch (e) {
    return { ok: false, totalMs: Date.now() - t0, error: describeFetchError(e) };
  }
}

async function harnessRun(cfg: SmokeRunnerConfig, path: string, prompt: string, timeoutMs: number, retry: { enabled: boolean; maxRetries?: number; baseDelayMs?: number }) {
  rmSync(path, { force: true });
  const rig = await openRig({ storagePath: path, cfg, settings: { stream: { timeoutMs }, retry } });
  const t0 = Date.now();
  try {
    const out = await withTimeout(ask(rig.root, prompt), timeoutMs * 4 + 60_000, `harness run (timeout ${timeoutMs})`);
    return { ...describeSettled(out.settled), ms: Date.now() - t0, answer: out.text.slice(0, 40) };
  } catch (e) {
    return { status: "threw", error: errMessage(e), ms: Date.now() - t0 };
  } finally {
    await rig.close().catch(() => undefined);
  }
}

export async function run(cfg: SmokeRunnerConfig, opts: S6Options = {}): Promise<SmokeOutcome> {
  const reach = await checkRunnerReachable(cfg);
  if (!reach.reachable) return unreachableOutcome("S6", cfg, reach);
  const dir = opts.storageDir ?? join(smokeOutDir(), "s6");
  const small = buildPrompt(opts.smallTokens ?? 10_000);
  const large = buildPrompt(opts.largeTokens ?? 60_000);
  const shortMs = opts.shortTimeoutMs ?? 5000;
  const longMs = opts.longTimeoutMs ?? 600_000;
  const details: Record<string, unknown> = { promptTokensApprox: { small: opts.smallTokens ?? 10_000, large: opts.largeTokens ?? 60_000 }, shortTimeoutMs: shortMs, longTimeoutMs: longMs };

  const rawSmall = await rawStream(cfg, small, longMs);
  const rawLarge = await rawStream(cfg, large, longMs);
  details["ttft"] = { small: rawSmall, large: rawLarge };

  let queuedWaitMs = 0;
  if (opts.queueTest ?? cfg.runner === "strata") {
    // b2: a short request issued while a 60K request is still being prefilled waits behind it (Strata FIFO)
    const longReq = rawStream(cfg, large, longMs);
    await new Promise((r) => setTimeout(r, 2000));
    const shortReq = await rawStream(cfg, "Say OK", longMs);
    await longReq;
    queuedWaitMs = shortReq.totalMs;
    details["queue"] = { shortRequestTotalMs: shortReq.totalMs, shortRequestTtftMs: shortReq.ttftMs, note: "latency of a tiny request sent 2 s after a 60K request started; on a FIFO runner this is the queued wait (U28)" };
  }

  details["harness"] = {
    large_at_short_timeout: await harnessRun(cfg, join(dir, "large-short.sqlite"), large, shortMs, { enabled: true, maxRetries: 1, baseDelayMs: 500 }),
    small_at_long_timeout: await harnessRun(cfg, join(dir, "small-long.sqlite"), small, longMs, { enabled: true, maxRetries: 0 }),
    large_at_long_timeout: await harnessRun(cfg, join(dir, "large-long.sqlite"), large, longMs, { enabled: true, maxRetries: 0 }),
  };
  const largeLong = (details["harness"] as Record<string, { status: string }>)["large_at_long_timeout"];
  const ttft60 = rawLarge.ttftMs ?? rawLarge.totalMs;
  const rec = Math.max(120_000, Math.ceil((3 * (ttft60 + queuedWaitMs)) / 30_000) * 30_000);
  details["recommendedStreamTimeoutMs"] = rec;
  details["recommendationRule"] = cfg.runner === "strata" ? "3x (60K TTFT + queued wait), rounded up to 30 s, at least 120 s" : "3x the 60K TTFT, rounded up to 30 s, at least 120 s";
  const pass = largeLong?.status === "done" && rawLarge.ok;
  return {
    id: "S6",
    runner: cfg.runner,
    pass,
    reason: pass ? `60K prompt answered at the ${longMs} ms timeout (TTFT ${rawLarge.ttftMs ?? "?"} ms); recommended stream.timeoutMs >= ${rec}` : `60K prompt did not succeed at the ${longMs} ms timeout (${largeLong?.status ?? "no result"}; raw: ${rawLarge.error ?? "ok"})`,
    details,
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadSmokeRunner(args);
  try {
    finish(await run(cfg));
  } catch (e) {
    finish(failOutcome("S6", cfg.runner, `unexpected error: ${errMessage(e)}`));
  }
}
