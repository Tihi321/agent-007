<#
.SYNOPSIS
  S7.9 (optional): registers the scheduled task \agent-007\strata that runs Strata as the agent user. Run ELEVATED.
  Used only when the G0 decision [UI-10] is Strata. Supports -WhatIf. Idempotent (adopts what P0.7a created).

.DESCRIPTION
  - REFUSES to run unless `git rev-parse HEAD` of the Strata install starts with the pinned commit (default e88ee39d) and
    `git status --porcelain` is empty. Read-only git only (rev-parse, status with --no-optional-locks); it never pulls,
    fetches or updates.
  - NEVER writes under the Strata install dir or data dir. It only adds the agent user's ACEs there:
    (OI)(CI)RX plus an explicit Deny WRITE ACE (WD, AD, WEA, WA, DC, D). No read right is ever denied.
  - Creates the agent-owned config copy (default C:\ProgramData\agent-007\strata\strata.json) from the install's
    strata-iq3_s.json with "open_browser": false, the log path set to <logDir>\strata.log and "api_key" set to
    strataApiKey from secrets.json (written by new-secrets.ps1). Nothing else changes. If the copy exists, only api_key
    is updated when it differs from secrets.json; the task is restarted only with -RestartTask [GO].
  - The copy is a SECRET file: its ACL (agent R, SYSTEM F, Administrators F, inheritance off, no Users) is set BEFORE the
    key is written (the file is created empty first), as in new-secrets.ps1. The log folder gets agent M.
  - Without a key (-NoStrataKey, or none in secrets.json) the copy has no api_key and a warning says any local process
    can call Strata.
  - Registers task \agent-007\strata: <install>\.venv\Scripts\python.exe <install>\serve\server.py --engine strata --config
    <copy> --port 8080 (no --open); working dir = the copy's folder; the agent user, S4U, RunLevel Limited; the triggers
    and settings of register-task.ps1 except that AtStartup has no delay.
  - -WhatIf prints the ACEs, the config copy (key masked) and the task, and changes nothing.

.PARAMETER LogKey
  The key of the log path inside the Strata config (a dotted path is allowed). Default: auto-detected among log, log_file,
  logfile, log_path, logPath, or any top-level string ending in .log. [U: the key name is read from the real config.]
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$AgentUser = 'agent007',
    [string]$ConfigPath = '',
    [string]$PinnedCommit = 'e88ee39d',
    [string]$SourceConfigName = 'strata-iq3_s.json',
    [string]$LogKey = '',
    [int]$Port = 8080,
    [string]$TaskPath = '\agent-007\',
    [string]$TaskName = 'strata',
    [switch]$NoStrataKey,
    [switch]$RestartTask
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'acl-write.ps1')
$dry = [bool]$WhatIfPreference
Assert-Elevated -DryRun:$dry -ScriptName 'register-strata-task.ps1'

if (-not $ConfigPath) { $ConfigPath = Get-DefaultConfigPath }
$config = Read-JsonFile -Path $ConfigPath
$layout = Resolve-AgentLayout -Config $config -AgentUser $AgentUser
$installDir = $layout.StrataInstallDir
$dataDir = $layout.StrataDataDir
$configCopy = $layout.StrataConfigFile
$copyDir = $layout.StrataDir
$logDir = $layout.StrataLogDir
$logFile = Join-WinPath $logDir 'strata.log'
$sourceConfig = Join-WinPath $installDir $SourceConfigName
$pythonExe = Join-WinPath $installDir '.venv', 'Scripts', 'python.exe'
$serverPy = Join-WinPath $installDir 'serve', 'server.py'
$userId = "$env:COMPUTERNAME\$AgentUser"

