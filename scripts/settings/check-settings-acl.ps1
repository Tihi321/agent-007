<#
.SYNOPSIS
  S17.4: READ-ONLY check of the Phase 3 settings ACLs (plan section 4.2). Exit 0 = compliant, exit 1 = at least one violation.

.DESCRIPTION
  Changes nothing: it only calls Get-Acl and Test-Path. Checks:
    - settings\, settings\personas\ and settings\security.json: the agent user has READ only (no write-data, append-data,
      delete, change-permissions, take-ownership, and no delete-child on a folder); inheritance is off; no Users,
      Authenticated Users or Everyone write access;
    - settings\audit\: the agent user and the main user have read plus append only. On the folder the agent user may
      have add-file (Plan A) but never delete-child, delete or change-permissions; on every settings-*.jsonl the agent
      user must NOT have write-data, delete or change-permissions (append-data is the point);
    - no Users, Authenticated Users or Everyone write access anywhere under settings\.
  Run it elevated: a path whose ACL cannot be read is a violation.

.PARAMETER AgentUser
  Default agent007.

.PARAMETER ProgramDataDir
  Default C:\ProgramData\agent-007.
#>
[CmdletBinding()]
param(
    [string]$AgentUser = 'agent007',
    [string]$ProgramDataDir = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\deploy\common.ps1')

if (-not $ProgramDataDir) {
    $pd = $env:ProgramData
    if (-not $pd) { $pd = 'C:\ProgramData' }
    $ProgramDataDir = Join-WinPath $pd 'agent-007'
}
$settingsDir = Join-WinPath $ProgramDataDir 'settings'
$personasDir = Join-WinPath $ProgramDataDir 'settings', 'personas'
$auditDir = Join-WinPath $ProgramDataDir 'settings', 'audit'
$securityFile = Join-WinPath $ProgramDataDir 'settings', 'security.json'

$violations = New-Object System.Collections.Generic.List[string]
$agentSid = Get-AccountSid -Name $AgentUser
if ($null -eq $agentSid) { $violations.Add("the account '$AgentUser' cannot be resolved"); }

# FileSystemRights bits
$WRITE_DATA = 0x2; $APPEND_DATA = 0x4; $DELETE_CHILD = 0x40; $DELETE = 0x10000; $CHANGE_PERMS = 0x40000; $TAKE_OWNER = 0x80000
$ANY_WRITE = ($WRITE_DATA -bor $APPEND_DATA -bor $DELETE_CHILD -bor $DELETE -bor $CHANGE_PERMS -bor $TAKE_OWNER)

function Get-EffectiveBits {
    # The union of the Allow rights that name this SID (minus Deny bits); inherit-only ACEs are skipped.
    param($Acl, $Sid)
    $allow = 0; $deny = 0
    foreach ($r in $Acl.Access) {
        if (($r.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        $rsid = $null
        try { $rsid = $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) } catch { continue }
        if ($rsid.Value -ne $Sid.Value) { continue }
        if ($r.AccessControlType -eq 'Allow') { $allow = $allow -bor [int]$r.FileSystemRights } else { $deny = $deny -bor [int]$r.FileSystemRights }
    }
    return ($allow -band (-bnot $deny))
}

function Get-ForbiddenWrite {
    param($Acl)
    foreach ($sidValue in @($script:SidUsers, $script:SidAuthenticatedUsers, $script:SidEveryone)) {
        $sid = New-Object System.Security.Principal.SecurityIdentifier($sidValue)
        if ((Get-EffectiveBits -Acl $Acl -Sid $sid) -band $ANY_WRITE) { return $sidValue }
    }
    return $null
}

function Test-ReadOnlyForAgent {
    param([string]$Path, [string]$Label, [bool]$IsDir)
    if (-not (Test-Path -LiteralPath $Path)) { $violations.Add("$Label does not exist: ${Path}"); return }
    $acl = $null
    try { $acl = Get-Acl -LiteralPath $Path } catch { $violations.Add("$Label ACL cannot be read (run elevated): ${Path}"); return }
    if (-not $acl.AreAccessRulesProtected) { $violations.Add("$Label has inheritance on: ${Path}") }
    if ($agentSid) {
        $bits = Get-EffectiveBits -Acl $acl -Sid $agentSid
        if ($bits -band $ANY_WRITE) { $violations.Add("${Label}: the agent user can write, append, delete or change permissions: ${Path}") }
    }
    $bad = Get-ForbiddenWrite -Acl $acl
    if ($bad) { $violations.Add("${Label}: $bad has write access: ${Path}") }
}

Test-ReadOnlyForAgent -Path $settingsDir -Label 'settings folder' -IsDir $true
Test-ReadOnlyForAgent -Path $personasDir -Label 'settings\personas folder' -IsDir $true
if (Test-Path -LiteralPath $securityFile -PathType Leaf) { Test-ReadOnlyForAgent -Path $securityFile -Label 'security.json' -IsDir $false }

# The audit folder: add-file may be allowed (Plan A); never delete, change permissions or write-data on the files.
if (-not (Test-Path -LiteralPath $auditDir -PathType Container)) {
    $violations.Add("audit folder does not exist: $auditDir")
} else {
    $acl = $null
    try { $acl = Get-Acl -LiteralPath $auditDir } catch { $violations.Add("audit folder ACL cannot be read (run elevated): $auditDir") }
    if ($acl) {
        if (-not $acl.AreAccessRulesProtected) { $violations.Add("audit folder has inheritance on: $auditDir") }
        if ($agentSid) {
            $bits = Get-EffectiveBits -Acl $acl -Sid $agentSid
            if ($bits -band ($DELETE_CHILD -bor $DELETE -bor $CHANGE_PERMS -bor $TAKE_OWNER)) { $violations.Add("audit folder: the agent user can delete or change permissions: $auditDir") }
        }
        $bad = Get-ForbiddenWrite -Acl $acl
        if ($bad) { $violations.Add("audit folder: $bad has write access: $auditDir") }
    }
    foreach ($f in @(Get-ChildItem -LiteralPath $auditDir -Filter 'settings-*.jsonl' -File -ErrorAction SilentlyContinue)) {
        $facl = $null
        try { $facl = Get-Acl -LiteralPath $f.FullName } catch { $violations.Add("audit file ACL cannot be read (run elevated): $($f.FullName)"); continue }
        if ($agentSid) {
            $bits = Get-EffectiveBits -Acl $facl -Sid $agentSid
            if ($bits -band ($WRITE_DATA -bor $DELETE -bor $CHANGE_PERMS -bor $TAKE_OWNER)) { $violations.Add("audit file: the agent user can overwrite, delete or change permissions (append only is required): $($f.FullName)") }
        }
        $bad = Get-ForbiddenWrite -Acl $facl
        if ($bad) { $violations.Add("audit file: ${bad} has write access: $($f.FullName)") }
    }
}

if ($violations.Count -eq 0) {
    Write-Host 'settings ACLs: OK'
    exit 0
}
Write-Host 'settings ACLs: VIOLATIONS'
foreach ($v in $violations) { Write-Host "  - $v" }
exit 1
