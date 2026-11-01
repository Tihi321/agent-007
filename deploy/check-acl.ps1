<#
.SYNOPSIS
  S7.3: READ-ONLY report on the NTFS layout of plan section 4.2. Exit 0 = compliant, exit 1 = at least one violation.

.DESCRIPTION
  Changes nothing: it only calls Get-Acl, Get-PSDrive and Test-Path. It does not load acl-write.ps1.

  Prints:
    - the agent user's access on every allowed folder and every group (a) deny path (expect a Deny Read);
    - drive roots and denied paths where Users, Authenticated Users or Everyone have rights (a report, not a violation);
    - the secrets file ACL (and the Strata config copy when model.runner is strata): only the agent user (R), SYSTEM and
      Administrators, inheritance off, no Users / Authenticated Users / Everyone;
    - group (b) paths: the agent user must be able to read them and must have NO Deny Read ACE (a Deny Read there would
      break the agent or the Strata task). Always checked: <programData>\config, <programData>\secrets, the agent data
      root. Only when model.runner is strata: the Strata install dir and data dir (RX, no write), the Strata config
      folder and the Strata log dir (modify). With LM Studio those paths are skipped;
    - Program Files\agent-007 (agent RX only), the config dir and secrets dir (agent R, no write);
    - Phase 2 (S9.4), section 4.2: <programData>\jobrunner\ (inheritance off; the agent user has NO access to the folder
      itself and R, no write, on templates\ only; no Users / Authenticated Users / Everyone), and, only when they exist,
      <programData>\settings\ (inheritance off, agent R and no write, also on security.json) and settings\audit\ (agent
      creates files in it, then append only: CreateFiles on the folder, AppendData on files, OWNER RIGHTS Read + AppendData, no delete; U48, deviation 141). A missing jobrunner\ or settings\ is a SKIP, not a violation (a Phase 1
      install has neither);
    - Phase 4 (S20.3, I43), only when it exists: <programData>\shared\ with FACTS.md and shared\skills\. Only the user or an
      admin writes shared facts and skills, so the agent user may READ them and must have NO write on any of the three: a
      write right (also through Users, Authenticated Users or Everyone) is a VIOLATION. A missing shared\ is a SKIP.

  "Effective access" is evaluated from the ACEs that name the agent user or one of Everyone, Authenticated Users and
  Users (a standard user is in all three); explicit Deny beats Allow; inherit-only ACEs are skipped. A path whose ACL
  cannot be read (not elevated) is reported as a violation: run this elevated.

.PARAMETER ConfigPath
  config.json. Default C:\ProgramData\agent-007\config\config.json.

.PARAMETER AgentUser
  The agent's Windows user. Default agent007.

.PARAMETER ProgramFilesDir
  Default C:\Program Files\agent-007. Skipped (with a note) if it does not exist yet.
#>
[CmdletBinding()]
param(
    [string]$ConfigPath = '',
    [string]$AgentUser = 'agent007',
    [string]$ProgramFilesDir = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not $ConfigPath) { $ConfigPath = Get-DefaultConfigPath }
$config = Read-JsonFile -Path $ConfigPath
$layout = Resolve-AgentLayout -Config $config -AgentUser $AgentUser -ProgramFilesDir $ProgramFilesDir
$groupA = @(Get-GroupAPaths -Layout $layout)

$violations = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

$READ_BIT = 0x1                                    # ReadData / ListDirectory
$WRITE_BITS = (0x2 -bor 0x4 -bor 0x40 -bor 0x10000) # WriteData, AppendData, DeleteSubdirectoriesAndFiles, Delete
$APPEND_BIT = 0x4                                  # AppendData / AddSubdirectory
$STRICT_WRITE_BITS = (0x2 -bor 0x40 -bor 0x10000)  # WriteData, DeleteSubdirectoriesAndFiles, Delete: write that is not append

