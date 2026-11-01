<#
.SYNOPSIS
  S7.4: creates or updates secrets.json. The USER runs this, ELEVATED. The implementer never sees a value.

.DESCRIPTION
  - Prompts (Read-Host -AsSecureString, no echo) for the Telegram bot token and the LM Studio token. With -Runner strata
    the LM Studio token may be left empty. When a secrets file already exists, pressing Enter keeps the stored value.
  - With -Runner strata the script GENERATES strataApiKey itself (32 bytes from RandomNumberGenerator, base64url); the user
    never types it. -NoStrataKey skips it. An existing key is kept unless -RotateStrataKey. register-strata-task.ps1
    (S7.9) then copies the same value into the Strata config copy.
  - The file is created EMPTY first, its ACL is set (agent user R, SYSTEM F, Administrators F, inheritance off, no
    Users / Authenticated Users / Everyone), and only then is the content written.
  - Phase 2 (S9.4): the script also GENERATES ipcHmacKey (32 bytes from RandomNumberGenerator, base64url) for the agent <-> job
    runner IPC (I16). An existing key is kept unless -RotateIpcKey. The S11.6 installer copies the same value into the job
    runner's own secrets file. It then prompts (Read-Host -AsSecureString, no echo) for an optional MCP bearer token for each
    server id in -McpTokenServers (default book-translator, the one creative-hub server with a token, UI-18); Enter skips the
    server, or keeps the stored token. The tokens go into secrets.json under mcpTokens.
  - Phase 4 (S20.5): -Bots lists the extra bots (ids, never main) and prompts (Read-Host -AsSecureString, no echo) for each bot's
    Telegram token, stored under botTokens.<id>; -Mirror prompts for the bot room (mirror) bot's token, stored as mirrorBotToken.
    Enter keeps a stored value. A token that two bots share is refused. The BotFather checklist is printed first (/newbot,
    /setjoingroups Disable, Bot-to-Bot Communication Mode off); the user does those steps in Telegram. The proxy key is NOT
    handled here: the user copies it in S23.1.
  - Values are never echoed, logged, written to the pipeline or put in an environment variable. Other keys already in the
    file are kept.
  - -WhatIf prints the plan and does NOT prompt.

.PARAMETER Runner
  lmstudio or strata. Default: model.runner of an existing config.json, else lmstudio.

.PARAMETER ProgramDataDir
  Default C:\ProgramData\agent-007. The file is <ProgramDataDir>\secrets\secrets.json.

.PARAMETER AgentUser
  The agent's Windows user. Default agent007.

.PARAMETER RotateIpcKey
  Replace the stored ipcHmacKey with a new random one. The job runner's copy must be updated too (S11.6 installer).

.PARAMETER McpTokenServers
  Server ids to prompt an optional MCP bearer token for. Default book-translator. Pass an empty array to skip the prompts.

.PARAMETER Bots
  Phase 4: the ids of the extra bots to prompt a Telegram token for (2 to 24 of a-z, 0-9 and '-'; not main, which uses
  telegramBotToken). Default none: a one-bot install is unchanged.

.PARAMETER Mirror
  Phase 4: also prompt for the mirror (bot room) bot's token.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('lmstudio', 'strata')][string]$Runner,
    [string]$ProgramDataDir = '',
    [string]$AgentUser = 'agent007',
    [switch]$NoStrataKey,
    [switch]$RotateStrataKey,
    [switch]$RotateIpcKey,
    [string[]]$McpTokenServers = @('book-translator'),
    [string[]]$Bots = @(),
    [switch]$Mirror
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'acl-write.ps1')
$dry = [bool]$WhatIfPreference
Assert-Elevated -DryRun:$dry -ScriptName 'new-secrets.ps1'

if (-not $ProgramDataDir) {
    $pd = $env:ProgramData
    if (-not $pd) { $pd = 'C:\ProgramData' }
    $ProgramDataDir = Join-WinPath $pd 'agent-007'
}
$secretsDir = Join-WinPath $ProgramDataDir 'secrets'
$secretsFile = Join-WinPath $ProgramDataDir 'secrets', 'secrets.json'

