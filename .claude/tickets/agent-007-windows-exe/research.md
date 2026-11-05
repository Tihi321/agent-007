# agent-007 Windows exe: research

Date 2026-11-02. Repo master 544ba5a. Planning only: nothing was built, installed or changed.

User request (word for word): "one more thing we should have a build that we an have exe file we can start, so we do not have
to run form code".
Scope chosen by the director (full reading): a Windows installer plus a launcher. The user starts agent-007 like a program
(Start menu, shortcut, tray icon). It starts the web gateway and opens http://localhost:47009. The Telegram agent and the job
runner are optional toggles. A first-run setup replaces `yarn setup:local`. Data, config and secrets live in a fixed per-user
folder outside the install dir. An update means installing a newer version over the old one.

## 1. What agent-007 needs at runtime (evidence)

- `package.json`: ESM (`"type": "module"`), `engines.node >=24.14.0 <25`, Yarn 4.18.1, `nodeLinker: node-modules`,
  `enableScripts: false` (`.yarnrc.yml`). Production deps: `@agentclientprotocol/sdk`, `@earendil-works/*` 1.4.0, `grammy`,
  `typebox`, `zod`. There are no `.node` files and no `binding.gyp` in `node_modules`, so there are no native modules.
  `quickjs-wasi` and `@silvia-odwyer` are WASM. SQLite is the built-in `node:sqlite`.
- The three entry points: `dist/src/web/main.js` (gateway, port 47009, `src/web/tailscale.ts` GATEWAY_PORT),
  `dist/src/main.js` (Telegram agent), `dist/src/jobrunner/main.js` (job runner, IPC 47007, settings UI 47008).
- Files read at runtime by path relative to `dist/`, so they must ship in the same layout:
  - `dist/ui/web/*` (copied by `scripts/settings/copy-ui.mjs`; resolved at `src/web/main.ts:187`)
  - `dist/ui/settings/*` (`src/jobrunner/settingsUi/assets.ts:26`)
  - `<root>/prompts/preamble.md`, `<root>/prompts/peers.md` (`src/prompt/sections.ts:29`, `src/agent/multibot.ts:156`)
  - `<root>/config/config.example.json` (read by `scripts/setup-local.ts` for the first-run setup)
  - drivers loaded by dynamic `import()` of `./drivers/<engine>/index.js` (`src/jobrunner/main.ts:156`). This breaks
    single-file bundling.
- Code that spawns `process.execPath` as a Node runtime:
  - `src/jobrunner/drivers/claude/driver.ts:200`: the permission MCP helper is `process.execPath permissionMcp.js`. Claude
    starts it from an MCP config whose env holds only `A7_JOB_*` (`process.ts:111`). It inherits Claude's env, which is
    `buildClaudeEnv(process.env)` (it strips only `ANTHROPIC_*`).
  - `src/jobrunner/flowEstimate.ts:91`: `process.execPath scripts/video-plan.mjs`.
  These calls are why the runtime under the launcher must be a real `node.exe`, or must always run with
  `ELECTRON_RUN_AS_NODE=1` (see section 3).
- Shutdown:
  - `src/main.ts` stops cleanly on an IPC `{type:"shutdown"}` message and on SIGINT, SIGTERM, SIGBREAK or SIGHUP. Exit codes:
    0 ok, 1 fatal, 2 bad config, 3 lock held (`runtime/lock.ts`), 4 restart requested (`src/telegram/settingsUi.ts:292`,
    `requestRestart(4)`).
  - `src/web/main.ts` and `src/jobrunner/main.ts` listen only to signals. On Windows a parent cannot send a real signal:
    `child.kill()` is a hard kill. A small change is needed: an IPC `shutdown` message plus exit on `disconnect`.

## 2. Packaging options

