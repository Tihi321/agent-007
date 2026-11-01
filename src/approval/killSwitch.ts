/**
 * Kill switch (S3.2, I7). Shell is OFF if any of these holds, checked on every call:
 *  1. `config.shell.enabled === false` (the caller passes a function that re-reads the config);
 *  2. the flag file `<controlDir>\shell-disabled` exists;
 *  3. the in-memory flag is set.
 *
 * `turnOn(by)` sets the memory flag first, then writes the flag file, logs, audits and fires `onChange`.
 * There is deliberately NO code path that clears the flag: re-enabling is local only (an admin deletes the file,
 * or edits the config and restarts). Do not add a `turnOff`, `reset` or `clear`.
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditLog, KillSwitch, Logger } from "../contracts.js";

export const SHELL_DISABLED_FLAG = "shell-disabled";

export function killSwitchFlagPath(controlDir: string): string {
  return join(controlDir, SHELL_DISABLED_FLAG);
}

export type KillSwitchSource = "config" | "flagFile" | "memory";

export interface KillSwitchOptions {
  controlDir: string;
  /** Returns the CURRENT `config.shell.enabled` (re-read from the config on every call). */
  shellEnabled: () => boolean;
  logger?: Logger;
  audit?: AuditLog;
  now?: () => Date;
}

export interface KillSwitchHandle extends KillSwitch {
  /** Why shell is off, for `/status` and the audit `blocked` reason. Empty when shell is on. */
  sources(): KillSwitchSource[];
  /** `"disabled"` when only the config switch is off, otherwise `"killswitch"`. */
  blockReason(): "killswitch" | "disabled";
  readonly flagPath: string;
}

export function createKillSwitch(opts: KillSwitchOptions): KillSwitchHandle {
  const flagPath = killSwitchFlagPath(opts.controlDir);
  const now = opts.now ?? (() => new Date());
  const listeners: Array<() => void> = [];
  let memory = false;

  const sources = (): KillSwitchSource[] => {
    const out: KillSwitchSource[] = [];
    let enabled = true;
    try {
      enabled = opts.shellEnabled();
    } catch {
      enabled = false; // an unreadable config fails closed
    }
    if (!enabled) out.push("config");
    try {
      if (existsSync(flagPath)) out.push("flagFile");
    } catch {
      out.push("flagFile"); // cannot tell: fail closed
    }
    if (memory) out.push("memory");
    return out;
  };

  return {
    flagPath,
    isOn: () => sources().length > 0,
    sources,
    blockReason() {
      const s = sources();
      return s.length === 1 && s[0] === "config" ? "disabled" : "killswitch";
    },
    async turnOn(by: string): Promise<void> {
      memory = true; // immediate, before any I/O
      try {
        mkdirSync(opts.controlDir, { recursive: true });
        writeFileSync(flagPath, JSON.stringify({ by, at: now().toISOString() }) + "\n", { encoding: "utf8", flag: "a" });
      } catch (e) {
        opts.logger?.error("killswitch.flag_write_failed", { by, error: e instanceof Error ? e.message : String(e) });
      }
      opts.logger?.warn("killswitch.on", { by });
      try {
        opts.audit?.write({ event: "blocked", ts: now().toISOString(), id: `killswitch:${by}`, command: `(kill switch turned on by ${by})`, reason: "killswitch" });
      } catch (e) {
        opts.logger?.error("killswitch.audit_failed", { by, error: e instanceof Error ? e.message : String(e) });
      }
      for (const cb of [...listeners]) {
        try {
          cb();
        } catch (e) {
          opts.logger?.error("killswitch.listener_failed", { error: e instanceof Error ? e.message : String(e) });
        }
      }
    },
    onChange(cb: () => void): void {
      listeners.push(cb);
    },
  };
}
