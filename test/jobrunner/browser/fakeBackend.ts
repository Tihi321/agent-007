/**
 * Test doubles for the browser driver (REQ-0014 T3). Not a test file. An in-memory page with scripted elements, a fake
 * installer, a fake egress proxy and a fake host. Nothing here starts Chromium, opens a socket or downloads anything.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserKey } from "../../../src/jobs/browserContracts.js";
import type { JobEvent, JobTemplate, PermissionDecision, PermissionRequest, PolicyVerdict } from "../../../src/jobs/contracts.js";
import type { BrowserBackend, BrowserSession, ElementFacts, LaunchOptions, PageSnapshot } from "../../../src/jobrunner/drivers/browser/backend.js";
import { BrowserDriver } from "../../../src/jobrunner/drivers/browser/driver.js";
import type { ChromiumInstaller } from "../../../src/jobrunner/drivers/browser/index.js";
import type { CoreEngineHost } from "../../../src/jobrunner/manager.js";
import { DEFAULT_BROWSER_SETTINGS } from "../../../src/settings/browser.js";
import type { BrowserSettings } from "../../../src/settings/browser.js";

export const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..");
export const TEMP_BASE = join(ROOT, ".claude", "temp");
export const JOB_ID = "job-0123456789ab";

export function facts(over: Partial<ElementFacts> & { ref: string }): ElementFacts {
  return {
    tag: "a",
    type: "",
    role: "link",
    name: "",
    autocomplete: "",
    nameAttr: "",
    idAttr: "",
    inForm: false,
    isSubmit: false,
    formAction: "",
    formHasPassword: false,
    href: "",
    contentEditable: false,
    visible: true,
    ...over,
  };
}

export interface Call {
  op: string;
  args: unknown[];
}

export class FakeSession implements BrowserSession {
  readonly calls: Call[] = [];
  private closeCb: (() => void) | undefined;
  closed = false;
  constructor(
    private readonly elements: ElementFacts[],
    private page: { url: string; title: string },
  ) {}
  private log(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args });
  }
  async goto(url: string) {
    this.log("goto", url);
    this.page = { url, title: "page" };
    return { url, title: "page", status: 200 };
  }
  async back() {
    this.log("back");
    return { ...this.page };
  }
  async snapshot(_max: number): Promise<PageSnapshot> {
    this.log("snapshot");
    return {
      ...this.page,
      text: "hello",
      truncated: false,
      elements: this.elements.map((e) => ({ ref: e.ref, role: e.role, name: e.name, tag: e.tag, inForm: e.inForm, ...(e.type ? { type: e.type } : {}) })),
    };
  }
  async facts(ref: string) {
    return this.elements.find((e) => e.ref === ref);
  }
  async click(ref: string) {
    this.log("click", ref);
  }
  async type(ref: string, text: string, clear: boolean) {
    this.log("type", ref, text, clear);
  }
  async fill(ref: string, value: string) {
    this.log("fill", ref, value);
  }
  async press(key: BrowserKey, ref?: string) {
    this.log("press", key, ref);
  }
  async screenshot(file: string, fullPage: boolean) {
    this.log("screenshot", fullPage);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    writeFileSync(file, png);
    return { bytes: png.length };
  }
  url(): string {
    return this.page.url;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  /** The user closes the window. */
  userCloses(): void {
    this.closeCb?.();
  }
  count(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }
}

export class FakeBackend implements BrowserBackend {
  readonly launches: LaunchOptions[] = [];
  session?: FakeSession;
  constructor(
    private readonly elements: ElementFacts[],
    private readonly url = "https://shop.example.com/",
  ) {}
  async launch(o: LaunchOptions): Promise<BrowserSession> {
    this.launches.push(o);
    this.session = new FakeSession(this.elements, { url: this.url, title: "Shop" });
    return this.session;
  }
}

export class FakeInstaller implements ChromiumInstaller {
  installs = 0;
  constructor(public installed: boolean) {}
  status() {
    return this.installed ? { installed: true, executable: "chrome.exe" } : { installed: false };
  }
  async install(_signal: AbortSignal): Promise<void> {
    this.installs += 1;
    this.installed = true;
  }
}

export class FakeHost implements CoreEngineHost {
  readonly jobId = JOB_ID;
  readonly channel = undefined;
  readonly asked: PermissionRequest[] = [];
  verdict: PolicyVerdict = "ask";
  answer: (req: PermissionRequest) => PermissionDecision["answer"] = () => "allow_once";
  readonly policy = { checkPermission: (): PolicyVerdict => this.verdict };
  reportChildPid(): void {}
  async askPermission(req: PermissionRequest): Promise<PermissionDecision> {
    this.asked.push(req);
    return { requestId: req.requestId, jobId: req.jobId, answer: this.answer(req), by: "user", at: 0 };
  }
}

export function template(): JobTemplate {
  return {
    id: "browser-session",
    title: "Browser",
    description: "browse",
    engine: "browser",
    cwd: ROOT,
    prompt: "Browse the web for the user.\n\n{{brief}}",
    params: { type: "object" },
    permissionMode: "default",
    allowedTools: [],
    disallowedTools: [],
    mcpServers: [],
    flow: { enabled: false },
    paidModels: false,
    autostart: [],
    timeoutMin: 60,
  };
}

export interface Rig {
  driver: BrowserDriver;
  backend: FakeBackend;
  installer: FakeInstaller;
  host: FakeHost;
  dir: string;
  artifactsDir: string;
  start(): Promise<void>;
  /** Ends the session through `browser_done` and returns every event. */
  finish(): Promise<JobEvent[]>;
  events(): Promise<JobEvent[]>;
}

export function rig(o: { elements?: ElementFacts[]; installed?: boolean; settings?: Partial<BrowserSettings> } = {}): Rig {
  mkdirSync(TEMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TEMP_BASE, "bs-"));
  const backend = new FakeBackend(o.elements ?? []);
  const installer = new FakeInstaller(o.installed ?? true);
  const host = new FakeHost();
  const artifactsDir = join(dir, "shots");
  const settings = { ...DEFAULT_BROWSER_SETTINGS, ...o.settings };
  const driver = new BrowserDriver(
    {
      backend,
      paths: { profileDir: join(dir, "profile"), artifactsDir, browsersDir: join(dir, "ms-playwright"), lockFile: join(dir, "profile.lock") },
      headless: true,
      idleMin: 10,
      settings: () => settings,
      installer,
      egress: async () => ({ server: "http://127.0.0.1:1", username: "u", password: "p", close: async () => undefined }),
    },
    { info: { version: "0.0.0-test", chromiumRevision: "1", dir: "" } },
  );
  const events = async (): Promise<JobEvent[]> => {
    const out: JobEvent[] = [];
    for await (const e of driver.events(JOB_ID)) out.push(e);
    return out;
  };
  return {
    driver,
    backend,
    installer,
    host,
    dir,
    artifactsDir,
    start: () => driver.start({ jobId: JOB_ID, template: template(), params: {}, brief: "b", prompt: "p", cwd: ROOT, host }),
    finish: async () => {
      await driver.act(JOB_ID, { jobId: JOB_ID, callId: "done", action: { op: "done", summary: "finished" } }, host);
      return events();
    },
    events,
  };
}
