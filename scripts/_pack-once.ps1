# Clean packaging leftovers and package to a fresh output dir.
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Out = "E:\temp\lumii-pkg-$Stamp"

# Kill common lock holders.
foreach ($n in @('Lumii','electron','app-builder','elevated')) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# Best-effort cleanup of previous temp package dirs.
Get-ChildItem 'E:\temp' -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'lumii-pkg*' } |
  ForEach-Object {
    try {
      cmd /c ("rmdir /s /q `"" + $_.FullName + "`"")
    } catch {}
  }

Start-Sleep -Seconds 2
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Write-Host ("Output: " + $Out)

Set-Location $Root
& (Join-Path $PSScriptRoot 'package-win.ps1') -StopDev -SkipInstall -SkipClean -OutputDir $Out
$code = $LASTEXITCODE
if ($code -eq 0) {
  Write-Host ''
  Write-Host 'Artifacts:'
  Get-ChildItem $Out -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @('.exe','.zip','.7z') } |
    ForEach-Object {
      $mb = [math]::Round($_.Length / 1MB, 1)
      Write-Host ("  - {0} ({1} MB)" -f $_.Name, $mb)
    }
}
exit $code
