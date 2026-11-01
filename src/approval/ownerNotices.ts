/**
 * Owner notices from the web gateway to Telegram (L2, L8), through the control folder, the same channel as the kill-switch flag.
 *
 * Least privilege: the gateway never holds the Telegram token. It writes one small JSON file per notice into
 * `<controlDir>\owner-notices\`; the agent process (which already holds the token) polls that folder, sends each notice to the owner
 * through its existing bot, and deletes the file. A notice carries only fields from a fixed set (a kind, a scope, a number of minutes),
 * so nothing a web client typed can reach the owner's chat: the agent builds the text from a fixed template and drops any file that does
 * not parse exactly.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const OWNER_NOTICES_DIR = "owner-notices";
/** Pending notices kept at most; more are dropped by the writer (a flood cannot fill the disk). */
export const OWNER_NOTICES_MAX_PENDING = 50;
/** Notices sent per poll at most; the rest are summed up in one line. */
export const OWNER_NOTICES_PER_POLL = 5;

export type OwnerNotice = { kind: "web_lockout"; scope: "login" | "client" | "invite"; minutes: number };

export function ownerNoticesDir(controlDir: string): string {
  return join(controlDir, OWNER_NOTICES_DIR);
}

/** The lockout tracker key (`login:...`, `client:...`, `invite:...`) to a notice. The key itself (a login, an address) is NOT carried. */
export function lockoutNotice(key: string, ms: number): OwnerNotice {
  const scope = key.startsWith("login:") ? "login" : key.startsWith("invite") ? "invite" : "client";
  return { kind: "web_lockout", scope, minutes: Math.max(1, Math.min(24 * 60, Math.round(ms / 60_000))) };
}

export function parseOwnerNotice(v: unknown): OwnerNotice | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "kind,minutes,scope") return undefined;
  if (o["kind"] !== "web_lockout") return undefined;
  if (o["scope"] !== "login" && o["scope"] !== "client" && o["scope"] !== "invite") return undefined;
  const m = o["minutes"];
  if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > 24 * 60) return undefined;
  return { kind: "web_lockout", scope: o["scope"], minutes: m };
}

export function ownerNoticeText(n: OwnerNotice): string {
  const what = n.scope === "login" ? "a web login" : n.scope === "invite" ? "an invitation attempt" : "a web client";
  return `Web access: ${what} was locked out for ${n.minutes} minutes after repeated failed sign-ins. Details (no passwords) are in the web audit on the PC.`;
}

/** Gateway side: writes one notice (atomic: temp file, then rename). Never throws; a full folder drops the notice. */
export function writeOwnerNotice(controlDir: string, n: OwnerNotice): boolean {
  try {
    const dir = ownerNoticesDir(controlDir);
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).filter((f) => f.endsWith(".json")).length >= OWNER_NOTICES_MAX_PENDING) return false;
    const name = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const tmp = join(dir, `${name}.tmp`);
    writeFileSync(tmp, JSON.stringify({ kind: n.kind, scope: n.scope, minutes: n.minutes }), { encoding: "utf8", flag: "wx" });
    renameSync(tmp, join(dir, `${name}.json`));
    return true;
  } catch {
    return false;
  }
}

/** Agent side: sends the pending notices (oldest first, at most `OWNER_NOTICES_PER_POLL`, the rest summed up) and deletes every file read. */
export async function drainOwnerNotices(controlDir: string, send: (text: string) => Promise<void>): Promise<number> {
  const dir = ownerNoticesDir(controlDir);
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir)
    .filter((f) => /^\d+-[0-9a-f]{8}\.json$/.test(f))
    .sort();
  const notices: OwnerNotice[] = [];
  for (const f of files) {
    const p = join(dir, f);
    let n: OwnerNotice | undefined;
    try {
      const st = statSync(p);
      n = st.isFile() && st.size <= 4096 ? parseOwnerNotice(JSON.parse(readFileSync(p, "utf8"))) : undefined;
    } catch {
      n = undefined;
    }
    try {
      rmSync(p, { force: true }); // a directory or locked file named like a notice must not stop the later ones
    } catch {
      /* skipped */
    }
    if (n) notices.push(n);
  }
  const now = notices.slice(0, OWNER_NOTICES_PER_POLL);
  for (const n of now) await send(ownerNoticeText(n));
  const rest = notices.length - now.length;
  if (rest > 0) await send(`Web access: ${rest} more lockout notices. See the web audit on the PC.`);
  return notices.length;
}

/** Agent side: polls the folder. A failed send is logged by the caller's `send`; it never stops the watcher. */
export function watchOwnerNotices(o: { controlDir: string; send: (text: string) => Promise<void>; intervalMs?: number; onError?: (e: unknown) => void }): { stop(): void; poll(): Promise<number> } {
  let busy = false;
  const poll = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    try {
      return await drainOwnerNotices(o.controlDir, o.send);
    } catch (e) {
      o.onError?.(e);
      return 0;
    } finally {
      busy = false;
    }
  };
  const t = setInterval(() => void poll(), o.intervalMs ?? 5000);
  t.unref?.();
  return { stop: () => clearInterval(t), poll };
}
