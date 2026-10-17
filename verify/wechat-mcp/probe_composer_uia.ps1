param([string]$Out = "$env:TEMP\composer_uia.txt", [switch]$Raise, [switch]$Activate)
# E0: can the MCP write the message composer in ONE call instead of posting WM_CHAR per character?
#
# wechat_sender.py posts each character with PostMessageW(WM_CHAR) and then verifies with a
# subsequence match (_residue), because per-character delivery is known to drop non-BMP chars.
# uia_read.ps1 shows the composer IS in the accessibility tree with AutomationId chat_input_field
# and DOES expose ValuePattern (used there for readback). If that pattern is not read-only, the
# whole send path collapses to: SetValue -> readback -> Enter.
#
# SAFETY: SetValue overwrites whatever the user has typed. This probe ONLY attempts a write when
# the box is currently EMPTY, and restores the empty state afterwards. If the box has a draft it
# reports the pattern state and writes NOTHING.
#
# Keep this file pure ASCII: PS 5.1 reads a BOM-less UTF-8 .ps1 as GBK, and a multi-byte comment
# can decode into a backtick that escapes the newline and eats the next line (measured).
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$lines = @()
function Say($s) { $script:lines += $s }

# Defined up here on purpose: PowerShell binds a function only when execution reaches its
# definition, so a Finish() called from an early exit below would otherwise be "not recognized".
$fg = [IntPtr]::Zero
function Finish {
  if ($fg -ne [IntPtr]::Zero) {
    [ZOrder]::ToTop($fg)
    Say ("RAISE  restored z-order for {0}" -f $fg)
  }
  [IO.File]::WriteAllLines($Out, $script:lines)
}

# -Raise lifts WeChat to the TOP of the z-order WITHOUT activating it (SWP_NOACTIVATE), so the
# user keeps typing wherever they were and never loses input focus. Reason: with the window
# covered, the whole accessibility tree came back empty (only a WIN line), which would make the
# composer look "not in the tree" purely because of occlusion. We then put the previously
# foreground window back on top. Both steps only reorder z-order: nothing is moved or resized.
Add-Type @'
using System;using System.Runtime.InteropServices;
public class ZOrder {
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 public const uint NOSIZE = 0x1, NOMOVE = 0x2, NOACTIVATE = 0x10;
 public static void ToTop(IntPtr h) { SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, NOSIZE | NOMOVE | NOACTIVATE); }
 public static void Activate(IntPtr h) { SetForegroundWindow(h); }
}
'@

$proc = Get-Process Weixin -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Say "ERR  no Weixin main window"; Finish; exit 0 }
Say ("WIN  hwnd={0} pid={1} title={2}" -f $proc.MainWindowHandle, $proc.Id, $proc.MainWindowTitle)

$root = $AE::FromHandle([IntPtr]$proc.MainWindowHandle)

# First read it exactly as it is NOW (WeChat covered by another window) - that is the state the
# MCP's background send actually runs in, so "does the composer exist here" is the real question.
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, "chat_input_field")
$box = $root.FindFirst($TS::Descendants, $cond)
Say ("COVERED  composer found = {0}" -f ($null -ne $box))
$anyCond = [System.Windows.Automation.Condition]::TrueCondition
$nAll = 0
try { $nAll = $root.FindAll($TS::Descendants, $anyCond).Count } catch {}
Say ("COVERED  total descendants = {0}" -f $nAll)
Say ("COVERED  session_list found = {0}" -f ($null -ne $root.FindFirst($TS::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, "session_list")))))

