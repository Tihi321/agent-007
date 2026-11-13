---
status: done
request: REQ-0014
repos: [agent-007]
branch: agent-007-browser-support
updated: 2026-11-11
---
# agent-007 browser support: plan

Ticket folder: `.claude/tickets/REQ-0014-browser-support/`. The evidence (file:line refs) is in `research.md`; the refs this plan
builds on were re-read on master 4b01440. Requirements and decisions: `.claude/director/requests/REQ-0014-browser-support.md`.

Workers must not run `yarn build` / `yarn test` in the main checkout (its `dist/` serves the user's running gateway). Work in a
worktree on branch `agent-007-browser-support`. Node: `fnm exec --using default yarn ...` if `node` is not on PATH.

## Decisions (user, 2026-11-11)

- D1 Driver = option A. A `browser` engine in the job runner owns the Playwright session. The agent's local model drives it with
  deferred `browser_*` tools over a new IPC request type. Screenshots travel by file path, never as bytes (IPC line cap 1 MiB,
  `src/ipc/protocol.ts:48`).
- D2 Chromium is downloaded on first use, owner-confirmed in Telegram first, by a pinned `playwright-core`, into a runner-owned
  folder, never at install or build time, with a clear failure message. This overrides the earlier no-runtime-downloads policy
  (windows-exe plan, `prepare-node.mjs` "No download"), by the user's own choice on 2026-11-11. It is the only runtime download.
- D3 The web UI gets an owner-only job/artifact view now. Images come from a same-origin authenticated route (CSP `img-src 'self'`,
  `src/web/http.ts:12`, stays unchanged).
- D4 Logins: a one-off visible-login command opens the isolated profile headed; the user logs in by hand. Jobs run headless. The
  agent never types into credential fields; typed values are masked in permission cards, events, journal and audit.

## Decisions made in this plan (defaults, with the reason)

1. **Profile and screenshots live under the job runner's data dir**, not the agent's:
   - profile `<runner dataDir>\browser\profile`, Chromium `<runner dataDir>\browser\ms-playwright`, screenshots
     `<runner dataDir>\browser\shots\<jobId>\NNN.png` plus `manifest.json`;
   - desktop: `<root>\jobrunner-data\browser\...`; deploy: `%LOCALAPPDATA%\agent-007-jobrunner\browser\...` of the main user.
   - Why: Chromium runs in the runner (main user in deploy). The agent user must never read cookies, so the profile inherits the
     data dir's main-user-only ACL (`deploy/jobrunner/install-jobrunner.ps1:184`, `Set-JobRunnerDataDirAcl`). Only `shots\` gets an
     extra "agent user Read" ACE, the same shape as `Set-JobRunnerTemplatesDirAcl` (`install-jobrunner.ps1:124-131`), so the Telegram
     agent and the web gateway (both run as the agent user, `deploy/web/README.md:56`) can read the PNGs by path.
   - R2 said "under the agent's data dir"; this deviates on purpose (the runner owns the session, D1). Tell the user.
   - The agent learns the folder from a new bootstrap key `paths.jobArtifactsDir` in `config.json` (admin-only). Absent = no images
     are delivered, text still is.
2. **Navigation guard = an egress proxy in the runner**, not only `page.route`. Chromium is launched with
   `proxy: {server: "http://127.0.0.1:<random>", username, password}` and `--proxy-bypass-list=<-loopback>`, so every request,
   redirect, sub-resource and WebSocket goes through a runner-owned loopback CONNECT/HTTP proxy that resolves DNS itself, refuses any
   name that resolves to a blocked address (loopback, private, link-local, CGNAT, tailnet, mapped v6), refuses `BLOCKED_PORTS`
   (1234, 8080, 8787, 47007, 47008, 47009; `src/web/runtime/ssrf.ts:10`), and connects to the vetted IP (no DNS rebinding). The proxy
   needs a random per-session credential, so no other local process can use it as an open proxy. `page.route` is kept only for
   scheme rules (`file:`, `chrome:`, `data:` / `javascript:` top-level navigations, `blob:` downloads) and the owner's domain lists.
   Why: `page.route` does not reliably see redirects, service workers or WebSockets; a proxy sees all of them.
3. **Risky-action classifier** runs in the runner on element facts the runner reads from the DOM (never on what the model claims).
   Rules are in T3; summary: credential/payment/OTP/file fields are **refused** (never typed, never asked); form submits, Enter in a
   form, clicks whose label matches a risky word, typing into login/payment/personal-data forms and every write action on an
   owner-listed `askDomains` host **always ask**; reads, screenshots, plain links and plain typing are allowed.
4. **Ack key**: a new security.json section `browser` with `browser.acknowledged` (UI only, form with `ack` text, like
   `termsAccepted`: `src/jobrunner/settingsUi/forms/phase4.ts:7-19,48-52`). Not a `termsAccepted.browser` key: those are provider
   terms cross-checked by bot validation (`src/bots/schema.ts:64,313-316,483`); the browser is not a provider. The runner treats the
   browser engine as disabled until `browser.acknowledged === true`.
5. **Settings**: the `browser` section (acknowledged, allowedDomains, blockedDomains, askDomains, extraRiskyWords,
   maxScreenshotsPerJob) in security.json, one form `browser` in group "Jobs". Machine paths and the engine switch stay in
   `jobrunner.json` `engines.browser` (`enabled` default **true**, the ack is the real gate; an admin can still set false).
6. **No resume**: a browser session does not survive a job runner restart. The driver never reports an `engineSessionId`, so the
   existing resume path refuses (`src/jobrunner/manager.ts:387`) and the job fails with "dispatch a new browser session".
7. **Lifecycle**: one job = one browser session. It ends on `browser_done`, after `idleMin` (default 10) with no action, at the
   template `timeoutMin` (60), on cancel, or on a driver error. `maxConcurrent.browser` is fixed at 1 (one profile can be open once).
8. **Visible login** is a runner CLI subcommand `browser-login` (and `browser-install`), run by the user as the main user, plus a
   desktop tray item that spawns it. Never a Telegram command and never reachable by the model.
9. **Packaging**: `playwright-core` is an exact-pinned production dependency. It ships in `build/stage/node_modules` (desktop) and
   via `deploy-app.ps1` (deploy). No browser binary is bundled or downloaded at install or build time; `verify-package.mjs` asserts
   both. Only `src/jobrunner/drivers/browser/**` may import `playwright-core` (boundary check).

## Scope

- A `browser` job engine in the job runner with a persistent isolated Chromium profile, driven step by step by the agent's local model
  through 9 deferred tools: `browser_goto`, `browser_back`, `browser_read`, `browser_click`, `browser_type`, `browser_fill`,
  `browser_press`, `browser_screenshot`, `browser_done`.
- One template `browser-session` (params `startUrl?`), approved from Telegram like every job; the card says it browses the web.
- Mid-job approval of risky actions through the existing `host.askPermission` path (Allow once / Deny), with a screenshot of the page
  sent before the card.
- First-use Chromium download behind a Telegram permission card, and a `browser-install` CLI.
- `browser-login` CLI (headed, same profile, same egress proxy) and a desktop tray item for it.
- Screenshots to Telegram (`sendPhoto`) and to an owner-only web view (`/api/owner/jobs`, `/api/owner/artifact`).
- The `browser` settings section and form, the ack gate, the deploy installer ACL for `shots\`, desktop setup wiring, docs.

## Out of scope

- The model typing passwords, OTP codes or card numbers, or reading them back. File uploads and downloads (`acceptDownloads: false`).
- Browser tools for user bots, web chat bots, peer-triggered (bot-to-bot) turns or bots with a cloud preset in their route.
- Resuming a browser session after a runner restart; several browser sessions at once; multiple profiles.
- Showing images to the model (the local text model gets text only; screenshots are for the user).
- Using the installed Chrome or Edge binary or any existing user profile; extensions; `--remote-debugging-port`.
- Bundling Chromium in the installer; any download at `yarn install`, `yarn dist` or installer time; auto-update of Chromium.
- A Telegram `/browser` command; inbound photos; a web UI for anything but browser job screenshots.
- An outbound firewall for the job runner as a whole; macOS/Linux.

## Files and modules to touch

New:
- `src/jobs/browserContracts.ts`: browser IPC types (T1).
- `src/jobrunner/drivers/browser/`: `index.ts` (`createDriver`), `driver.ts`, `classify.ts`, `backend.ts` (interface),
  `playwright.ts` (real backend), `snapshot.ts` (the in-page script as a string), `egress.ts` (proxy), `install.ts`,
  `artifacts.ts` (shot writer + manifest), `lock.ts` (profile lock), `cli.ts` (`browser-install`, `browser-login`).
- `src/settings/browser.ts`: `BrowserSettings`, `readBrowserSettings`.
- `src/jobrunner/settingsUi/forms/browser.ts`: the form descriptor and `BROWSER_ACK_TEXT`.
- `src/browser/tools.ts`: the agent-side deferred tools.
- `src/artifacts/store.ts`: safe reading of a screenshot by relative path (Telegram agent and gateway).
- `src/web/routes/owner.ts`: the two owner routes. `ui/web/jobs.js`: the view.
- `config/templates/browser-session.json`.
- Tests: `test/jobrunner/browser/{fakeBackend.ts,classify.test.ts,egress.test.ts,driver.test.ts,real-chromium.test.ts}`,
  `test/browser/tools.test.ts`, `test/artifacts/store.test.ts`, `test/web/owner-artifacts.test.ts`.

Changed (owner task in brackets):
- `src/jobs/contracts.ts`, `src/ipc/protocol.ts`, `src/ipc/client.ts`, `test/helpers/fakeJobRunner.ts`, compile stubs in
  `src/jobrunner/manager.ts`, `src/jobrunner/limits.ts`, `src/jobs/progress.ts`, pinned-list tests [T1].
- `src/web/runtime/ssrf.ts` [T2].
- `src/jobrunner/manager.ts`, `server.ts`, `main.ts`, `limits.ts`, `templates.ts`, `src/jobs/tools.ts` (`summarizeTemplate` cloud
  use), `config/jobrunner.example.json` [T4].
- `src/settings/schema.ts`, `src/settings/split.ts`, `src/jobrunner/settingsUi/forms/registry.ts` [T5].
- `src/agent/phase2.ts`, `src/jobs/task.ts`, `src/jobs/approval.ts` (card lines), `src/config/schema.ts` (`paths.jobArtifactsDir`),
  `src/settings/catalog.ts`, `src/bots/schema.ts`, `src/botbus/capabilities.ts`, `src/web/capabilities.ts` [T6].
- `src/telegram/jobUi.ts` [T7].
- `src/web/app.ts`, `ui/web/index.html`, `ui/web/sidebar.js`, `ui/web/app.js`, `ui/web/app.css` [T8].
- `package.json`, `yarn.lock`, `scripts/desktop/verify-package.mjs`, `scripts/check-adapter-boundary.ts`,
  `deploy/jobrunner/install-jobrunner.ps1`, `deploy/jobrunner/check-jobrunner.ps1`, `deploy/acl-write.ps1`,
  `src/setup/personal.ts`, `src/desktop/main.ts`, `src/desktop/tray.ts`, `README.md`, `deploy/README-ops.md` [T9; the dependency
  add itself is step 0 of T1].

## Tasks for workers

Order: **T1 alone first** (it adds the dependency and the shared types and keeps the build green). Then **T2, T3, T4, T5, T6, T7,
T8, T9 in parallel** (disjoint files; each codes against the contracts below, not against another task's code). Then **T10** last.
If two parallel tasks must touch one file, the owner listed above makes the edit and the other task asks through the orchestrator.

### T1: dependency, shared contracts, IPC op, compile stubs (serial, first)

- Inputs: this plan; `src/jobs/contracts.ts:97-101,205-216,231,262-276,476-497,540-557`; `src/ipc/protocol.ts:60-86`;
  `src/ipc/client.ts:226,318`; `test/helpers/fakeJobRunner.ts`.
- Step 0 [GO needed from the user]: add `playwright-core` to `dependencies` at an **exact** version (the latest stable that is at
  least two weeks old; record it in this plan's Risks section). `yarn install` with `enableScripts: false` (no postinstall runs).
  Commit `yarn.lock`. No browser download.
- Outputs:
  - `src/jobs/contracts.ts`:
    ```ts
    export type JobEngine = "claude" | "dsh" | "hub" | "browser";
    export const JOB_ENGINES: readonly JobEngine[] = ["claude", "dsh", "hub", "browser"];
    export type CloudUse = "claude-subscription" | "deepseek-api" | "google-flow" | "web-browsing";
    export type PermissionKind = "execute" | "read" | "edit" | "flow" | "browser" | "other";

    /** A file the runner wrote under its artifacts root. `path` is RELATIVE: `<jobId>/<NNN>.png`. Never an absolute path. */
    export interface ArtifactRef {
      path: string;          // /^job-[0-9a-f]{12}\/\d{3}\.png$/ for screenshots (jobIdFor format, src/jobs/tools.ts:265)
      mime: "image/png";
      bytes: number;         // <= 5 MiB
      sha256: string;        // hex of the file
      caption: string;       // <= 200 chars, no query string or fragment of any URL
    }
    // JobEvent: add one variant
    | { kind: "artifact"; artifact: ArtifactRef }
    // PermissionRequest: add
    attachments?: ArtifactRef[];   // at most 1: the page as it is when the card is sent
    // JobDone.artifacts stays string[]: the relative paths, in order
    // JobRunnerClient: add
    browserAction(body: BrowserActionBody, opts?: CallOptions): Promise<BrowserActionReply>;
    // JobApprovalTransport: add
    postArtifact(post: JobArtifactPost): Promise<void>;
    export interface JobArtifactPost { jobId: string; conversationId: string; artifact: ArtifactRef; index: number }
    // DEFERRED_KNOWN_TOOLS: append the 9 browser_* names (BROWSER_TOOL_NAMES from browserContracts.ts)
    ```
  - `src/jobs/browserContracts.ts` (the IPC contract between T4 and T6, and the driver contract for T3):
    ```ts
    export const BROWSER_TOOL_NAMES = ["browser_goto","browser_back","browser_read","browser_click","browser_type",
      "browser_fill","browser_press","browser_screenshot","browser_done"] as const;
    export const BROWSER_KEYS = ["Enter","Tab","Escape","ArrowDown","ArrowUp","PageDown","PageUp","Home","End","Backspace"] as const;
    export type BrowserKey = (typeof BROWSER_KEYS)[number];
    /** `ref` = an element id from the last `read`, /^e\d{1,5}$/. */
    export type BrowserAction =
      | { op: "goto"; url: string }                                   // http(s) only, <= 2048 chars
      | { op: "back" }
      | { op: "read"; maxChars?: number }                             // default 12000, 1000..40000
      | { op: "click"; ref: string }
      | { op: "type"; ref: string; text: string; clear?: boolean }    // text <= 2000
      | { op: "fill"; fields: { ref: string; value: string }[] }      // 1..20 fields, value <= 2000; <select> takes the option label or value
      | { op: "press"; key: BrowserKey; ref?: string }
      | { op: "screenshot"; fullPage?: boolean }                      // fullPage is clipped to 1280x4000
      | { op: "done"; summary: string };                              // <= 2000
    export interface BrowserActionBody { jobId: string; callId: string; action: BrowserAction }  // callId /^[A-Za-z0-9_.:-]{1,100}$/
    export type BrowserOutcome = "done" | "denied" | "refused" | "error";
    export interface BrowserActionReply {
      outcome: BrowserOutcome;        // denied = the user said no or timed out; refused = a rule said no, nobody was asked
      url?: string;                   // full URL of the page after the action (only the model sees it)
      title?: string;
      text?: string;                  // untrusted page content (read), or a one-line result; <= 40000 chars
      shot?: ArtifactRef;
      message?: string;               // why (denied, refused, error), plain text for the model
    }
    ```
  - `src/ipc/protocol.ts`: `"browser_action"` in `REQUEST_TYPES` and
    `browser_action: { body: BrowserActionBody; reply: BrowserActionReply }` in `RequestMap`. New `IpcErrorCode` value
    `"not_running"` (job exists but is not `running`).
  - `src/ipc/client.ts`: `browserAction` with a default timeout of `opts.timeoutMs` (the caller passes it; see T6).
  - `test/helpers/fakeJobRunner.ts`: `browserAction` scripted by a callback, and `postArtifact` on any fake transport.
  - Compile stubs only, so the build stays green: `queues` gets `browser: []` (`manager.ts:193`); `limits.ts` parses
    `limits.maxConcurrent.browser` (int 1..1, default 1) and `engines.browser` as `{enabled}` (default true; T4 adds the rest);
    the event-kind switches (`manager.ts:749`, `src/jobs/progress.ts:78`) ignore `artifact`; the server answers
    `browser_action` with `unsupported` until T4; `engineEnabled` returns false for `browser` until T4.
  - **Cross-task stubs**, so every parallel worktree builds on its own. Each file has the exact exported types and signatures
    given in the owning task below; function bodies `throw new Error("not implemented: <task>")` unless noted. The owning task
    replaces the bodies and keeps the signatures (a signature change goes through the orchestrator):
    - `src/settings/browser.ts` (owner T5): `BrowserSettings`, a **real** `DEFAULT_BROWSER_SETTINGS`, stub `readBrowserSettings`.
    - `src/jobrunner/drivers/browser/egress.ts` (owner T2): `EgressOptions`, `EgressProxy`, stub `startEgressProxy`.
    - `src/jobrunner/drivers/browser/backend.ts` (owner T3): `SnapshotElement`, `PageSnapshot`, `ElementFacts`, `LaunchOptions`,
      `BrowserSession`, `BrowserBackend` (types only).
    - `src/jobrunner/drivers/browser/index.ts` (owner T3): `BrowserEngineDriver`, `BrowserDriverDeps`, `ChromiumInstaller`
      (types as in T3) and a stub `createDriver(ctx: DriverFactoryContext): BrowserEngineDriver`. T3 may move the implementation
      into `driver.ts` but `index.ts` keeps exporting these names.
    - `src/artifacts/store.ts` (owner T7): `ArtifactRead`, `JobManifest`, stub `readArtifact`, stub `listManifests`.
  - T1 does not wire the stubs into running code paths (the browser driver is not loaded yet, routes are not mounted), so
    `yarn test` stays green.
  - Update the pinned-list tests (`grep -rn "JOB_ENGINES\|REQUEST_TYPES\|DEFERRED_KNOWN_TOOLS" test/`). Do not add new tests.
- Done when `yarn build` and `yarn test` pass in the worktree.

**Rule for T2-T9**: each task is done when `yarn build` and its own tests pass against T1's stubs (other tasks' stubs still throw).
Tests that need another task's real code belong to T10.

### T2: URL vetting and the egress proxy (parallel)

- Inputs: `src/web/runtime/ssrf.ts` (whole file, 125 lines); the existing ssrf tests (`grep -rln ssrf test/`).
- Outputs:
  - `src/web/runtime/ssrf.ts`: split `checkUrl` into an exported `vetUrlShape(input: string): {ok:true; url: URL; host: string} |
    {ok:false; reason:string}` (scheme, credentials, local names, blocked ports, numeric tricks, literal blocked IPs) and keep
    `checkUrl` behaviour byte-identical on top of it (the existing tests prove it). Add
    `export async function vetPublicHost(host: string, port: number, resolver: Resolver): Promise<{ok:true; addresses:string[]} | {ok:false; reason:string}>`
    (no allowlist; refuses blocked ports, local names, and a DNS answer with ANY blocked address).
  - `src/jobrunner/drivers/browser/egress.ts`:
    ```ts
    export interface EgressOptions {
      resolver?: Resolver;                       // default: dns.promises.lookup(host, {all:true})
      /** TEST SEAM ONLY: hosts (e.g. "127.0.0.1") that skip the address check. Never read from config. */
      testAllowHosts?: readonly string[];
      onRefused?: (host: string, reason: string) => void;
    }
    export interface EgressProxy { server: string; username: string; password: string; close(): Promise<void> }
    export function startEgressProxy(o?: EgressOptions): Promise<EgressProxy>;
    ```
    - Listens on 127.0.0.1 port 0; refuses non-loopback peers; requires `Proxy-Authorization: Basic` with the random credential
      (32 bytes base64url) on every request and CONNECT, else 407.
    - Handles `CONNECT host:port` (https, wss) and absolute-form HTTP requests (http, ws). For each: `vetPublicHost`, then connect
      to the first vetted address (not the name). Refusal: 403 with a short reason; `onRefused` is called.
    - Idle socket timeout 120 s; max 256 concurrent sockets.
- Contract with T3: T3 calls `startEgressProxy()` once per session and passes `{server, username, password}` to the backend launch.
- Stub: T2 replaces the body of T1's `startEgressProxy` stub in `egress.ts`; the exported types stay as T1 wrote them.
- Tests: `test/jobrunner/browser/egress.test.ts` (see Acceptance).
- Done when `yarn build` and T2's own tests pass against T1's stubs.

### T3: browser driver, classifier, backends, install, CLI (parallel)

- Inputs: `src/jobs/contracts.ts:340-363` (`EngineDriver`, `EngineHost`, `EngineStartSpec`); `src/jobrunner/manager.ts:76-93`
  (`CoreEngineHost`); the dsh driver as the pattern for asking (`src/jobrunner/drivers/dsh/driver.ts:371,395`);
  `src/jobrunner/drivers/dsh/index.ts:36-44` (`createDriver`); T1, T2, T5 contracts.
- Outputs (all under `src/jobrunner/drivers/browser/`):
  - `backend.ts`:
    ```ts
    export interface SnapshotElement { ref: string; role: string; name: string; tag: string; type?: string; value?: string; inForm: boolean }
    export interface PageSnapshot { url: string; title: string; text: string; elements: SnapshotElement[]; truncated: boolean }
    export interface ElementFacts {
      ref: string; tag: string; type: string; role: string;
      name: string;                // accessible name / text / value, <= 120 chars
      autocomplete: string; nameAttr: string; idAttr: string;
      inForm: boolean; isSubmit: boolean;          // submit button, input[type=submit|image], or <button> without type in a form
      formAction: string; formHasPassword: boolean;
      href: string; contentEditable: boolean; visible: boolean;
    }
    export interface LaunchOptions {
      profileDir: string; headless: boolean; browsersDir: string;
      proxy: { server: string; username: string; password: string };
      viewport: { width: 1280; height: 800 };
    }
    export interface BrowserSession {
      goto(url: string): Promise<{ url: string; title: string; status?: number }>;
      back(): Promise<{ url: string; title: string }>;
      snapshot(maxChars: number): Promise<PageSnapshot>;   // tags interactive elements with data-a7-ref="eN"; password values never returned
      facts(ref: string): Promise<ElementFacts | undefined>;
      click(ref: string): Promise<void>;
      type(ref: string, text: string, clear: boolean): Promise<void>;
      fill(ref: string, value: string): Promise<void>;     // select: option by label, then by value
      press(key: BrowserKey, ref?: string): Promise<void>;
      screenshot(file: string, fullPage: boolean): Promise<{ bytes: number }>;
      url(): string;
      onClose(cb: () => void): void;                       // the user closed the window, or Chromium crashed
      close(): Promise<void>;
    }
    export interface BrowserBackend { launch(o: LaunchOptions): Promise<BrowserSession> }
    ```
  - `playwright.ts`: `PlaywrightBackend` with `chromium.launchPersistentContext(profileDir, { headless, proxy, viewport,
    acceptDownloads: false, serviceWorkers: "block", bypassCSP: false, permissions: [], args: ["--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-extensions"] })`. Never `--no-sandbox`, never a
    debugging port, never `channel`/`executablePath` of an installed browser. `PLAYWRIGHT_BROWSERS_PATH` is set to `browsersDir`
    before the dynamic `import("playwright-core")`. `page.route("**/*")` aborts non-http(s) top-level navigations and hosts on
    `blockedDomains` / off `allowedDomains` (when that list is non-empty). Popups: a new page is closed and its URL goes through
    `goto` rules instead. Dialogs (`alert/confirm/prompt`) are dismissed and reported in the next reply.
  - `snapshot.ts`: the in-page enumeration script (interactive elements, visible text to `maxChars`, `data-a7-ref`).
  - `classify.ts` (pure, the rule table; `settings` is `BrowserSettings` from T5):
    ```ts
    export type Verdict = { verdict: "allow" } | { verdict: "ask"; reason: string } | { verdict: "refuse"; reason: string };
    export function classifyAction(action: BrowserAction, facts: ElementFacts[] /* one per ref, in order */, pageUrl: string, settings: BrowserSettings): Verdict;
    export function isCredentialField(f: ElementFacts): boolean;
    export function maskAction(action: BrowserAction): Json;   // text/value -> "‹masked, N chars›"; URLs lose query and fragment
    ```
    Rules, first match wins:
    1. **refuse** `type`/`fill`/`press` into a credential field: `type` in {password, file}; `autocomplete` contains
       `password`, `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`; `nameAttr`/`idAttr` matches
       `/pass(word|wd)?|pwd|otp|2fa|totp|cvv|cvc|card.?num|iban|ssn|pin\b/i`. Reason: "credential fields are filled by you in
       browser-login, never by the agent".
    2. **refuse** a click on `input[type=file]`; any `ref` not in the last snapshot ("call browser_read first").
    3. **ask** every action except `read`, `screenshot`, `back`, `done` when the page host is on `askDomains`.
    4. **ask** `click` when `isSubmit`, or when `name`/`href` matches the risky words
       `/\b(send|submit|post|publish|reply|pay|buy|purchase|order|checkout|check out|confirm|delete|remove|cancel subscription|transfer|subscribe|sign ?up|register|book|reserve|donate|log ?in|sign ?in|accept|agree|authori[sz]e|allow|install|upload|share)\b/i`
       plus `extraRiskyWords`.
    5. **ask** `press Enter` when the focused/ref element is in a form; **ask** `fill` when it contains any field in a form
       with `formHasPassword`, or `formAction`/page path matches `/login|signin|sign-in|auth|checkout|payment|pay|billing|wallet|account/i`,
       or any `autocomplete` in {email, username, tel, street-address, address-line1, postal-code, cc-name, bday}.
    6. **ask** `type` under the same form conditions as rule 5.
    7. **allow** everything else (goto passes the guard first; a refused goto is `refuse`).
  - `driver.ts`: `BrowserDriver implements EngineDriver` plus the method T4 calls:
    ```ts
    export interface BrowserEngineDriver extends EngineDriver {
      readonly engine: "browser";
      act(jobId: string, body: BrowserActionBody, host: CoreEngineHost): Promise<BrowserActionReply>;
    }
    export interface BrowserDriverDeps {
      backend: BrowserBackend;
      paths: { profileDir: string; artifactsDir: string; browsersDir: string; lockFile: string };
      headless: boolean;
      idleMin: number;
      settings: () => BrowserSettings;            // read at each action (T5 readBrowserSettings)
      installer: ChromiumInstaller;               // install.ts
      egress: (o: EgressOptions) => Promise<EgressProxy>;
      now?: () => number;
    }
    ```
    - `version()` returns `playwright-core <ver> chromium <revision>` (from `playwright-core/browsers.json`).
    - `start(spec)`: take the profile lock (`lock.ts`: exclusive create of `lockFile` with the pid; a stale lock of a dead pid
      is replaced); if Chromium is missing, ask first:
      `host.askPermission({requestId: "<jobId>:install", jobId, engine: "browser", tool: "browser_install", kind: "browser",
      input: {playwrightCore, chromiumRevision, approxSize: "about 150-300 MB", into: browsersDir, from: "Playwright's download CDN"},
      summary: "Download Chromium <rev> for browser jobs (one time)", cwd: "", requestedAt: 0, timeoutSec: 0})`; on
      `allow_once` run the installer and emit `progress` events; on deny fail the job with exactly: "Chromium is not installed and
      the download was not approved. Approve the download card on the next browser job, or run `node dist\src\jobrunner\main.js
      browser-install` as the job runner user." Then start the egress proxy, launch the backend, emit `init` (no
      `engineSessionId`), and `goto(startUrl)` when the param is set.
    - `act`: one action at a time per job (a second concurrent call gets `IpcHandlerError("busy")`); replies are cached per
      `callId` (last 50) so a retried call never clicks twice. Order per action: validate (strict, unknown keys refused) →
      facts for each `ref` → `classifyAction` → for `ask`: screenshot → `host.policy.checkPermission` (a `deny` there is final)
      → `host.askPermission({..., tool: "browser_<op>", kind: "browser", input: maskAction(action), summary: "<op> '<name>' on
      <origin><path>: <reason>", attachments: [shot]})` → perform only on `allow_once`. Emits `tool_call` (masked input),
      `tool_result` (one line, no page text), `artifact` events. Screenshots go to `<artifactsDir>/<jobId>/NNN.png` via
      `artifacts.ts`, which also rewrites `manifest.json` `{jobId, templateId, startedAt, endedAt?, state, shots:[{path, at,
      caption}]}`; past `maxScreenshotsPerJob` a screenshot is refused.
    - `done`, idle timeout, `onClose`, cancel: close the session, stop the proxy, release the lock, emit `result` then the
      terminal `state`. A result text: `summary` from `done`, or "idle for N min, session closed".
  - `install.ts`: `ChromiumInstaller { status(): {installed: boolean; executable?: string}; install(signal): Promise<void> }`.
    `install` spawns `process.execPath <playwright-core dir>/cli.js install chromium` (resolved through
    `createRequire(import.meta.url).resolve("playwright-core/package.json")`), no shell, `windowsHide`, env
    `PLAYWRIGHT_BROWSERS_PATH=<browsersDir>`, 15 min timeout, stderr tail in the error. Afterwards it checks that the executable
    exists, else fails "the Chromium download finished but no browser was found in <dir>".
  - `cli.ts`: `browser-install` (prints what and where, asks `Download Chromium <rev> (about 150-300 MB) into <dir>? [y/N]` on the
    terminal, refuses without a TTY) and `browser-login [--url <https url>]` (needs `browser.acknowledged` and Chromium; refuses
    while the profile lock is held by a live pid: "a browser job is running; wait for it or cancel it"; launches headed through
    the same egress proxy; no classifier (the user drives); exits when the window closes; exit codes 0 ok, 2 config, 3 busy, 1 error).
  - `index.ts`: `createDriver(ctx)` builds the deps from `ctx.config.engines.browser` and `ctx.config.paths.settingsDir`.
- Contract with T4: `createDriver` returns a `BrowserEngineDriver`; T4 calls `act(jobId, body, host)` with the job's
  `CoreEngineHost`. Contract with T6/T7: event and reply shapes from T1 only.
- Stubs: T3 replaces T1's stub `createDriver` in `index.ts` (and may add `driver.ts`); `backend.ts` and the `index.ts` types stay as
  T1 wrote them. T3 imports T2's `egress.ts` and T5's `settings/browser.ts` as stubs: tests inject `egress` and `settings` through
  `BrowserDriverDeps` (`settings: () => DEFAULT_BROWSER_SETTINGS` or a test value) and never call the stub bodies.
- Done when `yarn build` and T3's own tests pass against T1's stubs.
- Tests: `classify.test.ts` and `driver.test.ts` with `fakeBackend.ts` (an in-memory page model with scripted elements, a fake
  installer and an egress stub).

### T4: job runner core wiring (parallel)

- Inputs: `src/jobrunner/manager.ts:193,305-376,378-402,557-595,636-728,824-850,899-915`; `server.ts:79-190`;
  `main.ts:151-171,191-192`; `limits.ts:103,180-227`; `templates.ts:31-50,236-384`; `src/jobs/tools.ts:51-74`; T1, T3, T5 contracts.
- Outputs:
  - `limits.ts`: `engines.browser` keys `enabled` (default true), `headless` (default true), `profileDir`, `artifactsDir`,
    `browsersDir` (absolute, default under `paths.dataDir\browser\`), `idleMin` (1..120, default 10). Refuse a `profileDir` whose
    path contains `\Google\Chrome\`, `\Microsoft\Edge\`, `\Chromium\`, `\BraveSoftware\`, `\Opera Software\` or ends in
    `\User Data`; refuse a `profileDir` inside `artifactsDir` or any `cwdAllowlist` entry, and vice versa.
  - `templates.ts`: accept `engine: "browser"`; a browser template must have `allowedTools: []`, `mcpServers: []`,
    `flow.enabled: false`, `paidModels: false`, `autostart: []`, keep the shell disallow and the `{{brief}}` slot; `cloudUse`
    returns `["web-browsing"]`; the engine error text lists browser.
  - `src/jobs/tools.ts` `summarizeTemplate`: cloud use for browser (with T6 for the label; T4 owns this file edit).
  - `manager.ts`:
    - `browserAction(body)`: unknown job → `not_found`; not engine browser → `unsupported`; not `running` → `not_running`;
      else `driver.act(jobId, body, act.host)`. Each call resets nothing in the job timeout (the template timeout still bounds it).
    - Collect `artifact` events per job (in `emit`), and put their paths into `JobDone.artifacts` (`manager.ts:836`).
    - `engineEnabled("browser")` = config enabled, driver loaded, and `readBrowserSettings(settingsDir).acknowledged === true`
      (a read error = false); `disabledWhy` says "the browser acknowledgment is not ticked in the settings UI (Browser form)".
    - Keep the `execute` auto-deny; `browser` kind goes to the user like `other`.
  - `server.ts`: `parseBrowserActionBody` (strict: only `jobId`, `callId`, `action`; per-op allowed keys and limits from T1),
    `case "browser_action"`.
  - `main.ts`: `loadConventionDrivers` loops over `["claude", "dsh", "browser"]`; subcommands `browser-install` and
    `browser-login` dispatch to T3's `cli.ts` (same arg style as `settings-link`).
  - `config/jobrunner.example.json`: `engines.browser` with a `_comment`, `limits.maxConcurrent.browser: 1`.
  - `config/templates/browser-session.json`: id `browser-session`, engine `browser`, `cwd` = the same creative-hub default as the
    other templates (desktop setup rewrites it, T9), params `{type: object, properties: {startUrl: {type: string, format: uri,
    maxLength: 2048}}}`, prompt "Browse the web for the user.\n\n{{brief}}", `timeoutMin: 60`.
- Stubs: T4 calls T3's `createDriver` and T5's `readBrowserSettings`, which are still T1 stubs in T4's worktree. Add a seam
  `JobManagerOptions.browserAcknowledged?: () => boolean` (default: `readBrowserSettings(settingsDir).acknowledged`, a throw = false)
  and drive tests with a fake `BrowserEngineDriver` passed in `drivers`, so no stub body runs. `loadConventionDrivers` already
  logs and skips a driver whose `createDriver` throws.
- Tests: extend the existing manager and server tests (one case each, see Acceptance); no new file unless none fits.
- Done when `yarn build` and T4's own tests pass against T1's stubs.

### T5: settings section, ack and form (parallel)

- Inputs: `src/settings/schema.ts:250-272`; `src/settings/split.ts:15-53`; `src/jobrunner/settingsUi/forms/registry.ts:65-80`;
  `phase4.ts:7-60`; the test that proves `termsAccepted` is reachable only from its form (`grep -rln termsAccepted test/`).
- Outputs:
  - `src/settings/browser.ts`:
    ```ts
    export interface BrowserSettings {
      acknowledged: boolean;              // default false
      allowedDomains: string[];           // empty = any public host; entries "example.com" or "*.example.com", max 200
      blockedDomains: string[];           // always refused, max 200
      askDomains: string[];               // every write action asks, max 200
      extraRiskyWords: string[];          // max 50, each 2..40 chars, letters/spaces only
      maxScreenshotsPerJob: number;       // 1..200, default 50
    }
    export const DEFAULT_BROWSER_SETTINGS: BrowserSettings;
    /** Reads <settingsDir>\security.json `browser`. Missing section = defaults. Unreadable or invalid file = throws. */
    export function readBrowserSettings(settingsDir: string): BrowserSettings;
    ```
  - `schema.ts`: a `browser` object section with those fields (`acknowledged` label "I understand the agent can act on websites
    with the sessions in its browser profile"). `split.ts`: add `browser` to `PHASE4_SECURITY_KEYS` (security.json only).
  - `forms/browser.ts` + registry: form `browser`, title "Browser", group "Jobs", `ack: { text: BROWSER_ACK_TEXT }` where
    `BROWSER_ACK_TEXT = "I understand that browser jobs act on real websites with the accounts I log into in the agent's browser
    profile, that risky steps ask me in Telegram but ordinary clicks do not, and that this is my own decision. This is saved in the
    audit log."` Warnings: "Log in with: node dist\src\jobrunner\main.js browser-login (desktop: tray > Browser login...)."
  - No proposal row, tool or Telegram path may write `browser.*` (add it to the existing reachability test's table).
- Stub: T5 replaces T1's stub `readBrowserSettings` in `src/settings/browser.ts`; `BrowserSettings` and `DEFAULT_BROWSER_SETTINGS`
  stay as T1 wrote them.
- Done when `yarn build` and T5's own tests pass against T1's stubs.

### T6: agent side: tools, injection, catalogs, card (parallel)

- Inputs: `src/jobs/tools.ts:292-347,479-530`; `src/jobs/task.ts:318-345,486-575`; `src/agent/phase2.ts:160-181`;
  `src/jobs/approval.ts:30-41,91-106,231-295`; `src/mcp/untrusted.ts:28`; catalogs `src/settings/catalog.ts:9-54`,
  `src/bots/schema.ts:34-36`, `src/botbus/capabilities.ts:22`, `src/web/capabilities.ts:14-31`; `src/config/schema.ts:99-106,392-399`.
- Outputs:
  - `src/browser/tools.ts`: `createBrowserTools({client, tracker, templates, logger, timeoutMs})` → 9 `defineTool`s, all
    `deferred: true`, `replay: "unsafe"`. Params: `jobId?` (default: the one browser job of this conversation in phase `run`;
    none or several → a refusal that says so) plus the action fields of T1. `execute` sends
    `client.browserAction({jobId, callId: api.callId, action}, {timeoutMs})`. Output: `outcome` line + `wrapUntrustedContent("browser:<host>",
    text)` for page text; `denied`/`refused` are `isError` results with the message. `browser_screenshot` returns "Screenshot N sent
    to the user's chat" (no bytes). `timeoutMs` = `(config.jobs.approvalTimeoutSec + 120) * 1000`.
  - `src/agent/phase2.ts`: register the browser tools extension next to the jobs extension (main agent only); pass `onRunning`;
    `onSettled` skips the injection for a browser job that ended `succeeded` through `browser_done` (the model ended it itself).
  - `src/jobs/task.ts`: `JobTaskDeps.onRunning?: (job: {jobId; conversationId; templateId; engine}) => void | Promise<void>`, called
    once when the run phase first sees `state: running` for an engine `browser` job; phase2 maps it to
    `bridge.injectInput(conversationId, "Browser session <jobId> is running. Use the browser_* tools (find them with tool_search),
    start with browser_read. Risky steps ask the user in Telegram.", "browser-ready:<jobId>")`. On an `artifact` event call
    `transport.postArtifact({jobId, conversationId, artifact, index})` (errors logged, never fatal). `SettledJob` gains `engine`.
  - `src/jobs/approval.ts`: `CLOUD_LABELS["web-browsing"] = "the web (headless Chromium with your logged-in sessions; risky steps ask again)"`.
  - `src/config/schema.ts`: optional bootstrap `paths.jobArtifactsDir` (absolute local path).
  - Catalogs: the 9 names in `KNOWN_TOOLS`; the write ones (`goto, click, type, fill, press`) in `SENSITIVE_TOOLS`; all 9 in
    `PRIVILEGED_TOOLS`, `TAINT_BLOCKED_TOOLS` and `HOST_TOOL_NAMES`. Update the tests that enumerate them.
- T6 also owns the one phase2 line that passes `artifactsRoot: config.paths.jobArtifactsDir` to `TelegramJobUi` (T7's option is
  optional, so both build in either order).
- Tests: `test/browser/tools.test.ts` (see Acceptance).
- Done when `yarn build` and T6's own tests pass against T1's stubs.

### T7: Telegram images and the artifact reader (parallel)

- Inputs: `src/telegram/jobUi.ts:35,134-275,410-471`; `test/jobs/jobUi.test.ts`; T1 contracts.
- Outputs:
  - `src/artifacts/store.ts`:
    ```ts
    export type ArtifactRead = { ok: true; bytes: Buffer; mime: "image/png" } | { ok: false; reason: string };
    /** root = paths.jobArtifactsDir. Refuses: rel not matching the ArtifactRef pattern, realpath outside root, size > 5 MiB,
     *  not a PNG (magic 89 50 4E 47 0D 0A 1A 0A), sha256 mismatch when `expectSha` is given. */
    export function readArtifact(root: string, rel: string, expectSha?: string): ArtifactRead;
    export interface JobManifest { jobId: string; templateId: string; startedAt: number; endedAt?: number; state: string; shots: { path: string; at: number; caption: string }[] }
    export function listManifests(root: string, max?: number): JobManifest[];   // newest first, default 50, bad files skipped
    ```
  - `jobUi.ts`: `JobUiApi` adds `"sendPhoto"`; `postArtifact` sends `sendPhoto(chatId, new InputFile(bytes, "shot.png"),
    {caption})` (caption ≤ 1024, plain text) and at most 30 photos per job (then one text line); `requestPermission` sends the
    attachment photo first, then the card as today; a missing root or a refused read sends the card alone with "(screenshot
    unavailable: <reason>)". `postFinal` for a browser job adds "N screenshots: agent-007 web UI > Browser sessions".
  - Constructor option `artifactsRoot?: string` (phase2 passes `config.paths.jobArtifactsDir`; T6 owns that one line in phase2,
    T7 does not edit phase2).
- Stub: T7 replaces T1's stub bodies of `readArtifact` and `listManifests` in `src/artifacts/store.ts`; the types stay.
- Tests: `test/artifacts/store.test.ts` (refusals, see A10) and one new case in `test/jobs/jobUi.test.ts` (A1).
- Done when `yarn build` and T7's own tests pass against T1's stubs.

### T8: web owner view (parallel)

- Inputs: `src/web/server.ts:38-61,253`; `src/web/http.ts:11-21`; `src/web/app.ts:74-90,130`; `src/web/routes/admin.ts:75-83`;
  `ui/web/*.js`; T7's `store.ts` contract.
- Outputs:
  - `src/web/routes/owner.ts`: `GET /api/owner/jobs` (`auth: "owner"`) → `{jobs: JobManifest[]}`; `GET /api/owner/artifact?path=<rel>`
    (`auth: "owner"`) → writes the PNG itself (`{handled: true}`) with every `SECURITY_HEADERS` entry plus
    `Content-Type: image/png`; refusals 400/404 JSON. Both 404 when the gateway has no `paths.jobArtifactsDir`.
  - `app.ts`: add the routes when the config has the artifacts dir. CSP unchanged.
  - UI: owner-only sidebar entry "Browser sessions"; `ui/web/jobs.js` lists sessions (time, state, shot count) and shows the
    shots as `<img src="/api/owner/artifact?path=...">` with captions; a click opens the image full size in the same view.
    Follow the existing app.css tokens and dark mode.
- Stub: T8 imports T7's `store.ts`, still a T1 stub in T8's worktree. `ownerRoutes(stack, {root, store})` takes the store
  functions as a dependency (default: the real imports), and T8's test passes a small fake store, so no stub body runs.
- Tests: `test/web/owner-artifacts.test.ts` (see Acceptance).
- Done when `yarn build` and T8's own tests pass against T1's stubs.

### T9: packaging, deploy, desktop, boundary, docs (parallel)

- Inputs: `scripts/desktop/verify-package.mjs`; `scripts/check-adapter-boundary.ts:1-12`; `electron-builder.config.cjs:31-44`;
  `deploy/jobrunner/install-jobrunner.ps1:117-208`; `deploy/acl-write.ps1:74-85`; `deploy/jobrunner/check-jobrunner.ps1`;
  `src/setup/personal.ts:284-330`; `src/desktop/main.ts`, `src/desktop/tray.ts`; `test/deploy-jobrunner/`, `test/desktop/`.
- Outputs:
  - `verify-package.mjs`: assert `resources/app/node_modules/playwright-core/package.json` exists with the exact pinned version,
    and that no `ms-playwright` folder or `chrome.exe` exists anywhere under `resources/`.
  - `check-adapter-boundary.ts`: `playwright-core` may only be imported under `src/jobrunner/drivers/browser/`.
  - `install-jobrunner.ps1`: create `<DataDir>\browser\shots` with a new `Set-JobRunnerArtifactsDirAcl` (System F,
    Administrators F, Main Modify, Agent Read, inheritable), leave `profile\` and `ms-playwright\` on the data dir ACL; `-WhatIf`
    prints it; print the `paths.jobArtifactsDir` line the admin adds to the agent's config.json. `check-jobrunner.ps1`: verify that
    ACL and that the agent user has no access to `browser\profile`. Extend the existing dry-run test.
  - `setup/personal.ts`: `ensureJobrunner` also writes `templates\browser-session.json` (cwd = `<root>\data\workspace`) when
    absent, creates `jobrunner-data\browser\shots`, and `setupPersonal` / an idempotent update writes
    `paths.jobArtifactsDir = <root>\jobrunner-data\browser\shots` into `config\config.json` when absent. Extend the existing test.
  - Desktop tray: "Browser login..." (enabled only while the job runner toggle is on) spawns
    `node.exe dist\src\jobrunner\main.js browser-login --config <jobrunner.json>` with the bundled node, shows the exit reason in a
    dialog on a non-zero code. No unit test (Electron glue; manual checklist).
  - Docs: README (Desktop app and Install sections) and `deploy/README-ops.md`: what the browser engine does, the ack, the first-use
    download card, `browser-install`, `browser-login`, where the profile and screenshots live, how to wipe the profile (delete
    `browser\profile`), and that the download is the one runtime download the project makes.
- Done when `yarn build` and T9's own (extended) tests pass against T1's stubs.

### T10: opt-in real-Chromium test and integration check (serial, last)

- Inputs: everything above.
- Outputs: `test/jobrunner/browser/real-chromium.test.ts`. It skips (`t.skip`) unless `A7_BROWSERS_PATH` points at a folder where
  `chromium.executablePath()` exists. It serves fixture pages from `http.createServer().listen(0, "127.0.0.1")` and uses the egress
  proxy with `testAllowHosts: ["127.0.0.1"]` (the only place that seam is used). Then a full `yarn build && yarn test`,
  `yarn check:adapter`, and a `rg` that `testAllowHosts` appears only in `egress.ts` and test files.

## Acceptance criteria

Tests run offline with `node --test` over `dist/test`, against the fake backend unless marked opt-in. Only the tests below are new;
pinned-list tests are updated, not duplicated.

| # | Criterion | Proof |
|---|---|---|
| A1 | A browser job is dispatched, approved, runs, takes screenshots and reports; screenshots reach Telegram | `test/browser/tools.test.ts` "session flow": fake client in `running` → `onRunning` injects once (same requestId on a repeat) → `browser_screenshot` returns the "sent" text → the run phase calls `postArtifact`; plus `test/jobs/jobUi.test.ts` one new case: `postArtifact` calls fake `sendPhoto` with the bytes of a temp PNG and a caption without a query string |
| A2 | A risky action pauses for approval, deny means not performed, allow once means performed | `driver.test.ts` "submit asks": click on an `isSubmit` element → `askPermission` called once with `kind: "browser"`, masked input and one attachment; deny → fake page unchanged and reply `denied`; allow → clicked |
| A3 | Classifier rules | `classify.test.ts`: one table-driven test, one row per rule 1-7 (password refuse, file refuse, askDomains ask, submit ask, risky word ask, Enter-in-login-form ask, plain link allow, plain search box type allow) |
| A4 | Credentials never typed, values never leak | `driver.test.ts` "credential refused": `type` into a password field → `refused`, `askPermission` not called, backend `type` not called; the typed text appears in no event, no permission request and no manifest (JSON search of everything the fake host saw) |
| A5 | Navigation guard blocks loopback, private ranges, the project ports and rebinding | `egress.test.ts`: one table test through a real proxy on loopback with a fake resolver: `127.0.0.1`, `localhost`, `10.0.0.5`, a name resolving to `192.168.1.2`, `[::ffff:127.0.0.1]`, `example.com:47009` → 403; a name resolving to a public test address → the proxy dials that address (fake dialer); no credential → 407. Existing `checkUrl` tests pass unchanged |
| A6 | Profile persists and is isolated | `limits` config test row: `profileDir` under `...\Google\Chrome\User Data` and inside `artifactsDir` refused; real persistence is A11 (opt-in) and manual M5 |
| A7 | IPC op is strict and routed only to a running browser job | extend the server/manager test: unknown key in `action` → `bad_request`; unknown job → `not_found`; claude job → `unsupported`; running browser job → the fake driver's `act` gets the body; `JobDone.artifacts` lists the artifact paths |
| A8 | Ack gates the engine; ack only from the UI form | extend the manager test: browser template refused with `engine_disabled` and the ack text while `acknowledged` is false; extend the existing termsAccepted reachability test with `browser.acknowledged` |
| A9 | First-use download is owner-confirmed with a clear failure | `driver.test.ts` "install": installer says missing → `askPermission` with `tool: "browser_install"`; deny → job `failed` with the exact message of T3; allow → `install()` called once, then the session starts |
| A10 | Web view serves screenshots to the owner only, CSP-safe | `owner-artifacts.test.ts` (T8, fake store): owner session GET returns `image/png` with the unchanged CSP header; a non-owner session gets 403. `store.test.ts` (T7): one table test, `../x.png`, an absolute path, a non-PNG file, a file over 5 MiB and a sha mismatch are refused, a valid PNG is read |
| A11 | (opt-in) Real Chromium works end to end on loopback fixtures | `real-chromium.test.ts`, skipped without `A7_BROWSERS_PATH`: goto, read lists the form fields with refs, type into a text field, click submit asks (fake host), screenshot writes a valid PNG, a cookie set in session 1 is present in session 2 (persistence), and with the default (no seam) proxy the fixture URL is refused |
| A12 | Desktop exe ships playwright-core and no browser | `verify-package.mjs` checks (run by `yarn dist`); manual M1 |
| A13 | The build boundary holds | `yarn check:adapter` fails on a `playwright-core` import outside the driver folder (extend `test/adapter-boundary.test.ts` by one case) |

## Risks

- **Prompt injection**: page text steers the local model. Controls: page text wrapped as untrusted; risky steps always ask with a
  screenshot; credential fields refused; tools absent from peer-triggered turns, cloud-route bots and web bots. Ordinary clicks do
  not ask, by design (the ack text says so).
- **Classifier misses** (a "Send" button labelled with an icon only, a non-English label, a JS-driven submit without a form).
  Mitigation: `askDomains` for sensitive sites, `extraRiskyWords`, submit detection by element facts. Accept and document.
- **Blocking tool call**: an asked action keeps the agent's tool call open up to the permission timeout (default 1800 s). T6 must
  check that a pending tool call does not block Telegram callback handling (it should not: the Job task's relay is separate); if it
  does, stop and report.
- **Download**: size and CDN hosts are from general knowledge, not verified here. Playwright verifies nothing beyond TLS; the
  pinned `playwright-core` fixes the revision. Corporate proxies or an offline PC fail with the T3 message.
- **Playwright behaviour assumptions to confirm in T3/T10**: proxy auth with `launchPersistentContext`, `--proxy-bypass-list=<-loopback>`
  forcing loopback through the proxy, `serviceWorkers: "block"` in a persistent context, `cli.js install chromium` also fetching the
  headless shell. If one fails, report before changing the design.
- **Deploy session**: `browser-login` needs the main user's interactive desktop; the runner itself runs headless as a scheduled
  task. A headed job is not supported.
- **Desktop mode**: everything runs as the user, so the profile is readable by the user's other programs and, if the owner ever
  adds the data root to `folders.allow`, by the agent's `read_file`. Document; never add `jobrunner-data` to `folders.allow`.
- **Pinned version**: playwright-core `1.64.1` (published 2026-10-14; 1.65.0 was under two weeks old); Chromium revision `1248` (156.0.8078.4).
- Shared files (manager.ts, limits.ts, contracts.ts) get edits from T1 then T4; T1 must finish first.

## Manual live-verification checklist (the user)

- M1 `yarn dist`, install the exe, check `resources\app\node_modules\playwright-core` exists and the install folder has no Chromium.
- M2 Desktop: turn on the job runner, open the settings UI, tick the Browser form ack and save; check the audit line has the ack text.
- M3 In Telegram ask for a browsing task; the job card shows "Uses cloud: the web (...)"; approve. The Chromium download card
  appears (first time only); Deny once and check the failure message; dispatch again and Allow; the download finishes into
  `jobrunner-data\browser\ms-playwright`.
- M4 Ask it to read a public page and take a screenshot: the photo arrives in Telegram; the web UI "Browser sessions" shows it.
- M5 Run `browser-login` (tray item or CLI), log into a test account, close the window; run a new browser job and check it is
  logged in (profile persists); check `%LOCALAPPDATA%\Google\Chrome\User Data` is untouched.
- M6 On a test form, let it fill fields and press submit: a screenshot then an Allow once / Deny card arrives; Deny leaves the form
  unsent; Allow sends it. Check the card and the job events show no typed values.
- M7 Ask it to type a password into a login field: refused without a card.
- M8 Ask it to open `http://127.0.0.1:47009`, `http://localhost:1234` and a LAN address: each refused.
- M9 Restart the job runner during a session: the job fails with "dispatch a new browser session".
- M10 Hardened deploy: run `install-jobrunner.ps1 -WhatIf`, then for real; `check-jobrunner.ps1` reports the `shots` ACL and no agent
  access to `profile`; Telegram photos arrive (the agent user can read `shots`).

## Implementation status (implement, 2026-11-11)

Branch `agent-007-browser-support` (worktree `.claude/worktrees/browser-support`). T2-T9 ran in sub-worktrees on
`agent-007-browser-support-tN` branches and were merged with `--no-ff`.

- [x] T1 9b37fe9 - [x] T2 3c633ab - [x] T3 6f27684 - [x] T4 dc06968 - [x] T5 6c980b8 - [x] T6 7f2a19f - [x] T7 3b2e978
- [x] T8 df290d5 - [x] T9 bd9d034 - [x] merge tidy eb09286 - [x] T10 2fc763c (A11 test written; skipped, real-Chromium path UNTESTED)
- Verification on the merged branch: `yarn build` ok; `yarn test` 1622 tests, 1620 pass, 0 fail, 2 skipped (pre-existing + A11);
  `yarn check:adapter` pass (adapter, ACP, Playwright boundaries); `testAllowHosts` only in egress.ts and the A11 test.
- Deviations: see changelog.md. Manual checklist M1-M10 not run.
