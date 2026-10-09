Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

$root = $AE::RootElement
$tc = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, "Shell_TrayWnd")
$tray = $root.FindFirst($TS::Children, $tc)
$bc = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, "SystemTray.NormalButton")
$all = $tray.FindAll($TS::Descendants, $bc)
$target = $null
foreach ($e in $all) { if ($e.Current.Name.Trim() -eq [char]0x5FAE + [char]0x4FE1) { $target = $e; break } }
if (-not $target) { Write-Output "NOT_FOUND"; exit 1 }
$r = $target.Current.BoundingRectangle
Write-Output ("FOUND rect={0},{1} {2}x{3}" -f [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)

$names = @()
foreach ($p in $target.GetSupportedPatterns()) { $names += $p.ProgrammaticName }
Write-Output ("PATTERNS " + ($names -join ","))

$done = $false
try {
  $ip = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $ip.Invoke(); Write-Output "OK InvokePattern.Invoke"; $done = $true
} catch { Write-Output ("ERR invoke: " + $_.Exception.Message) }

if (-not $done) {
  try {
    $lp = $target.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    Write-Output ("DEFAULT_ACTION " + $lp.Current.DefaultAction)
    $lp.DoDefaultAction(); Write-Output "OK DoDefaultAction"; $done = $true
  } catch { Write-Output ("ERR legacy: " + $_.Exception.Message) }
}
if (-not $done) { Write-Output "FAILED_BOTH" }
