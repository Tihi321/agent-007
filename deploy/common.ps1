<#
.SYNOPSIS
  Shared READ-ONLY helpers for the agent-007 deploy scripts (dot-sourced; not run on its own).

.DESCRIPTION
  Holds elevation checks, config reading, the layout of section 4.2, the two built-in deny groups of S1.2, path
  comparison and the scheduled-task definition builders (they only build objects; registering is done by the callers).
  Nothing here changes the system. The ACL-changing helpers live in acl-write.ps1, which check-acl.ps1 never loads.

  Kept ASCII-only so Windows PowerShell 5.1 reads it the same as PowerShell 7.
#>

$script:SidSystem = 'S-1-5-18'
$script:SidAdministrators = 'S-1-5-32-544'
$script:SidUsers = 'S-1-5-32-545'
$script:SidAuthenticatedUsers = 'S-1-5-11'
$script:SidEveryone = 'S-1-1-0'

$script:DefaultStrataInstallDir = 'D:\Strata'
$script:DefaultStrataDataDir = 'D:\Strata-data'
$script:DefaultTaskPath = '\agent-007\'

# ---- elevation and dry-run ------------------------------------------------------------------

function Test-Elevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Real runs refuse to start unelevated. A dry run (-WhatIf) changes nothing, so it is allowed to run unelevated.
function Assert-Elevated {
    param([switch]$DryRun, [string]$ScriptName = 'this script')
    if (Test-Elevated) { return }
    if ($DryRun) {
        Write-Host '[WhatIf] not elevated: this is a dry run, nothing is changed.'
        return
    }
    throw "$ScriptName must run in an elevated (Administrator) PowerShell. Nothing was changed."
}

# Every system-changing action goes through here: a dry run prints the description and does nothing.
function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [switch]$DryRun
    )
    if ($DryRun) {
        Write-Host "[WhatIf] $Description"
        return
    }
    Write-Host "[do]     $Description"
    & $Action
}

# ---- JSON and config ------------------------------------------------------------------------

function ConvertTo-HashtableDeep {
    # Windows PowerShell 5.1 has no ConvertFrom-Json -AsHashtable; keeps key order and nesting.
    param($InputObject)
    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Management.Automation.PSCustomObject]) {
        $h = [ordered]@{}
        foreach ($p in $InputObject.PSObject.Properties) { $h[$p.Name] = ConvertTo-HashtableDeep $p.Value }
        return $h
    }
    if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
        $list = New-Object System.Collections.ArrayList
        foreach ($item in $InputObject) { [void]$list.Add((ConvertTo-HashtableDeep $item)) }
        return , $list.ToArray()
    }
    return $InputObject
}

function Read-JsonFile {
    # Error messages never echo file content (the file may be a secrets file).
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "File not found: $Path" }
    $text = [System.IO.File]::ReadAllText($Path)
    try { return (ConvertFrom-Json -InputObject $text) } catch { throw "Not valid JSON: $Path" }
}

function Get-JsonProp {
    param($Obj, [Parameter(Mandatory = $true)][string]$Name, $Default = $null)
    if ($null -eq $Obj) { return $Default }
    $p = $Obj.PSObject.Properties[$Name]
    if ($null -eq $p -or $null -eq $p.Value) { return $Default }
    return $p.Value
}

function ConvertTo-StringList {
    param($Value)
    $out = New-Object System.Collections.Generic.List[string]
    if ($null -ne $Value) {
        foreach ($v in @($Value)) {
            if ($null -ne $v -and "$v".Trim() -ne '') { $out.Add([string]$v) }
        }
    }
    return , $out.ToArray()
}

function Join-WinPath {
    # Not Join-Path: that throws for a drive that does not exist on this machine.
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string[]]$Child)
    $r = $Path
    foreach ($c in $Child) { $r = [System.IO.Path]::Combine($r, $c) }
    return $r
}

