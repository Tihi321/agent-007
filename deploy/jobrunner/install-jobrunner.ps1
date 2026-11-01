<#
.SYNOPSIS
  S11.6: installs the job runner for the MAIN user (UI-13). Run ELEVATED by the user. Supports -WhatIf. Idempotent.
  The implementer never runs this for real (only -WhatIf and parse tests).

.DESCRIPTION
  What it does, in this order (every change goes through Invoke-Step, so -WhatIf prints each one and changes nothing):
    1. Creates C:\ProgramData\agent-007\jobrunner\ with the section 4.2 ACL: inheritance off, SYSTEM F, Administrators F,
       main user Modify, NO ACE for the agent user (it cannot read jobrunner.json or the folder).
    2. Creates jobrunner\templates\ with its own exact ACL (inheritance off, SYSTEM F, Administrators F, main user Modify,
       agent user READ only), THEN copies config\templates\*.json into it (an existing template is kept unless
       -ForceTemplates) and config\jobrunner.example.json to jobrunner.json if there is none.
    3. Creates the job runner's data folder %LOCALAPPDATA%\agent-007-jobrunner of the main user (journal, audit, logs,
       secrets.json): inheritance off, SYSTEM F, Administrators F, main user F, nothing for the agent user.
    4. secrets.json: the file is created EMPTY, its ACL is set (main user F, SYSTEM F, Administrators F, no agent user),
       and only then is the content written: ipcHmacKey copied from the agent's secrets.json (generated once by
       deploy\new-secrets.ps1; never printed), and the DeepSeek key typed at a hidden prompt (Read-Host -AsSecureString;
       Enter keeps the stored value or skips it) [UI-14].
    5. Registers the scheduled task \agent-007\jobrunner: trigger AT LOGON of the main user, principal the main user
       (Interactive, Limited), MultipleInstances IgnoreNew, restart on failure. The script never starts the task.

  Code comes from the same Program Files folder as the agent (deploy-app.ps1 deploys dist\); the agent user has RX there
  only, so it cannot change code that runs as the main user (I17).

  Values are never echoed, logged, written to the pipeline or put in an environment variable.

.PARAMETER MainUser
  The user the job runner runs as. Default: the user running this elevated shell (DOMAIN\name).

.PARAMETER DataDir
  Default %LOCALAPPDATA%\agent-007-jobrunner of the user running this shell. Pass it when an administrator other than the
  main user runs the script.

.PARAMETER ForceTemplates
  Overwrite templates that already exist in the job runner's templates folder.

.PARAMETER SkipSecrets
  Do not touch secrets.json (no prompt).

