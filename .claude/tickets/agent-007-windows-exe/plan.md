# agent-007 Windows exe: plan

Ticket folder: `.claude/tickets/agent-007-windows-exe/`. The evidence for every decision below is in `research.md`.
Base: master 544ba5a.

**Status: approved to build (user go 2026-11-02, "implement Windows exe"; REQ-0012). Ticket branch: `agent-007-windows-exe` in worktree `.claude/worktrees/agent-a8436684a1d04217f`, cut from master 544ba5a.**

## Decisions (user, 2026-11-02)

1. **Data folder**: new `%LOCALAPPDATA%\agent-007` by default, plus a "Use an existing folder..." picker on the setup page
   (for example the repo `.local`).
2. **Services**: all three in v1: web gateway, Telegram agent toggle, job runner toggle (T7 is no longer optional). The job
   runner is off by default, with a clear warning when turned on.
3. **Packaging**: NSIS installer **and** a portable exe (electron-builder `portable` target, as the proxy's `dist:portable`),
   with a bundled node.exe. Unsigned (SmartScreen warning).
4. Runtime for the services: bundled node.exe (the earlier default, kept).

Workers must not build or run `yarn build` / `yarn dist` in the main checkout. Its `dist/` serves the user's running gateway.
Work in a worktree on a ticket branch (for example `agent-007-windows-exe`). Do not touch the worktree on
`agent-007-eval-prompt-fixes`.

## Scope

Full reading: a Windows **installer** (NSIS, per-user, no admin) installs **agent-007** as a program. A **portable exe** of the
same launcher is built as well (see "Portable specifics").
- It has a Start menu entry and a desktop shortcut. Starting it opens a tray app that:
  - starts the web gateway (`--mode local`, port 47009) and opens `http://localhost:47009`;
  - starts the Telegram agent (`src/main.ts`) when its toggle is on (default off);
  - starts the job runner (`src/jobrunner/main.ts`) when its toggle is on (default off, behind a warning; task T7, in v1).
- A first-run window replaces `yarn setup:local`. It creates the per-user root `%LOCALAPPDATA%\agent-007` (override:
  `AGENT007_HOME`, or the folder chosen with "Use an existing folder...") with `config\`, `settings\`, `secrets\`, `data\` and
  `logs\`. It asks for the ACP proxy key, the Claude terms
  acknowledgment and the optional Telegram token and user id. Then it shows the one-time owner claim code with an
  "Open claim page" button.
- Tray menu items:
  - status lines per service;
  - Open agent-007, Show claim code, Start/Stop/Restart per service, Retry (shown on error);
  - Open logs folder, Open data folder;
  - Launch at login (toggle, off by default), Quit.
- An update means installing a newer Setup over the old one. Data is never inside the install dir, so it is kept.
  Uninstall keeps the data.

## Out of scope

- No changes to the hardened deploy: `deploy\*.ps1`, the agent007 user, scheduled tasks, ProgramData layout, `check-acl.ps1`.
  The exe does not replace it, does not migrate it and is not supported side by side with it on one PC.
- Tailnet mode (`--mode tailnet`, `tailscale serve`) from the launcher. It stays a CLI/hardened feature.
- Code signing in v1 (unsigned; SmartScreen warning documented). Auto-update (electron-updater). macOS and Linux builds.
- Running the gateway inside the Electron main process. Electron is the launcher only.
- Importing or migrating an existing `.local` dev setup by copying. The "Use an existing folder..." picker (Decision 1) is
  the only path. The chosen folder is remembered in a small pointer file `%LOCALAPPDATA%\agent-007\root.json` (see T4).
- Auto-update for the portable exe (it is replaced by hand).
- A per-machine (all users) install. CI workflows: the repo has no `.github/workflows`, and adding CI is not part of this
  ticket.

## Decision: packaging

**Electron tray launcher + electron-builder NSIS (the api-acp-proxy setup) + a bundled official node.exe for the services.**

- What is reused from `C:\projects\Personal\api-acp-proxy`:
  - `electron-builder.config.cjs` shape (`nsis { oneClick:false, perMachine:false, allowToChangeInstallationDirectory:true }`,
    `npmRebuild:false`, `win.icon`);
  - the `dist` / `dist:installer` / `dist:dir` scripts that end in a `verify-package` script;
  - from its `src/electron/main.ts`: the single-instance lock, `window-all-closed` as a no-op, `before-quit` with a timeout,
    `setLoginItemSettings(--hidden)`, own-page-only IPC guards;
  - the tray icon states and the "Port N in use" + Retry pattern from its `tray.ts`;
  - `make-icons.mjs`.
- What differs, and why:
  - The services run as `resources\node\node.exe resources\app\dist\src\…\main.js`, **not** `ELECTRON_RUN_AS_NODE`.
    That env var would leak into the shell tool's and the job runner's grandchildren, including any Electron app they start.
    `process.execPath` is used as Node by the claude permission helper and by flowEstimate. A console node.exe also avoids
    the proxy's hide-windows hook. The hardened deploy runs the same `node.exe dist\…` command.
  - The service tree (`dist\`, production `node_modules\`, `prompts\`, `config\*.example.json`, `package.json`) ships unpacked in
    `extraResources` (`resources\app\`). Only the launcher's own compiled code goes in `app.asar`.
- Targets: `nsis` (installer) and `portable` (one self-extracting exe), both x64, from the same config. Artifacts:
  `agent-007-Setup-<v>-x64.exe` and `agent-007-Portable-<v>-x64.exe`. Scripts: `dist` (both), `dist:installer`,
  `dist:portable`, `dist:dir`.
- Alternatives rejected:
  - Node SEA: needs bundling despite the dynamic driver `import()`, the asset API for `ui/` and `prompts/`, and its own
    installer. It has no tray.
  - `pkg` / `@yao-pkg/pkg`: upstream is deprecated, and ESM and `node:sqlite` are shaky.
  - nexe: stale.
  - NSIS + node.exe + a `.cmd` file: no tray, no status, no clean stop.
  - Fallback if the installer size matters: `ELECTRON_RUN_AS_NODE` children (saves about 30 MB compressed) with an env scrub
    (open question 4).

## Security invariants in exe mode

- **Stays as it is:**
  - Loopback-only gateway (`src/web/server.ts:125,161`); the launcher always passes `--mode local`.
  - The secrets ACL check stays ON, without `--skip-acl-check`. `%LOCALAPPDATA%` has no `Users` ACE, and the launcher also
    sets an explicit ACL when it creates the file.
  - `web.key` sealing; the owner claim with a one-time code; the gateway holds only the model keys (L8).
- **Changes:**
  - The settings-ACL check (`assertSettingsAcl` and the hourly `phase3` check) cannot pass with one Windows user. A new
    narrow `--personal` flag skips **only** that check and logs it once. `--skip-acl-check` is **not** used by the launcher.
  - I25 is weakened: the agent's shell tool runs as the owner, so the path policy is the only barrier to it writing
    `security.json`. The data root is never added to `folders.allow`, and the first-run window says so.
  - I17 is gone when the job runner toggle is on (default off). I25 is weakened further then too: the job runner's settings UI
    and the agent's shell run as the same user. The toggle shows a clear warning before the first start and every time it is
    turned on from the tray/settings page. Off after every fresh install; the launcher never turns it on by itself.

## Portable specifics

- The portable exe unpacks the app (about 200 MB) to a temp folder on every start, so the first start is slower. The
  `resources\app` layout and bundled node.exe are identical to the installed build.
- Data folder: still `%LOCALAPPDATA%\agent-007` unless the user picks another folder. Nothing is written next to the exe.
  Because the exe's own folder is not a data folder, moving or deleting the exe never loses data.
- Launch at login: the registry entry must point at the real portable exe, not the temp-unpacked one. Use
  `process.env.PORTABLE_EXECUTABLE_FILE` as `path` (the proxy does this), with `--hidden`. If the exe is moved, the entry
  breaks: the settings page shows the stored path and re-registers it on the next start of the toggle.
- No uninstaller: to remove it, delete the exe and the data folder by hand. Install and portable copies can coexist, but
  only one may run at a time (single-instance lock and port 47009 guard this).
- Switching between installer and portable keeps data, since both use the same root. The settings page and README say so.
- Unsigned, like the installer. SmartScreen is likely stricter on a freshly downloaded portable exe.

## Files and modules to touch

New (`src/desktop/` compiles with the main `tsconfig.json`; only the files marked * import `electron`):
- `src/setup/personal.ts`: the shared setup core. `scripts/setup-local.ts` becomes a thin wrapper over it.
- `src/desktop/paths.ts`: root resolution (`AGENT007_HOME` or `%LOCALAPPDATA%\agent-007`), the resource paths and the
  launcher settings file `<root>\launcher.json`.
- `src/desktop/supervisor.ts`: spawn, the exit-code policy, logs, stop. It does not import electron.
- `src/desktop/ports.ts`: probe 127.0.0.1:port and tell "our gateway" apart from "something else".
- `src/desktop/main.ts`* (Electron entry), `src/desktop/tray.ts`*, `src/desktop/window.ts`*, `src/desktop/preload.cts`*.
- `ui/desktop/setup.html`, `ui/desktop/setup.js`, `ui/desktop/setup.css`: the first-run and launcher settings page
  (plain DOM; reuse `ui/common` styles if practical). Copied by `scripts/settings/copy-ui.mjs` to `dist/ui/desktop`.
- `electron-builder.config.cjs`; `scripts/desktop/prepare-node.mjs`; `scripts/desktop/make-icons.mjs`;
  `scripts/desktop/verify-package.mjs`.
- `build/icon.ico`, `assets/desktop/tray-{idle,running,warn,error}{,@2x}.png` (generated and committed).

Changed:
- `package.json`:
  - `main: "dist/src/desktop/main.js"`;
  - devDeps `electron` and `electron-builder` at exact versions (save-exact; Electron 44.x, whose Node is 24.x, inside `engines`);
  - scripts `desktop:dev`, `dist`, `dist:installer`, `dist:portable`, `dist:dir`, `icons`.
  - `yarn.lock` follows.
  - Optional: `dependenciesMeta.electron.built: true`, only if `desktop:dev` needs the local Electron binary.
- `src/web/main.ts`, `src/jobrunner/main.ts`: IPC `{type:"shutdown"}` triggers a graceful stop; IPC `disconnect` triggers a
  graceful stop (the parent died).
- `src/main.ts`: `--personal` flag; on `disconnect`, `shutdown(EXIT_OK, "parent gone")`.
- `src/agent/harness.ts:201`, `src/agent/phase3.ts:320`: honour `settingsAcl: "personal"` (skip the settings-ACL check
  only). `startAgent` options gain `personal?: boolean`.
- `src/config/load.ts:88`: add the hint "or start agent-007 from the Start menu" (and update the regex in
  `test/local-setup.test.ts:13`).
- `.gitignore`: `release/`, `build/node/`.
- `README.md`: a "Desktop app (Windows)" section. `deploy/README-ops.md`: one note that the exe is personal mode and must not
  run beside the scheduled task.

## Tasks for workers

Each task lists inputs, outputs and the contract. Order: T1 and T2 in parallel → T3 → T4 → T7 → T5 → T6. All tasks are in v1.

### T1: service entry points (src only, small)

- Inputs: `src/main.ts`, `src/web/main.ts`, `src/jobrunner/main.ts`, `src/agent/harness.ts`, `src/agent/phase3.ts`,
  `src/config/load.ts`.
- Contract:
  - Each of the three entries, when started with an IPC channel, stops gracefully on `{type:"shutdown"}` and on `disconnect`.
    Exit codes: web 0; agent per the existing table (0/1/2/3/4); job runner 0.
  - `node dist/src/main.js --personal` behaves exactly like today, except that it skips `assertSettingsAcl` at start and the
    hourly `checkSettingsAcl` freeze. It logs `settings.acl_personal_mode` once.
  - The secrets ACL check still runs. `--personal` and `--skip-acl-check` can be combined; `--skip-acl-check` is unchanged.
- Outputs: the code changes plus one test (see Tests).

### T2: shared personal setup core

- Inputs: `scripts/setup-local.ts`, `config/config.example.json`, `src/settings/split.ts`, `src/models/templates.ts`,
  `deploy/new-secrets.ps1` (the ACL pattern).
- Contract:

  ```ts
  setupPersonal(o: {
    root: string;
    resourcesDir: string;
    home?: string;
    answers?: {
      proxyApiKey?: string;
      acceptClaudeTerms?: boolean;
      telegram?: { botToken: string; allowedUserId: number };
    };
    icacls?: (args: string[]) => void;
  }): SetupResult & { configPath: string; secretsPath: string; dataDir: string }
  ```

  - It never overwrites an existing file. It applies the answers only to files it creates. A later change of the key or the
    terms goes through `updatePersonal(root, answers)`, which rewrites only the given fields with an atomic write.
  - The secrets file is created empty, its ACL is set (`/inheritance:r`, `/grant:r <current user>:F SYSTEM:F
    Administrators:F`, using the absolute `icacls.exe` path as `runIcacls` does), and only then is the content written. The
    same ACL is set on `data\web\` before the gateway first creates `web.key`.
  - The answers are never logged or printed. `scripts/setup-local.ts` keeps its CLI and output by calling the core with
    `root = <repo>\.local` and no answers.
- Outputs: `src/setup/personal.ts`, the refactored `scripts/setup-local.ts`, and an extended `test/local-setup.test.ts`.

### T3: supervisor and port probe (no electron)

- Inputs: T1 contract; `src/jobrunner/proc.ts:29` (the taskkill pattern).
- Contract:

  ```ts
  new Supervisor({
    name,
    nodeExe,
    script,
    args,
    cwd,
    env,
    logFile,
    onState,
  })
  ```

  - `start()` / `stop(timeoutMs = 10_000)` / `restart()`.
  - Spawn: `stdio ['ignore','pipe','pipe','ipc']`, `windowsHide: true`, and an env without `ELECTRON_*`.
  - stdout and stderr are appended to `logFile` (cap 5 MB, one `.1` rotation).
  - `stop` sends `{type:"shutdown"}`, waits, then runs `taskkill /PID /T /F`.
  - The policy is a pure exported function `nextAction(code, history) → "stopped" | "restart" | {error: reason}`:
    - 0 → stopped;
    - 4 → restart now;
    - 1 → restart with backoff 2 s, 10 s, 30 s; a 4th exit within 10 minutes → error "keeps crashing";
    - 2 → error "bad configuration";
    - 3 → error "already running elsewhere".
  - `onState` reports `starting | running | stopped | error(reason, lastStderrLine)`. The last stderr line is already
    redacted by the services.
  - `probePort(port) → "free" | "agent007" | "other"`. It tries a TCP connect to 127.0.0.1. If the port answers, it sends
    `GET /`, and the gateway's fixed security headers or title mean `agent007`.
- Outputs: `src/desktop/supervisor.ts`, `src/desktop/ports.ts`, and tests.

### T4: Electron launcher

- Inputs: T2, T3; the proxy's `src/electron/{main,tray,settings-window}.ts` and `preload.cts` as the template.
- Contract:
  - Startup:
    - Single-instance lock. A second start opens the browser at the gateway, or the setup window if setup is not done.
    - Root resolution (in `paths.ts`): `AGENT007_HOME`, else the folder in the pointer file
      `%LOCALAPPDATA%\agent-007\root.json` (`{ "root": "<abs path>" }`, written only when the user picks a folder), else
      `%LOCALAPPDATA%\agent-007`. The pointer file and `app.setPath("userData", %LOCALAPPDATA%\agent-007\launcher\electron)`
      always stay in the default location so the launcher can find them.
    - The launcher log is `<root>\logs\launcher.log`.
  - First run (no `<root>\config\config.json`):
    - It shows `setup.html`: data folder (the default path plus a "Use an existing folder…" picker; a picked folder that
      already holds `config\config.json` is used as is, nothing is overwritten and the secrets ACL check still decides),
      the proxy key (password field, optional), "I accept the Claude consumer terms" (an unticked checkbox with a link
      that `openExternal` limits to `https://www.anthropic.com/legal/consumer-terms`), and an optional Telegram block.
    - It calls `setupPersonal`.
  - Starting the services:
    - Gateway: it probes the port. `agent007` → a tray error "already running elsewhere" with an Open item. `other` →
      "Port N in use" with Retry. `free` → it spawns `web/main.js --config … --secrets … --mode local --port N`.
    - When the gateway is running: if no owner exists yet (it checks `<data>\web\users.json`, or reuses the gateway's
      "No owner yet" stdout line), it runs `web/cli.js owner-code --data-dir <data>` and shows the code **only in the
      window** (with Copy and "Open claim page" → `http://localhost:N/claim`). Otherwise it opens `http://localhost:N`,
      unless started with `--hidden`.
    - Telegram toggle on: `main.js --config … --secrets … --personal`. The launcher refuses to start it while the token or
      allowedUserIds still holds a placeholder, and says why.
  - Quit:
    - It stops all services in parallel through `Supervisor.stop`, with a 15 s overall cap, then `app.exit(0)`.
  - IPC from the page:
    - Only to the launcher's own `file:` page.
    - Channels: `getState`, `runSetup(answers)`, `updateSecrets(answers)` (`updatePersonal`), `setToggles`,
      `showClaimCode`, `openPath(logs|data)`.
    - Secret values go from the page to the main process only and never come back. `getState` returns `hasProxyKey: bool`.
  - `launcher.json` (non-secret): `{ port, telegram: bool, jobrunner: bool, launchAtLogin: bool }`.
  - Launch at login uses `PORTABLE_EXECUTABLE_FILE ?? process.execPath` as the path (see Portable specifics).
  - The job runner toggle is wired here, with the supervisor and warning dialog from T7.
- Outputs: `src/desktop/*`, `ui/desktop/*`, the copy-ui change. No unit tests for the Electron glue; the manual checklist
  covers it.

### T5: packaging

- Inputs: T4; the proxy's `electron-builder.config.cjs` and `scripts/verify-package.mjs`.
- Contract:
  - `prepare-node.mjs` copies `process.execPath` to `build/node/node.exe`. Before that it checks that the version satisfies
    `engines` and that `Get-AuthenticodeSignature` shows Valid with signer "OpenJS Foundation". Otherwise it fails with a
    clear message. There is no download.
  - `electron-builder.config.cjs`:
    - `appId dev.selak.agent-007`, `productName "agent-007"`;
    - `files: ["dist/src/desktop/**", "dist/ui/desktop/**", "package.json"]`;
    - `extraResources`:
      - `dist/**` → `app/dist`, excluding `dist/test/**`, `dist/scripts/{smoke,bakeoff,spike,*-eval}/**` and `*.map`;
      - `prompts/**` → `app/prompts`;
      - `config/*.example.json` and `config/{personas,templates}/**` → `app/config`;
      - the production `node_modules` → `app/node_modules`. Obtain them with
        `yarn workspaces focus --production` into a staging dir under `.claude/temp/` or `build/stage/`, as
        `deploy-app.ps1` does in Program Files;
      - `build/node/node.exe` → `node/node.exe`;
    - `win.icon build/icon.ico`, targets `nsis` and `portable`, x64; `portable { artifactName
      "agent-007-Portable-${version}-${arch}.${ext}" }`;
    - `nsis { oneClick:false, perMachine:false, allowToChangeInstallationDirectory:true, deleteAppDataOnUninstall:false,
      artifactName "agent-007-Setup-${version}-${arch}.${ext}" }`.
  - `verify-package.mjs` (it runs at the end of `yarn dist` / `dist:dir`) uses `release/win-unpacked`:
    1. The files exist (node.exe, `app/dist/src/web/main.js`, `app/dist/ui/web/index.html`, `app/prompts/preamble.md`,
       `app/config/config.example.json`).
    2. `node.exe --version` is in `engines`.
    3. `setupPersonal` runs into a temp root.
    4. It spawns the bundled `node.exe app/dist/src/web/main.js` on a free port with the temp config and secrets **with the
       ACL check on**.
    5. `GET /` returns 200 HTML.
    6. It sends IPC shutdown and expects exit 0 within 10 s.
    7. It deletes the temp root.
    Exit 0 means pass. The portable exe is not run by the script (it is the same `win-unpacked` tree); the manual checklist
    covers it.
- Outputs: config, scripts, icons, `.gitignore`, `release/agent-007-Setup-0.1.0-x64.exe` and
  `release/agent-007-Portable-0.1.0-x64.exe`, built in the worktree.

### T6: docs

- README: the "Desktop app (Windows)" section covers:
  - install, SmartScreen, the data folder (default, and picking an existing one), claim, the three services/toggles, logs;
  - installer vs portable: update = install over (installer) or replace the exe (portable); portable has no uninstaller;
    launch at login with the portable exe; both share the same data folder;
  - uninstall keeps `%LOCALAPPDATA%\agent-007`; delete it by hand to wipe;
  - the job runner warning (personal mode, I17/I25);
  - personal mode vs hardened deploy;
  - the security notes above.
- `deploy/README-ops.md`: one paragraph.

### T7: job runner toggle (in v1)

- Inputs: T3 (supervisor), T4 (launcher), `config/jobrunner.example.json`, `src/jobrunner/main.ts`,
  `deploy/install-jobrunner.ps1` (the key and path pattern).
- Contract:
  - Off by default, also after every fresh install. Turning it on first shows a confirm dialog with the warning below. Cancel
    leaves it off.
  - First enable: create `<root>\jobrunner\jobrunner.json` from `config/jobrunner.example.json`, with paths under the root
    and `settingsUi.enabled: true`.
  - Create `<root>\jobrunner-data\secrets.json` (ACL as in T2) with `ipcHmacKey` copied from the agent's secrets. If the
    agent's secrets have none, generate 32 random bytes as base64url into both files.
  - Spawn `jobrunner/main.js --config …`.
  - The tray gets "Open settings UI", which runs `jobrunner/main.js settings-link --config …` and opens the printed link.
  - The toggle shows the I17/I25 warning ("in personal mode the agent runs as you; jobs it starts are not isolated, and the
    agent can in principle change the settings the job runner trusts"). The tray shows a warn-state icon item "Job runner on
    (not isolated)" while it runs.
  - The job runner uses the same exit-code policy and shutdown contract as T1/T3 (exit 0 on shutdown, kill after timeout).
    Ports 47007 and 47008 are probed like 47009; a clash shows "Port N in use" with Retry.
- Outputs: the jobrunner config bootstrap in `src/setup/personal.ts` (`ensureJobrunner(root)`), the supervisor wiring in
  `src/desktop/main.ts`, and one test (see Tests).

## Acceptance criteria

1. `yarn dist` (in a worktree) produces `release/agent-007-Setup-<version>-x64.exe` and
   `release/agent-007-Portable-<version>-x64.exe`, and `verify-package` passes.
2. On a machine with no Node and no repo, the installer runs without admin and installs to `%LOCALAPPDATA%\Programs\agent-007`
   with Start menu and desktop entries.
3. The first start shows the setup window and creates `%LOCALAPPDATA%\agent-007\{config,settings,secrets,data,logs}`. On
   `secrets\secrets.json`, `icacls` lists only the current user, SYSTEM and Administrators. Nothing is written to ProgramData
   or the install dir.
4. The gateway starts on 127.0.0.1:47009 with the ACL check on. A claim code is shown in the window; claiming works and chat
   works with a configured model.
5. Quit stops every child within 15 s. Afterwards `Get-Process node | ? Path -like '*Programs\agent-007*'` returns nothing.
   A second launch while running opens the browser and does not start a second gateway.
6. If port 47009 is taken, the tray shows a clear error with Retry, and nothing crashes.
7. Telegram toggle on, with a valid token: the agent starts with `--personal`, without `--skip-acl-check`, and answers in
   Telegram. Toggle off: it stops gracefully.
8. Installing a newer version over the old one keeps users, chats and keys. Uninstalling keeps `%LOCALAPPDATA%\agent-007`.
9. Job runner toggle: off after a fresh install. Turning it on shows the warning, and Cancel leaves it off. Confirming starts
   `jobrunner/main.js` with its own config and `ipcHmacKey` under the root, "Open settings UI" opens the printed link, and
   toggling off stops it gracefully. Ports 47007/47008 clashes show a clear error with Retry.
10. The portable exe starts on a machine with no install, uses `%LOCALAPPDATA%\agent-007` (or the picked folder), writes
    nothing next to itself, and Quit leaves no node.exe behind. Launch at login registers the portable exe path, not the temp
    folder.
11. "Use an existing folder..." with the repo `.local` starts the gateway with that data and the secrets ACL check on, and
    overwrites nothing.
12. `yarn build && yarn test` stay green. `deploy\*.ps1` is unchanged (`git diff --stat master -- deploy` shows only the
   README-ops note).

## Tests (test-discipline: few, important)

1. `test/local-setup.test.ts` (extend the existing setup test, no new file): `setupPersonal` with answers writes the proxy
   key and terms into the files it creates, never overwrites an existing file, and calls icacls for the secrets file before
   the content is written (fake icacls records the order).
2. `test/desktop/supervisor.test.ts`: one table test of `nextAction` over the exit codes and the crash-loop window, plus one
   real-process test. A tiny node child script that waits for `shutdown` exits 0 when `stop()` is called; a child that
   ignores it is killed by taskkill after the timeout.
3. One test in `test/settings/acl.test.ts` or the harness tests: with `personal: true`, a writable `security.json` does not
   refuse start, but a secrets file readable by `Users` still does.
4. In the extended `test/local-setup.test.ts` (no new file): `ensureJobrunner` creates the jobrunner config and secrets
   with the ACL set first, copies the agent's `ipcHmacKey` (or generates one into both files), and is idempotent.
5. The package check is `scripts/desktop/verify-package.mjs` (it runs in `yarn dist`), not a unit test.

Not tested on purpose: Electron tray and window glue (manual checklist), icon generation, and electron-builder config details.

## Manual install checklist (for the user)

1. Install: run `agent-007-Setup-<v>-x64.exe`. SmartScreen shows "Windows protected your PC": click More info, then Run
   anyway. Keep the default folder. A Start menu entry appears.
2. First run: start agent-007. The setup window opens. Paste the ACP proxy key (optional), tick the Claude terms if you use
   the Claude presets, leave Telegram empty for now, and click Finish. Check that `%LOCALAPPDATA%\agent-007` exists.
3. Claim: the window shows a claim code. Click "Open claim page", enter the code, and create your passkey/password. The
   browser lands on the chat.
4. Chat: send a message with a Claude preset (the proxy must be running) or a local model, and get an answer. The tray icon
   shows green, and the menu shows "Gateway: running".
5. Telegram (optional): tray → Settings → enter the bot token and your user id, then turn on Telegram. Send the bot a
   message and get an answer.
5b. Job runner (optional): tray → turn on Job runner. Read the warning, confirm. The tray shows "Job runner on (not
   isolated)". Click "Open settings UI" and check the page loads. Turn it off and check the process is gone. Cancel at the
   warning once and check it stays off.
5c. Existing folder: on a fresh profile (or after deleting `root.json`), start, choose "Use an existing folder...", pick the
   repo `.local`, and check the gateway starts with your old users and chats.
6. Restart: Quit from the tray and check in Task Manager that no agent-007 node.exe is left. Start it again: no setup window,
   the browser opens, and you are still signed in or can sign in, with the history kept.
7. Launch at login: turn it on, sign out and back in. The tray icon is there and no window opens.
8. Port clash: start something on 47009 (for example `yarn web:local` from the repo) and start the app. You get a clear
   "port in use" message with Retry.
9. Update: install a newer Setup over it. The data and the claim are still there.
10. Uninstall: Settings → Apps → agent-007 → Uninstall. `%LOCALAPPDATA%\agent-007` is still there. Delete it by hand to
    wipe.
11. Portable: close the installed app first. Run `agent-007-Portable-<v>-x64.exe` from a folder such as Downloads (expect
    SmartScreen and a slower first start). Check it uses the same data, nothing new appears next to the exe, and Quit
    leaves no node.exe. Turn on Launch at login, sign out and in, and check the tray icon appears. Move the exe and check
    the settings page tells you to re-toggle. Remove it by deleting the exe (no uninstaller).

## Risks

- **I25/I17 weakening in personal mode** is real: the shell tool runs as the owner. This is documented. The job runner is in
  v1 but off by default, with a confirm dialog and a persistent tray warning while on. With it on, I17 is gone and I25
  rests on the path policy only. Owners who need isolation use the hardened deploy.
- **Portable exe**: about 200 MB unpacked to temp on each start (slow start, antivirus scans); the launch-at-login path can
  go stale if the exe is moved; no uninstaller. Mitigated as in "Portable specifics".
- **Using an existing folder** (for example `.local`): it may hold placeholder values, absolute paths from another setup,
  or a different ACL. The secrets ACL check still gates start; the launcher never rewrites its files.
- **Size**: about 110 to 140 MB installer (Electron + node.exe + node_modules). The fallback is `ELECTRON_RUN_AS_NODE`
  children with an env scrub (saves about 30 MB compressed), not chosen.
- **Unsigned binaries**: SmartScreen and possible antivirus false positives on node.exe + Electron.
- **Build downloads** (Electron and NSIS tools from GitHub, through electron-builder). The user should know, as with
  `deploy-app.ps1`.
- **Placeholders**: `setupLocal` writes `allowedUserIds: [123456789]` and `CHANGE-ME`. The launcher must never start the
  Telegram agent with placeholders (T4 contract).
- **Port / token clash** with a hardened install or a dev `yarn web:local` on the same PC: detected for the port; a shared
  Telegram token shows as getUpdates 409 in `telegram.log`.
- **The path-relative reads** (`prompts/`, `ui/`) depend on the `resources\app` layout matching the repo. `verify-package`
  guards it.
- **Yarn `enableScripts: false`**: no local Electron binary for `desktop:dev` without `dependenciesMeta.electron.built`.
  Packaging is not affected.

## Open questions: all resolved (2026-11-02)

1. Data folder: fresh `%LOCALAPPDATA%\agent-007` plus the existing-folder picker. RESOLVED (Decision 1).
2. Job runner in v1: yes, all three services, off by default with a warning. RESOLVED (Decision 2).
3. Portable exe: yes, as well as the installer. RESOLVED (Decision 3).
4. Runtime for the services: bundled node.exe. RESOLVED (Decision 4).
5. Code signing: unsigned for now; revisit when the exe is shared with others. RESOLVED (Decision 3).
