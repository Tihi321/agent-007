<#
.SYNOPSIS
  S7.5: builds the repo and deploys it to C:\Program Files\agent-007. Run ELEVATED. Supports -WhatIf. Idempotent.

.DESCRIPTION
  Its two `yarn install` steps download packages from the npm registry: the user runs it knowingly [GO].
    1. In the repo: yarn install --immutable, yarn build, yarn test (skip with -SkipRepoBuild when already built and tested).
    2. Copy dist\, prompts\, package.json, yarn.lock and .yarnrc.yml to Program Files\agent-007 (dist and prompts are mirrored).
    3. There: yarn install --immutable then yarn workspaces focus --production (skipped when yarn.lock is unchanged and node_modules exists).
    4. Apply the ACLs of section 4.2 (agent user RX only, inheritance off, SYSTEM F, Administrators F).
    5. Copy config\config.example.json to <ProgramData>\agent-007\config\config.json ONLY if no config.json exists.
       An existing config.json is never overwritten. USER.md is not created: copy config\USER.example.md yourself.

.PARAMETER RepoRoot
  Default: the parent of this script's folder.

.PARAMETER NodeDir
  Where node.exe and corepack.cmd live (Yarn 4 runs through corepack, pinned by packageManager). Default C:\Program Files\nodejs (machine-wide Node, I1).
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$RepoRoot = '',
    [string]$AgentUser = 'agent007',
    [string]$ProgramFilesDir = '',
    [string]$ProgramDataDir = '',
    [string]$NodeDir = 'C:\Program Files\nodejs',
    [switch]$SkipRepoBuild
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'acl-write.ps1')
$dry = [bool]$WhatIfPreference
Assert-Elevated -DryRun:$dry -ScriptName 'deploy-app.ps1'

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
if (-not $ProgramFilesDir) { $ProgramFilesDir = Join-WinPath $env:ProgramFiles 'agent-007' }
if (-not $ProgramDataDir) {
    $pd = $env:ProgramData
    if (-not $pd) { $pd = 'C:\ProgramData' }
    $ProgramDataDir = Join-WinPath $pd 'agent-007'
}
$configDir = Join-WinPath $ProgramDataDir 'config'
$configFile = Join-WinPath $configDir 'config.json'
$exampleConfig = Join-WinPath $RepoRoot 'config', 'config.example.json'

$npm = Join-WinPath $NodeDir 'corepack.cmd'
if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
    $cmd = Get-Command corepack.cmd -ErrorAction SilentlyContinue
    if ($cmd) { $npm = $cmd.Source }
}
if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
    if ($dry) { Write-Warning "corepack.cmd not found under $NodeDir or on PATH (a real run needs it; Node must be installed machine-wide, I1)." }
    else { throw "corepack.cmd not found under $NodeDir or on PATH. Install Node 24 machine-wide first (P0.1)." }
}

function Invoke-Npm {
    param([string[]]$NpmArgs, [string]$WorkDir)
    Push-Location -LiteralPath $WorkDir
    try {
        & $npm yarn @NpmArgs
        if ($LASTEXITCODE -ne 0) { throw "yarn $($NpmArgs -join ' ') failed (exit $LASTEXITCODE) in $WorkDir" }
    } finally { Pop-Location }
}

