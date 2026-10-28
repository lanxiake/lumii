param([string]$NameMatch = '', [string]$Out = '')
# Invoke a system-tray icon by name (UIA). Used to pull WeChat's UI out of its frozen state.
#
# Why UIA and not a real mouse double-click: the icon's Qt window (`TrayRocketView`,
# class `Qt51514QWindowToolSaveBits`) is reported by WindowFromPoint but is NOT hit-testable
# -- a real click at its rect lands on Shell_TrayWnd instead (GetForegroundWindow becomes the
# taskbar) and the main window never changes. InvokePattern talks straight to the provider.
#
# Pure ASCII on purpose: PS 5.1 reads a BOM-less .ps1 as GBK, so Chinese comments/strings turn
# into mojibake and can eat quotes. The target name is passed in as an argument.
#
# Output is one record per line, tab separated, written UTF-8 no-BOM:
#   EL      <index> <name> <class> <x> <y> <width>
#   MATCH   <index> <name>
#   INVOKED <index>
#   ERR     <where> <message>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$root = $AE::RootElement
$lines = New-Object System.Collections.Generic.List[string]

# Win11 renders the tray in a XAML island; the icons surface as ClassName 'SystemTray.NormalButton'.
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'SystemTray.NormalButton')
$els = $null
try {
  $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
} catch {
  $lines.Add("ERR`tfindall`t$($_.Exception.Message)")
}

$i = 0
$hit = -1
if ($els) {
  foreach ($e in $els) {
    try {
      $n = $e.Current.Name
      $c = $e.Current.ClassName
      $r = $e.Current.BoundingRectangle
      # BoundingRectangle is NaN for virtualised/off-screen items and [int]$NaN throws --
      # that would abort the whole enumeration, so cast inside the per-item try.
      $lines.Add(("EL`t{0}`t{1}`t{2}`t{3}`t{4}`t{5}" -f $i, $n, $c, [int]$r.X, [int]$r.Y, [int]$r.Width))
      if ($NameMatch -ne '' -and ($n -replace '\s', '') -eq $NameMatch) {
        $lines.Add(("MATCH`t{0}`t{1}" -f $i, $n))
        if ($hit -lt 0) { $hit = $i }   # first exact match wins; names repeat across apps (WeCom etc.)
      }
    } catch { $lines.Add("ERR`titem$i`t$($_.Exception.Message)") }
    $i++
  }
}

if ($hit -ge 0) {
  try {
    $p = $els.Item($hit).GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $p.Invoke()
    $lines.Add(("INVOKED`t{0}" -f $hit))
  } catch { $lines.Add("ERR`tinvoke`t$($_.Exception.Message)") }
} elseif ($NameMatch -ne '') {
  $lines.Add(("NOTE`tno exact match for '{0}'" -f $NameMatch))
}

if ($Out -ne '') {
  [System.IO.File]::WriteAllLines($Out, $lines, (New-Object System.Text.UTF8Encoding $false))
}
Write-Output ("DONE {0} elements, hit={1}" -f $i, $hit)
