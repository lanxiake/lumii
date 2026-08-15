# package-win.ps1 - One-click Windows packaging (thin wrapper)
# Usage: .\scripts\package-win.ps1
#        .\scripts\package-win.ps1 -SkipClean -Target portable
#        .\scripts\package-win.ps1 -Arch both -StopDev
# Encoding: ASCII-only comments to avoid PS 5.1 parse issues without BOM
param(
  [switch]$SkipClean,
  [switch]$SkipInstall,
  [switch]$SkipDrawCheck,
  [Alias('SkipProdCheck')]
  [switch]$SkipProdCheckCompat,
  [ValidateSet('x64', 'ia32', 'both')]
  [string]$Arch = 'x64',
  [ValidateSet('nsis', 'portable', 'zip', 'dir')]
  [string]$Target = 'nsis',
  [string]$OutputDir = '',
  [switch]$StopDev,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$WindowsRoot = Join-Path $Root 'apps\windows'
$PackScript = Join-Path $WindowsRoot 'scripts\package-windows.js'
$StopScript = Join-Path $PSScriptRoot 'stop-dev.ps1'
$Tag = 'Lumii'

# Switch console to UTF-8 to reduce Chinese mojibake.
function Set-Utf8Console {
  try { chcp 65001 | Out-Null } catch {}
  try {
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [Console]::InputEncoding = $utf8
    [Console]::OutputEncoding = $utf8
    $global:OutputEncoding = $utf8
  } catch {}
  $env:PYTHONIOENCODING = 'utf-8'
  $env:LANG = 'zh_CN.UTF-8'
}

# Print usage help for the packaging wrapper.
function Show-Help {
  Write-Host @"
$Tag Windows packaging (wrapper around apps/windows/scripts/package-windows.js)

Usage:
  .\scripts\package-win.ps1 [options]
  pnpm package:win -- [options]

Options:
  -SkipClean       Skip cleaning out/ and release/
  -SkipInstall     Skip pnpm install
  -SkipDrawCheck   Skip Draw API config validation (-SkipProdCheck alias)
  -Arch <arch>     x64 (default) | ia32 | both
  -Target <type>   nsis (default) | portable | zip | dir
  -OutputDir <dir> Custom electron-builder output dir
  -StopDev         Stop local dev before packaging (avoids app.asar lock)
  -Help            Show this help

Examples:
  .\scripts\package-win.ps1
  .\scripts\package-win.ps1 -SkipClean -Target portable
  .\scripts\package-win.ps1 -Arch both -StopDev
  .\scripts\package-win.ps1 -OutputDir release-build
"@
}

Set-Utf8Console

if ($Help) {
  Show-Help
  exit 0
}

if (-not (Test-Path (Join-Path $WindowsRoot 'package.json'))) {
  Write-Host "$Tag : apps/windows not found under $Root" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path $PackScript)) {
  Write-Host "$Tag : missing package script: $PackScript" -ForegroundColor Red
  exit 1
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "$Tag : pnpm not found. Install: npm i -g pnpm" -ForegroundColor Red
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "$Tag : node not found. Install Node.js first." -ForegroundColor Red
  exit 1
}

# Domestic mirrors for Electron / electron-builder binaries
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

if ($StopDev) {
  Write-Host "$Tag : -StopDev stopping local dev ..." -ForegroundColor Yellow
  if (Test-Path $StopScript) {
    & $StopScript
  } else {
    Write-Host "$Tag : stop-dev.ps1 not found, skip" -ForegroundColor Yellow
  }
}

$skipDraw = $SkipDrawCheck -or $SkipProdCheckCompat

$nodeArgs = @($PackScript)
if ($SkipClean) { $nodeArgs += '--skip-clean' }
if ($SkipInstall) { $nodeArgs += '--skip-install' }
if ($skipDraw) { $nodeArgs += '--skip-draw-check' }
$nodeArgs += @('--arch', $Arch)
$nodeArgs += @('--target', $Target)
if ($OutputDir -and $OutputDir.Trim().Length -gt 0) {
  $nodeArgs += @('--output-dir', $OutputDir.Trim())
}

$releaseHint = if ($OutputDir -and $OutputDir.Trim().Length -gt 0) {
  Join-Path $WindowsRoot $OutputDir.Trim()
} else {
  Join-Path $WindowsRoot 'release'
}

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host "  $Tag Windows package" -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host "  Arch:    $Arch"
Write-Host "  Target:  $Target"
Write-Host "  Clean:   $(if ($SkipClean) { 'skip' } else { 'yes' })"
Write-Host "  Install: $(if ($SkipInstall) { 'skip' } else { 'yes' })"
Write-Host "  Output:  $releaseHint"
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''

Set-Location $WindowsRoot
Write-Host "$Tag : running node $($nodeArgs -join ' ')" -ForegroundColor Cyan

& node @nodeArgs
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
  Write-Host "$Tag : packaging failed (exit $exitCode)" -ForegroundColor Red
  exit $exitCode
}

Write-Host ''
Write-Host "$Tag : done. Artifacts -> $releaseHint" -ForegroundColor Green
if (Test-Path $releaseHint) {
  Get-ChildItem $releaseHint -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @('.exe', '.zip', '.7z') } |
    ForEach-Object {
      $sizeMB = [math]::Round($_.Length / 1MB, 1)
      Write-Host ("  - {0} ({1} MB)" -f $_.Name, $sizeMB)
    }
}
exit 0