.PARAMETER SkipTask
  Do not register the scheduled task.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$AgentUser = 'agent007',
    [string]$MainUser = '',
    [string]$RepoRoot = '',
    [string]$ProgramFilesDir = '',
    [string]$ProgramDataDir = '',
    [string]$DataDir = '',
    [string]$AgentSecretsFile = '',
    [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
    [string]$TaskPath = '\agent-007\',
    [string]$TaskName = 'jobrunner',
    [switch]$ForceTemplates,
    [switch]$SkipSecrets,
    [switch]$SkipTask
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\common.ps1')
. (Join-Path $PSScriptRoot '..\acl-write.ps1')
$dry = [bool]$WhatIfPreference
Assert-Elevated -DryRun:$dry -ScriptName 'install-jobrunner.ps1'

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
if (-not $MainUser) { $MainUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name }
if (-not $ProgramFilesDir) {
    $pf = $env:ProgramFiles
    if (-not $pf) { $pf = 'C:\Program Files' }
    $ProgramFilesDir = Join-WinPath $pf 'agent-007'
}
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
if (-not $AgentSecretsFile) { $AgentSecretsFile = Join-WinPath $ProgramDataDir 'secrets', 'secrets.json' }

$jobRunnerDir = Join-WinPath $ProgramDataDir 'jobrunner'
$templatesDir = Join-WinPath $ProgramDataDir 'jobrunner', 'templates'
$configFile = Join-WinPath $ProgramDataDir 'jobrunner', 'jobrunner.json'
$secretsFile = Join-WinPath $DataDir 'secrets.json'
$mainJs = Join-WinPath $ProgramFilesDir 'dist', 'src', 'jobrunner', 'main.js'
$exampleConfig = Join-WinPath $RepoRoot 'config', 'jobrunner.example.json'
$templateSource = Join-WinPath $RepoRoot 'config', 'templates'

# ---- preconditions (a dry run only warns) -----------------------------------------------------
$missing = @()
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { $missing += "node.exe not found: $NodeExe" }
if (-not (Test-Path -LiteralPath $mainJs -PathType Leaf)) { $missing += "the job runner is not deployed yet (run deploy-app.ps1): $mainJs" }
if (-not (Test-Path -LiteralPath $exampleConfig -PathType Leaf)) { $missing += "config\jobrunner.example.json not found under $RepoRoot" }
if (-not $SkipSecrets -and -not (Test-Path -LiteralPath $AgentSecretsFile -PathType Leaf)) { $missing += "the agent's secrets file does not exist (run new-secrets.ps1 first): $AgentSecretsFile" }
if ($null -eq (Get-AccountSid -Name $MainUser)) { $missing += "the account '$MainUser' cannot be resolved" }
foreach ($m in $missing) { if ($dry) { Write-Warning $m } }
if ($missing.Count -gt 0 -and -not $dry) { throw ('Preconditions failed: ' + ($missing -join '; ')) }
$ownProfile = $env:USERPROFILE
if ($ownProfile -and -not $DataDir.StartsWith($ownProfile, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Warning "The data folder $DataDir is not under the profile of the user running this shell ($ownProfile). It must be the MAIN user's folder."
}

$mainSid = Get-AccountSid -Name $MainUser
$mainAcct = $MainUser

Write-Host "agent-007 S11.6: job runner install for $MainUser$(if ($dry) { ' (dry run)' })"
Write-Host "  config folder : $jobRunnerDir (agent user: NO access; templates\ read only)"
Write-Host "  data folder   : $DataDir (main user only; the agent user has no access)"
Write-Host "  code          : $mainJs"
Write-Host "  task          : $TaskPath$TaskName at logon of $MainUser"

# ---- 1. the config folder ---------------------------------------------------------------------
function Set-JobRunnerConfigDirAcl {
    param([string]$Path, [string]$Main)
    Set-ExactAcl -Path $Path -Entries @(
        (New-AclEntry -Sid $script:SidSystem -Rights 'FullControl'),
        (New-AclEntry -Sid $script:SidAdministrators -Rights 'FullControl'),
        (New-AclEntry -Account $Main -Rights 'Modify'))
}
function Set-JobRunnerTemplatesDirAcl {
    param([string]$Path, [string]$Main, [string]$Agent)
    Set-ExactAcl -Path $Path -Entries @(
        (New-AclEntry -Sid $script:SidSystem -Rights 'FullControl'),
        (New-AclEntry -Sid $script:SidAdministrators -Rights 'FullControl'),
        (New-AclEntry -Account $Main -Rights 'Modify'),
        (New-AclEntry -Account $Agent -Rights 'Read'))
}
function Set-JobRunnerDataDirAcl {
    param([string]$Path, [string]$Main)
    Set-ExactAcl -Path $Path -Entries @(
        (New-AclEntry -Sid $script:SidSystem -Rights 'FullControl'),
        (New-AclEntry -Sid $script:SidAdministrators -Rights 'FullControl'),
        (New-AclEntry -Account $Main -Rights 'FullControl'))
}
function Set-JobRunnerSecretFileAcl {
    param([string]$Path, [string]$Main)
    Set-ExactAcl -Path $Path -Entries @(
        (New-AclEntry -Sid $script:SidSystem -Rights 'FullControl' -Inherit $false),
        (New-AclEntry -Sid $script:SidAdministrators -Rights 'FullControl' -Inherit $false),
        (New-AclEntry -Account $Main -Rights 'FullControl' -Inherit $false))
}

Invoke-Step -DryRun:$dry -Description "create folder $jobRunnerDir" -Action {
    if (-not (Test-Path -LiteralPath $jobRunnerDir -PathType Container)) { New-Item -ItemType Directory -Path $jobRunnerDir -Force | Out-Null }
}
Invoke-Step -DryRun:$dry -Description "SET ACL on $jobRunnerDir (inheritance off, SYSTEM F, Administrators F, $MainUser Modify, no ACE for $AgentUser)" -Action {
    Set-JobRunnerConfigDirAcl -Path $jobRunnerDir -Main $mainAcct
}
Invoke-Step -DryRun:$dry -Description "create folder $templatesDir" -Action {
    if (-not (Test-Path -LiteralPath $templatesDir -PathType Container)) { New-Item -ItemType Directory -Path $templatesDir -Force | Out-Null }
}
Invoke-Step -DryRun:$dry -Description "SET ACL on $templatesDir (inheritance off, SYSTEM F, Administrators F, $MainUser Modify, $AgentUser Read only)" -Action {
    Set-JobRunnerTemplatesDirAcl -Path $templatesDir -Main $mainAcct -Agent $AgentUser
}

# ---- 2. templates and config (copied AFTER the ACLs above) ------------------------------------
if (Test-Path -LiteralPath $templateSource -PathType Container) {
    foreach ($f in @(Get-ChildItem -LiteralPath $templateSource -Filter '*.json' -File)) {
        $target = Join-WinPath $templatesDir $f.Name
        if ((Test-Path -LiteralPath $target -PathType Leaf) -and -not $ForceTemplates) {
            Write-Host "  keep template $($f.Name) (exists; -ForceTemplates replaces it)"
            continue
        }
        Invoke-Step -DryRun:$dry -Description "copy template $($f.Name) to $templatesDir" -Action {
            Copy-Item -LiteralPath $f.FullName -Destination $target -Force
        }
    }
} else {
    Write-Warning "No templates folder at ${templateSource}: nothing to copy."
}
Invoke-Step -DryRun:$dry -Description "copy config\jobrunner.example.json to $configFile if there is no jobrunner.json (an existing file is never overwritten)" -Action {
    if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) { Copy-Item -LiteralPath $exampleConfig -Destination $configFile }
}

# ---- 3. the data folder -----------------------------------------------------------------------
Invoke-Step -DryRun:$dry -Description "create folder $DataDir" -Action {
    if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
}
Invoke-Step -DryRun:$dry -Description "SET ACL on $DataDir (inheritance off, SYSTEM F, Administrators F, $MainUser F, no ACE for $AgentUser)" -Action {
    Set-JobRunnerDataDirAcl -Path $DataDir -Main $mainAcct
}

# ---- 4. secrets.json: empty file, ACL, and only then the content ------------------------------
if ($SkipSecrets) {
    Write-Host '  secrets.json  : skipped (-SkipSecrets)'
} elseif ($dry) {
    Invoke-Step -DryRun:$dry -Description "create $secretsFile EMPTY if missing" -Action { }
    Invoke-Step -DryRun:$dry -Description "set the secret-file ACL on $secretsFile (inheritance off, $MainUser F, SYSTEM F, Administrators F, no ACE for $AgentUser)" -Action { }
    Invoke-Step -DryRun:$dry -Description "write ipcHmacKey (copied from the agent's secrets file, value not shown) and the DeepSeek key (typed at a hidden prompt, value not shown) to $secretsFile" -Action { }
} else {
    function Read-SecretText {
        param([Parameter(Mandatory = $true)][string]$Prompt)
        $sec = Read-Host -Prompt $Prompt -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        try { return ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)).Trim() } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            $sec.Dispose()
        }
    }
    Invoke-Step -DryRun:$dry -Description "create $secretsFile EMPTY if missing" -Action {
        if (-not (Test-Path -LiteralPath $secretsFile -PathType Leaf)) { [System.IO.File]::WriteAllBytes($secretsFile, [byte[]]@()) }
    }
    Invoke-Step -DryRun:$dry -Description "set the secret-file ACL on $secretsFile" -Action {
        Set-JobRunnerSecretFileAcl -Path $secretsFile -Main $mainAcct
    }
    $existing = [ordered]@{}
    if ((Get-Item -LiteralPath $secretsFile).Length -gt 0) {
        try {
            $h = ConvertTo-HashtableDeep (Read-JsonFile -Path $secretsFile)
            if ($h -is [System.Collections.IDictionary]) { $existing = $h }
        } catch { throw "Existing job runner secrets file is not readable JSON: $secretsFile. Fix or remove it first." }
    }
    $agentSecrets = ConvertTo-HashtableDeep (Read-JsonFile -Path $AgentSecretsFile)
    $ipcKeyPlain = ''
    if ($agentSecrets -is [System.Collections.IDictionary] -and $agentSecrets.Contains('ipcHmacKey')) { $ipcKeyPlain = [string]$agentSecrets['ipcHmacKey'] }
    if ($ipcKeyPlain -notmatch '^[A-Za-z0-9_-]{43,}$') { throw 'The agent secrets file has no valid ipcHmacKey (run deploy\new-secrets.ps1). Nothing was written.' }
    $deepseekPlain = Read-SecretText -Prompt 'DeepSeek API key (input hidden; Enter to keep the stored value or skip)'
    $content = [ordered]@{}
    foreach ($k in $existing.Keys) { $content[$k] = $existing[$k] }
    $content['ipcHmacKey'] = $ipcKeyPlain
    if ($deepseekPlain -ne '') { $content['deepseekApiKey'] = $deepseekPlain }
    $json = ConvertTo-Json -InputObject $content -Depth 8
    Invoke-Step -DryRun:$dry -Description "write the JSON content to $secretsFile (values not shown)" -Action {
        [System.IO.File]::WriteAllText($secretsFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    }
    $ipcKeyPlain = $null; $deepseekPlain = $null; $content = $null; $existing = $null; $agentSecrets = $null; $json = $null
    Write-Host "Secrets written (values not shown) to $secretsFile"
}

