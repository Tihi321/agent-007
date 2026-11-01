<#
.SYNOPSIS
  S7.2: sets the NTFS ACLs of plan section 4.2 for the allowed folders, the denied folders and the agent's own folders.
  Run ELEVATED. Supports -WhatIf. Idempotent.

.DESCRIPTION
  Reads config.json, then:
    - grants the agent user (OI)(CI)RX on every folders.allow entry;
    - adds an explicit Deny (OI)(CI)R ACE for the agent user ONLY on group (a): every folders.deny entry [UI-2] and the
      built-in user-data deny <mainUserProfile>\.lmstudio;
    - NEVER adds a Deny Read on group (b): the C:\ProgramData\agent-007 root (config, secrets, Strata config copy and log),
      the agent data root, D:\Strata and D:\Strata-data. The agent and the Strata task must read them; the in-process
      path policy keeps the agent's tools out. A folders.deny entry that is, is under, or contains a group (b) path is
      REFUSED before anything is changed;
    - sets the section 4.2 ACLs on Program Files\agent-007, ProgramData\agent-007\config, ...\secrets and the agent
      data root (the Strata paths are S7.9's job);
    - prints a before and after ACL diff for each path it changes.

  The group (a) built-in list below is this script's own copy of builtinDenyNtfs (src/config/paths.ts), kept in
  deploy/common.ps1; test/deploy keeps the two in step.

.PARAMETER ConfigPath
  config.json to read. Default C:\ProgramData\agent-007\config\config.json.

.PARAMETER AgentUser
  The agent's Windows user. Default agent007.

.PARAMETER ProgramFilesDir
  Default C:\Program Files\agent-007.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ConfigPath = '',
    [string]$AgentUser = 'agent007',
    [string]$ProgramFilesDir = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'acl-write.ps1')
$dry = [bool]$WhatIfPreference
Assert-Elevated -DryRun:$dry -ScriptName 'grant-folder-acls.ps1'

if (-not $ConfigPath) { $ConfigPath = Get-DefaultConfigPath }
$config = Read-JsonFile -Path $ConfigPath
$layout = Resolve-AgentLayout -Config $config -AgentUser $AgentUser -ProgramFilesDir $ProgramFilesDir
$groupA = @(Get-GroupAPaths -Layout $layout)
$groupB = @(Get-GroupBPaths -Layout $layout)

Write-Host "agent-007 S7.2: folder ACLs for '$AgentUser'$(if ($dry) { ' (dry run)' }), config $ConfigPath"
Write-Host "  group (a), NTFS Deny Read : $($groupA.Count) path(s)"
foreach ($p in $groupA) { Write-Host "      $p" }
Write-Host "  group (b), never a Deny   : $($groupB.Count) path(s)"
foreach ($p in $groupB) { Write-Host "      $p" }

# ---- validate everything BEFORE changing anything --------------------------------------------
foreach ($d in $groupA) {
    $why = Get-DenyRefusalReason -Target $d -GroupB $groupB
    if ($why) { throw "folders.deny / built-in deny '$d' $why. Nothing was changed." }
}
foreach ($a in $layout.AllowPaths) {
    foreach ($d in $groupA) {
        if (Test-SameOrUnder -Child $a -Parent $d) { Write-Warning "Allowed folder '$a' is inside the denied path '$d': the Deny wins, the agent will not read it." }
    }
}

function Invoke-AclChange {
    param([string]$Path, [string]$Description, [scriptblock]$Action)
    $before = @()
    if (Test-Path -LiteralPath $Path) { $before = @(Get-AclLines -Path $Path) }
    Invoke-Step -DryRun:$dry -Description $Description -Action $Action
    if ($dry) {
        if ($before.Count -gt 0) { Write-Host "         current ACL of ${Path}:"; foreach ($l in $before) { Write-Host "           $l" } }
    } else {
        Show-AclDiff -Path $Path -Before $before -After @(Get-AclLines -Path $Path)
    }
}