$agentSid = Get-AccountSid -Name $AgentUser
$broadSids = @($script:SidEveryone, $script:SidAuthenticatedUsers, $script:SidUsers)
$allowedSecretSids = @($script:SidSystem, $script:SidAdministrators)

function Add-Violation {
    param([string]$Path, [string]$Message)
    $violations.Add("${Path}: $Message")
    Write-Host "VIOLATION  $Path : $Message"
}
function Add-Warning2 {
    param([string]$Path, [string]$Message)
    $warnings.Add("${Path}: $Message")
    Write-Host "WARN       $Path : $Message"
}

function Get-RuleSid {
    param($Rule)
    $id = $Rule.IdentityReference
    if ($id -is [System.Security.Principal.SecurityIdentifier]) { return $id.Value }
    try { return $id.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { return $null }
}

function Test-RuleIsAgent {
    param($Rule)
    $sid = Get-RuleSid $Rule
    if ($agentSid -and $sid) { return ($sid -eq $agentSid.Value) }
    $n = [string]$Rule.IdentityReference
    return ($n -ieq $AgentUser -or $n -like "*\$AgentUser")
}

function Format-Rule {
    param($Rule)
    $kind = 'Allow'
    if ($Rule.AccessControlType -eq 'Deny') { $kind = 'Deny' }
    $inh = ''
    if ($Rule.IsInherited) { $inh = '(inherited)' }
    return ("{0}:({1})({2}){3}" -f $Rule.IdentityReference, $kind, $Rule.FileSystemRights, $inh)
}

function Read-PathAcl {
    param([string]$Path)
    try { return (Get-Acl -LiteralPath $Path) } catch {
        Add-Violation $Path "cannot read the ACL (run this script elevated): $($_.Exception.Message)"
        return $null
    }
}

# What the agent user can do on this exact path, from the ACEs that apply to it.
function Get-AgentView {
    param($Acl)
    $view = [pscustomobject]@{ Read = $false; Write = $false; Append = $false; StrictWrite = $false; DenyRead = $false; DenyWrite = $false; AgentAces = @(); BroadAces = @() }
    $denyStrict = $false
    $agentAces = New-Object System.Collections.Generic.List[string]
    $broadAces = New-Object System.Collections.Generic.List[string]
    foreach ($r in @($Acl.Access)) {
        if ($r.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
        $sid = Get-RuleSid $r
        $isAgent = Test-RuleIsAgent $r
        $isBroad = ($sid -and ($broadSids -contains $sid))
        if (-not ($isAgent -or $isBroad)) { continue }
        if ($isAgent) { $agentAces.Add((Format-Rule $r)) } else { $broadAces.Add((Format-Rule $r)) }
        $bits = [int]$r.FileSystemRights
        if ($r.AccessControlType -eq 'Deny') {
            if ($bits -band $READ_BIT) { $view.DenyRead = $true }
            if ($bits -band $WRITE_BITS) { $view.DenyWrite = $true }
            if ($bits -band $STRICT_WRITE_BITS) { $denyStrict = $true }
        } else {
            if ($bits -band $READ_BIT) { $view.Read = $true }
            if ($bits -band $WRITE_BITS) { $view.Write = $true }
            if ($bits -band $APPEND_BIT) { $view.Append = $true }
            if ($bits -band $STRICT_WRITE_BITS) { $view.StrictWrite = $true }
        }
    }
    if ($view.DenyRead) { $view.Read = $false }
    if ($view.DenyWrite) { $view.Write = $false }
    if ($denyStrict) { $view.StrictWrite = $false }
    $view.AgentAces = $agentAces.ToArray()
    $view.BroadAces = $broadAces.ToArray()
    return $view
}

# An audit folder (bus-audit, settings\audit): the agent creates files in it and may only append to them. Allowed exactly: a NON-inheriting folder ACE
# with CreateFiles (WriteData on the directory), and an inheritable files-only ACE with AppendData. Flagged: Delete or
# DeleteSubdirectoriesAndFiles anywhere, WriteData on an inheriting or inherited ACE (that is WriteData on files), write rights for the
# creator-owner (OWNER RIGHTS S-1-3-4) beyond Read + AppendData.
function Test-AuditFolder {
    param([string]$Dir, [string]$Label, $Acl)
    $createFiles = $false
    $fileAppend = $false
    $ownerRights = $false
    $bad = New-Object System.Collections.Generic.List[string]
    foreach ($r in @($Acl.Access)) {
        if ($r.AccessControlType -eq 'Deny') { continue }
        $sid = Get-RuleSid $r
        $isAgent = Test-RuleIsAgent $r
        $isOwner = ($sid -eq 'S-1-3-4' -or $sid -eq 'S-1-3-0')
        $isBroad = ($sid -and ($broadSids -contains $sid))
        if (-not ($isAgent -or $isOwner -or $isBroad)) { continue }
        $bits = [int]$r.FileSystemRights
        $inhFiles = [bool]($r.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit)
        $inhAny = [bool]($r.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None)
        $inheritOnly = [bool]($r.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)
        $text = Format-Rule $r
        if ($isOwner) {
            if ($sid -eq 'S-1-3-4') { $ownerRights = $true }
            # 0x2 WriteData, 0x40 DeleteSubdirectoriesAndFiles, 0x10000 Delete, 0x40000 ChangePermissions, 0x80000 TakeOwnership
            if ($bits -band (0x2 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000)) { $bad.Add("the creator-owner can write, delete or change the ACL of its audit file: $text") }
            continue
        }
        if ($bits -band (0x40 -bor 0x10000)) { $bad.Add("the agent user can delete in the audit folder: $text"); continue }
        if ($bits -band 0x2) {
            if ($inhAny -or $r.IsInherited) { $bad.Add("WriteData is inherited onto the audit files (the agent could overwrite them): $text") }
            elseif (-not $inheritOnly) { if ($isAgent) { $createFiles = $true } else { $bad.Add("a broad group can create files in the audit folder: $text") } }
        }
        if (($bits -band $APPEND_BIT) -and $inhFiles -and $isAgent) { $fileAppend = $true }
    }
    foreach ($b in $bad) { Add-Violation $Dir $b }
    if (-not $createFiles) { Add-Warning2 $Dir "the agent user has no create-files right on the $Label folder (it cannot start a new month's file; deviation 141)" }
    if (-not $fileAppend) { Add-Warning2 $Dir "the agent user has no append right on the $Label files (an inheritable files-only AppendData ACE; U48: append-only ACEs are not yet proved)" }
    if (-not $ownerRights) { Add-Warning2 $Dir "no OWNER RIGHTS (S-1-3-4) ACE on the $Label folder: the agent owns the files it creates and could change their ACL" }
    # existing files: the agent must not hold write data or delete on them
    foreach ($f in @(Get-ChildItem -LiteralPath $Dir -File -Force -ErrorAction SilentlyContinue)) {
        try { $fv = Get-AgentView (Get-Acl -LiteralPath $f.FullName) } catch { continue }
        if ($fv.StrictWrite) { Add-Violation $f.FullName "the agent user can overwrite or delete this audit file: $($fv.AgentAces -join ' ')$($fv.BroadAces -join ' ')" }
    }
}

function Write-View {
    param([string]$Label, [string]$Path, $View)
    Write-Host ("{0,-10} {1} : agent read={2} write={3} denyRead={4}" -f $Label, $Path, $View.Read, $View.Write, $View.DenyRead)
    foreach ($a in $View.AgentAces) { Write-Host "             ACE (agent)  $a" }
    foreach ($a in $View.BroadAces) { Write-Host "             ACE (group)  $a" }
}

# A secret file: only the agent (R), SYSTEM and Administrators; no inheritance; no Users / Authenticated Users / Everyone.
function Test-SecretFile {
    param([string]$Path, [string]$Label)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Add-Warning2 $Path "$Label does not exist yet (nothing to check)"
        return
    }
    $acl = Read-PathAcl $Path
    if ($null -eq $acl) { return }
    Write-Host "SECRET     $Label : $Path"
    $agentRead = $false
    foreach ($r in @($acl.Access)) {
        Write-Host "             $(Format-Rule $r)"
        $sid = Get-RuleSid $r
        $isAllow = ($r.AccessControlType -ne 'Deny')
        if ($r.IsInherited) { Add-Violation $Path "$Label has an inherited ACE: $(Format-Rule $r) (inheritance must be off)" }
        if (-not $isAllow) { continue }
        if ($sid -and ($broadSids -contains $sid)) { Add-Violation $Path "$Label is open to a broad group: $(Format-Rule $r)"; continue }
        if (Test-RuleIsAgent $r) {
            $bits = [int]$r.FileSystemRights
            if ($bits -band $READ_BIT) { $agentRead = $true }
            if ($bits -band $WRITE_BITS) { Add-Violation $Path "$Label gives the agent user more than read: $(Format-Rule $r)" }
            continue
        }
        if ($sid -and ($allowedSecretSids -contains $sid)) { continue }
        Add-Violation $Path "$Label has an unexpected principal: $(Format-Rule $r)"
    }
    if (-not $agentRead) { Add-Violation $Path "$Label is not readable by the agent user $AgentUser" }
}

Write-Host "agent-007 S7.3: ACL check (read-only), runner '$($layout.Runner)', agent user '$AgentUser', config $ConfigPath"
Write-Host ''

# ---- 1. allowed folders -----------------------------------------------------------------------
$driveRoots = @{}
function Note-Drive {
    param([string]$Path)
    try { $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path)); if ($root) { $driveRoots[$root.ToLowerInvariant()] = $root } } catch { }
}

