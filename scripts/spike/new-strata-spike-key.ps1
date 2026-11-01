<#
.SYNOPSIS
  P0.7a spike key helper: generates a random 32-byte Strata API key and stores it, without ever printing it.

.DESCRIPTION
  Run ELEVATED, by the user, as part of the P0.7a Strata spike (plan section 5, P0.7a). It
    1. checks the agent-owned Strata config copy exists and is valid JSON (the copy is made from the shipped config
       with only open_browser and the log path changed; nothing under D:\Strata is touched);
    2. sets the copy's ACL FIRST: the agent user Read, SYSTEM Full, Administrators Full, inheritance off,
       no Users / Authenticated Users (it is a secret file);
    3. generates a random 32-byte key (64 hex characters) from the OS random generator;
    4. writes it into the copy as "api_key" and into the dev secrets file as "strataApiKey".
  The key is never printed, logged or placed in an environment variable. S7.4 later generates the real key at deploy time.

.PARAMETER ConfigCopy
  Path of the agent-owned Strata config copy. Default C:\ProgramData\agent-007\strata\strata.json.

.PARAMETER DevSecrets
  Dev secrets file of the main user. Default %LOCALAPPDATA%\agent-007-dev\secrets.json. Other keys in it are kept.

.PARAMETER AgentUser
  The agent Windows user that gets Read on the copy. Default agent007.

.PARAMETER SkipAcl
  Tests only: skips the elevation check and the ACL change (used on temp paths by the unit test).
#>
[CmdletBinding()]
param(
    [string]$ConfigCopy = 'C:\ProgramData\agent-007\strata\strata.json',
    [string]$DevSecrets = (Join-Path $env:LOCALAPPDATA 'agent-007-dev\secrets.json'),
    [string]$AgentUser = 'agent007',
    [switch]$SkipAcl
)

$ErrorActionPreference = 'Stop'

function Test-Elevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function New-HexKey([int]$Bytes) {
    $buf = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
    return (($buf | ForEach-Object { $_.ToString('x2') }) -join '')
}

function ConvertTo-HashtableDeep($obj) {
    # Windows PowerShell 5.1 has no -AsHashtable; keep key order and nesting.
    if ($null -eq $obj) { return $null }
    if ($obj -is [System.Management.Automation.PSCustomObject]) {
        $h = [ordered]@{}
        foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = ConvertTo-HashtableDeep $p.Value }
        return $h
    }
    if ($obj -is [System.Collections.IEnumerable] -and $obj -isnot [string]) {
        return @($obj | ForEach-Object { ConvertTo-HashtableDeep $_ })
    }
    return $obj
}

if (-not $SkipAcl -and -not (Test-Elevated)) {
    throw 'Run this script in an elevated PowerShell (it sets an ACL on the Strata config copy).'
}
if (-not (Test-Path -LiteralPath $ConfigCopy -PathType Leaf)) {
    throw "Config copy not found: $ConfigCopy. Create it first (P0.7a, 'Agent-owned config')."
}

# 1. the copy must be valid JSON before anything changes
$raw = Get-Content -LiteralPath $ConfigCopy -Raw -Encoding UTF8
try { $cfg = ConvertTo-HashtableDeep (ConvertFrom-Json -InputObject $raw) } catch { throw "Config copy is not valid JSON: $ConfigCopy" }
if ($cfg -isnot [System.Collections.IDictionary]) { throw 'Config copy must be a JSON object.' }

# 2. ACL FIRST: agent user R, SYSTEM F, Administrators F, inheritance off
if (-not $SkipAcl) {
    $acl = Get-Acl -LiteralPath $ConfigCopy
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($r in @($acl.Access)) { [void]$acl.RemoveAccessRule($r) }
    $rights = [System.Security.AccessControl.FileSystemRights]
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $none = [System.Security.AccessControl.InheritanceFlags]::None
    $prop = [System.Security.AccessControl.PropagationFlags]::None
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\SYSTEM', $rights::FullControl, $none, $prop, $allow)))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('BUILTIN\Administrators', $rights::FullControl, $none, $prop, $allow)))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($AgentUser, $rights::Read, $none, $prop, $allow)))
    Set-Acl -LiteralPath $ConfigCopy -AclObject $acl
}

# 3. the key: 32 random bytes as 64 hex characters, held only in this variable
$key = New-HexKey 32

# 4a. into the config copy
$cfg['api_key'] = $key
$json = ($cfg | ConvertTo-Json -Depth 32)
[System.IO.File]::WriteAllText($ConfigCopy, $json, (New-Object System.Text.UTF8Encoding($false)))

# 4b. into the dev secrets file (other keys are kept)
$secretsDir = Split-Path -Parent $DevSecrets
if (-not (Test-Path -LiteralPath $secretsDir)) { New-Item -ItemType Directory -Path $secretsDir -Force | Out-Null }
$secrets = [ordered]@{}
if (Test-Path -LiteralPath $DevSecrets -PathType Leaf) {
    $existing = Get-Content -LiteralPath $DevSecrets -Raw -Encoding UTF8
    if ($existing.Trim().Length -gt 0) {
        try { $secrets = ConvertTo-HashtableDeep (ConvertFrom-Json -InputObject $existing) } catch { throw "Dev secrets file is not valid JSON: $DevSecrets" }
    }
}
$secrets['strataApiKey'] = $key
[System.IO.File]::WriteAllText($DevSecrets, ($secrets | ConvertTo-Json -Depth 32), (New-Object System.Text.UTF8Encoding($false)))

$key = $null
Write-Host "Strata spike key written (not shown) to:"
Write-Host "  config copy : $ConfigCopy  (key 'api_key', ACL: $(if ($SkipAcl) { 'unchanged (-SkipAcl)' } else { "$AgentUser R, SYSTEM F, Administrators F, no inheritance" }))"
Write-Host "  dev secrets : $DevSecrets  (key 'strataApiKey')"
Write-Host 'Next: check the diff against the shipped config shows exactly open_browser, the log path and api_key.'
