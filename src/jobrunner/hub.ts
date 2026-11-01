/**
 * `hub_status` and `hub_start` (S11.5). The job runner runs exactly
 *
 *     <pwsh> -NoProfile -File <hub>\scripts\hub.ps1 start <service>      (or `status`)
 *
 * as a fixed argv (no shell, no string interpolation), with `<service>` taken from a FIXED list: the ids in the job
 * runner's config, or in creative-hub's `services.json` when `hub.servicesFile` is set. An unknown service is refused
 * before anything runs. `scriptorium` additionally needs the request to carry the explicit Scriptorium approval flag
 * (its own warning card, S10.4); inside a job it is never startable (the policy denies it).
 *
 * agent-007 never starts a hub service by itself: this only runs after the agent's Telegram approval, whose proof the
 * server records in its audit log.
 */
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { Logger } from "../contracts.js";
import type { IpcErrorCode } from "../ipc/protocol.js";
import type { EngineDriver, EngineResumeSpec, EngineStartSpec, HubServiceStatus, HubStartReply, HubStatusReply, JobEvent } from "../jobs/contracts.js";
import type { HubConfig } from "./limits.js";
import { nodeExec } from "./proc.js";
import type { Exec } from "./proc.js";

export const SCRIPTORIUM = "scriptorium";
export const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

export class HubError extends Error {
  readonly code: IpcErrorCode;
  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = "HubError";
    this.code = code;
  }
}

export interface HubDeps {
  exec?: Exec;
  /** True when something listens on 127.0.0.1:<port>. */
  probe?: (port: number) => Promise<boolean>;
  readFile?: (path: string) => string;
  logger?: Logger;
}

/** Service ids from creative-hub `services.json`: an array of ids or objects with an id/name, or an object keyed by id. */
export function parseServicesJson(text: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("services.json is not valid JSON");
  }
  const ids = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === "string" && SERVICE_ID_PATTERN.test(v)) ids.add(v);
  };
  const fromList = (list: unknown[]): void => {
    for (const item of list) {
      if (typeof item === "string") add(item);
      else if (typeof item === "object" && item !== null) {
        const o = item as Record<string, unknown>;
        add(o["id"] ?? o["name"] ?? o["service"]);
      }
    }
  };
  if (Array.isArray(raw)) fromList(raw);
  else if (typeof raw === "object" && raw !== null) {
    const o = raw as Record<string, unknown>;
    const inner = o["services"];
    if (Array.isArray(inner)) fromList(inner);
    else if (typeof inner === "object" && inner !== null) for (const k of Object.keys(inner)) add(k);
    else for (const k of Object.keys(o)) if (!k.startsWith("_")) add(k);
  }
  return [...ids];
}

const UP_WORDS = /\b(up|running|listening|online|ok|healthy|started|alive)\b/i;
const DOWN_WORDS = /\b(down|stopped|not running|offline|dead|failed|inactive|unreachable)\b/i;

/** Best-effort read of `hub.ps1 status` output: JSON, or one line per service that says up/running or down/stopped. */
export function parseStatusOutput(stdout: string, services: readonly string[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const text = stdout.trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const raw = JSON.parse(text) as unknown;
      const list: unknown[] = Array.isArray(raw)
        ? raw
        : typeof raw === "object" && raw !== null && Array.isArray((raw as Record<string, unknown>)["services"])
          ? ((raw as Record<string, unknown>)["services"] as unknown[])
          : [];
      for (const item of list) {
        if (typeof item !== "object" || item === null) continue;
        const o = item as Record<string, unknown>;
        const id = String(o["id"] ?? o["name"] ?? o["service"] ?? "");
        const state = o["up"] ?? o["running"] ?? o["ok"] ?? o["status"] ?? o["state"];
        if (!services.includes(id)) continue;
        if (typeof state === "boolean") out.set(id, state);
        else if (typeof state === "string") out.set(id, UP_WORDS.test(state) && !DOWN_WORDS.test(state));
      }
      if (out.size > 0) return out;
    } catch {
      /* fall through to the line parser */
    }
  }
  for (const line of stdout.split(/\r?\n/)) {
    const lower = line.toLowerCase();
    for (const id of services) {
      if (!new RegExp(`(^|[^a-z0-9-])${id}([^a-z0-9-]|$)`).test(lower)) continue;
      if (DOWN_WORDS.test(line)) out.set(id, false);
      else if (UP_WORDS.test(line)) out.set(id, true);
    }
  }
  return out;
}

