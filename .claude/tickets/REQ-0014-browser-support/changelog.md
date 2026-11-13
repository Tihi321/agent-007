# REQ-0014 browser support: changelog

## 2026-11-11 - REQ-0014 - browser job engine implemented (T1-T10), automated checks green, manual checks not run

Repo `agent-007`, branch `agent-007-browser-support` (from master 4b01440), worktree `.claude/worktrees/browser-support`.
Commits: 9b37fe9 (T1), merges of `agent-007-browser-support-t2..t9` (3c633ab, 6f27684, dc06968, 6c980b8, 7f2a19f, 3b2e978,
df290d5, bd9d034), eb09286 (merge tidy), 2fc763c (T10).

### What changed

- `package.json`, `yarn.lock`: `playwright-core` 1.64.1 exact (Chromium rev 1248). No browser downloaded at install/build.
- `src/jobs/contracts.ts`, `src/jobs/browserContracts.ts`, `src/ipc/protocol.ts`, `src/ipc/client.ts`: `browser` engine,
  `web-browsing` cloud use, `browser` permission kind, `ArtifactRef`, `artifact` job event, permission attachments,
  `browser_action` IPC request and `not_running` error, `browserAction` client call, nine deferred `browser_*` names.
- `src/web/runtime/ssrf.ts`: `checkUrl` now sits on `vetUrlShape` (same behaviour); new `vetPublicHost`.
- `src/jobrunner/drivers/browser/`: authenticated loopback egress proxy (vets DNS answers, blocked ports, dials the vetted IP);
  rule-table classifier (refuse credential/file fields, ask on submits, risky words, login/payment forms, askDomains) and
  masking; Playwright backend (persistent profile, headless, proxy, service workers blocked, downloads off,
  `chromiumSandbox: true`); in-page snapshot script; owner-confirmed Chromium install; screenshot writer + manifest; profile
  lock; `browser-install` / `browser-login` CLI; the driver (one action at a time, callId reply cache, ask with a screenshot,
  idle close, no resume).
- `src/jobrunner/limits.ts`, `templates.ts`, `manager.ts`, `server.ts`, `main.ts`, `src/jobs/tools.ts`,
  `config/jobrunner.example.json`, `config/templates/browser-session.json`: engine config keys and profile-path refusals,
  browser template rules, ack-gated `engineEnabled`, strict `browser_action` parsing and routing, artifact paths in
  `JobDone.artifacts`, the two subcommands.
- `src/settings/browser.ts`, `schema.ts`, `split.ts`, `settingsUi/forms/browser.ts`, `registry.ts`, `settingsUi/routes.ts`:
  `browser` section in security.json, the Browser form with the ack, and the save route's ack guard now covers `browser`.
- `src/browser/tools.ts`, `src/agent/phase2.ts`, `src/jobs/task.ts`, `src/config/schema.ts`, catalogs (`settings/catalog.ts`,
  `bots/schema.ts`, `botbus/capabilities.ts`, `web/capabilities.ts`), `config/config.example.json`: the nine agent tools for
  the main agent only (privileged, peer-forbidden, taint-blocked), running-session injection, artifact relay, `paths.jobArtifactsDir`.
- `src/artifacts/store.ts`, `src/telegram/jobUi.ts`: safe PNG reader and manifest list; screenshots as Telegram photos
  (30 per job), screenshot before the permission card, "N screenshots" final line.
- `src/web/routes/owner.ts`, `src/web/app.ts`, `src/web/main.ts`, `ui/web/{jobs.js,app.js,sidebar.js,app.css}`: owner-only
  "Browser sessions" view and authenticated image route; CSP unchanged.
- `scripts/desktop/verify-package.mjs`, `scripts/check-adapter-boundary.ts`, `deploy/jobrunner/install-jobrunner.ps1`,
  `check-jobrunner.ps1`, `src/setup/personal.ts`, `src/desktop/main.ts`, `src/desktop/tray.ts`, `README.md`,
  `deploy/README-ops.md`: packaging asserts, Playwright import boundary, `shots` ACL, desktop setup wiring, tray
  "Browser login...", docs.
- Tests: new `test/jobrunner/browser/{fakeBackend,classify,egress,driver,real-chromium}`, `test/browser/tools`,
  `test/artifacts/store`, `test/web/owner-artifacts`; extended limits, manager, server, shipped, forms, jobUi,
  adapter-boundary, deploy install, local-setup and enumeration tests.

### Deviations from the plan

- Playwright adds `--no-sandbox` by default; the backend sets `chromiumSandbox: true` to keep the plan's "never --no-sandbox".
- The driver's `start()` returns after the lock and `running`; install card, proxy and launch run in a background bootstrap.
- Card screenshots are stored but emit no `artifact` event (the card's attachment already delivers them).
- `classifyAction` takes `(ElementFacts | undefined)[]`; `PlaywrightBackend` takes `{settings}` for the domain lists.
- `onRunning` reaches the Job task through a `JobTracker` hook, not through `createJobsExtension`.
- `PEER_FORBIDDEN_TOOLS` also gets the nine tools; `config/config.example.json` updated to match the default tool list.
- `settingsUi/routes.ts` edited (ack guard), `src/web/main.ts` edited (passes `artifactsDir`); not in the plan's file list.
- Template `startUrl` uses `pattern` + `maxLength: 2000` (the params schema has no `format`, strings cap at 2000).
- `postFinal` detects a browser job by all artifacts matching the screenshot pattern (`JobDone` has no engine field).
- Playwright import boundary also allows `test/jobrunner/browser/`; `EgressOptions` gained an optional `dial` test seam.
- `onSettled` skips injection for any succeeded browser job (an idle close also ends `succeeded`).

### Verification

- Run on the merged branch: `yarn build` ok; `yarn test` 1622 tests, 1620 pass, 0 fail, 2 skipped (one pre-existing, A11);
  `yarn check:adapter` pass; `testAllowHosts` only in `egress.ts` and the A11 test.
- Not run: the A11 real-Chromium test (no `A7_BROWSERS_PATH`; no Chromium downloaded), `yarn dist` / `verify-package.mjs`,
  the web UI in a browser, the tray item, a real `install-jobrunner.ps1` run, real Telegram, manual checklist M1-M10.
- Playwright assumptions: proxy auth with persistent context, forced loopback through the proxy, `serviceWorkers: "block"`,
  and `install chromium` fetching the headless shell were confirmed by reading playwright-core 1.64.1 code only, not by a run.

### Follow-ups and limitations

- See `discoveries.md` (credential regex over-matching, iframes not snapshotted, flaky redteam/claude-driver tests).

### Commit status

Committed on `agent-007-browser-support` (and its `-t2`..`-t9` sub-branches). Not pushed, not merged to master.