# ---- 5. the scheduled task --------------------------------------------------------------------
if ($SkipTask) {
    Write-Host '  task          : skipped (-SkipTask)'
} else {
    $action = New-ScheduledTaskAction -Execute $NodeExe -Argument ('"' + $mainJs + '" --config "' + $configFile + '"') -WorkingDirectory $DataDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $MainUser
    $settings = New-AgentTaskSettings
    $principal = New-ScheduledTaskPrincipal -UserId $MainUser -LogonType Interactive -RunLevel Limited
    $existingTask = $null
    try { $existingTask = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop } catch { $existingTask = $null }
    Write-Host "scheduled task $TaskPath$TaskName$(if ($existingTask) { ' (exists: will be updated in place)' } else { ' (new)' })"
    Write-TaskSummary -TaskPath $TaskPath -TaskName $TaskName -Action $action -Triggers @($trigger) -Settings $settings -UserId $MainUser -LogonType 'Interactive'
    Invoke-Step -DryRun:$dry -Description "REGISTER task $TaskPath$TaskName for $MainUser (at logon, LogonType Interactive, RunLevel Limited)" -Action {
        $desc = 'agent-007: the job runner (node dist\src\jobrunner\main.js) under the main user, started at logon (I17, UI-13).'
        Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Description $desc -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    }
}

Write-Host ''
Write-Host "Done$(if ($dry) { ' (dry run: nothing was changed)' }). The task is not started by this script."
Write-Host 'Next: deploy\check-acl.ps1 should exit 0; deploy\jobrunner\check-jobrunner.ps1 checks the listener and the secrets ACL after the first logon.'
