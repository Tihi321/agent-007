# Research: check-jobrunner loopback-listener test failing since 2026-11-01

## Question
Why does `test/deploy-jobrunner/install.test.ts` "check-jobrunner: reports a loopback listener..." fail 3/3 since 2026-11-01 when the suite had 0 failures on 2026-10-31?

## Answer
Environmental, not a code regression. The test opens a Node listener on 127.0.0.1:<random port> and the script finds it with
`Get-NetTCPConnection -LocalPort $IpcPort -State Listen`. Since the Windows update/reboot, that machine reports loopback
listeners with an EMPTY State (null, raw 0), so the `-State Listen` filter matches nothing and the script prints
"nothing is listening on port N". Strata, the port, the process filter and the scz/split/schema changes are not involved.
Confirmed hotfixes KB5127936 and KB5132402 installed 2026-10-31; last boot 2026-11-01 11:22 (OS 10.0.26300).

## Path through the code
- Test: `test/deploy-jobrunner/install.test.ts:274-303`. `createServer().listen(0,"127.0.0.1")` (ephemeral port, not 8080) then runs
  `deploy/jobrunner/check-jobrunner.ps1 -IpcPort <port> ...` and asserts `listening on 127\.0\.0\.1:<port>` (line 289). confirmed
- Script: `deploy/jobrunner/check-jobrunner.ps1`, listener block: `Get-NetTCPConnection -LocalPort $IpcPort -State Listen -ErrorAction Stop`
  inside try/catch -> empty list -> violation "nothing is listening on port ..." . No process-name/path filter. confirmed
- Static test `install.test.ts:123` asserts the script text matches `/Get-NetTCPConnection -LocalPort \$IpcPort -State Listen/`. confirmed

## Reproduction
Reproduced: `node --test dist/test/deploy-jobrunner/install.test.js` -> 10 pass, 1 fail, same message as `.claude/temp/test-23.txt:1706-1717`
(also unsandboxed). Isolated probe (Node listener on 127.0.0.1:52690, then PowerShell 5.1):
- `Get-NetTCPConnection -LocalPort 52690` returns the row: LocalAddress 127.0.0.1, State empty (`[int]` = 0), AppliedSetting Internet,
  RemoteAddress 0.0.0.0.
- same with `-State Listen` -> 0 rows ("No matching MSFT_NetTCPConnection objects").
- `netstat -ano` also does not list the listener; `GetActiveTcpListeners()` does not list it either. Only 4-7 listeners show at all,
  mostly `127.0.0.1:5xxxx` with PID 0 (also 8080 Strata shows State blank, PID 0 in some rows, 24292 in another).
So the TCP table on this box is degraded; Get-NetTCPConnection without a State filter is the only view that still sees the listener. confirmed

## What the plan needs
Options (worker applies; I did not change code):
1. Script: in `check-jobrunner.ps1` drop `-State Listen` and select listener rows by shape instead:
   `Get-NetTCPConnection -LocalPort $IpcPort -ErrorAction Stop | Where-Object { $_.State -eq 'Listen' -or ($_.RemoteAddress -in '0.0.0.0','::' -and $_.RemotePort -eq 0 -and -not $_.State) }`
   (probe: 1 row matches). Keep the 127.0.0.1-only violation check. Update `install.test.ts:123` regex to the new text.
   Keep it read-only (test at ~line 120 forbids write cmdlets).
2. Test only: skip/relax when the OS reports no State (not recommended; hides a real production check).
3. Do nothing, wait for a Windows fix/reboot (state unknown). Production risk: the real check would report a false violation
   on this OS build too, so option 1 is preferable.
Port choice is already dynamic, so "pick a free port" does not apply.

## Risks
- Option 1 could match half-open/other rows with no State; the RemoteAddress/RemotePort filter narrows it. Non-loopback listeners
  (0.0.0.0 / ::) still flagged because LocalAddress is compared afterwards.
- Real runs on a healthy OS still return State=Listen, so both branches stay covered; only the fixture test exercises the null branch.
- I created and deleted a scratch `.claude/temp/lis.cjs`; no code/test/config changed.

## Open questions
- Which of the two KBs (or the reboot/a filter driver) caused the null State; not determined. A second reboot may restore it. (Why
  netstat omits the listener is also unexplained.)
- Whether the earlier "0 failures" run on 10-31 was before the hotfix install/reboot: inferred yes, not verified.
