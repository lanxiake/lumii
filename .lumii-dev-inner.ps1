$ErrorActionPreference = 'Continue'
chcp 65001 | Out-Null
try {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [Console]::InputEncoding = $utf8
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
} catch {}
$env:PYTHONIOENCODING = 'utf-8'
$env:LANG = 'zh_CN.UTF-8'
Set-Location 'C:\myself\projects\my\open-source\lumii'
$Host.UI.RawUI.WindowTitle = 'Lumii Dev'
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
pnpm --filter ./apps/windows dev -- --inspect=5860 --sourcemap