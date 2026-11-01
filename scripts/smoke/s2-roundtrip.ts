/**
 * S2 (P0.4): model round trip through the real Harness and pi-ai request shape.
 * Provider for the configured runner (plan 4.5); root conversation; submit "Reply with exactly: PONG"; wait.
 * PASS: the answer contains PONG within 180 s.
 *  - LM Studio with a token: a run with a deliberately wrong token must fail with an auth error.
 *  - Strata without a key (the P0.3b manual test): the negative run is skipped; the result records `auth: none`.
 *  - Strata with a key (24/7 config): the wrong-key run AND a no-key run must both fail (U29).
 * It also records raw HTTP evidence for U20/U21/U29: how the runner treats a `developer` message, the
 * `max_completion_tokens` field, `stream_options.include_usage`, and what /health and /v1/models return without a key.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { checkRunnerReachable, failOutcome, finish, isMain, loadSmokeRunner, parseArgs, smokeOutDir, unreachableOutcome } from "./config.js";
import type { SmokeOutcome, SmokeRunnerConfig } from "./config.js";
import { ask, describeSettled, errMessage, openRig } from "./common.js";
import { describeFetchError } from "../../src/runtime/health.js";

export interface S2Options {
  /** Overall wait for the positive run. Default 180 s. */
  timeoutMs?: number;
  /** Wait for each negative run. Default 60 s. */
  negativeTimeoutMs?: number;
  storageDir?: string;
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}

interface RawProbe {
  name: string;
  status?: number;
  error?: string;
  note?: string;
}

async function rawPost(cfg: SmokeRunnerConfig, name: string, body: unknown, key: string | undefined): Promise<RawProbe> {
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    const out: RawProbe = { name, status: res.status };
    if (!res.ok) out.note = text.slice(0, 160);
    return out;
  } catch (e) {
    return { name, error: describeFetchError(e) };
  }
}

async function rawGet(cfg: SmokeRunnerConfig, name: string, url: string, key: string | undefined): Promise<RawProbe> {
  try {
    const res = await fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15_000) });
    await res.arrayBuffer().catch(() => undefined);
    return { name, status: res.status };
  } catch (e) {
    return { name, error: describeFetchError(e) };
  }
}

async function rawProbes(cfg: SmokeRunnerConfig): Promise<RawProbe[]> {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const origin = new URL(cfg.baseUrl).origin;
  const tiny = { model: cfg.modelId, messages: [{ role: "user", content: "Say OK" }], max_tokens: 8 };
  const probes: RawProbe[] = [];
  // U29: auth enforcement. Without a configured key these just record what an unauthenticated caller sees.
  probes.push(await rawGet(cfg, "GET /v1/models, no key", `${base}/models`, undefined));
  probes.push(await rawGet(cfg, "GET /health, no key", `${origin}/health`, undefined));
  probes.push(await rawPost(cfg, "POST chat/completions, no key", tiny, undefined));
  probes.push(await rawPost(cfg, "POST chat/completions, wrong key", tiny, "wrong-key-for-s2"));
  // U20: compat evidence, sent with the real key.
  probes.push(await rawPost(cfg, "developer role accepted?", { ...tiny, messages: [{ role: "developer", content: "Be brief." }, { role: "user", content: "Say OK" }] }, cfg.apiKey));
  probes.push(await rawPost(cfg, "max_completion_tokens accepted?", { model: cfg.modelId, messages: tiny.messages, max_completion_tokens: 8 }, cfg.apiKey));
  probes.push(await rawPost(cfg, "stream_options.include_usage accepted?", { ...tiny, stream: true, stream_options: { include_usage: true } }, cfg.apiKey));
  return probes;
}

