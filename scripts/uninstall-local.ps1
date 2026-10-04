<#
.SYNOPSIS
  Remove dsh-computer-control from a DSH profile on Windows.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-local.ps1
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' })
)

$ErrorActionPreference = 'Stop'

$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$dest = Join-Path $profileDir 'plugins\computer-control'
$patch = Join-Path $profileDir 'cordis.patch.yml'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (Test-Path -LiteralPath $patch) {
    $content = [System.IO.File]::ReadAllText($patch)
    $marker = '# dsh-computer-control (added by scripts/install-local.ps1)'

    if ($content.Contains($marker)) {
        Copy-Item -LiteralPath $patch -Destination "$patch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
        $lines = $content -split "`r?`n"
        $kept = New-Object System.Collections.Generic.List[string]
        $index = 0
        while ($index -lt $lines.Count) {
            if ($lines[$index].Trim() -eq $marker.Trim()) {
                # skip the marker and the top-level "- " block that follows it
                $index += 1
                while ($index -lt $lines.Count -and -not $lines[$index].StartsWith('- ')) { $index += 1 }
                continue
            }
            $kept.Add($lines[$index])
            $index += 1
        }
        [System.IO.File]::WriteAllText($patch, (($kept -join "`r`n").TrimEnd() + "`r`n"), $utf8NoBom)
        Write-Host 'removed loader row'
    }
    else {
        Write-Host 'no loader row found'
    }
}

if (Test-Path -LiteralPath $dest) {
    Remove-Item -LiteralPath $dest -Recurse -Force
    Write-Host "removed $dest"
}

Write-Host 'done. Restart DeepSeek Harness.'
