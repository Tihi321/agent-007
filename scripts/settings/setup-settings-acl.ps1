<#
.SYNOPSIS
  S17.4: creates the Phase 3 settings folders with the section 4.2 ACLs. Run ELEVATED by the user [GO] [ADMIN]. Supports -WhatIf.
  The implementer never runs this for real (only -WhatIf and parse tests). Idempotent.

.DESCRIPTION
  Creates, in this order (every change goes through Invoke-Step, so -WhatIf prints each one and changes nothing):
    1. <ProgramData>\agent-007\settings\            inheritance off, SYSTEM F, Administrators F, main user Modify, agent user READ only.
    2. <ProgramData>\agent-007\settings\personas\   the same (user-authored personas, written by the settings UI).
    3. <ProgramData>\agent-007\settings\audit\      the append-only audit log (I29, I29e, U48): inheritance off, SYSTEM F,
       Administrators F; the agent user and the main user get READ plus APPEND only. On the folder: read and add-file (so a
       new monthly file can be created). On the files (inherited): read and append-data, NO write-data, NO delete, NO
       change-permissions.
    4. security.json, if it exists, gets the same read-only ACL for the agent user.
    5. <LocalAppData of the agent user>\agent-007\prefs\ and prefs\personas\ are NOT touched: the agent user owns its profile.

  -PlanB (I29e, only if the U48a spike showed that the creator of a new monthly audit file can change its permissions):
  the folder gives the agent user and the main user READ only (no add-file), and this script pre-creates the next
  -PreCreateMonths monthly files (default 24) as Administrators, each with the append-only file ACL. A missing monthly file
  then makes the audit write fail, which means "no audit, no change" (fail closed). Re-run it every two years.

  Nothing here edits security.json. It only creates folders and sets ACLs.

.PARAMETER AgentUser
  The agent's Windows user. Default agent007.

.PARAMETER MainUser
  The main user (the settings UI and the job runner run as this user). Default: the user running this elevated shell.

.PARAMETER ProgramDataDir
  Default C:\ProgramData\agent-007.

.PARAMETER PlanB
  See above.

.PARAMETER PreCreateMonths
  Plan B only: how many monthly audit files to create ahead. Default 24.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$AgentUser = 'agent007',
    [string]$MainUser = '',
    [string]$ProgramDataDir = '',
    [switch]$PlanB,
    [int]$PreCreateMonths = 24
)

$ErrorActionPreference = 'Stop'
$deployDir = Join-Path $PSScriptRoot '..\..\deploy'
. (Join-Path $deployDir 'common.ps1')
. (Join-Path $deployDir 'acl-write.ps1')
$dry = [bool]$WhatIfPreference
Assert-Elevated -DryRun:$dry -ScriptName 'setup-settings-acl.ps1'

if (-not $MainUser) { $MainUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name }
if (-not $ProgramDataDir) {
    $pd = $env:ProgramData
    if (-not $pd) { $pd = 'C:\ProgramData' }
    $ProgramDataDir = Join-WinPath $pd 'agent-007'
}
$settingsDir = Join-WinPath $ProgramDataDir 'settings'
$personasDir = Join-WinPath $ProgramDataDir 'settings', 'personas'
$auditDir = Join-WinPath $ProgramDataDir 'settings', 'audit'
$securityFile = Join-WinPath $ProgramDataDir 'settings', 'security.json'

if ($null -eq (Get-AccountSid -Name $AgentUser)) { if ($dry) { Write-Warning "the account '$AgentUser' cannot be resolved" } else { throw "the account '$AgentUser' cannot be resolved" } }
if ($null -eq (Get-AccountSid -Name $MainUser)) { if ($dry) { Write-Warning "the account '$MainUser' cannot be resolved" } else { throw "the account '$MainUser' cannot be resolved" } }

Write-Host "agent-007 S17.4: settings folders under $settingsDir$(if ($dry) { ' (dry run)' })"

