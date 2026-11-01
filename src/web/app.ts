/**
 * Composition of the web gateway (S34 to S36): stores and auth, user management, chat, routes, static assets, the startup checks and the
 * listener. Everything the live host needs (the real engine, the presets, the terms flags, the Tailscale CLI) is injected, so the whole
 * application runs in tests against fakes.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import type { PresetConfig, TermsAccepted } from "../bots/schema.js";
import type { WebAudit } from "./audit.js";
import { ApprovalBroker } from "./chat/approvals.js";
import type { ChatEngine } from "./chat/engine.js";
import { ChatService } from "./chat/service.js";
import { watchKillSwitch } from "./killswitch.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { privacyRoutes } from "./routes/privacy.js";
import { TurnScheduler } from "./runtime/scheduler.js";
import { GatewayStartError, checkStartup, startGateway } from "./server.js";
import type { GatewayOptions, RunningGateway } from "./server.js";
import { recordFor } from "./schemas.js";
import { createWebStack } from "./stack.js";
import type { WebStack } from "./stack.js";
import { makeIdentityVerifier } from "./tailscale.js";
import type { WhoisFn } from "./tailscale.js";
import { UserAdmin } from "./users.js";

export interface WebAppOptions {
  dataDir: string;
  port: number;
  /** `local`: the PC only (L1). `tailnet`: serve and Funnel checks, the identity verifier with whois (L2). */
  mode: "local" | "tailnet";
  publicHosts: string[];
  presets: () => readonly PresetConfig[];
  terms: () => TermsAccepted;
  engine: ChatEngine;
  whois?: WhoisFn;
  serveStatus?: () => Promise<string | undefined> | string | undefined;
  clockSkewMs?: () => Promise<number | undefined> | number | undefined;
  assetsDir?: string;
  scheduler?: TurnScheduler;
  audit?: WebAudit;
  now?: () => number;
  onLockout?: (key: string, ms: number) => void;
  /** Test seam: replaces the identity verifier. */
  identify?: GatewayOptions["identify"];
  rate?: GatewayOptions["rate"];
  bodyTimeoutMs?: number;
  /** How long a finished chat run stays available to a late SSE client (ms). */
  keepRunMs?: number;
  /** The agent control folder: when its kill-switch flag exists, every web session ends and the API answers 503 (S36). */
  controlDir?: string;
}

export interface WebApp {
  gateway: RunningGateway;
  stack: WebStack;
  admin: UserAdmin;
  chat: ChatService;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

/** The built UI files (`dist/ui/web`), keyed by URL path. `/` is index.html. A fixed map: no path joining at request time. */
export function loadWebAssets(dir: string): Map<string, { body: Buffer; type: string }> {
  const m = new Map<string, { body: Buffer; type: string }>();
  if (!existsSync(dir)) return m;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const type = TYPES[extname(e.name)];
    if (!type) continue;
    const body = readFileSync(join(dir, e.name));
    m.set(`/${e.name}`, { body, type });
    if (e.name === "index.html") m.set("/", { body, type });
  }
  return m;
}

export async function startWebApp(o: WebAppOptions): Promise<WebApp> {
  const now = o.now ?? Date.now;
  const stack = createWebStack({ dataDir: o.dataDir, port: o.port, publicHosts: o.publicHosts, ...(o.audit ? { audit: o.audit } : {}), now, ...(o.onLockout ? { onLockout: o.onLockout } : {}) });
  await checkStartup(
    { host: "127.0.0.1", port: o.port, audit: stack.audit },
    { mode: o.mode, loadStores: () => stack.loadStores(), ...(o.serveStatus ? { serveStatus: o.serveStatus } : {}), ...(o.clockSkewMs ? { clockSkewMs: o.clockSkewMs } : {}) },
  );
  const scheduler = o.scheduler ?? new TurnScheduler({ slots: 1, now });
  const chat = new ChatService({ dataDir: o.dataDir, audit: stack.audit, users: stack.users, presets: o.presets, terms: o.terms, scheduler, engine: o.engine, approvals: new ApprovalBroker(stack.audit, { now }), now, ...(o.keepRunMs !== undefined ? { keepRunMs: o.keepRunMs } : {}) });
  // L3: disabling or deleting a user, the kill switch and the owner lockdown also stop the running turns, not only the sessions
  const admin = new UserAdmin(stack, { now, knownPresets: () => o.presets().map((p) => p.id), onUserRevoked: (id) => void chat.stopAllFor(id) });
  admin.sweepDisabled();
  const sweep = setInterval(() => {
    try {
      admin.sweepDisabled();
    } catch {
      /* the next round tries again */
    }
  }, 6 * 3_600_000);
  sweep.unref();
  const identify = o.identify ?? makeIdentityVerifier({ port: o.port, publicHosts: o.mode === "tailnet" ? o.publicHosts : [], whois: o.whois ?? (async () => undefined) });
  const assets = o.assetsDir ? loadWebAssets(o.assetsDir) : undefined;
  const userCaps = (userId: string) => {
    const u = recordFor(stack.users.read().users, userId);
    return u && u.status === "active" ? { caps: u.caps } : undefined;
  };
  const watch = o.controlDir ? watchKillSwitch({ controlDir: o.controlDir, sessions: stack.sessions, audit: stack.audit, onTrip: () => void chat.stopAll() }) : undefined;
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: o.port,
    publicHosts: o.mode === "tailnet" ? o.publicHosts : [],
    audit: stack.audit,
    sessions: stack.sessions,
    identify,
    admit: admin.admit,
    routes: { ...authRoutes(stack, { onLockdown: () => void chat.stopAll() }), ...adminRoutes(stack, admin), ...chatRoutes(chat, o.presets, userCaps), ...privacyRoutes(stack, chat, admin) },
    ...(assets ? { assets } : {}),
    now,
    ...(watch ? { lockedDown: watch.lockedDown } : {}),
    ...(o.rate ? { rate: o.rate } : {}),
    ...(o.bodyTimeoutMs !== undefined ? { bodyTimeoutMs: o.bodyTimeoutMs } : {}),
  });
  return {
    gateway,
    stack,
    admin,
    chat,
    close: async () => {
      for (const u of Object.keys(stack.users.read().users)) chat.stopAllFor(u);
      watch?.stop();
      clearInterval(sweep);
      await gateway.close();
    },
  };
}

export { GatewayStartError };
