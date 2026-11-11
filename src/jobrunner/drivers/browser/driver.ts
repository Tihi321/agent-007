/**
 * `BrowserDriver` (REQ-0014 T3): the `EngineDriver` for `engine: "browser"` templates. One job = one browser session on one
 * isolated profile. The agent's local model drives it through `act()` (the IPC op `browser_action`, routed by the manager).
 *
 * Safety:
 *   - Risky steps are decided by `classifyAction` from element facts read from the DOM; `ask` goes to the user with a
 *     screenshot, `refuse` is never asked. Credential fields are never typed.
 *   - Typed values never appear in events, permission requests, the manifest or the journal (`maskAction`).
 *   - All Chromium traffic goes through the runner's egress proxy (private/loopback/blocked ports refused there).
 *   - No resume: no `engineSessionId` is ever reported, a restart ends the session.
 */
import { IpcHandlerError } from "../../../ipc/server.js";
import type { BrowserAction, BrowserActionBody, BrowserActionReply } from "../../../jobs/browserContracts.js";
import { BROWSER_KEYS } from "../../../jobs/browserContracts.js";
import type { ArtifactRef, EngineResumeSpec, EngineStartSpec, JobEvent, JobRef, TerminalJobState } from "../../../jobs/contracts.js";
import type { Logger } from "../../../contracts.js";
import type { BrowserSettings } from "../../../settings/browser.js";
import type { CoreEngineHost } from "../../manager.js";
import { ArtifactWriter, safeUrlLabel } from "./artifacts.js";
import type { BrowserSession, ElementFacts } from "./backend.js";
import { classifyAction, maskAction } from "./classify.js";
import type { Verdict } from "./classify.js";
import type { BrowserDriverDeps, BrowserEngineDriver } from "./index.js";
import { APPROX_DOWNLOAD_SIZE, readPlaywrightInfo } from "./install.js";
import type { PlaywrightInfo } from "./install.js";
import { acquireProfileLock } from "./lock.js";
import type { ProfileLock } from "./lock.js";
import { guardReason } from "./playwright.js";
import { formatSnapshot } from "./snapshot.js";
import type { EgressProxy } from "./egress.js";

export const INSTALL_DENIED_MESSAGE =
  "Chromium is not installed and the download was not approved. Approve the download card on the next browser job, or run `node dist\\src\\jobrunner\\main.js browser-install` as the job runner user.";

const REPLY_CACHE = 50;
const READ_DEFAULT = 12_000;
const READ_MAX = 40_000;
const TEXT_CAP = 40_000;
const REF = /^e\d{1,5}$/;
const REFUSAL_WINDOW_MS = 10_000;

export interface BrowserDriverExtras {
  logger?: Logger;
  redact?: (s: string) => string;
  info?: PlaywrightInfo;
}

type Parsed = { ok: true; action: BrowserAction } | { ok: false; message: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const bad = Object.keys(o).find((k) => !keys.includes(k));
  return bad === undefined ? undefined : `unknown field "${bad}"`;
}