# ---- 1. allowed folders: grant RX -------------------------------------------------------------
foreach ($p in $layout.AllowPaths) {
    if (-not (Test-Path -LiteralPath $p -PathType Container)) { Write-Warning "Allowed folder does not exist, skipped: $p"; continue }
    Invoke-AclChange -Path $p -Description "GRANT (OI)(CI)RX to $AgentUser on $p" -Action { Add-GrantReadExecute -Path $p -AgentUser $AgentUser }
}

# ---- 2. group (a): explicit Deny Read for the agent user only ---------------------------------
foreach ($p in $groupA) {
    if (-not (Test-Path -LiteralPath $p)) { Write-Host "[skip]   deny path does not exist (the in-process deny still applies): $p"; continue }
    Invoke-AclChange -Path $p -Description "DENY READ (OI)(CI)R for $AgentUser on $p" -Action { Add-DenyRead -Path $p -AgentUser $AgentUser -GroupB $groupB }
}

# ---- 3. the agent's own folders (section 4.2) -------------------------------------------------
function Set-OurFolder {
    param([string]$Path, [string]$Label, [scriptblock]$SetAcl)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        Invoke-Step -DryRun:$dry -Description "create folder $Path" -Action { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
    }
    Invoke-AclChange -Path $Path -Description "SET ACL on $Path ($Label; inheritance off, SYSTEM F, Administrators F)" -Action $SetAcl
}

Set-OurFolder -Path $layout.ProgramFilesDir -Label "agent $AgentUser RX" -SetAcl { Set-ProgramFilesAcl -Path $layout.ProgramFilesDir -AgentUser $AgentUser }
Set-OurFolder -Path $layout.ConfigDir -Label "agent $AgentUser R" -SetAcl { Set-ReadOnlyForAgentDirAcl -Path $layout.ConfigDir -AgentUser $AgentUser }
Set-OurFolder -Path $layout.SecretsDir -Label "agent $AgentUser R" -SetAcl { Set-ReadOnlyForAgentDirAcl -Path $layout.SecretsDir -AgentUser $AgentUser }
Set-OurFolder -Path $layout.DataDir -Label "agent $AgentUser F (owner)" -SetAcl { Set-AgentOwnedDirAcl -Path $layout.DataDir -AgentUser $AgentUser }

# The audit folders (I45, deviations 102 and 141): the agent creates each month's file and may only append to it. Folder ACE, this folder only:
# RX + CreateFiles; inheritable files-only ACE: RX + AppendData; OWNER RIGHTS (S-1-3-4): Read + AppendData; no write data or delete on files (U48).
# bus-audit sits inside the agent data root, so it is set after it. bus\chains.json is a state file the agent rewrites; it keeps the data root's ACL (check-acl.ps1 checks it).
$busAuditDir = Join-WinPath $layout.DataDir 'bus-audit'
Set-OurFolder -Path $busAuditDir -Label "agent $AgentUser create files + append only" -SetAcl { Set-AppendOnlyDirAcl -Path $busAuditDir -AgentUser $AgentUser }
# <programData>\settings\audit (U48): same pattern, only when the settings folder exists (Phase 3). settings\ itself is not changed here.
$settingsAuditDir = Join-WinPath $layout.ProgramDataDir 'settings', 'audit'
if (Test-Path -LiteralPath $settingsAuditDir -PathType Container) {
    Set-OurFolder -Path $settingsAuditDir -Label "agent $AgentUser create files + append only" -SetAcl { Set-AppendOnlyDirAcl -Path $settingsAuditDir -AgentUser $AgentUser }
} else {
    Write-Host "[skip]   settings audit folder does not exist yet: $settingsAuditDir"
}

Write-Host ''
Write-Host "Done$(if ($dry) { ' (dry run: nothing was changed)' }). The Strata paths are set by register-strata-task.ps1 (S7.9), only when the runner is Strata. Next: deploy/check-acl.ps1."
