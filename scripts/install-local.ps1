<#
.SYNOPSIS
  Install dsh-computer-control into a DSH profile on Windows, without pnpm.

.DESCRIPTION
  Copies the plugin to <profile>\plugins\computer-control, builds the native
  helper with the .NET Framework compiler, and appends the loader row to the
  profile's cordis.patch.yml (backed up first). Idempotent: running it again
  only refreshes files.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-local.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-local.ps1 -Profile web
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' })
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"

if (-not (Test-Path -LiteralPath $profileDir)) {
    $available = @()
    $profilesRoot = Join-Path $env:USERPROFILE '.dsh\profiles'
    if (Test-Path -LiteralPath $profilesRoot) {
        $available = Get-ChildItem -LiteralPath $profilesRoot -Directory | Select-Object -ExpandProperty Name
    }
    throw "profile not found: $profileDir`navailable: $($available -join ', ')"
}

$dest = Join-Path $profileDir 'plugins\computer-control'
Write-Host "installing to $dest"
New-Item -ItemType Directory -Force -Path (Join-Path $dest 'bin') | Out-Null

foreach ($entry in @('lib', 'native', 'scripts', 'docs', 'package.json', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE')) {
    $source = Join-Path $repoRoot $entry
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $target = Join-Path $dest $entry
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
}

Write-Host 'building the native helper'
& (Join-Path $dest 'scripts\build-helper.ps1')

$patch = Join-Path $profileDir 'cordis.patch.yml'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $patch)) {
    [System.IO.File]::WriteAllText($patch, "# dsh profile patch layer`r`n[]`r`n", $utf8NoBom)
}

$content = [System.IO.File]::ReadAllText($patch)
if ($content -match '(?m)^\s*-\s*id:\s*computer-control\s*$') {
    Write-Host "loader row already present in $patch"
}
else {
    $backup = "$patch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $patch -Destination $backup -Force

    $block = @'

# dsh-computer-control (added by scripts/install-local.ps1)
- insert:
    - id: computer-control
      name: './plugins/computer-control/lib/index.js'

# dsh-computer-control: watch the plugin sources so code edits reload live.
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  config:
    root: ['./plugins']
'@

    # Append without a BOM: a byte-order mark at the start of a YAML document
    # makes some parsers reject it, and Set-Content -Encoding UTF8 adds one.
    $separator = if ($content.EndsWith("`n")) { '' } else { "`r`n" }
    [System.IO.File]::AppendAllText($patch, $separator + $block, $utf8NoBom)
    Write-Host "added loader row to $patch (backup: $backup)"
}

Write-Host ''
Write-Host 'done. Restart DeepSeek Harness (or let HMR pick up the patch), then:'
Write-Host '  - Windows needs no Accessibility grant; a non-elevated process cannot send'
Write-Host '    input to an elevated (Administrator) window, so run DSH at the same level'
Write-Host '    as the app you want to drive.'
Write-Host '  - ask the agent to run computer_policy action=environment to confirm'