function str(v: unknown, max: number, min = 0): string | undefined {
  return typeof v === "string" && v.length >= min && v.length <= max ? v : undefined;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CONTROL_MESSAGE = "must not contain line breaks or control characters; to press Enter use browser_press with key Enter";

/** Strict validation (unknown keys refused), the same limits as the IPC contract. */
export function parseAction(raw: unknown): Parsed {
  const bad = (message: string): Parsed => ({ ok: false, message });
  if (!isObj(raw)) return bad("action must be an object");
  const op = raw["op"];
  const ref = (v: unknown): string | undefined => (typeof v === "string" && REF.test(v) ? v : undefined);
  switch (op) {
    case "goto": {
      const extra = onlyKeys(raw, ["op", "url"]);
      const url = str(raw["url"], 2048, 1);
      if (extra) return bad(extra);
      return url === undefined ? bad("url must be a string of at most 2048 characters") : { ok: true, action: { op, url } };
    }
    case "back":
      return onlyKeys(raw, ["op"]) ? bad("back takes no fields") : { ok: true, action: { op } };
    case "read": {
      const extra = onlyKeys(raw, ["op", "maxChars"]);
      if (extra) return bad(extra);
      const m = raw["maxChars"];
      if (m === undefined) return { ok: true, action: { op } };
      return typeof m === "number" && Number.isInteger(m) && m >= 1000 && m <= READ_MAX ? { ok: true, action: { op, maxChars: m } } : bad("maxChars must be an integer from 1000 to 40000");
    }
    case "click": {
      const extra = onlyKeys(raw, ["op", "ref"]);
      const r = ref(raw["ref"]);
      if (extra) return bad(extra);
      return r === undefined ? bad("ref must look like e12") : { ok: true, action: { op, ref: r } };
    }
    case "type": {
      const extra = onlyKeys(raw, ["op", "ref", "text", "clear"]);
      const r = ref(raw["ref"]);
      const text = str(raw["text"], 2000);
      const clear = raw["clear"];
      if (extra) return bad(extra);
      if (r === undefined) return bad("ref must look like e12");
      if (text === undefined) return bad("text must be a string of at most 2000 characters");
      if (CONTROL_CHARS.test(text)) return bad(`text ${CONTROL_MESSAGE}`);
      if (clear !== undefined && typeof clear !== "boolean") return bad("clear must be a boolean");
      return { ok: true, action: { op, ref: r, text, ...(clear !== undefined ? { clear } : {}) } };
    }
    case "fill": {
      const extra = onlyKeys(raw, ["op", "fields"]);
      if (extra) return bad(extra);
      const fields = raw["fields"];
      if (!Array.isArray(fields) || fields.length < 1 || fields.length > 20) return bad("fields must have 1 to 20 entries");
      const out: { ref: string; value: string }[] = [];
      for (const f of fields) {
        if (!isObj(f) || onlyKeys(f, ["ref", "value"])) return bad("each field is {ref, value}");
        const r = ref(f["ref"]);
        const value = str(f["value"], 2000);
        if (r === undefined || value === undefined) return bad("each field needs a ref like e12 and a value of at most 2000 characters");
        if (CONTROL_CHARS.test(value)) return bad(`value ${CONTROL_MESSAGE}`);
        out.push({ ref: r, value });
      }
      return { ok: true, action: { op, fields: out } };
    }
    case "press": {
      const extra = onlyKeys(raw, ["op", "key", "ref"]);
      if (extra) return bad(extra);
      const key = raw["key"];
      if (typeof key !== "string" || !(BROWSER_KEYS as readonly string[]).includes(key)) return bad(`key must be one of ${BROWSER_KEYS.join(", ")}`);
      if (raw["ref"] === undefined) return { ok: true, action: { op, key: key as (typeof BROWSER_KEYS)[number] } };
      const r = ref(raw["ref"]);
      return r === undefined ? bad("ref must look like e12") : { ok: true, action: { op, key: key as (typeof BROWSER_KEYS)[number], ref: r } };
    }
    case "screenshot": {
      const extra = onlyKeys(raw, ["op", "fullPage"]);
      if (extra) return bad(extra);
      const fp = raw["fullPage"];
      if (fp !== undefined && typeof fp !== "boolean") return bad("fullPage must be a boolean");
      return { ok: true, action: { op, ...(fp !== undefined ? { fullPage: fp } : {}) } };
    }
    case "done": {
      const extra = onlyKeys(raw, ["op", "summary"]);
      if (extra) return bad(extra);
      const summary = str(raw["summary"], 2000);
      return summary === undefined ? bad("summary must be a string of at most 2000 characters") : { ok: true, action: { op, summary } };
    }
    default:
      return bad("unknown op");
  }
}

class Run {
  readonly events: JobEvent[] = [];
  seq = 0;
  terminal = false;
  private waiters: Array<() => void> = [];
  session?: BrowserSession;
  proxy?: EgressProxy;
  writer?: ArtifactWriter;
  ending?: Promise<void>;
  idleTimer?: NodeJS.Timeout;
  readonly abort = new AbortController();
  readonly replies = new Map<string, BrowserActionReply>();
  inflight?: { callId: string; p: Promise<BrowserActionReply> };
  knownRefs = new Set<string>();
  lastRef?: string;
  askSeq = 0;
  lastRefusal?: { host: string; reason: string; at: number };
  readonly ready: Promise<void>;
  private readyOk!: () => void;
  private readyFail!: (e: Error) => void;

  constructor(
    readonly jobId: string,
    readonly spec: EngineStartSpec,
    readonly lock: ProfileLock,
  ) {
    this.ready = new Promise<void>((res, rej) => {
      this.readyOk = res;
      this.readyFail = rej;
    });
    this.ready.catch(() => undefined);
  }
  markReady(): void {
    this.readyOk();
  }
  failReady(e: Error): void {
    this.readyFail(e);
  }
  push(e: JobEvent): void {
    this.events.push(e);
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }
  waitForEvent(): Promise<void> {
    return new Promise<void>((r) => this.waiters.push(r));
  }
}

const CHANGED_MESSAGE = "the page changed while waiting for approval; read it again";

function sameElement(a: ElementFacts | undefined, b: ElementFacts | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.tag === b.tag && a.name === b.name && a.isSubmit === b.isSubmit && a.href === b.href && a.formAction === b.formAction;
}

function oneLine(s: string, n = 300): string {
  return s.replace(/\s+/g, " ").trim().slice(0, n);
}

export class BrowserDriver implements BrowserEngineDriver {
  readonly engine = "browser" as const;
  private readonly runs = new Map<string, Run>();
  private readonly now: () => number;
  private info?: PlaywrightInfo;

  constructor(
    private readonly deps: BrowserDriverDeps,
    private readonly extras: BrowserDriverExtras = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.info = extras.info;
  }

  private pw(): PlaywrightInfo {
    return (this.info ??= readPlaywrightInfo());
  }
  private redact(s: string): string {
    return this.extras.redact ? this.extras.redact(s) : s;
  }

  async version(): Promise<string> {
    const i = this.pw();
    return `playwright-core ${i.version} chromium ${i.chromiumRevision}`;
  }

  async resume(_spec: EngineResumeSpec): Promise<void> {
    throw new Error("a browser session cannot be resumed; dispatch a new browser session");
  }

  async *events(jobId: string): AsyncIterable<JobEvent> {
    const run = this.runs.get(jobId);
    if (!run) return;
    let i = 0;
    for (;;) {
      while (i < run.events.length) {
        const e = run.events[i++] as JobEvent;
        yield e;
        if (e.kind === "state" && (e.state === "succeeded" || e.state === "failed" || e.state === "cancelled" || e.state === "rejected")) return;
      }
      await run.waitForEvent();
    }
  }

  async cancel(jobId: string): Promise<void> {
    const run = this.runs.get(jobId);
    if (!run || run.terminal) return;
    await this.finalize(run, "cancelled", "cancelled", "the browser session was cancelled");
  }

  async start(spec: EngineStartSpec): Promise<void> {
    if ([...this.runs.values()].some((r) => !r.terminal)) throw new Error("a browser session is already running");
    const lock = acquireProfileLock(this.deps.paths.lockFile); // throws ProfileBusyError
    const run = new Run(spec.jobId, spec, lock);
    this.runs.set(spec.jobId, run);
    for (const [id, r] of this.runs) if (r.terminal && this.runs.size > 10) this.runs.delete(id);
    this.emit(run, { kind: "state", state: "running" });
    void this.bootstrap(run);
  }

  // ---- bootstrap -------------------------------------------------------------------------------------------------

  private async bootstrap(run: Run): Promise<void> {
    const d = this.deps;
    try {
      if (!d.installer.status().installed) {
        const approved = await this.askInstall(run);
        if (run.ending) return;
        if (!approved) return void (await this.fail(run, INSTALL_DENIED_MESSAGE));
        this.emit(run, { kind: "progress", message: "Downloading Chromium (one time). This can take a few minutes." });
        const beat = setInterval(() => this.emit(run, { kind: "progress", message: "Still downloading Chromium..." }), 30_000);
        beat.unref();
        try {
          await d.installer.install(run.abort.signal);
        } finally {
          clearInterval(beat);
        }
        if (run.ending) return;
        this.emit(run, { kind: "progress", message: "Chromium downloaded." });
      }
      run.proxy = await d.egress({
        onRefused: (host, reason) => {
          run.lastRefusal = { host, reason, at: this.now() };
        },
      });
      if (run.ending) return;
      const session = await d.backend.launch({
        profileDir: d.paths.profileDir,
        headless: d.headless,
        browsersDir: d.paths.browsersDir,
        proxy: { server: run.proxy.server, username: run.proxy.username, password: run.proxy.password },
        viewport: { width: 1280, height: 800 },
      });
      run.session = session;
      if (run.ending) return void (await session.close().catch(() => undefined));
      session.onClose(() => void this.finalize(run, "failed", "the browser window was closed or crashed", "the browser window was closed or crashed"));
      run.writer = new ArtifactWriter(d.paths.artifactsDir, run.jobId, run.spec.template.id, this.now);
      this.emit(run, { kind: "init", engineVersion: await this.version() });
      const startUrl = run.spec.params["startUrl"];
      if (typeof startUrl === "string" && startUrl !== "") {
        const why = this.checkGoto(startUrl);
        if (why !== undefined) this.emit(run, { kind: "progress", message: `The start page was not opened: ${why}` });
        else await session.goto(startUrl).catch((e: unknown) => this.emit(run, { kind: "progress", message: `The start page could not be opened: ${oneLine(String((e as Error)?.message ?? e), 160)}` }));
      }
      run.markReady();
      this.armIdle(run);
    } catch (e) {
      await this.fail(run, oneLine(e instanceof Error ? e.message : String(e), 500));
    }
  }

  private async askInstall(run: Run): Promise<boolean> {
    const info = this.pw();
    try {
      const decision = await run.spec.host.askPermission({
        requestId: `${run.jobId}:install`,
        jobId: run.jobId,
        engine: "browser",
        tool: "browser_install",
        kind: "browser",
        input: {
          playwrightCore: info.version,
          chromiumRevision: info.chromiumRevision,
          approxSize: APPROX_DOWNLOAD_SIZE,
          into: this.deps.paths.browsersDir,
          from: "Playwright's download CDN",
        },
        summary: `Download Chromium ${info.chromiumRevision} for browser jobs (one time)`,
        cwd: "",
        requestedAt: 0,
        timeoutSec: 0,
      });
      return decision.answer === "allow_once";
    } catch {
      return false;
    }
  }

  private fail(run: Run, message: string): Promise<void> {
    return this.finalize(run, "failed", message, message);
  }

  // ---- end of a session ------------------------------------------------------------------------------------------

  private finalize(run: Run, state: TerminalJobState, detail: string | undefined, resultText: string): Promise<void> {
    if (run.ending) return run.ending;
    run.ending = (async () => {
      if (run.idleTimer) clearTimeout(run.idleTimer);
      run.abort.abort();
      run.failReady(new Error("the browser session ended"));
      await run.session?.close().catch(() => undefined);
      await run.proxy?.close().catch(() => undefined);
      try {
        run.writer?.finish(state);
      } catch (e) {
        this.extras.logger?.warn("browser.manifest_failed", { jobId: run.jobId, error: String((e as Error)?.message ?? e) });
      }
      run.lock.release();
      this.emit(run, { kind: "result", text: this.redact(resultText) });
      this.emit(run, { kind: "state", state, ...(detail !== undefined ? { detail: this.redact(detail) } : {}) });
      run.terminal = true;
    })();
    return run.ending;
  }

  private armIdle(run: Run): void {
    if (run.idleTimer) clearTimeout(run.idleTimer);
    if (run.ending) return;
    run.idleTimer = setTimeout(() => {
      const min = this.deps.idleMin;
      void this.finalize(run, "succeeded", undefined, `idle for ${min} min, session closed`);
    }, this.deps.idleMin * 60_000);
    run.idleTimer.unref();
  }

  // ---- events ----------------------------------------------------------------------------------------------------

  private emit(run: Run, body: Omit<JobEvent, "jobId" | "seq" | "ts"> | Record<string, unknown>): void {
    run.push({ ...(body as object), jobId: run.jobId, seq: ++run.seq, ts: this.now() } as JobEvent);
  }

  // ---- actions ---------------------------------------------------------------------------------------------------

  async act(jobId: string, body: BrowserActionBody, host: CoreEngineHost): Promise<BrowserActionReply> {
    const run = this.runs.get(jobId);
    if (!run || run.ending) return { outcome: "error", message: "the browser session is not running" };
    const cached = run.replies.get(body.callId);
    if (cached) return cached;
    if (run.inflight) {
      if (run.inflight.callId === body.callId) return run.inflight.p;
      throw new IpcHandlerError("busy", "another browser action is still running for this job");
    }
    const p = this.execute(run, body, host);
    run.inflight = { callId: body.callId, p };
    try {
      const reply = await p;
      run.replies.set(body.callId, reply);
      if (run.replies.size > REPLY_CACHE) run.replies.delete(run.replies.keys().next().value as string);
      return reply;
    } finally {
      run.inflight = undefined;
    }
  }

  private async execute(run: Run, body: BrowserActionBody, host: CoreEngineHost): Promise<BrowserActionReply> {
    const parsed = parseAction(body.action);
    if (!parsed.ok) return { outcome: "refused", message: `invalid action: ${parsed.message}` };
    const action = parsed.action;
    try {
      await run.ready;
    } catch (e) {
      return { outcome: "error", message: run.ending ? "the browser session has ended" : oneLine(String((e as Error)?.message ?? e)) };
    }
    if (run.ending || !run.session) return { outcome: "error", message: "the browser session has ended" };
    if (run.idleTimer) clearTimeout(run.idleTimer);
    const tool = `browser_${action.op}`;
    this.emit(run, { kind: "tool_call", callId: body.callId, tool, input: maskAction(action) });
    let reply: BrowserActionReply;
    try {
      reply = await this.dispatch(run, run.session, action, host);
    } catch (e) {
      reply = this.errorReply(run, e);
    }
    this.emit(run, { kind: "tool_result", callId: body.callId, tool, ok: reply.outcome === "done", text: this.redact(this.summaryLine(action, reply)) });
    if (action.op === "done" && reply.outcome === "done") {
      await this.finalize(run, "succeeded", undefined, action.summary);
    } else {
      this.armIdle(run);
    }
    return reply;
  }

  private summaryLine(action: BrowserAction, r: BrowserActionReply): string {
    if (r.outcome !== "done") return oneLine(`${r.outcome}: ${r.message ?? ""}`, 200);
    if (action.op === "goto" || action.op === "back") return `ok: ${safeUrlLabel(r.url ?? "")}`;
    if (action.op === "screenshot") return `ok: ${r.shot?.path ?? "screenshot"}`;
    return "ok";
  }

  private errorReply(run: Run, e: unknown): BrowserActionReply {
    const recent = run.lastRefusal && this.now() - run.lastRefusal.at < REFUSAL_WINDOW_MS ? run.lastRefusal : undefined;
    if (recent) return { outcome: "refused", message: `the address was refused by the safety guard (${recent.reason})` };
    const msg = e instanceof Error ? e.message : String(e);
    return { outcome: "error", message: oneLine(this.redact(msg), 300) };
  }

  private settings(): BrowserSettings {
    return this.deps.settings();
  }

  /** A reason when the goto target may not be opened, else undefined. The egress proxy is the network guard. */
  private checkGoto(url: string): string | undefined {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return "not a valid URL";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "only http and https pages can be opened";
    if (u.username !== "" || u.password !== "") return "URLs with a user name or password are not allowed";
    const s = this.settings();
    return guardReason(url, true, s);
  }

  /**
   * The facts the verdict is decided on, read from the DOM. A press without a ref is judged on the element that really has
   * focus (`activeFacts`); when that cannot be read, `unreadable` is set and the caller fails closed to "ask".
   */
  private async gatherFacts(run: Run, session: BrowserSession, action: BrowserAction): Promise<{ refs: string[]; facts: Array<ElementFacts | undefined>; unreadable: boolean }> {
    if (action.op === "press" && action.ref === undefined) {
      try {
        const f = await session.activeFacts();
        if (f === undefined) return { refs: [], facts: [], unreadable: false };
        run.knownRefs.add(f.ref);
        return { refs: [f.ref], facts: [f], unreadable: false };
      } catch {
        return { refs: [], facts: [], unreadable: true };
      }
    }
    const refs = action.op === "click" || action.op === "type" ? [action.ref] : action.op === "fill" ? action.fields.map((f) => f.ref) : action.op === "press" && action.ref !== undefined ? [action.ref] : [];
    const facts: Array<ElementFacts | undefined> = [];
    for (const r of refs) facts.push(run.knownRefs.has(r) ? await session.facts(r) : undefined);
    return { refs, facts, unreadable: false };
  }

  private async dispatch(run: Run, session: BrowserSession, action: BrowserAction, host: CoreEngineHost): Promise<BrowserActionReply> {
    const { refs, facts, unreadable } = await this.gatherFacts(run, session, action);

    if (action.op === "goto") {
      const why = this.checkGoto(action.url);
      if (why !== undefined) return { outcome: "refused", message: why };
    }
    let verdict: Verdict;
    try {
      verdict = classifyAction(action, facts, session.url(), this.settings());
    } catch {
      return { outcome: "refused", message: "the browser settings could not be read, so nothing was done" };
    }
    if (verdict.verdict === "refuse") return { outcome: "refused", message: verdict.reason };
    if (verdict.verdict === "allow" && unreadable) verdict = { verdict: "ask", reason: "the element that has focus could not be read" };
    if (verdict.verdict === "ask") {
      const denied = await this.askUser(run, session, action, verdict.reason, facts, host);
      if (denied) return denied;
      if (run.ending) return { outcome: "error", message: "the browser session has ended" };
      // the page may have changed while the user decided: read again, and do nothing if it is stricter or a different element
      const again = await this.gatherFacts(run, session, action);
      let now: Verdict;
      try {
        now = classifyAction(action, again.facts, session.url(), this.settings());
      } catch {
        now = { verdict: "refuse", reason: "settings unreadable" };
      }
      const same = again.facts.length === facts.length && facts.every((f, i) => sameElement(f, again.facts[i]));
      const otherReason = now.verdict === "ask" && !unreadable && now.reason !== verdict.reason;
      if (now.verdict === "refuse" || !same || otherReason || (again.unreadable && !unreadable)) return { outcome: "denied", message: CHANGED_MESSAGE };
      return this.perform(run, session, action, again.refs.length > 0 ? again.refs : refs);
    }
    return this.perform(run, session, action, refs);
  }

  private async askUser(
    run: Run,
    session: BrowserSession,
    action: BrowserAction,
    reason: string,
    facts: ReadonlyArray<ElementFacts | undefined>,
    host: CoreEngineHost,
  ): Promise<BrowserActionReply | undefined> {
    const shot = await this.cardShot(run, session);
    const jobRef: JobRef = { jobId: run.jobId, templateId: run.spec.template.id, engine: "browser" };
    const masked = maskAction(action);
    const tool = `browser_${action.op}`;
    let policy: string;
    try {
      policy = await host.policy.checkPermission(jobRef, tool, masked);
    } catch {
      policy = "deny";
    }
    if (policy === "deny") return { outcome: "denied", message: "the job runner policy does not allow this action" };

    const where = safeUrlLabel(session.url());
    const target =
      action.op === "goto"
        ? safeUrlLabel(action.url)
        : action.op === "fill"
          ? `${action.fields.length} field(s)`
          : `'${oneLine(facts.find((f) => f !== undefined)?.name ?? "", 60)}'`;
    const summary = this.redact(oneLine(`${action.op} ${target} on ${where}: ${reason}`, 200));
    let answer: "allow_once" | "deny" = "deny";
    let message: string | undefined;
    try {
      const d = await host.askPermission({
        requestId: `${run.jobId}:a${++run.askSeq}`,
        jobId: run.jobId,
        engine: "browser",
        tool,
        kind: "browser",
        input: masked,
        summary,
        cwd: "",
        requestedAt: 0,
        timeoutSec: 0,
        ...(shot ? { attachments: [shot] } : {}),
      });
      answer = d.answer;
      message = d.message;
    } catch {
      answer = "deny";
    }
    if (answer === "allow_once") return undefined;
    return { outcome: "denied", message: message ?? "the user said no, or did not answer in time; nothing was done" };
  }

  /** The page as it is, for the permission card. Not announced as an `artifact` event (the card carries it). */
  private async cardShot(run: Run, session: BrowserSession): Promise<ArtifactRef | undefined> {
    const w = run.writer;
    if (!w || w.count >= this.settings().maxScreenshotsPerJob) return undefined;
    try {
      const slot = w.next();
      await session.screenshot(slot.abs, false);
      return w.commit(slot, `Before approval: ${safeUrlLabel(session.url())}`);
    } catch {
      return undefined;
    }
  }

  private async perform(run: Run, session: BrowserSession, action: BrowserAction, refs: string[]): Promise<BrowserActionReply> {
    switch (action.op) {
      case "goto": {
        const r = await session.goto(action.url);
        run.knownRefs = new Set();
        return { outcome: "done", url: r.url, title: r.title, text: `opened (status ${r.status ?? "n/a"}); call browser_read to see the page` };
      }
      case "back": {
        const r = await session.back();
        run.knownRefs = new Set();
        return { outcome: "done", url: r.url, title: r.title, text: "went back; call browser_read to see the page" };
      }
      case "read": {
        const snap = await session.snapshot(action.maxChars ?? READ_DEFAULT);
        run.knownRefs = new Set(snap.elements.map((e) => e.ref));
        return { outcome: "done", url: snap.url, title: snap.title, text: formatSnapshot(snap, TEXT_CAP) };
      }
      case "click":
        await session.click(action.ref);
        run.lastRef = action.ref;
        return { outcome: "done", url: session.url(), text: "clicked" };
      case "type":
        await session.type(action.ref, action.text, action.clear === true);
        run.lastRef = action.ref;
        return { outcome: "done", url: session.url(), text: "typed" };
      case "fill":
        for (const f of action.fields) await session.fill(f.ref, f.value);
        run.lastRef = action.fields[action.fields.length - 1]?.ref;
        return { outcome: "done", url: session.url(), text: `filled ${action.fields.length} field(s)` };
      case "press":
        await session.press(action.key, action.ref ?? refs[0]);
        return { outcome: "done", url: session.url(), text: `pressed ${action.key}` };
      case "screenshot": {
        const w = run.writer;
        if (!w) return { outcome: "error", message: "the session has no screenshot folder" };
        if (w.count >= this.settings().maxScreenshotsPerJob) return { outcome: "refused", message: "the screenshot limit for this job was reached" };
        const slot = w.next();
        await session.screenshot(slot.abs, action.fullPage === true);
        const shot = w.commit(slot, `Screenshot ${w.count}: ${safeUrlLabel(session.url())}`);
        this.emit(run, { kind: "artifact", artifact: shot });
        return { outcome: "done", url: session.url(), shot, text: `screenshot ${w.count} taken` };
      }
      case "done":
        return { outcome: "done", message: "session closed" };
    }
  }
}