function New-Dir {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { [void](New-Item -ItemType Directory -Path $Path -Force) }
}

# 1 and 2: read-only for the agent, modify for the main user.
foreach ($d in @($settingsDir, $personasDir)) {
    Invoke-Step -DryRun:$dry -Description "create $d with inheritance off: SYSTEM F, Administrators F, $MainUser Modify, $AgentUser read only" -Action {
        New-Dir -Path $d
        Set-ExactAcl -Path $d -Entries @(
            (New-AclEntry -Sid $script:SidSystem -Rights 'FullControl'),
            (New-AclEntry -Sid $script:SidAdministrators -Rights 'FullControl'),
            (New-AclEntry -Account $MainUser -Rights 'Modify'),
            (New-AclEntry -Account $AgentUser -Rights 'ReadAndExecute'))
    }
}

# 3: the append-only audit folder. icacls component rights: R read, WD add-file / write-data, AD add-subdirectory / append-data.
$folderRights = if ($PlanB) { 'R' } else { 'R,WD' }
Invoke-Step -DryRun:$dry -Description "create $auditDir append-only: agent and main user read + append, no write-data, delete or change-permissions on the files$(if ($PlanB) { ' (Plan B: no add-file on the folder)' })" -Action {
    New-Dir -Path $auditDir
    $agentSid = (Get-AccountSid -Name $AgentUser).Value
    $mainSid = (Get-AccountSid -Name $MainUser).Value
    $args1 = @($auditDir, '/inheritance:r', '/grant:r',
        '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F',
        "*${agentSid}:(CI)($folderRights)", "*${agentSid}:(OI)(IO)(R,AD)",
        "*${mainSid}:(CI)($folderRights)", "*${mainSid}:(OI)(IO)(R,AD)")
    [void](Invoke-Icacls -ArgList $args1)
}

# 4: an existing security.json gets the read-only ACL for the agent user.
if (Test-Path -LiteralPath $securityFile -PathType Leaf) {
    Invoke-Step -DryRun:$dry -Description "set the read-only ACL on $securityFile (inheritance off; agent read only)" -Action {
        Set-ExactAcl -Path $securityFile -Entries @(
            (New-AclEntry -Sid $script:SidSystem -Rights 'FullControl' -Inherit $false),
            (New-AclEntry -Sid $script:SidAdministrators -Rights 'FullControl' -Inherit $false),
            (New-AclEntry -Account $MainUser -Rights 'Modify' -Inherit $false),
            (New-AclEntry -Account $AgentUser -Rights 'Read' -Inherit $false))
    }
}

# Plan B: pre-create the next monthly files as Administrators.
if ($PlanB) {
    $now = Get-Date
    for ($i = 0; $i -lt $PreCreateMonths; $i++) {
        $m = $now.AddMonths($i)
        $name = 'settings-{0}{1}.jsonl' -f $m.ToUniversalTime().ToString('yyyy'), $m.ToUniversalTime().ToString('MM')
        $file = Join-WinPath $auditDir $name
        if (Test-Path -LiteralPath $file -PathType Leaf) { continue }
        Invoke-Step -DryRun:$dry -Description "pre-create $file (Plan B, owner Administrators, append-only ACL)" -Action {
            [void](New-Item -ItemType File -Path $file -Force)
            $agentSid = (Get-AccountSid -Name $AgentUser).Value
            $mainSid = (Get-AccountSid -Name $MainUser).Value
            [void](Invoke-Icacls -ArgList @($file, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F', "*${agentSid}:(R,AD)", "*${mainSid}:(R,AD)"))
            [void](Invoke-Icacls -ArgList @($file, '/setowner', '*S-1-5-32-544'))
        }
    }
}

Write-Host 'Done. Next: scripts\settings\check-settings-acl.ps1, then node dist\scripts\migrate-settings.js --config <config.json> (dry run first).'