if (-not $PSBoundParameters.ContainsKey('Runner')) {
    $Runner = 'lmstudio'
    $cfgPath = Join-WinPath $ProgramDataDir 'config', 'config.json'
    if (Test-Path -LiteralPath $cfgPath -PathType Leaf) {
        try {
            $r = Get-JsonProp (Get-JsonProp (Read-JsonFile -Path $cfgPath) 'model' $null) 'runner' 'lmstudio'
            if ($r -eq 'strata') { $Runner = 'strata' }
        } catch { }
    }
}
if ($NoStrataKey -and $RotateStrataKey) { throw '-NoStrataKey and -RotateStrataKey cannot be used together.' }

function Read-SecretText {
    param([Parameter(Mandatory = $true)][string]$Prompt)
    $sec = Read-Host -Prompt $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)).Trim() } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        $sec.Dispose()
    }
}

function New-Base64UrlKey {
    param([int]$Bytes = 32)
    $buf = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
    return ([Convert]::ToBase64String($buf).TrimEnd('=').Replace('+', '-').Replace('/', '_'))
}

# The existing file is read into memory only. Parse errors never echo content.
$existing = [ordered]@{}
$fileExists = Test-Path -LiteralPath $secretsFile -PathType Leaf
if ($fileExists) {
    try {
        $parsed = Read-JsonFile -Path $secretsFile
        $h = ConvertTo-HashtableDeep $parsed
        if ($h -is [System.Collections.IDictionary]) { $existing = $h }
    } catch {
        if ($dry) { Write-Warning "Existing secrets file could not be read or parsed (dry run, continuing): $secretsFile" }
        else { throw "Existing secrets file is not readable JSON: $secretsFile. Fix or remove it first." }
    }
}
$hasBot = ($existing.Contains('telegramBotToken') -and "$($existing['telegramBotToken'])".Length -gt 0)
$hasLm = ($existing.Contains('lmStudioApiToken') -and "$($existing['lmStudioApiToken'])".Length -gt 0)
$hasStrata = ($existing.Contains('strataApiKey') -and "$($existing['strataApiKey'])".Length -gt 0)
$hasIpc = ($existing.Contains('ipcHmacKey') -and "$($existing['ipcHmacKey'])".Length -gt 0)
$willGenerateIpc = ($RotateIpcKey -or -not $hasIpc)
$mcpIds = @($McpTokenServers | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })

$willGenerate = ($Runner -eq 'strata' -and -not $NoStrataKey -and ($RotateStrataKey -or -not $hasStrata))

