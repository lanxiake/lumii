# READ-ONLY: dump a few UIA names under explicit hwnds, to tell the real chat window from a helper.
param([string[]]$Hwnds = @("132192","131852"))
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$TS = [System.Windows.Automation.TreeScope]
$AE = [System.Windows.Automation.AutomationElement]
$any = [System.Windows.Automation.Condition]::TrueCondition
foreach ($s in $Hwnds) {
  $h = [IntPtr][int]$s
  Write-Output "== hwnd=$h"
  try { $e = $AE::FromHandle($h) } catch { Write-Output "   FromHandle failed: $_"; continue }
  if (-not $e) { Write-Output "   null element"; continue }
  $n = 0; try { $n = $e.FindAll($TS::Descendants, $any).Count } catch {}
  Write-Output ("   descendants={0}" -f $n)
  if ($n -gt 0) {
    $ds = $e.FindAll($TS::Descendants, $any)
    $out = @()
    for ($j = 0; $j -lt [Math]::Min($n, 12); $j++) {
      $x = $ds.Item($j)
      $nm = [string]$x.Current.Name
      if ($nm.Length -gt 18) { $nm = $nm.Substring(0, 18) }
      $out += ("{0}/{1}" -f $x.Current.ControlType.ProgrammaticName.Replace("ControlType.",""), $nm)
    }
    Write-Output ("   {0}" -f ($out -join "  "))
  }
}
