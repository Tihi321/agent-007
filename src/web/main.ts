/**
 * Entry point of the web gateway (S36): `node dist/src/web/main.js [--config <path>] [--secrets <path>] [--mode local|tailnet] [--port 47009]
 * [--public-host <name>.<tailnet>.ts.net] [--skip-acl-check]`.
 *
 * Deviation from UI-35 (recorded in the plan): the gateway runs as its own process of the agent user, not inside the Telegram agent
 * process. The chat engine talks to the model endpoints directly and does not need the Pi Harness, so nothing of the owner's runtime is
 * shared with it; the kill switch is coupled through the flag file.
 *
 *   local   (L1)  loopback only, no Tailscale needed. The owner claims the account at http://localhost:47009/claim.
 *   tailnet (L2)  needs `tailscale serve` pointing at this port; refuses to start if a Funnel entry exists, the CLI is missing, the
 *                 version is too old, or the clock is off. Identity headers are trusted only after `tailscale whois` agrees.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { derivedPresets } from "../agent/multibot.js";
import { parseBots, termsOf } from "../bots/schema.js";
import type { PresetConfig, TermsAccepted } from "../bots/schema.js";
import { loadConfig } from "../config/load.js";
import type { Config } from "../config/schema.js";
import { loadSecrets, secretValues } from "../config/secrets.js";
import type { Secrets } from "../config/secrets.js";
import { composeRawConfig } from "../settings/load.js";
import { parseConfig } from "../config/schema.js";
import { createRedactor } from "../logging/redact.js";
import { DEFAULT_PROXY_PORT, ProxyStatus, fetchHealth, proxyEndpoint } from "../proxy/health.js";
import { startWebApp } from "./app.js";
import type { WebApp } from "./app.js";
import { createWebAudit } from "./audit.js";
import { createOpenAiEngine } from "./chat/openaiEngine.js";
import type { ModelEndpoint } from "./chat/openaiEngine.js";
import { webPaths } from "./paths.js";
import { GATEWAY_PORT, MIN_TAILSCALE_VERSION, cliWhois, meetsMinVersion } from "./tailscale.js";

export interface WebCli {
  configPath: string;
  secretsPath: string;
  mode: "local" | "tailnet";
  port: number;
  publicHost: string;
  checkAcl: boolean;
  tailscale: string;
}

export function parseWebCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): WebCli {
  const pd = env["ProgramData"] ?? env["PROGRAMDATA"] ?? "C:\\ProgramData";
  const cli: WebCli = { configPath: env["AGENT007_CONFIG"] ?? `${pd}\\agent-007\\config\\config.json`, secretsPath: env["AGENT007_SECRETS"] ?? `${pd}\\agent-007\\secrets\\secrets.json`, mode: "local", port: GATEWAY_PORT, publicHost: "", checkAcl: true, tailscale: "tailscale" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const v = (): string => {
      const n = argv[++i];
      if (n === undefined || n.startsWith("--")) throw new Error(`${a} needs a value`);
      return n;
    };
    if (a === "--config") cli.configPath = v();
    else if (a === "--secrets") cli.secretsPath = v();
    else if (a === "--mode") {
      const m = v();
      if (m !== "local" && m !== "tailnet") throw new Error("--mode must be local or tailnet");
      cli.mode = m;
    } else if (a === "--port") cli.port = Number(v());
    else if (a === "--public-host") cli.publicHost = v().toLowerCase();
    else if (a === "--tailscale") cli.tailscale = v();
    else if (a === "--skip-acl-check") cli.checkAcl = false;
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (!Number.isInteger(cli.port) || cli.port < 1 || cli.port > 65535) throw new Error("--port must be 1 to 65535");
  if (cli.mode === "tailnet" && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(cli.publicHost)) throw new Error("tailnet mode needs --public-host <name>.<tailnet>.ts.net");
  return cli;
}

/** Where each preset is reached: local presets at their runner's URL, proxy presets at the proxy URL with the proxy key. */
export function endpointResolver(config: Pick<Config, "model">, secrets: Pick<Secrets, "lmStudioApiToken" | "strataApiKey" | "proxyApiKey">, presets: readonly PresetConfig[]): (id: string) => ModelEndpoint | undefined {
  return (id) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return undefined;
    if (p.kind === "acp") {
      if (!p.baseUrl) return undefined;
      return { baseUrl: p.baseUrl, apiKey: secrets.proxyApiKey, modelId: p.modelId, maxTokens: p.maxTokens, viaProxy: true, providerId: p.providerId, label: p.label };
    }
    const runner = p.runner ? (config.model.runners as Record<string, { baseUrl: string } | undefined>)[p.runner] : undefined;
    if (!runner) return undefined;
    const apiKey = p.runner === "lmstudio" ? secrets.lmStudioApiToken : p.runner === "strata" ? secrets.strataApiKey : undefined;
    return { baseUrl: runner.baseUrl, apiKey, modelId: p.modelId, maxTokens: p.maxTokens, viaProxy: false, label: p.label };
  };
}

function run(file: string, args: string[], timeoutMs = 10_000): Promise<string | undefined> {
  return new Promise((res) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => res(err ? undefined : String(stdout)));
  });
}