foreach ($p in $layout.AllowPaths) {
    Note-Drive $p
    if (-not (Test-Path -LiteralPath $p -PathType Container)) { Add-Violation $p 'allowed folder does not exist'; continue }
    $acl = Read-PathAcl $p
    if ($null -eq $acl) { continue }
    $v = Get-AgentView $acl
    Write-View 'ALLOW' $p $v
    if (-not $v.Read) { Add-Violation $p 'the agent user cannot read this allowed folder (grant-folder-acls.ps1 not run?)' }
}

# ---- 2. group (a) deny paths: expect an explicit Deny Read ------------------------------------
foreach ($p in $groupA) {
    Note-Drive $p
    if (-not (Test-Path -LiteralPath $p)) { Write-Host "SKIP       $p : deny path does not exist (the in-process deny still applies)"; continue }
    $acl = Read-PathAcl $p
    if ($null -eq $acl) { continue }
    $v = Get-AgentView $acl
    Write-View 'DENY(a)' $p $v
    if (-not $v.DenyRead) { Add-Violation $p 'group (a) path has NO Deny Read ACE for the agent user' }
}

# ---- 3. the secrets file and, for Strata, the config copy -------------------------------------
Test-SecretFile -Path $layout.SecretsFile -Label 'secrets.json'
if ($layout.Runner -eq 'strata') { Test-SecretFile -Path $layout.StrataConfigFile -Label 'Strata config copy' }