# Phase 4: extra bots and the mirror bot. Only ids and yes/no flags are kept here for the plan text, never a value.
$botIds = @($Bots | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
foreach ($b in $botIds) {
    if ($b -notmatch '^[a-z][a-z0-9-]{1,23}$') { throw "Bot id '$b' is not valid (2 to 24 characters of a-z, 0-9 and '-', starting with a letter). Nothing was written." }
    if ($b -eq 'main') { throw "The bot 'main' uses telegramBotToken (prompted above); do not list it in -Bots. Nothing was written." }
}
if (@($botIds | Select-Object -Unique).Count -ne $botIds.Count) { throw 'A bot id is listed twice in -Bots. Nothing was written.' }
$botStored = @{}
foreach ($b in $botIds) { $botStored[$b] = $false }
$hasMirror = ($existing.Contains('mirrorBotToken') -and "$($existing['mirrorBotToken'])".Length -gt 0)
if ($existing.Contains('botTokens') -and $existing['botTokens'] -is [System.Collections.IDictionary]) {
    foreach ($b in $botIds) { if ($existing['botTokens'].Contains($b) -and "$($existing['botTokens'][$b])".Length -gt 0) { $botStored[$b] = $true } }
}

function Write-BotFatherSteps {
    Write-Host 'BotFather checklist for EACH extra bot (you do this in Telegram; this script never sees a token until you paste it at a prompt):'
    Write-Host '  1. /newbot          choose a name and a username; BotFather then shows the token'
    Write-Host '  2. /setjoingroups   choose the bot, then Disable (a working bot never joins a group)'
    Write-Host '  3. Bot-to-Bot Communication Mode: leave it OFF (BotFather > the bot > Bot Settings; off is the default)'
    Write-Host '  The mirror (bot room) bot: /newbot and keep Bot-to-Bot Communication Mode off, but do NOT disable joining groups: you add it to your private room.'
}

Write-Host "agent-007 S7.4: secrets file for runner '$Runner'$(if ($dry) { ' (dry run: no prompts, nothing is written)' })"
Write-Host "  file : $secretsFile ($(if ($fileExists) { 'exists, other keys are kept' } else { 'will be created' }))"
Write-Host "  ACL  : agent user $AgentUser R, SYSTEM F, Administrators F, inheritance off, no Users / Authenticated Users / Everyone (set BEFORE the content is written)"
Write-Host "  telegramBotToken : will prompt (no echo)$(if ($hasBot) { '; Enter keeps the stored value' })"
if ($Runner -eq 'lmstudio') { Write-Host "  lmStudioApiToken : will prompt (no echo)$(if ($hasLm) { '; Enter keeps the stored value' })" }
else { Write-Host '  lmStudioApiToken : will prompt (no echo); may be left empty with -Runner strata' }
if ($Runner -eq 'strata') {
    if ($NoStrataKey) { Write-Host '  strataApiKey     : skipped (-NoStrataKey): any local process can call Strata' }
    elseif ($willGenerate) { Write-Host '  strataApiKey     : will be generated here (32 random bytes, base64url), never shown, never typed' }
    else { Write-Host '  strataApiKey     : kept (use -RotateStrataKey to replace it)' }
}

if ($willGenerateIpc) { Write-Host '  ipcHmacKey       : will be generated here (32 random bytes, base64url), never shown, never typed' }
else { Write-Host '  ipcHmacKey       : kept (use -RotateIpcKey to replace it)' }
if ($mcpIds.Count -gt 0) { Write-Host "  mcpTokens        : will prompt (no echo) for an optional token for: $($mcpIds -join ', '); Enter skips or keeps" }
else { Write-Host '  mcpTokens        : no prompts (-McpTokenServers is empty)' }
if ($botIds.Count -gt 0 -or $Mirror) { Write-BotFatherSteps }
foreach ($b in $botIds) { Write-Host "  botTokens.$b : will prompt (no echo)$(if ($botStored[$b]) { '; Enter keeps the stored value' } else { '; required' })" }
if ($Mirror) { Write-Host "  mirrorBotToken   : will prompt (no echo)$(if ($hasMirror) { '; Enter keeps the stored value' } else { '; required' })" }
if ($botIds.Count -eq 0 -and -not $Mirror) { Write-Host '  botTokens        : no extra bots (-Bots is empty): a one-bot install is unchanged' }

if ($dry) {
    Invoke-Step -DryRun:$dry -Description "create folder $secretsDir with the secrets-folder ACL (agent R, SYSTEM F, Administrators F, inheritance off) if missing" -Action { }
    Invoke-Step -DryRun:$dry -Description "create $secretsFile EMPTY if missing" -Action { }
    Invoke-Step -DryRun:$dry -Description "set the secret-file ACL on $secretsFile (inheritance off, agent R, SYSTEM F, Administrators F)" -Action { }
    Invoke-Step -DryRun:$dry -Description "write the JSON content to $secretsFile (values not shown)" -Action { }
    foreach ($b in $botIds) { Invoke-Step -DryRun:$dry -Description "store the token of bot '$b' under botTokens.$b in $secretsFile (value not shown)" -Action { } }
    if ($Mirror) { Invoke-Step -DryRun:$dry -Description "store the mirror bot token as mirrorBotToken in $secretsFile (value not shown)" -Action { } }
    Write-Host 'Dry run complete: nothing was prompted, written or changed.'
    return
}

# ---- prompts (no echo). Values live only in these variables. ----------------------------------
$botTokenPlain = Read-SecretText -Prompt 'Telegram bot token (input hidden)'
if ($botTokenPlain -eq '') {
    if (-not $hasBot) { throw 'A Telegram bot token is required.' }
    $botTokenPlain = [string]$existing['telegramBotToken']
}
if ($botTokenPlain -notmatch '^\d+:[A-Za-z0-9_-]{20,}$') { throw 'The Telegram bot token does not look like <digits>:<characters> (value not shown). Nothing was written.' }

$lmTokenPlain = Read-SecretText -Prompt $(if ($Runner -eq 'strata') { 'LM Studio API token (input hidden; Enter to leave empty or keep)' } else { 'LM Studio API token (input hidden)' })
if ($lmTokenPlain -eq '') {
    if ($hasLm) { $lmTokenPlain = [string]$existing['lmStudioApiToken'] }
    elseif ($Runner -eq 'lmstudio') { throw 'An LM Studio API token is required with -Runner lmstudio.' }
}

$strataKeyPlain = $null
if ($Runner -eq 'strata' -and -not $NoStrataKey) {
    if ($willGenerate) { $strataKeyPlain = New-Base64UrlKey -Bytes 32 }
    else { $strataKeyPlain = [string]$existing['strataApiKey'] }
}

# Phase 2: the IPC key is generated here, never typed. MCP tokens are optional prompts.
if ($willGenerateIpc) { $ipcKeyPlain = New-Base64UrlKey -Bytes 32 } else { $ipcKeyPlain = [string]$existing['ipcHmacKey'] }
$mcpMap = [ordered]@{}
if ($existing.Contains('mcpTokens') -and $existing['mcpTokens'] -is [System.Collections.IDictionary]) {
    foreach ($k in $existing['mcpTokens'].Keys) { if ("$($existing['mcpTokens'][$k])".Length -gt 0) { $mcpMap[$k] = [string]$existing['mcpTokens'][$k] } }
}
foreach ($id in $mcpIds) {
    $mcpTokenPlain = Read-SecretText -Prompt "MCP bearer token for server '$id' (input hidden; Enter to skip or keep)"
    if ($mcpTokenPlain -ne '') { $mcpMap[$id] = $mcpTokenPlain }
}

# Phase 4: one token per extra bot and the mirror bot (secure prompts; Enter keeps a stored value; checked for shape and for sharing).
$botTokenMap = [ordered]@{}
if ($existing.Contains('botTokens') -and $existing['botTokens'] -is [System.Collections.IDictionary]) {
    foreach ($k in $existing['botTokens'].Keys) { if ("$($existing['botTokens'][$k])".Length -gt 0) { $botTokenMap[$k] = [string]$existing['botTokens'][$k] } }
}
$mirrorTokenPlain = $null
foreach ($b in $botIds) {
    $extraTokenPlain = Read-SecretText -Prompt "Telegram bot token for bot '$b' (input hidden; Enter keeps the stored value)"
    if ($extraTokenPlain -eq '') {
        if (-not $botTokenMap.Contains($b)) { throw "A token for bot '$b' is required. Nothing was written." }
        continue
    }
    if ($extraTokenPlain -notmatch '^\d+:[A-Za-z0-9_-]{20,}$') { throw "The token for bot '$b' does not look like <digits>:<characters> (value not shown). Nothing was written." }
    $botTokenMap[$b] = $extraTokenPlain
}
if ($Mirror) {
    $mirrorTokenPlain = Read-SecretText -Prompt 'Telegram bot token for the MIRROR bot (input hidden; Enter keeps the stored value)'
    if ($mirrorTokenPlain -eq '') {
        if (-not $hasMirror) { throw 'A token for the mirror bot is required with -Mirror. Nothing was written.' }
        $mirrorTokenPlain = [string]$existing['mirrorBotToken']
    }
    if ($mirrorTokenPlain -notmatch '^\d+:[A-Za-z0-9_-]{20,}$') { throw 'The mirror bot token does not look like <digits>:<characters> (value not shown). Nothing was written.' }
} elseif ($hasMirror) { $mirrorTokenPlain = [string]$existing['mirrorBotToken'] }
# no token may be used by two bots (one poller per token)
$seenTokens = @{}
$tokenOwners = New-Object System.Collections.ArrayList
[void]$tokenOwners.Add(@('main', $botTokenPlain))
foreach ($k in $botTokenMap.Keys) { [void]$tokenOwners.Add(@("bot '$k'", [string]$botTokenMap[$k])) }
if ($mirrorTokenPlain) { [void]$tokenOwners.Add(@('the mirror bot', $mirrorTokenPlain)) }
foreach ($pair in $tokenOwners) {
    if ($seenTokens.ContainsKey($pair[1])) { throw "$($seenTokens[$pair[1]]) and $($pair[0]) have the same token (value not shown). Nothing was written." }
    $seenTokens[$pair[1]] = $pair[0]
}
$seenTokens = $null; $tokenOwners = $null

# ---- folder, EMPTY file, ACL, and only then the content ---------------------------------------
Invoke-Step -DryRun:$dry -Description "create folder $secretsDir" -Action {
    if (-not (Test-Path -LiteralPath $secretsDir -PathType Container)) {
        New-Item -ItemType Directory -Path $secretsDir -Force | Out-Null
        Set-ReadOnlyForAgentDirAcl -Path $secretsDir -AgentUser $AgentUser
    }
}
Invoke-Step -DryRun:$dry -Description "create $secretsFile EMPTY if missing" -Action {
    if (-not (Test-Path -LiteralPath $secretsFile -PathType Leaf)) { [System.IO.File]::WriteAllBytes($secretsFile, [byte[]]@()) }
}
Invoke-Step -DryRun:$dry -Description "set the secret-file ACL on $secretsFile" -Action {
    Set-SecretFileAcl -Path $secretsFile -AgentUser $AgentUser
}

$content = [ordered]@{}
foreach ($k in $existing.Keys) { $content[$k] = $existing[$k] }
$content['telegramBotToken'] = $botTokenPlain
if ($lmTokenPlain -ne '') { $content['lmStudioApiToken'] = $lmTokenPlain }
if ($strataKeyPlain) { $content['strataApiKey'] = $strataKeyPlain }
$content['ipcHmacKey'] = $ipcKeyPlain
if ($mcpMap.Count -gt 0) { $content['mcpTokens'] = $mcpMap }
if ($botTokenMap.Count -gt 0) { $content['botTokens'] = $botTokenMap }
if ($mirrorTokenPlain) { $content['mirrorBotToken'] = $mirrorTokenPlain }
$json = ConvertTo-Json -InputObject $content -Depth 16
Invoke-Step -DryRun:$dry -Description "write the JSON content to $secretsFile (values not shown)" -Action {
    [System.IO.File]::WriteAllText($secretsFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$botTokenMap = $null; $extraTokenPlain = $null; $mirrorTokenPlain = $null
$botTokenPlain = $null; $lmTokenPlain = $null; $strataKeyPlain = $null; $ipcKeyPlain = $null; $mcpTokenPlain = $null; $mcpMap = $null; $json = $null; $content = $null; $existing = $null
Write-Host "Secrets written (values not shown) to $secretsFile"
if ($Runner -eq 'strata' -and -not $NoStrataKey) { Write-Host 'Next: deploy/register-strata-task.ps1 copies the Strata key into the Strata config copy.' }
Write-Host 'Next: deploy/check-acl.ps1 should exit 0. The job runner installer (S11.6) copies ipcHmacKey into its own secrets file.'
