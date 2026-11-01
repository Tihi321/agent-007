/**
 * Web side of the owner kill switch (S31, S36). The Telegram `/killswitch` writes the flag file `<controlDir>\shell-disabled`
 * (`src/approval/killSwitch.ts`); nothing in the code clears it. This watcher lives in the gateway process: the moment the flag exists it
 * ends every web session (once, audited) and the gateway answers 503 to every API call while it stays (`lockedDown`). The owner CLI
 * `web-lockdown` does the same without the flag. Re-enabling the web is local: delete the flag file.
 */
import { existsSync } from "node:fs";
import { killSwitchFlagPath } from "../approval/killSwitch.js";
import type { WebAudit } from "./audit.js";
import type { SessionManager } from "./sessions.js";

export interface KillSwitchWatch {
  /** True while the flag file exists (checked on every call, so a request never sees a stale answer). */
  lockedDown(): boolean;
  stop(): void;
}

export function watchKillSwitch(o: { controlDir: string; sessions: SessionManager; audit: WebAudit; intervalMs?: number }): KillSwitchWatch {
  const flag = killSwitchFlagPath(o.controlDir);
  const check = (): boolean => {
    try {
      return existsSync(flag);
    } catch {
      return true; // cannot tell: fail closed
    }
  };
  let tripped = false;
  const trip = (): void => {
    if (tripped || !check()) return;
    tripped = true;
    let n = 0;
    try {
      n = o.sessions.revokeAll();
    } catch {
      /* an unreadable session store already refuses every session (I55) */
    }
    try {
      o.audit.write({ kind: "lockdown", detail: { via: "killswitch", sessions: n } });
    } catch {
      /* the lockdown stands even if the audit is down */
    }
  };
  trip();
  const timer = setInterval(() => {
    if (!check()) tripped = false; // the owner deleted the flag locally: a later trip counts again
    trip();
  }, o.intervalMs ?? 2000);
  timer.unref?.();
  return {
    lockedDown: () => {
      const on = check();
      if (on) trip();
      return on;
    },
    stop: () => clearInterval(timer),
  };
}