| Option | Fit | Verdict |
|---|---|---|
| **Electron tray app + electron-builder NSIS** (the api-acp-proxy setup) | Gives a tray, a single-instance lock, launch at login, notifications, a first-run window, an NSIS per-user installer and a portable exe. Electron 44.10.0 ships Node 24.22.1 and has `node:sqlite` (checked: `ELECTRON_RUN_AS_NODE=1 electron.exe -e` printed `{"node":"24.22.1","electron":"44.10.0"}` and `sqlite_version() 3.53.4`). This matches `engines`. | **Chosen** |
| Node SEA (`--experimental-sea-config` + postject) | A single-script blob: it needs a CJS/ESM bundle (esbuild), and our dynamic driver `import()` and the path-relative `ui/` and `prompts/` reads need code changes or the SEA assets API. It has no tray, no installer and no launch at login, so an NSIS or Inno script and a console window would still be needed. Postject changes node.exe, which breaks Node's signature. | Rejected: more custom work and fewer features |
| `pkg` (Vercel) | Deprecated/archived upstream. The `@yao-pkg/pkg` fork supports newer Node, but ESM and `node:sqlite` support is partial and the snapshot filesystem breaks spawning `process.execPath` scripts. | Rejected |
| `nexe` | Stale and lags Node majors. No Node 24 prebuilt confidence. | Rejected |
| Plain NSIS/Inno + bundled node.exe + a `.cmd` or VBS launcher | Small and simple, but no tray, no status, no single-instance lock, no clean stop. "Quit" would mean killing node. | Rejected as the UI. Its runtime idea is kept (see section 3) |

### How api-acp-proxy does it (`C:\projects\Personal\api-acp-proxy`, master b57878a)

- `package.json`: `main: dist/electron/main.js`. Scripts: `dist` (NSIS + portable), `dist:installer`, `dist:portable` and
  `dist:dir`, each `npm run build && electron-builder --win … --config electron-builder.config.cjs && node scripts/verify-package.mjs`.
  devDeps: `electron ^44.7.2` (installed 44.10.0) and `electron-builder ^26.15.3`. Yarn 4.13 with the node-modules linker.
  The proxy has no `enableScripts: false`.
- `electron-builder.config.cjs`: `appId dev.selak.acp-proxy`, `asar: true` with a computed `asarUnpack` (everything spawned
  as a child process must be on disk), `npmRebuild: false`, `files: dist/**, assets/**, package.json`, `win.icon build/icon.ico`,
  targets `nsis` + `portable` x64, and `nsis { oneClick:false, perMachine:false, allowToChangeInstallationDirectory:true }`.
  The runAsNode fuse is left on on purpose.
- `src/electron/main.ts`:
  - The single-instance lock: `app.requestSingleInstanceLock()` exits the second instance, and `second-instance` shows the
    window.
  - The tray app: `window-all-closed` does nothing.
  - `before-quit` stops the controller with a 5 s timeout, then calls `app.exit(0)`.
  - `app.setPath("userData", dataDir)`. Logs go to `<dataDir>\logs`.
  - Launch at login: `app.setLoginItemSettings({openAtLogin, path: PORTABLE_EXECUTABLE_FILE ?? execPath, args:["--hidden"]})`.
    `--hidden` or `wasOpenedAtLogin` starts it with no window.
  - The tray menu has a Retry item for a port in use (`describeServerError` maps EADDRINUSE to "Port N in use").
  - IPC handlers refuse any caller that is not their own `file:` page.
  - `safeStorage` encrypts keys in the settings file.
  - The proxy runs its HTTP server **in the Electron main process**. It runs agents as children with
    `process.execPath` + `ELECTRON_RUN_AS_NODE=1` and a `--require hide-windows.cjs` hook (also put in NODE_OPTIONS),
    because Node grandchildren of a GUI-subsystem exe pop up console windows.
- `scripts/verify-package.mjs` runs the unpacked build the way the app does and checks it with a handshake. `scripts/make-icons.mjs`
  makes the PNG and ICO files with zlib only.