function Invoke-GitReadOnly {
    # Only `rev-parse` and `status` are allowed, and never a write: --no-optional-locks stops `status` refreshing the index.
    param([ValidateSet('rev-parse', 'status')][string]$Verb, [string[]]$Rest = @())
    $safe = $installDir.Replace('\', '/')
    $out = & git.exe --no-optional-locks -c "safe.directory=$safe" -C $installDir $Verb @Rest 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $Verb failed in ${installDir}: $($out -join ' ')" }
    return ($out -join "`n").Trim()
}

Write-Host "agent-007 S7.9: Strata task$(if ($dry) { ' (dry run)' }), install $installDir, data $dataDir"

# ---- 0. preconditions: the pinned commit and a clean tree (read-only git) ---------------------
$head = Invoke-GitReadOnly -Verb 'rev-parse' -Rest @('HEAD')
if (-not $head.StartsWith($PinnedCommit, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing: the Strata install is at '$($head.Substring(0, [Math]::Min(12, $head.Length)))', not at the pinned commit '$PinnedCommit'. Nothing was changed."
}
$dirty = Invoke-GitReadOnly -Verb 'status' -Rest @('--porcelain')
if ($dirty) { throw "Refusing: the Strata install has uncommitted changes (git status --porcelain is not empty). Nothing was changed." }
Write-Host "[ok]     Strata is at the pinned commit $PinnedCommit and the tree is clean"

$problems = @()
foreach ($f in @($sourceConfig, $pythonExe, $serverPy)) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { $problems += "missing: $f" } }
if (-not (Test-Path -LiteralPath $dataDir -PathType Container)) { $problems += "missing folder: $dataDir" }
foreach ($m in $problems) { if ($dry) { Write-Warning $m } }
if ($problems.Count -gt 0 -and -not $dry) { throw ('Preconditions failed: ' + ($problems -join '; ')) }

# ---- the key (from secrets.json, read into memory only) ---------------------------------------
$strataKey = $null
if (-not $NoStrataKey) {
    if (Test-Path -LiteralPath $layout.SecretsFile -PathType Leaf) {
        $strataKey = [string](Get-JsonProp (Read-JsonFile -Path $layout.SecretsFile) 'strataApiKey' '')
    }
    if (-not $strataKey) {
        if ($dry) { Write-Warning "No strataApiKey in $($layout.SecretsFile): run new-secrets.ps1 -Runner strata first, or pass -NoStrataKey." }
        else { throw "No strataApiKey in $($layout.SecretsFile). Run new-secrets.ps1 -Runner strata first, or pass -NoStrataKey." }
    }
}
if ($NoStrataKey -or -not $strataKey) {
    Write-Warning 'The Strata config copy will have NO api_key: any local process, under any user, can call Strata.'
}

# ---- 1. the agent user's ACEs on the install and data (additive; never any write) -------------
foreach ($d in @($installDir, $dataDir)) {
    $before = @()
    if (Test-Path -LiteralPath $d) { $before = @(Get-AclLines -Path $d) }
    Invoke-Step -DryRun:$dry -Description "GRANT (OI)(CI)RX to $AgentUser on $d" -Action { Add-GrantReadExecute -Path $d -AgentUser $AgentUser }
    Invoke-Step -DryRun:$dry -Description "DENY WRITE (OI)(CI)(WD,AD,WEA,WA,DC,D) for $AgentUser on $d (no read right is denied)" -Action { Add-DenyWrite -Path $d -AgentUser $AgentUser }
    if (-not $dry -and (Test-Path -LiteralPath $d)) { Show-AclDiff -Path $d -Before $before -After @(Get-AclLines -Path $d) }
}

# ---- 2. folders of the copy and the log -------------------------------------------------------
Invoke-Step -DryRun:$dry -Description "create folder $copyDir and set its ACL (agent R, SYSTEM F, Administrators F, inheritance off)" -Action {
    if (-not (Test-Path -LiteralPath $copyDir -PathType Container)) { New-Item -ItemType Directory -Path $copyDir -Force | Out-Null }
    Set-ReadOnlyForAgentDirAcl -Path $copyDir -AgentUser $AgentUser
}
Invoke-Step -DryRun:$dry -Description "create folder $logDir and set its ACL (agent M, SYSTEM F, Administrators F, inheritance off)" -Action {
    if (-not (Test-Path -LiteralPath $logDir -PathType Container)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    Set-AgentModifyDirAcl -Path $logDir -AgentUser $AgentUser
}

# ---- 3. the config copy -----------------------------------------------------------------------
function Set-DottedValue {
    param($Table, [string]$Dotted, $Value)
    $parts = $Dotted.Split('.')
    $cur = $Table
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        if (-not ($cur.Contains($parts[$i]) -and $cur[$parts[$i]] -is [System.Collections.IDictionary])) { throw "Log key '$Dotted' does not exist in the Strata config." }
        $cur = $cur[$parts[$i]]
    }
    $cur[$parts[-1]] = $Value
}

function Find-LogKey {
    param($Table)
    if ($LogKey) { return $LogKey }
    foreach ($k in 'log', 'log_file', 'logfile', 'log_path', 'logPath') { if ($Table.Contains($k) -and $Table[$k] -is [string]) { return $k } }
    foreach ($k in $Table.Keys) { if ($Table[$k] -is [string] -and $Table[$k] -match '\.log$') { return [string]$k } }
    throw "Cannot find the log path key in $sourceConfig. Pass -LogKey <name> (the key that holds the .log path)."
}

$copyExists = Test-Path -LiteralPath $configCopy -PathType Leaf
$keyChanged = $false
$newContent = $null     # the JSON text to write (contains the key: never printed)

if ($copyExists) {
    $current = ConvertTo-HashtableDeep (Read-JsonFile -Path $configCopy)
    $currentKey = ''
    if ($current.Contains('api_key')) { $currentKey = [string]$current['api_key'] }
    if ($NoStrataKey -or -not $strataKey) {
        if ($currentKey -ne '') { $keyChanged = $true; $current.Remove('api_key') }
    } elseif ($currentKey -ne $strataKey) {
        $keyChanged = $true
        $current['api_key'] = $strataKey
    }
    if ($keyChanged) { $newContent = ConvertTo-Json -InputObject $current -Depth 32 }
    Write-Host "[ok]     config copy exists: $configCopy ($(if ($keyChanged) { 'only api_key will be updated' } else { 'api_key already matches secrets.json, nothing to change' }))"
} else {
    if (-not (Test-Path -LiteralPath $sourceConfig -PathType Leaf)) {
        Write-Warning "Source config not found, so the copy cannot be previewed: $sourceConfig"
    } else {
        $src = ConvertTo-HashtableDeep (Read-JsonFile -Path $sourceConfig)
        $src['open_browser'] = $false
        Set-DottedValue -Table $src -Dotted (Find-LogKey -Table $src) -Value $logFile
        if (-not $NoStrataKey -and $strataKey) { $src['api_key'] = $strataKey }
        $newContent = ConvertTo-Json -InputObject $src -Depth 32
        $keyChanged = $true
    }
    Write-Host "[new]    config copy: $configCopy from $sourceConfig (open_browser=false, log=$logFile, api_key=$(if ($strataKey) { '****** (masked)' } else { 'none' }))"
}

if ($null -ne $newContent) {
    Invoke-Step -DryRun:$dry -Description "create $configCopy EMPTY if missing (secret file)" -Action {
        if (-not (Test-Path -LiteralPath $configCopy -PathType Leaf)) { [System.IO.File]::WriteAllBytes($configCopy, [byte[]]@()) }
    }
    Invoke-Step -DryRun:$dry -Description "set the secret-file ACL on $configCopy (agent R, SYSTEM F, Administrators F, inheritance off, no Users) BEFORE the key is written" -Action {
        Set-SecretFileAcl -Path $configCopy -AgentUser $AgentUser
    }
    Invoke-Step -DryRun:$dry -Description "write $configCopy (api_key masked here; nothing else in the source config changes)" -Action {
        [System.IO.File]::WriteAllText($configCopy, $newContent, (New-Object System.Text.UTF8Encoding($false)))
    }
} elseif ($copyExists) {
    Invoke-Step -DryRun:$dry -Description "re-assert the secret-file ACL on $configCopy (agent R, SYSTEM F, Administrators F, inheritance off)" -Action {
        Set-SecretFileAcl -Path $configCopy -AgentUser $AgentUser
    }
}
$newContent = $null
$strataKey = $null

# ---- 4. the task ------------------------------------------------------------------------------
$taskArgs = ('"{0}" --engine strata --config "{1}" --port {2}' -f $serverPy, $configCopy, $Port)
$action = New-ScheduledTaskAction -Execute $pythonExe -Argument $taskArgs -WorkingDirectory $copyDir
$triggers = New-AgentTaskTriggers -StartupDelaySec 0
$settings = New-AgentTaskSettings
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Limited

$existingTask = $null
try { $existingTask = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop } catch { $existingTask = $null }
Write-Host ''
Write-Host "Task $TaskPath$TaskName$(if ($existingTask) { ' (exists: will be updated in place)' } else { ' (new)' })"
Write-TaskSummary -TaskPath $TaskPath -TaskName $TaskName -Action $action -Triggers $triggers -Settings $settings -UserId $userId -LogonType 'S4U'

Invoke-Step -DryRun:$dry -Description "REGISTER task $TaskPath$TaskName for $userId (S4U)" -Action {
    Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Description 'agent-007: Strata model runner (127.0.0.1, no GUI) under the agent user. Start at boot, then every 5 minutes if not running.' `
        -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
}

if ($existingTask -and $keyChanged) {
    if ($RestartTask) {
        Invoke-Step -DryRun:$dry -Description "RESTART task $TaskPath$TaskName so Strata picks up the changed api_key [GO]" -Action {
            Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
            Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
        }
    } else {
        Write-Warning "The api_key changed: restart the task for it to take effect ([GO]: Stop-ScheduledTask / Start-ScheduledTask -TaskPath '$TaskPath' -TaskName '$TaskName', or rerun with -RestartTask)."
    }
}

Write-Host ''
Write-Host "Done$(if ($dry) { ' (dry run: nothing was changed)' }). Nothing under $installDir or $dataDir was written; only the agent user's ACEs were added."
