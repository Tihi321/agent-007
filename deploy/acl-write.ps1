<#
.SYNOPSIS
  ACL-CHANGING helpers for the agent-007 deploy scripts (dot-sourced by the scripts that change ACLs; never by check-acl.ps1).

.DESCRIPTION
  These functions DO change ACLs. Callers wrap every call in Invoke-Step (common.ps1), so a -WhatIf run never reaches them.

  Two styles, on purpose:
    - EXACT: the folder or file is ours (Program Files\agent-007, ProgramData\agent-007\config, secrets, the agent data
      root, the Strata config copy). The whole DACL is replaced, inheritance is switched off, nothing else survives.
    - ADDITIVE: the folder belongs to the user or to a third party (allowed folders, denied folders, D:\Strata,
      D:\Strata-data). Only the agent user's own ACEs are added or removed (icacls /grant, /deny, /remove).

  Two rules are enforced here, in code, whatever a caller passes:
    - Add-DenyRead refuses any group (b) path (and any path that is under or contains one): a Deny Read there would
      break the agent or the Strata task.
    - Add-DenyWrite is the only other /deny and its rights are fixed: no read right is ever denied by it.
#>

function Invoke-Icacls {
    param([Parameter(Mandatory = $true)][string[]]$ArgList)
    $out = & icacls.exe @ArgList 2>&1
    if ($LASTEXITCODE -ne 0) { throw "icacls failed (exit $LASTEXITCODE) for: icacls $($ArgList -join ' ')`n$($out -join "`n")" }
    return $out
}

# ---- EXACT ----------------------------------------------------------------------------------

# $Entries: @{ Sid = 'S-1-5-18' | $null; Account = 'agent007' (used when Sid is $null); Rights = 'ReadAndExecute'; Inherit = $true }
function Set-ExactAcl {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][object[]]$Entries)
    $isDir = Test-Path -LiteralPath $Path -PathType Container
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($r in @($acl.Access)) { [void]$acl.RemoveAccessRule($r) }
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $prop = [System.Security.AccessControl.PropagationFlags]::None
    foreach ($e in $Entries) {
        if ($e.Sid) { $id = New-Object System.Security.Principal.SecurityIdentifier($e.Sid) } else { $id = New-Object System.Security.Principal.NTAccount($e.Account) }
        $inh = [System.Security.AccessControl.InheritanceFlags]::None
        if ($isDir -and $e.Inherit) { $inh = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
        $rulePropagation = $prop
        # Explicit flags win (the audit folders need a this-folder-only ACE and a files-only inheritable ACE).
        if ($e.InheritFlags) { $inh = [System.Security.AccessControl.InheritanceFlags]$e.InheritFlags }
        if ($e.PropagationFlags) { $rulePropagation = [System.Security.AccessControl.PropagationFlags]$e.PropagationFlags }
        $rights = [System.Security.AccessControl.FileSystemRights]$e.Rights
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($id, $rights, $inh, $rulePropagation, $allow)))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function New-AclEntry {
    param([string]$Sid, [string]$Account, [string]$Rights, [bool]$Inherit = $true, [string]$InheritFlags = '', [string]$PropagationFlags = '')
    return @{ Sid = $Sid; Account = $Account; Rights = $Rights; Inherit = $Inherit; InheritFlags = $InheritFlags; PropagationFlags = $PropagationFlags }
}

# A secret file (secrets.json, the Strata config copy): agent user R, SYSTEM F, Administrators F, inheritance off,
# no Users / Authenticated Users / Everyone. Call it BEFORE any content is written (create the file empty first).
function Set-SecretFileAcl {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$AgentUser)
    Set-ExactAcl -Path $Path -Entries @(
        (New-AclEntry -Sid $script:SidSystem -Rights 'FullControl' -Inherit $false),
        (New-AclEntry -Sid $script:SidAdministrators -Rights 'FullControl' -Inherit $false),
        (New-AclEntry -Account $AgentUser -Rights 'Read' -Inherit $false))
}

# Folder patterns of section 4.2 (all: inheritance off, SYSTEM F, Administrators F).
function Set-ProgramFilesAcl {      # agent RX only
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$AgentUser)
    Set-ExactAcl -Path $Path -Entries @(
        (New-AclEntry -Sid $script:SidSystem -Rights 'FullControl'), (New-AclEntry -Sid $script:SidAdministrators -Rights 'FullControl'),
        (New-AclEntry -Account $AgentUser -Rights 'ReadAndExecute'))
}
function Set-ReadOnlyForAgentDirAcl {   # config dir, secrets dir: agent R
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$AgentUser)
    Set-ExactAcl -Path $Path -Entries @(
        (New-AclEntry -Sid $script:SidSystem -Rights 'FullControl'), (New-AclEntry -Sid $script:SidAdministrators -Rights 'FullControl'),
        (New-AclEntry -Account $AgentUser -Rights 'Read'))
}
function Set-AgentOwnedDirAcl {         # agent data root: agent F
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$AgentUser)
    Set-ExactAcl -Path $Path -Entries @(
        (New-AclEntry -Sid $script:SidSystem -Rights 'FullControl'), (New-AclEntry -Sid $script:SidAdministrators -Rights 'FullControl'),
        (New-AclEntry -Account $AgentUser -Rights 'FullControl'))
}
function Set-AppendOnlyDirAcl {         # audit folders (bus-audit, settings\audit; I45, deviations 102 and 141): create files, then append only (U48)
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$AgentUser)
    # The agent creates each month's file itself (openSync(path, "a")), which needs CreateFiles (WriteData on the DIRECTORY).
    #  1. folder, this folder only: ReadAndExecute + CreateFiles (no inheritance, so it never becomes WriteData on a file);
    #  2. files only, inheritable (InheritOnly): ReadAndExecute + AppendData (no WriteData, no Delete);
    #  3. OWNER RIGHTS (S-1-3-4), files only: Read + AppendData. The agent owns the files it creates; without this ACE the owner
    #     implicitly holds READ_CONTROL and WRITE_DAC and could rewrite the ACL, then overwrite its own file.
    Set-ExactAcl -Path $Path -Entries @(
        (New-AclEntry -Sid $script:SidSystem -Rights 'FullControl'), (New-AclEntry -Sid $script:SidAdministrators -Rights 'FullControl'),
        (New-AclEntry -Account $AgentUser -Rights 'ReadAndExecute, CreateFiles' -Inherit $false -InheritFlags 'None' -PropagationFlags 'None'),
        (New-AclEntry -Account $AgentUser -Rights 'ReadAndExecute, AppendData' -Inherit $false -InheritFlags 'ObjectInherit' -PropagationFlags 'InheritOnly'),
        (New-AclEntry -Sid 'S-1-3-4' -Rights 'Read, AppendData' -Inherit $false -InheritFlags 'ObjectInherit' -PropagationFlags 'InheritOnly'))
}
function Set-AgentModifyDirAcl {       # Strata log dir: agent M
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$AgentUser)
    Set-ExactAcl -Path $Path -Entries @(
        (New-AclEntry -Sid $script:SidSystem -Rights 'FullControl'), (New-AclEntry -Sid $script:SidAdministrators -Rights 'FullControl'),
        (New-AclEntry -Account $AgentUser -Rights 'Modify'))
}

# ---- ADDITIVE -------------------------------------------------------------------------------

function Add-GrantReadExecute {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$AgentUser)
    [void](Invoke-Icacls -ArgList @($Path, '/grant', "${AgentUser}:(OI)(CI)RX"))
}

# Deny Read (OI)(CI)R, for group (a) paths only. Refuses a group (b) path, whatever the caller passes.
function Add-DenyRead {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$AgentUser, [Parameter(Mandatory = $true)][string[]]$GroupB)
    $why = Get-DenyRefusalReason -Target $Path -GroupB $GroupB
    if ($why) { throw "Refusing to add a Deny Read ACE on '$Path': it $why." }
    [void](Invoke-Icacls -ArgList @($Path, '/deny', "${AgentUser}:(OI)(CI)R"))
}

# Deny WRITE only, for D:\Strata and D:\Strata-data (section 4.2). Spelled as component rights (WD, AD, WEA, WA, DC, D):
# the simple right W maps to FILE_GENERIC_WRITE, which also carries READ_CONTROL and SYNCHRONIZE, and denying those
# could break reads. No read right is denied here.
function Add-DenyWrite {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$AgentUser)
    [void](Invoke-Icacls -ArgList @($Path, '/deny', "${AgentUser}:(OI)(CI)(WD,AD,WEA,WA,DC,D)"))
}

# Removes every ACE (grant and deny) the agent user has on a path. Only the agent user's ACEs; nothing else changes.
function Remove-AgentAces {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$AgentUser)
    [void](Invoke-Icacls -ArgList @($Path, '/remove', $AgentUser))
}