export async function run(cfg: SmokeRunnerConfig, opts: S2Options = {}): Promise<SmokeOutcome> {
  const reach = await checkRunnerReachable(cfg);
  if (!reach.reachable) return unreachableOutcome("S2", cfg, reach);

  const dir = opts.storageDir ?? join(smokeOutDir(), "s2");
  const timeout = opts.timeoutMs ?? 180_000;
  const negTimeout = opts.negativeTimeoutMs ?? 60_000;
  const details: Record<string, unknown> = {
    auth: cfg.apiKey ? "api-key" : "none",
    authShape: "provider auth resolve() -> { auth: { apiKey } } (U1 first choice). Keyless: the README shape { auth: {} } throws \"No API key for provider\" at 1.4.0, so the adapter sends a placeholder bearer value (U21).",
    compatFlags: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens", ...(cfg.compat ?? {}) },
  };

  // positive run
  const posPath = join(dir, "positive.sqlite");
  rmSync(posPath, { force: true });
  let pos;
  const rig = await openRig({ storagePath: posPath, cfg, settings: { stream: { timeoutMs: timeout } } });
  try {
    pos = await withTimeout(ask(rig.root, "Reply with exactly: PONG"), timeout, "positive run");
  } catch (e) {
    await rig.close().catch(() => undefined);
    return { id: "S2", runner: cfg.runner, pass: false, reason: `positive run failed: ${errMessage(e)}`, details };
  }
  await rig.close();
  const gotPong = pos.settled.status === "done" && /PONG/.test(pos.text);
  details["positive"] = { ...describeSettled(pos.settled), answer: pos.text.slice(0, 80), ms: pos.ms };
  if (!gotPong) return { id: "S2", runner: cfg.runner, pass: false, reason: `positive run did not answer PONG (status ${pos.settled.status}${pos.settled.status === "unanswered" ? `, ${pos.settled.reason}` : ""})`, details };

  // negative runs
  const negatives: { name: string; failed: boolean; note: string }[] = [];
  const runNegative = async (name: string, key: string | null): Promise<void> => {
    const p = join(dir, `negative-${name.replace(/\W+/g, "-")}.sqlite`);
    rmSync(p, { force: true });
    const r = await openRig({ storagePath: p, cfg, apiKeyOverride: key, settings: { retry: { enabled: false }, stream: { timeoutMs: negTimeout } } });
    try {
      const out = await withTimeout(ask(r.root, "Reply with exactly: PONG"), negTimeout, `${name} run`);
      negatives.push({ name, failed: out.settled.status !== "done", note: JSON.stringify(describeSettled(out.settled)).slice(0, 300) });
    } catch (e) {
      negatives.push({ name, failed: true, note: `threw: ${errMessage(e)}` });
    } finally {
      await r.close().catch(() => undefined);
    }
  };

  const failures: string[] = [];
  if (cfg.apiKey) {
    await runNegative("wrong-key", "wrong-key-for-s2");
    if (cfg.runner === "strata") await runNegative("no-key", null);
    for (const n of negatives) if (!n.failed) failures.push(`${n.name} run was ACCEPTED (auth is not enforced)`);
  } else {
    details["negativeRuns"] = cfg.runner === "strata" ? "skipped: Strata without a key (P0.3b manual test); the no-auth shape was accepted [U21]" : "skipped: no LM Studio token in the dev secrets, so auth cannot be proved";
    if (cfg.runner === "lmstudio") failures.push("no LM Studio token configured: auth enforcement not proved");
  }
  details["negatives"] = negatives;
  details["raw"] = await rawProbes(cfg);
  details["live"] = "result of a real run against the runner above";

  const pass = failures.length === 0;
  return {
    id: "S2",
    runner: cfg.runner,
    pass,
    reason: pass ? `answered PONG in ${pos.ms} ms; auth ${cfg.apiKey ? "enforced (wrong/no-key runs failed)" : "none"}` : failures.join("; "),
    details,
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadSmokeRunner(args);
  try {
    finish(await run(cfg));
  } catch (e) {
    finish(failOutcome("S2", cfg.runner, `unexpected error: ${errMessage(e)}`));
  }
}
