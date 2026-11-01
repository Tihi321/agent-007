<#
.SYNOPSIS
  S7.1: creates (or adopts and corrects) the low-privilege local Windows user the agent runs as. Run ELEVATED.

.DESCRIPTION
  - Creates a standard local user (default agent007) with a random 32-character password that is generated in memory and
    NOT printed unless -ShowPassword. With an S4U task the password is never needed.
  - Not a member of Administrators (removed if found). Member of Users. Hidden from the sign-in screen through
    HKLM\...\Winlogon\SpecialAccounts\UserList.
  - Optional -DenyInteractiveLogon adds the deny-logon-locally and deny-RDP rights through secedit [U18].
  - Creates the user profile with the userenv CreateProfile API (no password needed) [U].
  - Idempotent: an existing user (for example created by hand in P0.7a, I15) is checked and corrected; its password is
    NOT reset. -WhatIf prints the intended changes and changes nothing.

.PARAMETER AgentUser
  Account name. Default agent007.

.PARAMETER ShowPassword
  Print the generated password once, when the user is created now. Off by default.

.PARAMETER DenyInteractiveLogon
  Also deny interactive and remote-interactive logon for the account (secedit) [U18]. Note: runas /profile uses an
  interactive logon and will then be refused; the S4U scheduled task is unaffected.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$AgentUser = 'agent007',
    [switch]$ShowPassword,
    [switch]$DenyInteractiveLogon
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$dry = [bool]$WhatIfPreference
Assert-Elevated -DryRun:$dry -ScriptName 'setup-agent-user.ps1'

if ($AgentUser -notmatch '^[A-Za-z][A-Za-z0-9_.-]{0,19}$') { throw "AgentUser '$AgentUser' is not a valid local account name (letters, digits, '_', '.', '-'; at most 20)." }

$specialAccountsKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'

function New-RandomPassword {
    # 32 characters from the OS random generator; retried until it has upper, lower, digit and symbol.
    $sets = @{ u = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; l = 'abcdefghijkmnopqrstuvwxyz'; d = '23456789'; s = '!#$%&*+-=?@^_' }
    $all = ($sets.u + $sets.l + $sets.d + $sets.s).ToCharArray()
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        while ($true) {
            $bytes = New-Object byte[] 32
            $rng.GetBytes($bytes)
            $chars = New-Object char[] 32
            for ($i = 0; $i -lt 32; $i++) { $chars[$i] = $all[$bytes[$i] % $all.Length] }
            $s = New-Object string (, $chars)
            if (($s.IndexOfAny($sets.u.ToCharArray()) -ge 0) -and ($s.IndexOfAny($sets.l.ToCharArray()) -ge 0) -and
                ($s.IndexOfAny($sets.d.ToCharArray()) -ge 0) -and ($s.IndexOfAny($sets.s.ToCharArray()) -ge 0)) { return $s }
        }
    } finally { $rng.Dispose() }
}

function Test-GroupMember {
    param([string]$GroupSid, [string]$User)
    try {
        foreach ($m in @(Get-LocalGroupMember -SID $GroupSid -ErrorAction Stop)) {
            if ($m.Name -like "*\$User" -or $m.Name -eq $User) { return $true }
        }
        return $false
    } catch {
        Write-Warning "Could not list members of group $GroupSid ($($_.Exception.Message)); assuming not a member."
        return $false
    }
}

Write-Host "agent-007 S7.1: local user '$AgentUser'$(if ($dry) { ' (dry run)' })"

# ---- 1. the user ----------------------------------------------------------------------------
$user = $null
try { $user = Get-LocalUser -Name $AgentUser -ErrorAction Stop } catch { $user = $null }
$createdNow = $false
$password = $null

if ($null -eq $user) {
    Invoke-Step -DryRun:$dry -Description "create local user '$AgentUser' (random 32-character password$(if ($ShowPassword) { ', shown once' } else { ', not printed' }), never expires, cannot change it)" -Action {
        $plain = New-RandomPassword
        $sec = ConvertTo-SecureString -String $plain -AsPlainText -Force
        New-LocalUser -Name $AgentUser -Password $sec -FullName 'agent-007 service account' `
            -Description 'agent-007 low-privilege agent account (not an administrator)' `
            -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires | Out-Null
        if ($ShowPassword) { Write-Host "Generated password (shown once): $plain" }
        $script:createdNow = $true
    }
} else {
    Write-Host "[ok]     user '$AgentUser' exists; checking its properties (the password is not reset)"
    if (-not $user.Enabled) {
        Invoke-Step -DryRun:$dry -Description "enable user '$AgentUser'" -Action { Enable-LocalUser -Name $AgentUser }
    }
    if (-not $user.PasswordNeverExpires) {
        Invoke-Step -DryRun:$dry -Description "set PasswordNeverExpires on '$AgentUser'" -Action { Set-LocalUser -Name $AgentUser -PasswordNeverExpires $true }
    }
    if ($ShowPassword) { Write-Warning 'The user already exists: its password is not known to this script and is not shown.' }
}