# The z-order restore is deferred to the very end on purpose: if we put the other window back on
# top here, WeChat is covered again while we are still reading/writing it - which is the very
# condition under test.
$fg = [IntPtr]::Zero
if (-not $box -and ($Raise -or $Activate)) {
  $fg = [ZOrder]::GetForegroundWindow()
  Say ("RAISE  foreground before = {0}" -f $fg)
  if ($Activate) { [ZOrder]::Activate([IntPtr]$proc.MainWindowHandle) }
  else           { [ZOrder]::ToTop([IntPtr]$proc.MainWindowHandle) }
  Start-Sleep -Milliseconds 800
  $nowFg = [ZOrder]::GetForegroundWindow()
  $took = ($nowFg -eq [IntPtr]$proc.MainWindowHandle)
  Say ("RAISED  foreground now = {0}  took_focus = {1}" -f $nowFg, $took)
  # Re-create the element: the one captured before the raise may hold a stale snapshot.
  $root = $AE::FromHandle([IntPtr]$proc.MainWindowHandle)
  $box = $root.FindFirst($TS::Descendants, $cond)
  $nAll2 = 0
  try { $nAll2 = $root.FindAll($TS::Descendants, $anyCond).Count } catch {}
  Say ("RAISED  activate={0} composer found = {1}  descendants = {2}" -f [bool]$Activate, ($null -ne $box), $nAll2)
  if ($nAll2 -gt 2) {
    $kids = $root.FindAll($TS::Descendants, $anyCond)
    for ($i = 0; $i -lt [Math]::Min(6, $nAll2); $i++) {
      $e = $kids.Item($i)
      Say ("  CTL  {0}  id={1}" -f $e.Current.ControlType.ProgrammaticName, $e.Current.AutomationId)
    }
  }
}

if (-not $box) { Say "RESULT composer NOT FOUND in the tree at this window state"; Finish; exit 0 }

$ct = ''; $cls = ''; $name = ''
try { $ct = $box.Current.ControlType.ProgrammaticName } catch {}
try { $cls = [string]$box.Current.ClassName } catch {}
try { $name = [string]$box.Current.Name } catch {}
Say ("BOX  controlType={0} class={1} name={2}" -f $ct, $cls, $name)

# Which patterns does it actually support?
$supported = @()
$pats = @(
  @('ValuePattern',     [System.Windows.Automation.ValuePattern]::Pattern),
  @('TextPattern',      [System.Windows.Automation.TextPattern]::Pattern),
  @('LegacyIAccessible',[System.Windows.Automation.LegacyIAccessiblePattern]::Pattern),
  @('Selection',        [System.Windows.Automation.SelectionPattern]::Pattern)
)
foreach ($p in $pats) {
  try { $box.GetCurrentPattern($p[1]) | Out-Null; $supported += $p[0] } catch {}
}
Say ("PATTERNS  " + ($supported -join ', '))

$vp = $null
try { $vp = $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
if (-not $vp) { Say "RESULT no ValuePattern -> SetValue is impossible; keep the WM_CHAR path"; Finish; exit 0 }

$ro = $null; $before = '<unreadable>'
try { $ro = $vp.Current.IsReadOnly } catch {}
try { $before = $vp.Current.Value } catch {}
Say ("READONLY  {0}" -f $ro)
Say ("VALUE_BEFORE  {0} chars: {1}" -f $before.Length, ($before -replace "`r|`n", ' '))

if ($ro -eq $true) { Say "RESULT read-only -> SetValue impossible; keep the WM_CHAR path"; Finish; exit 0 }
if ($before -ne '') {
  Say "RESULT writable, but the composer is NOT EMPTY -> wrote nothing (would have clobbered the user's draft)"
  Finish; exit 0
}

# Safe to try: the box is empty, so the worst case is we restore it to empty.
$probe = "__lumii_probe_wxyz__"
$err = ''
try { $vp.SetValue($probe) } catch { $err = $_.Exception.Message.Split("`n")[0] }
Say ("SETVALUE  err='{0}'" -f $err)
Start-Sleep -Milliseconds 300
$after = '<unreadable>'
try { $after = $vp.Current.Value } catch {}
Say ("VALUE_AFTER  {0} chars: {1}" -f $after.Length, ($after -replace "`r|`n", ' '))
Say ("MATCH  {0}" -f ($after -ceq $probe))

# Restore: leave the composer exactly as we found it (empty).
try { $vp.SetValue("") } catch {}
Start-Sleep -Milliseconds 200
$restored = '<unreadable>'
try { $restored = $vp.Current.Value } catch {}
Say ("RESTORED_EMPTY  {0}" -f ($restored -eq ''))
Say "RESULT writable via ValuePattern.SetValue"
Finish
