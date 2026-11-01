/**
 * S7 (P0.4): does the durable retry cover a runner that is down at submit time?
 * A tiny local TCP proxy `127.0.0.1:1299 -> <runner host:port>` runs inside the script and the provider points at 1299.
 * The proxy starts DOWN; a request is submitted; the proxy is brought up after 90 s (default). Settings:
 * `retry: { enabled: true, maxRetries: <high>, baseDelayMs: 2000, maxAgentDelayMs: 60000 }`. The runner itself is never
 * touched: it must already be running (the proxy is the only thing that is down).
 * PASS: the run completes after the proxy comes up, without a manual resubmit. If retries do not cover connection
 * refused, FAIL with the observed behaviour; then S1.5 implements the health-gate fallback (plan section 7).
 */
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { checkRunnerReachable, failOutcome, finish, isMain, loadSmokeRunner, parseArgs, smokeOutDir, unreachableOutcome } from "./config.js";
import type { SmokeOutcome, SmokeRunnerConfig } from "./config.js";
import { ctx, describeSettled, errMessage, openRig, answerText, sleep } from "./common.js";

export interface S7Options {
  storageDir?: string;
  proxyPort?: number;
  /** How long the proxy stays down after the submit. Default 90 s. */
  downMs?: number;
  /** Extra time allowed after the proxy comes up. Default 180 s. */
  graceMs?: number;
  retry?: { maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number };
}

export interface TcpProxy {
  readonly port: number;
  close(): Promise<void>;
}

export function startTcpProxy(listenPort: number, targetHost: string, targetPort: number): Promise<TcpProxy> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server: Server = createServer((client) => {
      sockets.add(client);
      const upstream = connect(targetPort, targetHost);
      sockets.add(upstream);
      client.pipe(upstream);
      upstream.pipe(client);
      const drop = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on("error", drop);
      upstream.on("error", drop);
      client.on("close", drop);
      upstream.on("close", drop);
    });
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : listenPort,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

export async function run(cfg: SmokeRunnerConfig, opts: S7Options = {}): Promise<SmokeOutcome> {
  const reach = await checkRunnerReachable(cfg);
  if (!reach.reachable) return unreachableOutcome("S7", cfg, reach);
  const target = new URL(cfg.baseUrl);
  const targetPort = Number(target.port || 80);
  const proxyPort = opts.proxyPort ?? 1299;
  const downMs = opts.downMs ?? 90_000;
  const graceMs = opts.graceMs ?? 180_000;
  const retry = opts.retry ?? { maxRetries: 1000, baseDelayMs: 2000, maxAgentDelayMs: 60_000 };
  const path = join(opts.storageDir ?? join(smokeOutDir(), "s7"), "s7.sqlite");
  rmSync(path, { force: true });
  const viaProxy = `http://127.0.0.1:${proxyPort}${target.pathname}`;
  const details: Record<string, unknown> = { proxyPort, downMs, retry };

  const rig = await openRig({ storagePath: path, cfg, baseUrl: viaProxy, settings: { retry: { enabled: true, ...retry }, stream: { timeoutMs: 120_000 } } });
  let proxy: TcpProxy | undefined;
  const t0 = Date.now();
  try {
    const sub = await rig.root.submit({ type: "input", content: "Reply with exactly: PONG" }, ctx);
    let settledEarly = false;
    const waited = sub.wait(ctx).then((s) => {
      settledEarly = true;
      return s;
    });
    await sleep(downMs);
    const settledWhileDown = settledEarly;
    const status = await sub.status(ctx);
    details["statusBeforeProxyUp"] = { status: status.status };
    if (settledWhileDown) {
      const s = await waited;
      details["settledWhileDown"] = describeSettled(s);
      return { id: "S7", runner: cfg.runner, pass: false, reason: `the request settled (${s.status}) while the runner was down: retries do not cover connection-refused; use the health-gate fallback (S1.5)`, details };
    }
    proxy = await startTcpProxy(proxyPort, target.hostname, targetPort);
    const upAt = Date.now();
    const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), graceMs));
    const result = await Promise.race([waited, timer]);
    if (result === "timeout") {
      details["observed"] = `still ${(await sub.status(ctx)).status} ${graceMs} ms after the proxy came up`;
      return { id: "S7", runner: cfg.runner, pass: false, reason: `the run did not complete within ${graceMs} ms after the proxy came up (no automatic recovery); use the health-gate fallback (S1.5)`, details };
    }
    const text = await answerText(rig.root, result);
    Object.assign(details, { settled: describeSettled(result), answer: text.slice(0, 40), msToComplete: Date.now() - t0, msAfterProxyUp: Date.now() - upAt });
    const pass = result.status === "done" && text.trim() !== "";
    return {
      id: "S7",
      runner: cfg.runner,
      pass,
      reason: pass ? `completed ${Date.now() - upAt} ms after the proxy came up, with no manual resubmit` : `ended ${result.status}${result.status === "unanswered" ? ` (${result.reason})` : ""}: retries do not cover this failure; use the health-gate fallback (S1.5)`,
      details,
    };
  } catch (e) {
    return { id: "S7", runner: cfg.runner, pass: false, reason: errMessage(e), details };
  } finally {
    await proxy?.close();
    await rig.close().catch(() => undefined);
  }
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadSmokeRunner(args);
  try {
    const o: S7Options = {};
    if (typeof args.flags["down-ms"] === "string") o.downMs = Number(args.flags["down-ms"]);
    finish(await run(cfg, o));
  } catch (e) {
    finish(failOutcome("S7", cfg.runner, `unexpected error: ${errMessage(e)}`));
  }
}
