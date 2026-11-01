<#
.SYNOPSIS
  S11.6 execution check, READ ONLY: after the first logon, is the job runner listening on 127.0.0.1 only, and can the agent
  user NOT reach the job runner's secrets? Exits 0 when every check passes, 1 otherwise. Changes nothing.

.DESCRIPTION
  - Get-NetTCPConnection -LocalPort <ipcPort> must show only 127.0.0.1 (the port comes from jobrunner.json,
    default 47007).
  - icacls (listing only) on the job runner's secrets.json and data folder must show no ACE for the agent user, Users,
    Authenticated Users or Everyone.
  - The scheduled task \agent-007\jobrunner must exist and run as the main user.
  The "a signed status from the agent answers" check needs the agent's key: it is done by the agent itself (S15), not here.
#>
[CmdletBinding()]
param(
    [string]$AgentUser = 'agent007',
    [string]$ProgramDataDir = '',
    [string]$DataDir = '',
    [int]$IpcPort = 0,
    [string]$TaskPath = '\agent-007\',
    [string]$TaskName = 'jobrunner'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\common.ps1')

if (-not $ProgramDataDir) {
    $pd = $env:ProgramData
    if (-not $pd) { $pd = 'C:\ProgramData' }
    $ProgramDataDir = Join-WinPath $pd 'agent-007'
}
if (-not $DataDir) {
    $la = $env:LOCALAPPDATA
    if (-not $la) { $la = Join-WinPath $env:USERPROFILE 'AppData', 'Local' }
    $DataDir = Join-WinPath $la 'agent-007-jobrunner'
}
$configFile = Join-WinPath $ProgramDataDir 'jobrunner', 'jobrunner.json'
$secretsFile = Join-WinPath $DataDir 'secrets.json'
$violations = New-Object System.Collections.Generic.List[string]

if ($IpcPort -le 0) {
    $IpcPort = 47007
    if (Test-Path -LiteralPath $configFile -PathType Leaf) {
        try { $IpcPort = [int](Get-JsonProp (Read-JsonFile -Path $configFile) 'ipcPort' 47007) } catch { Write-Warning "could not read ipcPort from $configFile; using $IpcPort" }
    }
}

Write-Host "agent-007 job runner check (read only): port $IpcPort"

# listener
$listeners = @()
# No "-State Listen" filter: Windows build 26300 reports loopback listeners with an empty State, so that filter matches nothing.
# Select listener rows by State, or by shape (remote 0.0.0.0/:: port 0 and no State).
try {
    $listeners = @(Get-NetTCPConnection -LocalPort $IpcPort -ErrorAction Stop |
        Where-Object { $_.State -eq 'Listen' -or ($_.RemoteAddress -in '0.0.0.0','::' -and $_.RemotePort -eq 0 -and -not $_.State) })
} catch { $listeners = @() }
if ($listeners.Count -eq 0) {
    $violations.Add("nothing is listening on port ${IpcPort} (is the job runner running? log on, or start the task)")
} else {
    foreach ($l in $listeners) {
        Write-Host "  listening on $($l.LocalAddress):$($l.LocalPort) (pid $($l.OwningProcess))"
        if ($l.LocalAddress -ne '127.0.0.1') { $violations.Add("port ${IpcPort} listens on $($l.LocalAddress): it must be 127.0.0.1 only") }
    }
}

# secrets ACL: a plain icacls listing
foreach ($p in @($secretsFile, $DataDir)) {
    if (-not (Test-Path -LiteralPath $p)) { $violations.Add("missing: $p"); continue }
    $lines = Get-AclLines -Path $p
    foreach ($l in $lines) { Write-Host "  ACL $p : $l" }
    foreach ($l in $lines) {
        if ($l -match [regex]::Escape($AgentUser) -or $l -match '(?i)\b(Everyone|Authenticated Users|BUILTIN\\Users)\b') {
            $violations.Add("$p has an ACE for the agent user or a broad group: $l")
        }
    }
}

# the task
$task = $null
try { $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop } catch { $task = $null }
if ($null -eq $task) { $violations.Add("scheduled task $TaskPath$TaskName does not exist") }
else {
    Write-Host "  task $TaskPath$TaskName : state $($task.State), principal $($task.Principal.UserId), logon type $($task.Principal.LogonType)"
    if ($task.Principal.UserId -match [regex]::Escape($AgentUser)) { $violations.Add('the job runner task runs as the agent user: it must run as the main user') }
}

if ($violations.Count -gt 0) {
    Write-Host ''
    foreach ($v in $violations) { Write-Host "VIOLATION  $v" }
    exit 1
}
Write-Host 'PASS: the job runner listens on 127.0.0.1 only, its secrets are closed to the agent user, and the task exists.'
exit 0
