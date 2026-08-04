# stop-dev.ps1 - Stop Lumii local dev process
# Usage: .\scripts\stop-dev.ps1
#        .\scripts\stop-dev.ps1 -KillAllElectron
param(
  [switch]$KillAllElectron
)

$ErrorActionPreference = 'Continue'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$PidFile = Join-Path $Root '.lumii-dev.pid'
$Tag = 'Lumii'
$RootPath = $Root.Path

function Stop-ProcessTree {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return }
  $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $p) {
    Write-Host "$Tag : PID=$ProcessId already gone"
    return
  }
  Write-Host "$Tag : killing tree PID=$ProcessId ($($p.ProcessName)) ..."
  & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
  Start-Sleep -Milliseconds 500
}

function Stop-OrphanDevProcesses {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $cmd = $_.CommandLine
      if (-not $cmd) { return $false }
      $inRepo = ($cmd -like "*$RootPath*") -or ($cmd -match 'open-source\\lumii') -or ($cmd -match 'lumii-windows')
      if (-not $inRepo) { return $false }
      return ($cmd -match 'electron-vite') -or ($cmd -match 'electron\.exe') -or ($cmd -match 'apps\\windows')
    } |
    ForEach-Object {
      Write-Host "$Tag : cleanup PID=$($_.ProcessId) $($_.Name)"
      & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null
    }
}

$saved = 0
if (Test-Path $PidFile) {
  $raw = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue)
  if ($raw) { [void][int]::TryParse($raw.Trim(), [ref]$saved) }
}

if ($saved -gt 0) {
  Stop-ProcessTree -ProcessId $saved
} else {
  Write-Host "$Tag : no .lumii-dev.pid, scanning orphans ..."
}

Stop-OrphanDevProcesses

if ($KillAllElectron) {
  Write-Host "$Tag : -KillAllElectron (all electron.exe)" -ForegroundColor Yellow
  Get-Process -Name 'electron' -ErrorAction SilentlyContinue | ForEach-Object {
    & taskkill.exe /PID $_.Id /T /F 2>$null | Out-Null
  }
}

if (Test-Path $PidFile) {
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Write-Host "$Tag : stopped" -ForegroundColor Green
