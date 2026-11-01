<#
.SYNOPSIS
  Milestone 2 (S30): prints the Tailscale ACL snippet and the exact `tailscale serve` command for the agent-007 web gateway.
  DRY RUN BY DEFAULT: without -Apply nothing is run and nothing is changed. [GO]: -Apply runs the serve command; -Remove runs the remove command.

.DESCRIPTION
  - The gateway listens on 127.0.0.1:47009 only. `tailscale serve` (tailnet only, never Funnel) proxies HTTPS to it.
  - The settings UI port 47008 and the job runner port 47007 are refused as a target.
  - This script never runs `tailscale funnel` and refuses a serve status that already has a Funnel entry.
  - It does not edit the Tailscale ACL: it prints a snippet for you to paste into the admin console (UI-33).
  - Run the real thing only after the local web UI (L1) passes: you claimed the owner account on this PC first.

.PARAMETER Apply
  Run the serve command (or the remove command with -Remove). Without it, only print.
.PARAMETER Remove
  Print (or with -Apply, run) the command that removes the serve entry.
.PARAMETER TailscaleExe
  The tailscale executable (default: tailscale on PATH). Tests pass a fake shim.
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$Remove,
    [string]$TailscaleExe = 'tailscale',
    [int]$Port = 47009,
    [string]$Group = 'group:agent007-users',
    [string]$Tag = 'tag:agent007-host'
)

$ErrorActionPreference = 'Stop'

if ($Port -eq 47007 -or $Port -eq 47008) { throw "refusing port ${Port}: that is the job runner or the settings UI, never the web gateway" }
if ($Port -lt 1 -or $Port -gt 65535) { throw "the port must be 1 to 65535" }

$serveCmd = "tailscale serve --bg --https=443 http://127.0.0.1:$Port"
$removeCmd = "tailscale serve --https=443 off"

Write-Host "agent-007 web gateway: Tailscale setup (dry run unless -Apply)"
Write-Host ""
Write-Host "1. Paste this into the Tailscale admin console, Access controls (edit the member list):"
Write-Host @"
{
  "tagOwners": { "$Tag": ["autogroup:admin"] },
  "groups":    { "$Group": ["EDIT-ME@example.com"] },
  "acls": [
    { "action": "accept", "src": ["$Group"], "dst": ["${Tag}:443"] }
  ]
}
"@
Write-Host "   Then tag this PC with $Tag. Keep node sharing to other tailnets OFF."
Write-Host ""

if ($Remove) {
    Write-Host "2. Command to remove the serve entry:"
    Write-Host "   $removeCmd"
} else {
    Write-Host "2. Command to publish the gateway on your tailnet (HTTPS, tailnet only, no Funnel):"
    Write-Host "   $serveCmd"
}

if (-not $Apply) {
    Write-Host ""
    Write-Host "DRY RUN: nothing was run. Add -Apply to run step 2."
    exit 0
}

# ---- -Apply ----
function Invoke-Ts {
    param([string[]]$TsArgs)
    $out = & $TailscaleExe @TsArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "tailscale $($TsArgs -join ' ') failed (exit $LASTEXITCODE)" }
    return ($out -join "`n")
}

if ($Remove) {
    Invoke-Ts @('serve', '--https=443', 'off') | Out-Null
    Write-Host "Removed the serve entry."
    exit 0
}

$before = Invoke-Ts @('serve', 'status', '--json')
if ($before -match '"AllowFunnel"\s*:\s*\{[^}]*true') { throw "a Funnel entry is already on; turn it off first. The gateway is never exposed with Funnel." }
Invoke-Ts @('serve', '--bg', '--https=443', "http://127.0.0.1:$Port") | Out-Null
$after = Invoke-Ts @('serve', 'status', '--json')
if ($after -match '"AllowFunnel"\s*:\s*\{[^}]*true') { throw "Funnel is on after the change; run this script with -Remove." }
Write-Host "Done. Check: $TailscaleExe serve status"
exit 0