# ---- 4. group (b): the agent must read them, and there must be no Deny Read ------------------
function Test-GroupB {
    param([string]$Path, [string]$Label, [string]$Need)   # Need: 'R' (read, no write), 'RX' (same), 'M' (modify), 'any' (read only)
    Note-Drive $Path
    if (-not (Test-Path -LiteralPath $Path)) { Write-Host "SKIP       $Label : $Path does not exist"; return }
    $acl = Read-PathAcl $Path
    if ($null -eq $acl) { return }
    $v = Get-AgentView $acl
    Write-View 'GROUP(b)' "$Label $Path" $v
    if ($v.DenyRead) { Add-Violation $Path "group (b) path has a Deny Read ACE that applies to the agent user: this would break the agent or the Strata task" }
    elseif (-not $v.Read) { Add-Violation $Path 'the agent user cannot read this group (b) path' }
    if ($Need -eq 'R' -or $Need -eq 'RX') {
        if ($v.Write) { Add-Violation $Path "the agent user can write here (expected read only): $($v.AgentAces -join ' ')$($v.BroadAces -join ' ')" }
    }
    if ($Need -eq 'M' -and -not $v.Write) { Add-Violation $Path 'the agent user cannot write here (modify is needed)' }
}

Test-GroupB -Path $layout.ConfigDir -Label 'config dir' -Need 'R'
Test-GroupB -Path $layout.SecretsDir -Label 'secrets dir' -Need 'R'
Test-GroupB -Path $layout.DataDir -Label 'agent data root' -Need 'any'
if ($layout.Runner -eq 'strata') {
    Test-GroupB -Path $layout.StrataInstallDir -Label 'Strata install' -Need 'RX'
    Test-GroupB -Path $layout.StrataDataDir -Label 'Strata data' -Need 'RX'
    Test-GroupB -Path $layout.StrataDir -Label 'Strata config folder' -Need 'R'
    Test-GroupB -Path $layout.StrataLogDir -Label 'Strata log dir' -Need 'M'
} else {
    Write-Host 'SKIP       Strata paths (model.runner is not strata)'
}

