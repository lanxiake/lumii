# start-dev.ps1 - Start Lumii local dev (electron-vite)
# Usage: .\scripts\start-dev.ps1 [-Force] [-Foreground]
# Encoding: ASCII-only comments to avoid PS 5.1 parse issues without BOM
param(
  [switch]$Force,
  [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$PidFile = Join-Path $Root '.lumii-dev.pid'
$LogFile = Join-Path $Root '.lumii-dev.log'
$StopScript = Join-Path $PSScriptRoot 'stop-dev.ps1'
$Tag = 'Lumii'

# Switch console to UTF-8 to reduce Chinese mojibake
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

function Test-DevRunning {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return $false }
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Get-SavedPid {
  if (-not (Test-Path $PidFile)) { return 0 }
  $raw = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue)
  if (-not $raw) { return 0 }
  $id = 0
  [void][int]::TryParse($raw.Trim(), [ref]$id)
  return $id
}

Set-Utf8Console

if (-not (Test-Path (Join-Path $Root 'apps\windows\package.json'))) {
  Write-Host "$Tag : apps/windows not found." -ForegroundColor Red
  exit 1
}

$existing = Get-SavedPid
if ($existing -gt 0 -and (Test-DevRunning -ProcessId $existing)) {
  if (-not $Force) {
    Write-Host "$Tag : already running (PID=$existing). Use -Force to restart." -ForegroundColor Yellow
    Write-Host "$Tag : log -> $LogFile"
    exit 0
  }
  Write-Host "$Tag : -Force stopping PID=$existing ..."
  & $StopScript
  Start-Sleep -Seconds 1
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "$Tag : pnpm not found. Install: npm i -g pnpm" -ForegroundColor Red
  exit 1
}

Set-Location $Root
Write-Host "$Tag : starting apps/windows dev ..." -ForegroundColor Cyan
Write-Host "$Tag : root = $Root"
Write-Host "$Tag : log  = $LogFile"

if ($Foreground) {
  if (Test-Path $PidFile) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
  pnpm --filter ./apps/windows dev
  exit $LASTEXITCODE
}

if (Test-Path $LogFile) { Remove-Item $LogFile -Force -ErrorAction SilentlyContinue }

$inner = @"
`$ErrorActionPreference = 'Continue'
chcp 65001 | Out-Null
try {
  `$utf8 = New-Object System.Text.UTF8Encoding `$false
  [Console]::InputEncoding = `$utf8
  [Console]::OutputEncoding = `$utf8
  `$OutputEncoding = `$utf8
} catch {}
`$env:PYTHONIOENCODING = 'utf-8'
`$env:LANG = 'zh_CN.UTF-8'
Set-Location '$Root'
`$Host.UI.RawUI.WindowTitle = 'Lumii Dev'
'starting...' | Out-File -FilePath '$LogFile' -Encoding utf8
pnpm --filter ./apps/windows dev *>&1 | ForEach-Object {
  `$line = `$_.ToString()
  Write-Host `$line
  Add-Content -Path '$LogFile' -Value `$line -Encoding utf8
}
"@

$proc = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', $inner
  ) `
  -PassThru `
  -WindowStyle Normal

$proc.Id | Set-Content -Path $PidFile -Encoding ascii
Write-Host "$Tag : started (PID=$($proc.Id))" -ForegroundColor Green
Write-Host "$Tag : stop -> .\scripts\stop-dev.ps1"
Write-Host "$Tag : tail -> Get-Content .lumii-dev.log -Encoding utf8 -Wait"
