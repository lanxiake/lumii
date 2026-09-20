# start-dev.ps1 - Start Lumii local dev (electron-vite)
# Usage: .\scripts\start-dev.ps1 [-Force] [-Foreground] [-Inspect <port>]
#   -Inspect 5860  -> passes --inspect=5860 --sourcemap to the main process
# Encoding: ASCII-only comments to avoid PS 5.1 parse issues without BOM
param(
  [switch]$Force,
  [switch]$Foreground,
  [string]$Inspect = ''
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$PidFile = Join-Path $Root '.lumii-dev.pid'
$LogFile = Join-Path $Root '.lumii-dev.log'
$ErrFile = Join-Path $Root '.lumii-dev.err.log'
$StopScript = Join-Path $PSScriptRoot 'stop-dev.ps1'
$Tag = 'Lumii'

# Args appended to `pnpm --filter ./apps/windows dev`.
# NOTE the `--` separator: without it pnpm may swallow --inspect itself.
$DevArgs = if ($Inspect) { "-- --inspect=$Inspect --sourcemap" } else { "" }

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
  pnpm --filter ./apps/windows dev $DevArgs
  exit $LASTEXITCODE
}

if (Test-Path $LogFile) { Remove-Item $LogFile -Force -ErrorAction SilentlyContinue }
if (Test-Path $ErrFile) { Remove-Item $ErrFile -Force -ErrorAction SilentlyContinue }

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
Write-Host ''
Write-Host 'Lumii dev starting. Output is redirected to .lumii-dev.log (this window no longer streams logs).' -ForegroundColor Cyan
Write-Host 'App logs live in ~/.lumii/logs/app/mtbot-*.log' -ForegroundColor DarkGray
Write-Host ''
# DO NOT pipe pnpm's output through PowerShell here (e.g. *>&1 | ForEach-Object {...}).
# That turns the app's stdout into a pipe with a SLOW reader, and on Windows Node
# writes to pipe stdout synchronously -- a burst of log lines then blocks the app's
# main thread, and the freeze lasts exactly as long as the reader stalls
# (measured: 8s ~ 606s). See docs/fix/2026-09-20-*.md section 6.
# Let output flow to this process's stdout; the outer Start-Process does the
# OS-level redirect to a file (a file has no reader, so it cannot stall).
pnpm --filter ./apps/windows dev $DevArgs
"@

# Run the inner script from a FILE, not via -Command / -EncodedCommand:
# multi-line scripts passed through those get re-parsed, and quotes/special chars
# easily produce "string is missing the terminator" (hit this on 2026-09-20).
#
# NOTE: write it with an EXPLICIT BOM. PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# which mangles any non-ASCII byte -- that is exactly why this file is ASCII-only.
$InnerScript = Join-Path $Root '.lumii-dev-inner.ps1'
[System.IO.File]::WriteAllText($InnerScript, $inner, (New-Object System.Text.UTF8Encoding $true))

$proc = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $InnerScript
  ) `
  -PassThru `
  -WindowStyle Normal `
  -RedirectStandardOutput $LogFile `
  -RedirectStandardError $ErrFile

$proc.Id | Set-Content -Path $PidFile -Encoding ascii
Write-Host "$Tag : started (PID=$($proc.Id))" -ForegroundColor Green
Write-Host "$Tag : stop -> .\scripts\stop-dev.ps1"
Write-Host "$Tag : tail -> Get-Content .lumii-dev.log -Encoding utf8 -Wait"