# ---- 2. group membership --------------------------------------------------------------------
$exists = ($null -ne $user)
if ($exists -and (Test-GroupMember -GroupSid $script:SidAdministrators -User $AgentUser)) {
    Invoke-Step -DryRun:$dry -Description "remove '$AgentUser' from Administrators (the agent must be a standard user)" -Action {
        Remove-LocalGroupMember -SID $script:SidAdministrators -Member $AgentUser
    }
} else {
    Write-Host "[ok]     '$AgentUser' is not in Administrators$(if (-not $exists) { ' (user not created yet)' })"
}
if (-not $exists -or -not (Test-GroupMember -GroupSid $script:SidUsers -User $AgentUser)) {
    Invoke-Step -DryRun:$dry -Description "add '$AgentUser' to the Users group" -Action {
        try { Add-LocalGroupMember -SID $script:SidUsers -Member $AgentUser -ErrorAction Stop } catch { if ($_.FullyQualifiedErrorId -notlike '*MemberExists*') { throw } }
    }
} else {
    Write-Host "[ok]     '$AgentUser' is in Users"
}

# ---- 3. hidden from the sign-in screen ------------------------------------------------------
$hidden = $false
try { $v = Get-ItemProperty -Path $specialAccountsKey -Name $AgentUser -ErrorAction Stop; $hidden = ($v.$AgentUser -eq 0) } catch { $hidden = $false }
if ($hidden) {
    Write-Host "[ok]     '$AgentUser' is hidden from the sign-in screen"
} else {
    Invoke-Step -DryRun:$dry -Description "hide '$AgentUser' from the sign-in screen ($specialAccountsKey\$AgentUser = 0)" -Action {
        if (-not (Test-Path -LiteralPath $specialAccountsKey)) { New-Item -Path $specialAccountsKey -Force | Out-Null }
        New-ItemProperty -Path $specialAccountsKey -Name $AgentUser -PropertyType DWord -Value 0 -Force | Out-Null
    }
}

# ---- 4. optional: deny interactive logon (secedit) [U18] ------------------------------------
if ($DenyInteractiveLogon) {
    Invoke-Step -DryRun:$dry -Description "deny interactive and remote-interactive logon for '$AgentUser' (secedit: SeDenyInteractiveLogonRight, SeDenyRemoteInteractiveLogonRight) [U18]" -Action {
        $sid = (Get-AccountSid -Name $AgentUser).Value
        $work = Join-Path ([System.IO.Path]::GetTempPath()) ('agent007-secedit-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $work | Out-Null
        try {
            $inf = Join-Path $work 'current.inf'
            & secedit.exe /export /cfg $inf /areas USER_RIGHTS | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "secedit /export failed (exit $LASTEXITCODE)" }
            $lines = [System.IO.File]::ReadAllLines($inf)
            $out = New-Object System.Collections.Generic.List[string]
            $seen = @{}
            foreach ($l in $lines) {
                $replaced = $false
                foreach ($right in 'SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight') {
                    if ($l -match "^\s*$right\s*=") {
                        $seen[$right] = $true
                        if ($l -notmatch [regex]::Escape("*$sid")) { $out.Add($l.TrimEnd() + ",*$sid") } else { $out.Add($l) }
                        $replaced = $true
                    }
                }
                if (-not $replaced) { $out.Add($l) }
            }
            $final = New-Object System.Collections.Generic.List[string]
            foreach ($l in $out) {
                $final.Add($l)
                if ($l -match '^\[Privilege Rights\]') {
                    foreach ($right in 'SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight') {
                        if (-not $seen.ContainsKey($right)) { $final.Add("$right = *$sid") }
                    }
                }
            }
            $new = Join-Path $work 'new.inf'
            [System.IO.File]::WriteAllLines($new, $final.ToArray(), [System.Text.Encoding]::Unicode)
            & secedit.exe /configure /db (Join-Path $work 'new.sdb') /cfg $new /areas USER_RIGHTS | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "secedit /configure failed (exit $LASTEXITCODE)" }
        } finally {
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# ---- 5. the profile (userenv CreateProfile, no password needed) [U] -------------------------
$sidObj = $null
if ($exists) { $sidObj = Get-AccountSid -Name $AgentUser }
$profileExists = $false
if ($sidObj) { $profileExists = Test-Path -LiteralPath ("HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + $sidObj.Value) }
if ($profileExists) {
    Write-Host "[ok]     the profile of '$AgentUser' exists"
} else {
    Invoke-Step -DryRun:$dry -Description "create the profile of '$AgentUser' (userenv CreateProfile) [U]" -Action {
        Add-Type -Namespace Agent007 -Name UserEnv -ErrorAction SilentlyContinue -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("userenv.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int CreateProfile([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string pszUserSid, [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string pszUserName, [System.Text.StringBuilder] pszProfilePath, uint cchProfilePath);
'@
        $sid = (Get-AccountSid -Name $AgentUser).Value
        $path = New-Object System.Text.StringBuilder 260
        $hr = [Agent007.UserEnv]::CreateProfile($sid, $AgentUser, $path, 260)
        if ($hr -ne 0 -and $hr -ne -2147024713) { throw ('CreateProfile failed, HRESULT 0x{0:X8}' -f $hr) }
        Write-Host "         profile: $($path.ToString())"
    }
}

Write-Host ''
Write-Host "Done$(if ($dry) { ' (dry run: nothing was changed)' }). Next: deploy/grant-folder-acls.ps1, new-secrets.ps1, deploy-app.ps1, register-task.ps1."
$password = $null
