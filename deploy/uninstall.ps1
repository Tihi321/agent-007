<#
.SYNOPSIS
  S7.7: removes the agent-007 installation. Run ELEVATED. Supports -WhatIf. Idempotent (missing pieces are skipped).

.DESCRIPTION
  Removes, in this order:
    1. the scheduled tasks \agent-007\agent and \agent-007\strata (stopped first), then the empty task folder;
    2. the ACEs this repo's scripts added for the agent user: on the allowed folders, the group (a) deny paths, the
       ProgramData config, secrets, strata and logs folders and, for Strata, on D:\Strata and D:\Strata-data
       (ACE removal ONLY: nothing under D:\Strata or D:\Strata-data is ever deleted, written or modified);
    3. Program Files\agent-007;
    4. the local user and its sign-in-screen entry, ONLY with -RemoveUser;
    5. the data (ProgramData\agent-007 with config, secrets, the Strata config copy and log, and the agent data root),
       ONLY with -RemoveData. Without it all data, the Strata config copy and the Strata log are kept.

  -WhatIf lists every task, ACE and folder it would touch and changes nothing.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$AgentUser = 'agent007',
    [string]$ConfigPath = '',
    [string]$ProgramFilesDir = '',
    [string]$TaskPath = '\agent-007\',
    [switch]$RemoveUser,
    [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'acl-write.ps1')
$dry = [bool]$WhatIfPreference
Assert-Elevated -DryRun:$dry -ScriptName 'uninstall.ps1'

if (-not $ConfigPath) { $ConfigPath = Get-DefaultConfigPath }
$config = $null
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) { $config = Read-JsonFile -Path $ConfigPath }
else { Write-Warning "config.json not found at ${ConfigPath}: using default paths (the allowed and denied folders are unknown, so their ACEs are not removed)." }
$layout = Resolve-AgentLayout -Config $config -AgentUser $AgentUser -ProgramFilesDir $ProgramFilesDir
$groupA = @(Get-GroupAPaths -Layout $layout)

# A folder may only be deleted if it is clearly ours: named agent-007, not a drive root, and not inside the Strata install or data.
function Assert-SafeToDelete {
    param([string]$Path)
    $leaf = Split-Path -Leaf (ConvertTo-NormalPath $Path)
    if ($leaf -ne 'agent-007') { throw "Refusing to delete '$Path': the folder is not named agent-007." }
    foreach ($s in @($layout.StrataInstallDir, $layout.StrataDataDir)) {
        if (Test-SameOrUnder -Child $Path -Parent $s) { throw "Refusing to delete '$Path': it is inside '$s'." }
    }
}

Write-Host "agent-007 S7.7: uninstall$(if ($dry) { ' (dry run)' }), agent user '$AgentUser', RemoveUser=$([bool]$RemoveUser), RemoveData=$([bool]$RemoveData)"
Write-Host ''

# ---- 1. scheduled tasks -----------------------------------------------------------------------
$taskNames = @('agent', 'strata')
foreach ($n in $taskNames) {
    $t = $null
    try { $t = Get-ScheduledTask -TaskPath $TaskPath -TaskName $n -ErrorAction Stop } catch { $t = $null }
    if ($null -eq $t) { Write-Host "[skip]   task $TaskPath$n not found"; continue }
    Invoke-Step -DryRun:$dry -Description "STOP and UNREGISTER task $TaskPath$n (state: $($t.State))" -Action {
        Stop-ScheduledTask -TaskPath $TaskPath -TaskName $n -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $n -Confirm:$false
    }
}
Invoke-Step -DryRun:$dry -Description "remove the task folder $TaskPath if it is empty (best effort)" -Action {
    try {
        $svc = New-Object -ComObject 'Schedule.Service'
        $svc.Connect()
        $root = $svc.GetFolder('\')
        $name = $TaskPath.Trim('\')
        $f = $root.GetFolder($TaskPath.TrimEnd('\'))
        if ($f.GetTasks(0).Count -eq 0 -and $f.GetFolders(0).Count -eq 0) { $root.DeleteFolder($name, 0) }
    } catch { }
}

# ---- 2. the agent user's ACEs (never any other change) ---------------------------------------
$aceTargets = New-Object System.Collections.Generic.List[string]
foreach ($p in $layout.AllowPaths) { $aceTargets.Add($p) }
foreach ($p in $groupA) { $aceTargets.Add($p) }
foreach ($p in @($layout.ConfigDir, $layout.SecretsDir, $layout.StrataDir, $layout.StrataLogDir)) { $aceTargets.Add($p) }
$aceTargets.Add($layout.StrataInstallDir)
$aceTargets.Add($layout.StrataDataDir)
foreach ($p in (Select-UniquePaths $aceTargets.ToArray())) {
    if (-not (Test-Path -LiteralPath $p)) { Write-Host "[skip]   $p does not exist (no ACE to remove)"; continue }
    $kind = 'ACEs'
    if ((Test-SameOrUnder -Child $p -Parent $layout.StrataInstallDir) -or (Test-SameOrUnder -Child $p -Parent $layout.StrataDataDir)) { $kind = 'ACEs ONLY (nothing else in it is touched)' }
    Invoke-Step -DryRun:$dry -Description "REMOVE the $AgentUser $kind from $p (icacls /remove)" -Action { Remove-AgentAces -Path $p -AgentUser $AgentUser }
}

# ---- 3. Program Files -------------------------------------------------------------------------
if (Test-Path -LiteralPath $layout.ProgramFilesDir) {
    Assert-SafeToDelete -Path $layout.ProgramFilesDir
    Invoke-Step -DryRun:$dry -Description "DELETE folder $($layout.ProgramFilesDir)" -Action { Remove-Item -LiteralPath $layout.ProgramFilesDir -Recurse -Force }
} else {
    Write-Host "[skip]   $($layout.ProgramFilesDir) does not exist"
}

# ---- 4. the user ------------------------------------------------------------------------------
if ($RemoveUser) {
    $u = $null
    try { $u = Get-LocalUser -Name $AgentUser -ErrorAction Stop } catch { $u = $null }
    if ($null -eq $u) {
        Write-Host "[skip]   local user '$AgentUser' not found"
    } else {
        Invoke-Step -DryRun:$dry -Description "REMOVE local user '$AgentUser' (its profile folder is left on disk)" -Action { Remove-LocalUser -Name $AgentUser }
    }
    Invoke-Step -DryRun:$dry -Description "remove the sign-in-screen entry for '$AgentUser' (SpecialAccounts\UserList) if present" -Action {
        Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList' -Name $AgentUser -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "[keep]   local user '$AgentUser' (use -RemoveUser to remove it)"
}

# ---- 5. data ----------------------------------------------------------------------------------
if ($RemoveData) {
    foreach ($d in @($layout.ProgramDataDir, $layout.DataDir)) {
        if (-not (Test-Path -LiteralPath $d)) { Write-Host "[skip]   $d does not exist"; continue }
        Assert-SafeToDelete -Path $d
        Invoke-Step -DryRun:$dry -Description "DELETE data folder $d" -Action { Remove-Item -LiteralPath $d -Recurse -Force }
    }
} else {
    Write-Host "[keep]   data: $($layout.ProgramDataDir) (config, secrets, Strata config copy and log) and $($layout.DataDir) (use -RemoveData to delete them)"
}

Write-Host ''
Write-Host "Done$(if ($dry) { ' (dry run: nothing was changed)' }). Nothing under $($layout.StrataInstallDir) or $($layout.StrataDataDir) was deleted, written or modified."