function Get-UsersRoot {
    $v = $null
    try { $v = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' -Name ProfilesDirectory -ErrorAction Stop).ProfilesDirectory } catch { $v = $null }
    if (-not $v) { $v = '%SystemDrive%\Users' }
    return [Environment]::ExpandEnvironmentVariables($v)
}

function Get-DefaultConfigPath {
    $pd = $env:ProgramData
    if (-not $pd) { $pd = 'C:\ProgramData' }
    return (Join-WinPath $pd 'agent-007', 'config', 'config.json')
}

# The layout of plan section 4.2, resolved the same way as src/config/schema.ts (defaults included).
function Resolve-AgentLayout {
    param(
        $Config = $null,
        [Parameter(Mandatory = $true)][string]$AgentUser,
        [string]$ProgramFilesDir
    )
    $pdRoot = $env:ProgramData
    if (-not $pdRoot) { $pdRoot = 'C:\ProgramData' }
    if (-not $ProgramFilesDir) {
        $pf = $env:ProgramFiles
        if (-not $pf) { $pf = 'C:\Program Files' }
        $ProgramFilesDir = Join-WinPath $pf 'agent-007'
    }
    $paths = Get-JsonProp $Config 'paths' $null
    $programData = [string](Get-JsonProp $paths 'programDataDir' (Join-WinPath $pdRoot 'agent-007'))
    $dataDir = [string](Get-JsonProp $paths 'dataDir' (Join-WinPath (Get-UsersRoot) $AgentUser, 'AppData', 'Local', 'agent-007'))
    $controlDir = [string](Get-JsonProp $paths 'controlDir' (Join-WinPath $dataDir 'control'))
    $mainProfile = [string](Get-JsonProp $Config 'mainUserProfile' $env:USERPROFILE)

    $model = Get-JsonProp $Config 'model' $null
    $runner = [string](Get-JsonProp $model 'runner' 'lmstudio')
    $runners = Get-JsonProp $model 'runners' $null
    $strata = Get-JsonProp $runners 'strata' $null
    $strataInstall = [string](Get-JsonProp $strata 'installDir' $script:DefaultStrataInstallDir)
    $strataData = [string](Get-JsonProp $strata 'dataDir' $script:DefaultStrataDataDir)
    $strataConfig = [string](Get-JsonProp $strata 'configFile' (Join-WinPath $programData 'strata', 'strata.json'))
    $strataLog = [string](Get-JsonProp $strata 'logDir' (Join-WinPath $programData 'logs'))
    $strataBase = [string](Get-JsonProp $strata 'baseUrl' 'http://127.0.0.1:8080/v1')

    $folders = Get-JsonProp $Config 'folders' $null
    $allow = New-Object System.Collections.Generic.List[string]
    foreach ($a in @(Get-JsonProp $folders 'allow' @())) {
        $p = [string](Get-JsonProp $a 'path' '')
        if ($p.Trim() -ne '') { $allow.Add($p) }
    }
    $deny = ConvertTo-StringList (Get-JsonProp $folders 'deny' @())

    return [pscustomobject]@{
        Runner           = $runner
        AgentUser        = $AgentUser
        ProgramFilesDir  = $ProgramFilesDir
        ProgramDataDir   = $programData
        ConfigDir        = (Join-WinPath $programData 'config')
        SecretsDir       = (Join-WinPath $programData 'secrets')
        SecretsFile      = (Join-WinPath $programData 'secrets', 'secrets.json')
        DataDir          = $dataDir
        ControlDir       = $controlDir
        MainUserProfile  = $mainProfile
        AllowPaths       = $allow.ToArray()
        DenyPaths        = $deny
        StrataInstallDir = $strataInstall
        StrataDataDir    = $strataData
        StrataConfigFile = $strataConfig
        StrataDir        = (Split-Path -Parent $strataConfig)
        StrataLogDir     = $strataLog
        StrataBaseUrl    = $strataBase
    }
}

# ---- paths and the two built-in deny groups (S1.2) ------------------------------------------

# Lower-cased, resolved, no trailing separator: the comparison form (same idea as normalizeWin in paths.ts).
function ConvertTo-NormalPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $p = [System.IO.Path]::GetFullPath($Path)
    while ($p.Length -gt 3 -and ($p.EndsWith('\') -or $p.EndsWith('/'))) { $p = $p.Substring(0, $p.Length - 1) }
    return $p.ToLowerInvariant()
}

function Test-SameOrUnder {
    param([Parameter(Mandatory = $true)][string]$Child, [Parameter(Mandatory = $true)][string]$Parent)
    $c = ConvertTo-NormalPath $Child
    $p = ConvertTo-NormalPath $Parent
    if ($c -eq $p) { return $true }
    if (-not $p.EndsWith('\')) { $p = $p + '\' }
    return $c.StartsWith($p)
}

function Select-UniquePaths {
    param([string[]]$Paths)
    $seen = @{}
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($p in $Paths) {
        if (-not $p) { continue }
        $k = ConvertTo-NormalPath $p
        if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; $out.Add($p) }
    }
    return $out.ToArray()
}

# Group (a), builtinDenyNtfs in src/config/paths.ts: user-data paths. In-process deny PLUS an NTFS Deny Read ACE.
# The script cannot import the TS list, so it keeps its own copy (the relative built-ins); test/deploy keeps the two in step.
$script:BuiltinDenyNtfsRelativeToMainProfile = @('.lmstudio')

function Get-GroupAPaths {
    param([Parameter(Mandatory = $true)]$Layout)
    $list = New-Object System.Collections.Generic.List[string]
    foreach ($rel in $script:BuiltinDenyNtfsRelativeToMainProfile) { $list.Add((Join-WinPath $Layout.MainUserProfile $rel)) }
    foreach ($d in $Layout.DenyPaths) { $list.Add($d) }
    return (Select-UniquePaths $list.ToArray())
}

# Group (b), builtinDenyInProcessOnly: the agent process or the Strata task must still read these.
# They NEVER receive an NTFS Deny Read ACE (the in-process path policy keeps the agent's tools out).
function Get-GroupBPaths {
    param([Parameter(Mandatory = $true)]$Layout)
    return (Select-UniquePaths @(
            $Layout.ProgramDataDir, $Layout.DataDir,
            $Layout.StrataInstallDir, $Layout.StrataDataDir, $Layout.StrataConfigFile, $Layout.StrataLogDir))
}

# Returns a reason string if `$Target` must not receive a Deny ACE (it IS a group (b) path, is under one, or
# contains one, because an inheritable Deny on a parent would flow down onto it). Returns $null when it is fine.
function Get-DenyRefusalReason {
    param([Parameter(Mandatory = $true)][string]$Target, [Parameter(Mandatory = $true)][string[]]$GroupB)
    foreach ($b in $GroupB) {
        if (Test-SameOrUnder -Child $Target -Parent $b) { return "is, or is under, the group (b) path '$b' (the agent or the Strata task must read it)" }
        if (Test-SameOrUnder -Child $b -Parent $Target) { return "contains the group (b) path '$b' (an inheritable Deny would flow onto it)" }
    }
    return $null
}

# ---- accounts -------------------------------------------------------------------------------

function Get-AccountSid {
    param([Parameter(Mandatory = $true)][string]$Name)
    try { return (New-Object System.Security.Principal.NTAccount($Name)).Translate([System.Security.Principal.SecurityIdentifier]) } catch { return $null }
}

# icacls without any modifying switch: a plain read-only listing, with the path stripped from each line.
function Get-AclLines {
    param([Parameter(Mandatory = $true)][string]$Path)
    $out = @()
    try { $out = @(& icacls.exe $Path 2>&1) } catch { return @("(cannot read: $($_.Exception.Message))") }
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($l in $out) {
        $t = ([string]$l)
        if ($t.Trim() -eq '' -or $t -match 'Successfully processed|Failed processing') { continue }
        if ($t.StartsWith($Path)) { $t = $t.Substring($Path.Length) }
        $lines.Add($t.Trim())
    }
    return $lines.ToArray()
}

function Show-AclDiff {
    param([Parameter(Mandatory = $true)][string]$Path, [string[]]$Before, [string[]]$After)
    Write-Host "  ACL diff for $Path"
    $diff = @(Compare-Object -ReferenceObject @($Before) -DifferenceObject @($After))
    if ($diff.Count -eq 0) { Write-Host '    (no change)'; return }
    foreach ($d in $diff) {
        $mark = '+'
        if ($d.SideIndicator -eq '<=') { $mark = '-' }
        Write-Host ("    {0} {1}" -f $mark, $d.InputObject)
    }
}

# ---- scheduled-task definitions (objects only; callers register them) ------------------------

function New-AgentTaskTriggers {
    # Two triggers (I5): one at startup, one that repeats every 5 minutes for ever. A fixed start in the past keeps the
    # definition identical on every run (idempotent).
    param([int]$StartupDelaySec = 0)
    $startup = New-ScheduledTaskTrigger -AtStartup
    if ($StartupDelaySec -gt 0) { $startup.Delay = ('PT{0}S' -f $StartupDelaySec) }
    $repeat = New-ScheduledTaskTrigger -Once -At ([datetime]'2026-01-01T00:00:00') -RepetitionInterval (New-TimeSpan -Minutes 5)
    return , @($startup, $repeat)
}

function New-AgentTaskSettings {
    return (New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable)
}

function Write-TaskSummary {
    param([Parameter(Mandatory = $true)][string]$TaskPath, [Parameter(Mandatory = $true)][string]$TaskName,
        $Action, $Triggers, $Settings, [string]$UserId, [string]$LogonType)
    Write-Host "  task      : $TaskPath$TaskName"
    Write-Host "  action    : $($Action.Execute) $($Action.Arguments)"
    Write-Host "  workdir   : $($Action.WorkingDirectory)"
    Write-Host "  principal : $UserId, LogonType $LogonType, RunLevel Limited"
    foreach ($t in @($Triggers)) {
        $kind = $t.CimClass.CimClassName
        $rep = ''
        if ($t.Repetition -and $t.Repetition.Interval) { $rep = " repeat every $($t.Repetition.Interval) duration '$($t.Repetition.Duration)'" }
        $delay = ''
        if ($t.Delay) { $delay = " delay $($t.Delay)" }
        Write-Host "  trigger   : $kind$delay$rep"
    }
    Write-Host ("  settings  : MultipleInstances={0} ExecutionTimeLimit={1} RestartCount={2} RestartInterval={3} DisallowStartIfOnBatteries={4} StopIfGoingOnBatteries={5} StartWhenAvailable={6}" -f `
            $Settings.MultipleInstances, $Settings.ExecutionTimeLimit, $Settings.RestartCount, $Settings.RestartInterval, `
            $Settings.DisallowStartIfOnBatteries, $Settings.StopIfGoingOnBatteries, $Settings.StartWhenAvailable)
}