- The README says the build is unsigned: SmartScreen shows "Windows protected your PC" (More info, then Run anyway).
  `release/ACP-Proxy-Portable-0.1.0-x64.exe` is 285 MB, mostly the bundled codex and claude binaries.

### Runtime for the three services: bundled node.exe, not ELECTRON_RUN_AS_NODE

The proxy pattern (`ELECTRON_RUN_AS_NODE=1` children) has three problems for agent-007:
1. The env var is inherited by every grandchild. The agent's shell tool runs PowerShell (`src/shell/runner.ts:250`), and the
   job runner runs `claude` and `dsh`. Any Electron app started from there (VS Code, Slack, the proxy itself) would start as
   bare Node. Removing the var leaves `process.execPath` (the helper and flowEstimate above) without it.
2. Console windows: GUI-subsystem parent → console grandchildren need the proxy's `hide-windows.cjs` hook in NODE_OPTIONS.
   A console-subsystem `node.exe` spawned with `windowsHide` gives its whole tree one hidden console.
3. The hardened deploy already runs `node.exe dist\src\main.js` (`deploy/register-task.ps1:7`). The same runtime in both
   modes means the same behaviour and the same tests.

Decision: Electron is only the launcher (tray, first-run window, supervisor). The three services run as children of a
**bundled official node.exe** (Node 24.x, `extraResources/node/node.exe`, about 80 MB raw, about 30 MB compressed). The build
copies it from the build machine's fnm Node after it checks the version is in `engines` and checks the Authenticode signer
"OpenJS Foundation" (no download). ELECTRON_RUN_AS_NODE stays as the documented fallback if the size matters.

asar: the children load `dist/**`, `node_modules/**`, `ui/**`, `prompts/**` and `config/*.example.json` from disk with a real
node.exe, which cannot read asar. So the files must be unpacked: either `asar: false`, or `asar: true` holding only the launcher
with everything else in `extraResources` (`resources/app/…`). The plan uses `extraResources` for the service tree, with
`dist/src/desktop/**` in asar. This also keeps the service tree byte-identical to what `deploy-app.ps1` copies to Program Files.

Yarn: `enableScripts: false` blocks `electron`'s postinstall, which downloads the binary. electron-builder downloads its own
Electron zip for packaging (through @electron/get, to its cache), so `yarn dist` works anyway. Only `electron .` dev runs need
the binary. If they are wanted, add `dependenciesMeta: { "electron": { "built": true } }`: with enableScripts off, Yarn builds
only the packages marked `built: true`. Both downloads (Electron and the NSIS tools) come from GitHub at build time. The user
should know that, like the npm downloads in `deploy-app.ps1` [GO].

## 3. The existing deploy model and how the exe relates

Hardened deploy (`deploy/README-ops.md`, `deploy/*.ps1`):
- Code in `C:\Program Files\agent-007` (`deploy-app.ps1`; the agent user has RX only). Config in
  `C:\ProgramData\agent-007\config\config.json` (the agent user can only read it). Secrets in
  `…\secrets\secrets.json` (ACL: agent007 R, SYSTEM F, Administrators F). Agent data in `C:\Users\agent007\AppData\Local\agent-007`.
- `setup-agent-user.ps1` creates the low-privilege local user `agent007`. `register-task.ps1` registers
  `\agent-007\agent`: S4U as agent007, `node.exe dist\src\main.js`, RestartCount 3. `install-jobrunner.ps1` runs the job runner
  as the MAIN user at logon, with config in `ProgramData\agent-007\jobrunner` (not readable by the agent user), data in
  `%LOCALAPPDATA%\agent-007-jobrunner`, and the `ipcHmacKey` copied from the agent's secrets.
- `check-acl.ps1` is a read-only compliance check. `uninstall.ps1` keeps data unless given `-RemoveData`.

In-process security checks and what each becomes in exe (personal) mode:

