/**
 * Builds the auth stack of the web gateway from a data directory (S31): stores, the encryption key, the audit, the lockout tracker,
 * sessions and the auth service. Used by the gateway, the CLI and the tests. The key file `web.key` is created on first use with 32 random
 * bytes; a key file of the wrong size stops the start (fail closed, I55).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createWebAudit } from "./audit.js";
import type { WebAudit } from "./audit.js";
import { AuthService } from "./auth.js";
import { SecretBox } from "./crypto.js";
import { webPaths } from "./paths.js";
import type { WebPaths } from "./paths.js";
import { LockoutTracker } from "./ratelimit.js";
import { SessionManager } from "./sessions.js";
import { credentialsStore, invitesStore, sessionsStore, usersStore } from "./store.js";

export interface WebStackOptions {
  dataDir: string;
  port: number;
  publicHosts: string[];
  audit?: WebAudit;
  now?: () => number;
  onLockout?: (key: string, ms: number) => void;
}

export function loadOrCreateKey(file: string): Buffer {
  if (existsSync(file)) {
    const k = readFileSync(file);
    if (k.length !== 32) throw new Error("web.key must be exactly 32 bytes");
    return k;
  }
  const k = SecretBox.generateKey();
  writeFileSync(file, k, { flag: "wx" });
  return k;
}

export function createWebStack(o: WebStackOptions) {
  const paths: WebPaths = webPaths(o.dataDir);
  mkdirSync(paths.webDir, { recursive: true });
  const users = usersStore(paths.usersFile);
  const invites = invitesStore(paths.invitesFile);
  const credentials = credentialsStore(paths.credentialsFile);
  const sessionFile = sessionsStore(paths.sessionsFile);
  const audit = o.audit ?? createWebAudit({ dir: paths.auditDir });
  const box = new SecretBox(loadOrCreateKey(paths.keyFile));
  const lockout = new LockoutTracker({ file: paths.lockoutFile, ...(o.now ? { now: o.now } : {}), ...(o.onLockout ? { onLockout: o.onLockout } : {}) });
  const sessions = new SessionManager({ sessions: sessionFile, users, ...(o.now ? { now: o.now } : {}) });
  const auth = new AuthService({ users, credentials, claimFile: paths.claimFile, box, sessions, lockout, audit, port: o.port, publicHosts: o.publicHosts, ...(o.now ? { now: o.now } : {}) });
  return {
    paths,
    users,
    invites,
    credentials,
    sessionFile,
    audit,
    box,
    lockout,
    sessions,
    auth,
    /** Reads every store once; throws `WebStoreError` for a corrupt one (the startup check). */
    loadStores(): void {
      users.read();
      invites.read();
      credentials.read();
      sessionFile.read();
    },
  };
}

export type WebStack = ReturnType<typeof createWebStack>;