# ---- 5. the deployed code ---------------------------------------------------------------------
Note-Drive $layout.ProgramFilesDir
if (Test-Path -LiteralPath $layout.ProgramFilesDir -PathType Container) {
    $acl = Read-PathAcl $layout.ProgramFilesDir
    if ($null -ne $acl) {
        $v = Get-AgentView $acl
        Write-View 'CODE' $layout.ProgramFilesDir $v
        if (-not $v.Read) { Add-Violation $layout.ProgramFilesDir 'the agent user cannot read the deployed code' }
        if ($v.Write) { Add-Violation $layout.ProgramFilesDir "the agent user can write its own code: $($v.AgentAces -join ' ')$($v.BroadAces -join ' ')" }
    }
} else {
    Write-Host "SKIP       $($layout.ProgramFilesDir) does not exist (not deployed yet)"
}

# ---- 5b. Phase 2 and 3 folders (S9.4, section 4.2) --------------------------------------------
function Test-PathExists {
    # A folder the current user cannot even stat (not elevated) still exists: Test-Path throws UnauthorizedAccess there.
    param([string]$Path, [ValidateSet('Container', 'Leaf')][string]$Type)
    try { return [bool](Test-Path -LiteralPath $Path -PathType $Type -ErrorAction Stop) } catch [System.UnauthorizedAccessException] { return $true } catch { return $false }
}

function Test-Protected {
    # Inheritance must be off on these folders (the ACL is exact, nothing flows in from ProgramData).
    param($Acl, [string]$Path, [string]$Label)
    if (-not $Acl.AreAccessRulesProtected) { Add-Violation $Path "$Label has inheritance on (it must be off)" }
}