| Invariant | Hardened | Exe personal mode |
|---|---|---|
| Secrets ACL (`assertAclSafe`, `src/config/secrets.ts:168`): refuse if Everyone/Users/Authenticated Users have access | holds | **Holds without `--skip-acl-check`**. `%LOCALAPPDATA%\agent-007\secrets\secrets.json` inherits user + SYSTEM + Administrators from the profile. The launcher also sets an explicit ACL when it creates the file (inheritance off, current user F, SYSTEM F, Administrators F), as `new-secrets.ps1` does. **ProgramData would fail**: it inherits `Users` read. So the per-user folder is required, not just preferred. |
| Settings ACL (`assertSettingsAcl`, `harness.ts:202`; hourly in `phase3.ts:319`): the agent user must not be able to write `security.json`, `settings\` or the audit folder | holds (agent007 vs main user) | **Cannot hold**: the agent user is the main user, who owns the files. The Telegram agent would refuse to start (exit 2) unless the check is skipped. `local-run.ts` passes `--skip-acl-check`, which also skips the secrets check. Plan: a narrow `--personal` flag that skips only the settings-ACL check and logs `settings.acl_personal_mode` once. The secrets check stays on. |
| I25: only the settings UI (the job runner's, as the main user) writes `security.json`; the gateway never does | holds | **Weakened**: one Windows user means the agent's shell tool could in principle write `security.json`. The in-process path policy (`folders.allow` / deny) is then the only barrier. Mitigation: the data root is not in `folders.allow` by default, and the first-run window states this plainly. The launcher (owner UI) is the one writer of `termsAccepted` and the proxy key at first run. |
| I17: the agent cannot change code or config that runs as the main user (job runner) | holds | **Gone** if the job runner toggle is on, because everything is one user. So the job runner toggle defaults to off, with a warning. |
| Separate agent user, S4U task, `C:\Program Files` RX only | holds | Not used. Code sits in `%LOCALAPPDATA%\Programs\agent-007` (user-writable, per-user NSIS). |
| `web.key` (`src/web/stack.ts loadOrCreateKey`, `<data>\web\web.key`): seals model keys | holds | Holds. It is created under the per-user data folder and gets the same explicit ACL as `secrets\`. |
| Loopback-only gateway (`src/web/server.ts:125,161`: refuses any host other than 127.0.0.1/localhost; Host/Origin checks at 170-173) | holds | Holds, unchanged. The launcher always passes `--mode local`. Tailnet mode stays a hardened/CLI feature. |
| Owner claim: one-time code from `web/cli.js owner-code`, hash stored, 10 min | holds | Holds. The launcher runs it as a child and shows the code in its window only (never in a notification, log or tooltip). |

Conclusion: the exe targets **personal mode** (one Windows user). It installs to a different folder, uses a different data root
and keeps `deploy\` untouched. Running both on one PC is not supported. They would fight over port 47009 and the Telegram token
(409 Conflict from getUpdates), and the launcher detects the port (section 5).

## 4. Config in exe mode

- `src/main.ts parseCli` and `src/web/main.ts parseWebCli` default to `%ProgramData%\agent-007\config\config.json` and
  `…\secrets\secrets.json`. `AGENT007_CONFIG` / `AGENT007_SECRETS` override them (secret values are never read from env). The
  launcher passes `--config` / `--secrets` explicitly, so ProgramData is never consulted.
- `src/config/load.ts:88` `missingConfigMessage` says "Run `yarn setup:local` … or deploy with deploy-app.ps1". In exe mode
  the launcher runs first-run before it starts any child, so this message should not appear. Add a third hint: "or start
  agent-007 from the Start menu".
- `scripts/setup-local.ts setupLocal({repoRoot, dir, presets, home})` already builds the right tree under any `dir`:
  `config\config.json` (bootstrap), `settings\security.json`, `secrets\secrets.json` (placeholders) and `data\…`. It never
  overwrites a file. It is the base for first-run, with three changes:
  1. it reads `config.example.json` from the resources dir;
  2. it takes values instead of placeholders (proxy key, terms, optional Telegram token and user id);
  3. the secrets file gets its ACL before it is written.
  Its default `model.runner = "strata"` is fine: the gateway warns but runs without a Strata key, and models can be added in
  the web Models page.
- Terms: `termsAccepted.claude` lives in `security.json` and is written only by the settings UI (I25). The web Models page only
  shows "needs terms" (`ui/web/models.js:109`). The exe has no job runner settings UI by default, so the first-run window
  must offer the terms acknowledgment, as the proxy's `proxy:acknowledgeTerms` does.
- Owner claim: `node dist/src/web/cli.js owner-code --data-dir <data>` prints a one-time code. The gateway tells the user to
  run it (`src/web/main.ts:209`). The launcher runs it and shows it.

## 5. Ops details

- **Signing**: unsigned at first. SmartScreen says "Windows protected your PC" until the file builds reputation. Later options:
  Azure Trusted Signing (electron-builder `win.azureSignOptions`) or an OV certificate. Antivirus heuristics may flag an unsigned
  Electron app plus node.exe. The bundled node.exe keeps its own OpenJS signature.
- **Versioning**: `package.json` version (0.1.0) gives the artifact names `agent-007-Setup-<v>-x64.exe` and
  `agent-007-Portable-<v>-x64.exe`. NSIS over-install upgrades in place. Data is outside the install dir, so it survives.
- **Icon**: `ui/web/icon.svg` exists. Make `build/icon.ico` and the tray PNGs (idle, running, warn, error) with a port of the
  proxy's `scripts/make-icons.mjs` (zlib only), and commit the outputs.
- **Auto-start**: `app.setLoginItemSettings` with `--hidden` (proxy pattern). Off by default, toggled in the tray.
- **Logs**: the launcher writes `<root>\logs\launcher.log`, and each child's stdout/stderr goes to `<root>\logs\<service>.log`
  (size-capped, one rotation). The agent also keeps its own `paths.logsDir`. A tray item "Open logs folder" opens them.
- **Single instance**: `app.requestSingleInstanceLock()`; a second start opens the browser at the gateway. The children keep
  their own locks (agent `run\` lock, exit 3; job runner lock).
- **Port in use**: before spawning the gateway, probe `127.0.0.1:47009`. If something answers `GET /` with the gateway's
  headers, say "agent-007 is already running (scheduled task or another copy)" and offer Open. Otherwise say "Port 47009 in
  use" with a Retry item, as the proxy does. The port is configurable in the launcher settings.
- **Clean shutdown**: spawn the children with an IPC channel and send `{type:"shutdown"}`. After 10 s, run
  `taskkill /PID <pid> /T /F` (the pattern already in `src/jobrunner/proc.ts:29`). Each child also exits on IPC `disconnect`,
  so a crashed launcher leaves no orphans. SQLite and pi-durable resume cover a hard kill (`main.ts` header comment).

## 6. Things checked on this machine

- No `%LOCALAPPDATA%\agent-007`, `%LOCALAPPDATA%\agent-007-jobrunner` or `C:\ProgramData\agent-007` exists. The user runs from
  `<repo>\.local` (`config`, `data`, `secrets`, `settings`), which `yarn setup:local` made.
- Node 24.14.0 (fnm) is on PATH. The proxy's Electron 44.10.0 is installed and its Node is 24.22.1.

## 7. Not verified

- The installer was not built in this repo (planning only).
- ESM loading from inside asar under ELECTRON_RUN_AS_NODE was not tested. The plan avoids it with unpacked `extraResources`.
- Exact installer size: estimated at 110 to 140 MB (Electron about 100 MB + node.exe 80 MB + production node_modules, compressed).
