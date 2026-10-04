# Build the Windows input helper (bin\dsh-input.exe) with the .NET Framework
# compiler that ships with Windows 10/11, then run its `check` command so the
# caller can see that the helper works.
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

$windir = $env:WINDIR
if ([string]::IsNullOrEmpty($windir)) { $windir = $env:SystemRoot }
if ([string]::IsNullOrEmpty($windir)) { throw 'WINDIR (or SystemRoot) is not set, so csc.exe cannot be located.' }

# 64-bit compiler first; the 32-bit one only exists on a 32-bit Windows.
$csc = Join-Path $windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
    $csc = Join-Path $windir 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $csc)) {
    throw ("csc.exe was not found. Looked in " +
        (Join-Path $windir 'Microsoft.NET\Framework64\v4.0.30319') + ' and ' +
        (Join-Path $windir 'Microsoft.NET\Framework\v4.0.30319') +
        '. Install the .NET Framework 4.x (it is part of Windows 10/11).')
}

Push-Location $repoRoot
try {
    if (-not (Test-Path -LiteralPath 'native\DshInput.cs')) {
        throw "native\DshInput.cs is missing from $repoRoot"
    }
    New-Item -ItemType Directory -Force -Path 'bin' | Out-Null

    Write-Host 'building bin\dsh-input.exe'
    & $csc /nologo /target:exe /platform:anycpu /out:bin\dsh-input.exe native\DshInput.cs /reference:System.Windows.Forms.dll /reference:System.Drawing.dll
    if ($LASTEXITCODE -ne 0) {
        throw "csc.exe failed with exit code $LASTEXITCODE; the output above explains why."
    }

    Write-Host 'running bin\dsh-input.exe check'
    & '.\bin\dsh-input.exe' check
    if ($LASTEXITCODE -ne 0) {
        throw "the helper was built but 'dsh-input.exe check' failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
