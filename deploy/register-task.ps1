<#
.SYNOPSIS
  S7.6: registers the scheduled task \agent-007\agent. Run ELEVATED. Supports -WhatIf. Idempotent (an existing task is updated).

.DESCRIPTION
  Task \agent-007\agent
    action     C:\Program Files\nodejs\node.exe "C:\Program Files\agent-007\dist\src\main.js", working dir = the agent data root
    principal  the agent user, LogonType S4U (-UsePassword for the Password fallback), RunLevel Limited
    triggers   AtStartup with a 60 s delay, plus a trigger that repeats every 5 minutes for ever (I5)
    settings   MultipleInstances IgnoreNew; ExecutionTimeLimit PT0S; RestartCount 3, RestartInterval PT1M;
               DisallowStartIfOnBatteries false; StopIfGoingOnBatteries false; StartWhenAvailable

  The task definition objects are built and printed in a dry run too; only Register-ScheduledTask is skipped.
  The script never starts the task.

.PARAMETER UsePassword
  Register with LogonType Password instead of S4U. Prompts (no echo) for the agent user's password. Fallback only (I4).
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$AgentUser = 'agent007',
    [string]$ConfigPath = '',
    [string]$ProgramFilesDir = '',
    [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
    [string]$TaskPath = '\agent-007\',
    [string]$TaskName = 'agent',
    [switch]$UsePassword
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$dry = [bool]$WhatIfPreference
Assert-Elevated -DryRun:$dry -ScriptName 'register-task.ps1'

if (-not $ConfigPath) { $ConfigPath = Get-DefaultConfigPath }
$config = $null
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) { $config = Read-JsonFile -Path $ConfigPath }
else { Write-Warning "config.json not found at ${ConfigPath}: using the default agent data root." }
$layout = Resolve-AgentLayout -Config $config -AgentUser $AgentUser -ProgramFilesDir $ProgramFilesDir
$mainJs = Join-WinPath $layout.ProgramFilesDir 'dist', 'src', 'main.js'
$userId = "$env:COMPUTERNAME\$AgentUser"

# ---- preconditions (a dry run only warns) -----------------------------------------------------
$missing = @()
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { $missing += "node.exe not found: $NodeExe" }
if (-not (Test-Path -LiteralPath $mainJs -PathType Leaf)) { $missing += "not deployed yet (run deploy-app.ps1): $mainJs" }
$userExists = $false
try { $null = Get-LocalUser -Name $AgentUser -ErrorAction Stop; $userExists = $true } catch { $userExists = $false }
if (-not $userExists) { $missing += "local user '$AgentUser' does not exist (run setup-agent-user.ps1)" }
foreach ($m in $missing) { if ($dry) { Write-Warning $m } }
if ($missing.Count -gt 0 -and -not $dry) { throw ("Preconditions failed: " + ($missing -join '; ')) }

# ---- the task definition (objects only) -------------------------------------------------------
$action = New-ScheduledTaskAction -Execute $NodeExe -Argument ('"' + $mainJs + '"') -WorkingDirectory $layout.DataDir
$triggers = New-AgentTaskTriggers -StartupDelaySec 60
$settings = New-AgentTaskSettings
$logonType = 'S4U'
if ($UsePassword) { $logonType = 'Password' }
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType $logonType -RunLevel Limited

$existingTask = $null
try { $existingTask = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop } catch { $existingTask = $null }

Write-Host "agent-007 S7.6: scheduled task $TaskPath$TaskName$(if ($dry) { ' (dry run)' })$(if ($existingTask) { ' (exists: will be updated in place)' } else { ' (new)' })"
Write-TaskSummary -TaskPath $TaskPath -TaskName $TaskName -Action $action -Triggers $triggers -Settings $settings -UserId $userId -LogonType $logonType

$plainPassword = $null
if ($UsePassword -and -not $dry) {
    $sec = Read-Host -Prompt "Password of $userId (input hidden)" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); $sec.Dispose() }
}

Invoke-Step -DryRun:$dry -Description "REGISTER task $TaskPath$TaskName for $userId (LogonType $logonType)" -Action {
    $desc = 'agent-007: the 24/7 agent (node dist\src\main.js) under the low-privilege agent user. Start at boot, then every 5 minutes if not running.'
    if ($UsePassword) {
        Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Description $desc -Action $action -Trigger $triggers -Settings $settings `
            -User $userId -Password $plainPassword -RunLevel Limited -Force | Out-Null
    } else {
        Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Description $desc -Action $action -Trigger $triggers -Settings $settings `
            -Principal $principal -Force | Out-Null
    }
}
$plainPassword = $null

Write-Host ''
Write-Host "Done$(if ($dry) { ' (dry run: nothing was registered)' }). The task is not started by this script (Start-ScheduledTask -TaskPath '$TaskPath' -TaskName '$TaskName')."