$jobRunnerDir = Join-WinPath $layout.ProgramDataDir 'jobrunner'
$jobRunnerTemplates = Join-WinPath $layout.ProgramDataDir 'jobrunner', 'templates'
if (Test-PathExists $jobRunnerDir 'Container') {
    Note-Drive $jobRunnerDir
    $acl = Read-PathAcl $jobRunnerDir
    if ($null -ne $acl) {
        $v = Get-AgentView $acl
        Write-View 'JOBRUNNER' $jobRunnerDir $v
        Test-Protected -Acl $acl -Path $jobRunnerDir -Label 'job runner folder'
        if ($v.Read -or $v.Write) { Add-Violation $jobRunnerDir "the agent user has access to the job runner folder (expected none except templates\): read=$($v.Read) write=$($v.Write)" }
        foreach ($r in @($acl.Access)) {
            $sid = Get-RuleSid $r
            if ($r.AccessControlType -ne 'Deny' -and $sid -and ($broadSids -contains $sid)) { Add-Violation $jobRunnerDir "job runner folder is open to a broad group: $(Format-Rule $r)" }
        }
    }
    if (Test-PathExists $jobRunnerTemplates 'Container') {
        $tacl = Read-PathAcl $jobRunnerTemplates
        if ($null -ne $tacl) {
            $tv = Get-AgentView $tacl
            Write-View 'JOBRUNNER' $jobRunnerTemplates $tv
            if ($tv.DenyRead) { Add-Violation $jobRunnerTemplates 'templates folder has a Deny Read that applies to the agent user' }
            elseif (-not $tv.Read) { Add-Violation $jobRunnerTemplates 'the agent user cannot read the templates folder (it needs R on templates only)' }
            if ($tv.Write) { Add-Violation $jobRunnerTemplates "the agent user can write the job templates (expected read only): $($tv.AgentAces -join ' ')$($tv.BroadAces -join ' ')" }
        }
    } else {
        Add-Warning2 $jobRunnerTemplates 'templates folder does not exist yet (nothing to check)'
    }
} else {
    Write-Host "SKIP       $jobRunnerDir does not exist (the job runner is not installed yet)"
}

$settingsDir = Join-WinPath $layout.ProgramDataDir 'settings'
if (Test-PathExists $settingsDir 'Container') {
    Note-Drive $settingsDir
    $acl = Read-PathAcl $settingsDir
    if ($null -ne $acl) {
        $v = Get-AgentView $acl
        Write-View 'SETTINGS' $settingsDir $v
        Test-Protected -Acl $acl -Path $settingsDir -Label 'settings folder'
        if ($v.DenyRead) { Add-Violation $settingsDir 'settings folder has a Deny Read that applies to the agent user' }
        elseif (-not $v.Read) { Add-Violation $settingsDir 'the agent user cannot read the settings folder' }
        if ($v.Write) { Add-Violation $settingsDir "the agent user can write the settings folder (expected read only): $($v.AgentAces -join ' ')$($v.BroadAces -join ' ')" }
    }
    $securityJson = Join-WinPath $settingsDir 'security.json'
    if (Test-PathExists $securityJson 'Leaf') {
        $facl = Read-PathAcl $securityJson
        if ($null -ne $facl) {
            $fv = Get-AgentView $facl
            Write-View 'SETTINGS' $securityJson $fv
            if (-not $fv.Read) { Add-Violation $securityJson 'the agent user cannot read security.json' }
            if ($fv.Write) { Add-Violation $securityJson "the agent user can write security.json (expected read only): $($fv.AgentAces -join ' ')$($fv.BroadAces -join ' ')" }
        }
    }
    $auditDir = Join-WinPath $settingsDir 'audit'
    if (Test-PathExists $auditDir 'Container') {
        $aacl = Read-PathAcl $auditDir
        if ($null -ne $aacl) {
            $av = Get-AgentView $aacl
            Write-View 'SETTINGS' $auditDir $av
            Test-AuditFolder -Dir $auditDir -Label 'settings audit' -Acl $aacl
        }
    }
} else {
    Write-Host "SKIP       $settingsDir does not exist (Phase 3 settings are not installed)"
}

# ---- 5b2. Phase 4: the bus audit log and the chain store, in the agent data root (I45, deviation 102). -----
$busAuditDir = Join-WinPath $layout.DataDir 'bus-audit'
if (Test-PathExists $busAuditDir 'Container') {
    $bacl = Read-PathAcl $busAuditDir
    if ($null -ne $bacl) {
        $bv = Get-AgentView $bacl
        Write-View 'BUS' $busAuditDir $bv
        Test-AuditFolder -Dir $busAuditDir -Label 'bus audit' -Acl $bacl
    }
} else {
    Write-Host "SKIP       $busAuditDir does not exist (no bus audit yet)"
}
$chainsJson = Join-WinPath $layout.DataDir 'bus', 'chains.json'
if (Test-PathExists $chainsJson 'Leaf') {
    $cacl = Read-PathAcl $chainsJson
    if ($null -ne $cacl) {
        $cv = Get-AgentView $cacl
        Write-View 'BUS' $chainsJson $cv
        if ($cv.DenyRead) { Add-Violation $chainsJson 'bus chains.json has a Deny Read that applies to the agent user' }
        elseif (-not $cv.Read) { Add-Violation $chainsJson 'the agent user cannot read bus chains.json' }
        if (-not $cv.Write) { Add-Warning2 $chainsJson 'the agent user cannot write bus chains.json (the chain store is rewritten on every change; it is state, not an append-only log)' }
    }
} else {
    Write-Host "SKIP       $chainsJson does not exist (no chain store yet)"
}

