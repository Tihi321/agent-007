<#
.SYNOPSIS
  Prints the port of the local api-acp-proxy (and nothing else).

.DESCRIPTION
  Reads ONLY the key server.port from %APPDATA%\api-acp-proxy\settings.json. That file can hold the proxy's API key, so this script
  never prints the file, never prints the parsed object and never puts any other value in an error message.
  The PROXY_PORT environment variable overrides the file (when it is set, the file is not read at all), as the proxy itself does.
  The user runs this script; agents must not read the proxy's settings.json.

.PARAMETER SettingsPath
  Read this file instead of %APPDATA%\api-acp-proxy\settings.json (tests point it at a fixture).

.EXAMPLE
  powershell -NoProfile -File scripts\proxy\check-port.ps1
#>
[CmdletBinding()]
param(
  [string]$SettingsPath
)

$ErrorActionPreference = 'Stop'

function Test-PortValue {
  param($Value)
  if ($null -eq $Value) { return $false }
  if ($Value -is [bool]) { return $false }
  $text = [string]$Value
  if ($text -notmatch '^\s*\d{1,5}\s*$') { return $false }
  $n = [int]$text.Trim()
  return ($n -ge 1 -and $n -le 65535)
}

# 1. PROXY_PORT wins; the settings file is not touched.
$envPort = $env:PROXY_PORT
if (-not [string]::IsNullOrWhiteSpace($envPort)) {
  if (-not (Test-PortValue $envPort)) {
    [Console]::Error.WriteLine('PROXY_PORT is set but is not an integer from 1 to 65535.')
    exit 2
  }
  Write-Output ([int]$envPort.Trim())
  exit 0
}

# 2. The settings file.
if ([string]::IsNullOrWhiteSpace($SettingsPath)) {
  if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
    [Console]::Error.WriteLine('APPDATA is not set, so the proxy settings file cannot be located. Set PROXY_PORT or pass -SettingsPath.')
    exit 2
  }
  $SettingsPath = Join-Path (Join-Path $env:APPDATA 'api-acp-proxy') 'settings.json'
}

if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf)) {
  [Console]::Error.WriteLine('The proxy settings file was not found (expected %APPDATA%\api-acp-proxy\settings.json). Start the proxy once, or set PROXY_PORT.')
  exit 2
}

$port = $null
$parsed = $false
try {
  $doc = Get-Content -LiteralPath $SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $parsed = $true
  if ($null -ne $doc -and $null -ne $doc.PSObject.Properties['server'] -and $null -ne $doc.server -and $null -ne $doc.server.PSObject.Properties['port']) {
    $port = $doc.server.port
  }
} catch {
  # never include $_ here: a parse error can quote the file content
}
$doc = $null

if (-not $parsed) {
  [Console]::Error.WriteLine('The proxy settings file could not be read as JSON (its content is not shown).')
  exit 2
}
if ($null -eq $port) {
  [Console]::Error.WriteLine('The key server.port is missing in the proxy settings file. The proxy default is 8787 when it is not set; set PROXY_PORT to use a port.')
  exit 2
}
if (-not (Test-PortValue $port)) {
  [Console]::Error.WriteLine('server.port in the proxy settings file is not an integer from 1 to 65535.')
  exit 2
}
Write-Output ([int]([string]$port).Trim())
exit 0