export function tcpProbe(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean): void => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export class HubRunner {
  private readonly exec: Exec;
  private readonly probe: (port: number) => Promise<boolean>;
  private readonly serviceIds: string[];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly cfg: HubConfig,
    private readonly deps: HubDeps = {},
  ) {
    this.exec = deps.exec ?? nodeExec;
    this.probe = deps.probe ?? tcpProbe;
    let ids = [...cfg.services];
    if (cfg.servicesFile) {
      try {
        ids = parseServicesJson((deps.readFile ?? ((p: string) => readFileSync(p, "utf8")))(cfg.servicesFile));
      } catch (e) {
        deps.logger?.warn("hub.services_file_unreadable", { file: cfg.servicesFile, error: e instanceof Error ? e.message : "error" });
      }
    }
    this.serviceIds = ids.filter((s) => SERVICE_ID_PATTERN.test(s));
  }

  /** The fixed list. */
  services(): string[] {
    return [...this.serviceIds];
  }

  scriptPath(): string {
    return join(this.cfg.dir, "scripts", "hub.ps1");
  }

  /** The fixed argument list after the pwsh executable. The only variable part is a service id from the fixed list. */
  argv(verb: "start" | "status", service?: string): string[] {
    const base = ["-NoProfile", "-File", this.scriptPath(), verb];
    if (verb === "status") return base;
    if (service === undefined || !this.serviceIds.includes(service)) throw new HubError("bad_request", `"${String(service)}" is not a known hub service`);
    return [...base, service];
  }

  async status(): Promise<HubStatusReply> {
    const parsed = new Map<string, boolean>();
    try {
      const r = await this.exec(this.cfg.pwsh, this.argv("status"), { cwd: this.cfg.dir, timeoutMs: this.cfg.statusTimeoutSec * 1000 });
      if (r.code === 0) for (const [k, v] of parseStatusOutput(r.stdout, this.serviceIds)) parsed.set(k, v);
      else this.deps.logger?.warn("hub.status_failed", { code: r.code, timedOut: r.timedOut });
    } catch (e) {
      this.deps.logger?.warn("hub.status_failed", { error: e instanceof Error ? e.message : "error" });
    }
    const services: HubServiceStatus[] = [];
    for (const id of this.serviceIds) {
      const port = this.cfg.ports[id];
      let up = parsed.get(id) ?? false;
      if (port !== undefined) up = await this.probe(port);
      services.push(port === undefined ? { id, up } : { id, up, port });
    }
    return { services };
  }

  /**
   * Starts one service. Refuses an unknown service, and `scriptorium` without the approval flag, before anything runs.
   * Runs one hub command at a time.
   */
  start(service: string, opts: { scriptoriumApproved?: boolean | undefined } = {}): Promise<HubStartReply> {
    if (typeof service !== "string" || !this.serviceIds.includes(service)) return Promise.reject(new HubError("bad_request", `"${String(service)}" is not a known hub service`));
    if (service === SCRIPTORIUM && opts.scriptoriumApproved !== true) {
      return Promise.reject(new HubError("forbidden", "starting scriptorium needs its own explicit approval (scriptoriumApproved)"));
    }
    const run = this.chain.then(() => this.doStart(service));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doStart(service: string): Promise<HubStartReply> {
    const before = await this.status();
    if (before.services.find((s) => s.id === service)?.up) return { service, started: false, alreadyUp: true, message: `${service} is already running` };
    const argv = this.argv("start", service);
    const r = await this.exec(this.cfg.pwsh, argv, { cwd: this.cfg.dir, timeoutMs: this.cfg.startTimeoutSec * 1000 });
    if (r.timedOut) return { service, started: false, message: `hub.ps1 start ${service} timed out after ${this.cfg.startTimeoutSec} s` };
    if (r.code !== 0) return { service, started: false, message: `hub.ps1 start ${service} exited with ${String(r.code)}: ${lastLine(r.stderr || r.stdout)}` };
    return { service, started: true, message: lastLine(r.stdout) || `started ${service}` };
  }
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  return (lines[lines.length - 1] ?? "").slice(0, 300);
}

// ---- engine "hub" templates ---------------------------------------------------------------------------

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(v: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const v = this.items.shift();
        if (v !== undefined) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

type DriverEvent = JobEvent;
function ev(jobId: string, seq: number, body: Record<string, unknown>): DriverEvent {
  return { jobId, seq, ts: Date.now(), ...body } as unknown as DriverEvent;
}

/**
 * The driver for `engine: "hub"` templates: a job that starts one fixed hub service (never scriptorium: that needs the
 * `hub_start` message and its own card). The core uses it like any other driver.
 */
export function createHubEngineDriver(hub: HubRunner): EngineDriver {
  const queues = new Map<string, { q: AsyncQueue<DriverEvent>; cancelled: boolean }>();
  return {
    engine: "hub",
    version: () => Promise.resolve("hub.ps1"),
    start(spec: EngineStartSpec): Promise<void> {
      const service = spec.template.hubService;
      if (service === undefined || service === SCRIPTORIUM) return Promise.reject(new HubError("forbidden", "this hub template cannot be started as a job"));
      const entry = { q: new AsyncQueue<DriverEvent>(), cancelled: false };
      queues.set(spec.jobId, entry);
      let seq = 0;
      entry.q.push(ev(spec.jobId, ++seq, { kind: "progress", message: `starting ${service}` }));
      void hub
        .start(service, { scriptoriumApproved: false })
        .then((r) => {
          if (entry.cancelled) return;
          entry.q.push(ev(spec.jobId, ++seq, { kind: "result", text: r.message }));
          entry.q.push(ev(spec.jobId, ++seq, { kind: "state", state: r.started || r.alreadyUp ? "succeeded" : "failed", detail: r.message }));
        })
        .catch((e: unknown) => {
          if (entry.cancelled) return;
          const msg = e instanceof Error ? e.message : "hub start failed";
          entry.q.push(ev(spec.jobId, ++seq, { kind: "result", text: msg }));
          entry.q.push(ev(spec.jobId, ++seq, { kind: "state", state: "failed", detail: msg }));
        })
        .finally(() => entry.q.close());
      return Promise.resolve();
    },
    resume(_spec: EngineResumeSpec): Promise<void> {
      return Promise.reject(new Error("a hub job cannot be resumed"));
    },
    events(jobId: string): AsyncIterable<JobEvent> {
      const e = queues.get(jobId);
      if (!e) return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true }) }) };
      return e.q as AsyncIterable<JobEvent>;
    },
    cancel(jobId: string): Promise<void> {
      const e = queues.get(jobId);
      if (e) {
        e.cancelled = true;
        e.q.push(ev(jobId, 99, { kind: "state", state: "cancelled", detail: "cancelled" }));
        e.q.close();
      }
      return Promise.resolve();
    },
  };
}