# ---- 5c. Phase 4: the shared folder (S20.3, I43). The agent reads FACTS.md and the shared skills; it never writes them. -----
$sharedDir = Join-WinPath $layout.ProgramDataDir 'shared'
if (Test-PathExists $sharedDir 'Container') {
    Note-Drive $sharedDir
    $sharedTargets = @(
        @{ Path = $sharedDir; Type = 'Container'; Label = 'shared folder' },
        @{ Path = (Join-WinPath $sharedDir 'FACTS.md'); Type = 'Leaf'; Label = 'shared FACTS.md' },
        @{ Path = (Join-WinPath $sharedDir 'skills'); Type = 'Container'; Label = 'shared skills folder' }
    )
    foreach ($t in $sharedTargets) {
        if (-not (Test-PathExists $t.Path $t.Type)) { Write-Host "SKIP       $($t.Path) does not exist"; continue }
        $sacl = Read-PathAcl $t.Path
        if ($null -eq $sacl) { continue }
        $sv = Get-AgentView $sacl
        Write-View 'SHARED' $t.Path $sv
        if ($sv.DenyRead) { Add-Violation $t.Path "the $($t.Label) has a Deny Read that applies to the agent user (bots with shared.read could not load it)" }
        if ($sv.Write) { Add-Violation $t.Path "the agent user can write the $($t.Label) (expected read only: only the user or an admin writes shared facts and skills, I43): $($sv.AgentAces -join ' ')$($sv.BroadAces -join ' ')" }
        elseif (-not $sv.Read -and -not $sv.DenyRead) { Add-Warning2 $t.Path "the agent user cannot read the $($t.Label) (bots with shared.read will not see it)" }
    }
} else {
    Write-Host "SKIP       $sharedDir does not exist (no shared facts or skills)"
}

# ---- 6. drive roots: report where broad groups have rights (never a violation) ----------------
Note-Drive $layout.ProgramDataDir
Note-Drive $layout.DataDir
Write-Host ''
Write-Host 'Drive roots and ambient group rights (a report; review it, nothing is changed):'
foreach ($root in @($driveRoots.Values)) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    try {
        $acl = Get-Acl -LiteralPath $root
        foreach ($r in @($acl.Access)) {
            $sid = Get-RuleSid $r
            if ($sid -and ($broadSids -contains $sid)) { Write-Host "  $root  $(Format-Rule $r)" }
        }
    } catch { Write-Host "  $root  (cannot read ACL: $($_.Exception.Message))" }
}
foreach ($p in $groupA) {
    if (-not (Test-Path -LiteralPath $p)) { continue }
    try {
        foreach ($r in @((Get-Acl -LiteralPath $p).Access)) {
            $sid = Get-RuleSid $r
            if ($sid -and ($broadSids -contains $sid)) { Write-Host "  $p  $(Format-Rule $r)" }
        }
    } catch { }
}
$psDrives = @(Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Root })
Write-Host "  (file system drives on this PC: $($psDrives -join ', '))"

Write-Host ''
if ($violations.Count -gt 0) {
    Write-Host "RESULT: FAIL, $($violations.Count) violation(s), $($warnings.Count) warning(s)"
    exit 1
}
Write-Host "RESULT: OK, no violations, $($warnings.Count) warning(s)"
exit 0