function Get-FileHashText {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

Write-Host "agent-007 S7.5: deploy $RepoRoot -> $ProgramFilesDir$(if ($dry) { ' (dry run)' })"

# ---- 1. repo: yarn install, build, test -------------------------------------------------------------
if ($SkipRepoBuild) {
    Write-Host '[skip]   step 1/5 repo build and test (-SkipRepoBuild)'
} else {
    Invoke-Step -DryRun:$dry -Description 'step 1/5 in the repo: yarn install --immutable (downloads from the npm registry), yarn build, yarn test' -Action {
        Invoke-Npm -NpmArgs @('install', '--immutable') -WorkDir $RepoRoot
        Invoke-Npm -NpmArgs @('build') -WorkDir $RepoRoot
        Invoke-Npm -NpmArgs @('test') -WorkDir $RepoRoot
    }
}

# ---- 2. copy dist, prompts, package files -----------------------------------------------------
$lockSrc = Join-WinPath $RepoRoot 'yarn.lock'
$lockDst = Join-WinPath $ProgramFilesDir 'yarn.lock'
$lockChanged = ((Get-FileHashText $lockSrc) -ne (Get-FileHashText $lockDst)) -or -not (Test-Path -LiteralPath (Join-WinPath $ProgramFilesDir 'node_modules') -PathType Container)

Invoke-Step -DryRun:$dry -Description "step 2/5 copy dist\ and prompts\ (mirrored), package.json, yarn.lock and .yarnrc.yml to $ProgramFilesDir" -Action {
    if (-not (Test-Path -LiteralPath $ProgramFilesDir -PathType Container)) { New-Item -ItemType Directory -Path $ProgramFilesDir -Force | Out-Null }
    foreach ($d in 'dist', 'prompts') {
        $src = Join-WinPath $RepoRoot $d
        if (-not (Test-Path -LiteralPath $src -PathType Container)) { throw "Missing $src (run without -SkipRepoBuild)." }
        & robocopy.exe $src (Join-WinPath $ProgramFilesDir $d) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE) for $d" }
    }
    $global:LASTEXITCODE = 0
    foreach ($f in 'package.json', 'yarn.lock', '.yarnrc.yml') { Copy-Item -LiteralPath (Join-WinPath $RepoRoot $f) -Destination (Join-WinPath $ProgramFilesDir $f) -Force }
}

# ---- 3. production dependencies, scripts off --------------------------------------------------
if ($lockChanged -or $dry) {
    Invoke-Step -DryRun:$dry -Description "step 3/5 in ${ProgramFilesDir}: yarn workspaces focus --production (downloads from the npm registry; skipped when yarn.lock is unchanged and node_modules exists)" -Action {
        Invoke-Npm -NpmArgs @('workspaces', 'focus', '--production') -WorkDir $ProgramFilesDir
    }
} else {
    Write-Host '[ok]     step 3/5 yarn.lock unchanged and node_modules present: yarn install skipped'
}

# ---- 4. ACLs ----------------------------------------------------------------------------------
$before = @()
if (Test-Path -LiteralPath $ProgramFilesDir) { $before = @(Get-AclLines -Path $ProgramFilesDir) }
Invoke-Step -DryRun:$dry -Description "step 4/5 SET ACL on $ProgramFilesDir (agent $AgentUser RX only, inheritance off, SYSTEM F, Administrators F)" -Action {
    Set-ProgramFilesAcl -Path $ProgramFilesDir -AgentUser $AgentUser
}
if (-not $dry) { Show-AclDiff -Path $ProgramFilesDir -Before $before -After @(Get-AclLines -Path $ProgramFilesDir) }

# ---- 5. config example, only if there is no config --------------------------------------------
if (Test-Path -LiteralPath $configFile -PathType Leaf) {
    Write-Host "[ok]     step 5/5 $configFile exists and is left untouched"
} else {
    Invoke-Step -DryRun:$dry -Description "step 5/5 copy $exampleConfig to $configFile (no config exists yet; edit it before the first start) and set the config-folder ACL (agent R)" -Action {
        if (-not (Test-Path -LiteralPath $exampleConfig -PathType Leaf)) { throw "Missing $exampleConfig" }
        if (-not (Test-Path -LiteralPath $configDir -PathType Container)) {
            New-Item -ItemType Directory -Path $configDir -Force | Out-Null
            Set-ReadOnlyForAgentDirAcl -Path $configDir -AgentUser $AgentUser
        }
        Copy-Item -LiteralPath $exampleConfig -Destination $configFile
    }
}

Write-Host ''
Write-Host "Done$(if ($dry) { ' (dry run: nothing was changed)' }). The deployed entry point is $(Join-WinPath $ProgramFilesDir 'dist', 'src', 'main.js')."