/** Seconds of difference between this clock and the HTTP `Date` of Tailscale's own control server (read-only, no login, one request). */
async function clockSkew(fetchFn: typeof fetch = fetch): Promise<number | undefined> {
  try {
    const res = await fetchFn("https://controlplane.tailscale.com/key?v=1", { method: "HEAD", signal: AbortSignal.timeout(8000) });
    const d = res.headers.get("date");
    return d ? Date.parse(d) - Date.now() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * L7: re-reads the proxy health at once when a chat turn meets a login problem or a 503, not only on the 60 s poll, so a fixed login (or
 * a switch to an API key, which must be refused) shows up on the next turn. At most one check runs at a time and at most one per `minGapMs`.
 */
export function proxyRefresher(check: () => Promise<void>, o: { minGapMs?: number; now?: () => number } = {}): { refresh(): Promise<void> | undefined } {
  const gap = o.minGapMs ?? 5000;
  const now = o.now ?? Date.now;
  let last = -Infinity;
  let running: Promise<void> | undefined;
  return {
    refresh() {
      if (running || now() - last < gap) return undefined;
      last = now();
      running = check()
        .catch(() => undefined)
        .finally(() => {
          running = undefined;
        });
      return running;
    },
  };
}

export interface RunningWeb {
  app: WebApp;
  stop(): Promise<void>;
}

export async function runWeb(cli: WebCli, out: (l: string) => void = (l) => void process.stdout.write(`${l}\n`)): Promise<RunningWeb> {
  const early = parseConfig(composeRawConfig(readFileSync(cli.configPath, "utf8"), { env: process.env as never }).raw, process.env as never);
  const strataFile = early.model.runners.strata?.configFile;
  const loaded = loadSecrets({ secretsPath: cli.secretsPath, runner: early.model.runner, ...(strataFile ? { strataConfigFile: strataFile } : {}), checkAcl: cli.checkAcl });
  const secrets = loaded.secrets;
  const { config, settings } = loadConfig({ configPath: cli.configPath, secrets });
  const bots = parseBots(settings.security, { folderAllow: config.folders.allow, derivedPresets: derivedPresets(config), defaultPreset: ((settings.security?.["model"] ?? {}) as { defaultPreset?: string }).defaultPreset ?? config.model.runner });
  const presets: PresetConfig[] = bots.presets;
  const terms: TermsAccepted = termsOf(bots);
  const redact = createRedactor(secretValues(secrets));
  const dataDir = config.paths.dataDir;
  const audit = createWebAudit({ dir: webPaths(dataDir).auditDir, redact });
  const status = new ProxyStatus();
  const proxyPreset = presets.find((p) => p.kind === "acp" && p.baseUrl);
  const watchProxy = async (): Promise<void> => {
    try {
      const ep = proxyEndpoint(proxyPreset?.baseUrl ? { baseUrl: proxyPreset.baseUrl } : { port: DEFAULT_PROXY_PORT });
      const h = await fetchHealth(ep, { timeoutMs: 3000 });
      if (h.ok) for (const p of h.health.providers) status.noteAuthMethod(p.id, p.authMethod);
    } catch {
      /* the proxy being down is handled per call */
    }
  };
  if (proxyPreset) {
    await watchProxy();
    setInterval(() => void watchProxy(), 60_000).unref();
  }
  const refresher = proxyRefresher(watchProxy);
  const engine = createOpenAiEngine({ endpoint: endpointResolver(config, secrets, presets), status, log: (l) => out(redact(l)), ...(proxyPreset ? { onProxyTrouble: () => void refresher.refresh() } : {}) });

  // the kill switch flag is shared with the Telegram agent through the control folder
  const tsExe = cli.tailscale;
  if (cli.mode === "tailnet") {
    const v = await run(tsExe, ["version"]);
    if (!meetsMinVersion(v?.split("\n")[0], MIN_TAILSCALE_VERSION)) throw new Error(`tailnet mode needs Tailscale ${MIN_TAILSCALE_VERSION} or newer (could not read the version)`);
  }
  const app = await startWebApp({
    dataDir,
    port: cli.port,
    mode: cli.mode,
    publicHosts: cli.publicHost ? [cli.publicHost] : [],
    presets: () => presets,
    terms: () => terms,
    engine,
    audit,
    controlDir: config.paths.controlDir,
    ...(cli.mode === "tailnet"
      ? {
          whois: cliWhois((args) => run(tsExe, args)),
          serveStatus: () => run(tsExe, ["serve", "status", "--json"]),
          clockSkewMs: () => clockSkew(),
        }
      : {}),
  });
  out(`web gateway listening on http://127.0.0.1:${app.gateway.port} (${cli.mode})`);
  if (!app.stack.auth.ownerExists()) out(`No owner yet: run "npm run web-owner-code -- --data-dir ${dataDir}" and open http://localhost:${app.gateway.port}/claim on this PC.`);
  return {
    app,
    stop: async () => {
      await app.close();
    },
  };
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  let cli: WebCli;
  try {
    cli = parseWebCli(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`web: ${(e as Error).message}\n`);
    process.exit(2);
  }
  runWeb(cli).then(
    (r) => {
      const stop = (): void => void r.stop().then(() => process.exit(0));
      for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(sig, stop);
    },
    (e: unknown) => {
      process.stderr.write(`web: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
