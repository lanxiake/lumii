param([string]$Out = "$env:TEMP\wx_uia_gate.txt", [switch]$NoRestore)
# E0 REDONE: WeChat 4.x exposes its UIA tree ON DEMAND -- by default you get an empty shell, and
# the full control tree is only built once a "legitimate accessibility client" attaches.
#
# The previous probe (probe_composer_uia.ps1) reported "only 2 descendants in all three window
# states" -- but all three were MINIMIZED: it used SetWindowPos(HWND_TOP, SWP_NOACTIVATE), which
# only reorders z-order and does NOT restore a minimized window. So that state was never tested.
# This probe adds the missing cell: restore first (SW_SHOWNOACTIVATE, no focus steal -- the MCP
# send path already does exactly this), then enumerate; and put the window back the way we found
# it (if it was minimized, minimize it again).
#
# Read-only UIA + a display-state change only. No injection, no file changes, no input posted.
#
# Keep this file PURE ASCII: PS 5.1 reads a BOM-less UTF-8 .ps1 as GBK, and a multi-byte comment
# can decode into a backtick that escapes the newline and eats the next line -- measured twice,
# including a Chinese comment inside the C# here-string below eating a const declaration.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$lines = @()
function Say($s) { $script:lines += $s }

Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;using System.Collections.Generic;
public class W {
 public delegate bool Cb(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(
   IntPtr h, uint m, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr res);
 public struct RC { public int l,t,r,b; }
 public const int SW_MINIMIZE = 6;
 public const int SW_SHOWNOACTIVATE = 4;
 public const uint WM_GETOBJECT = 0x003D;   // the accessibility handshake entry point
 public static IntPtr OBJID_CLIENT = (IntPtr)(-4);
 public static List<IntPtr> Qt(IntPtr parent) {
   var o = new List<IntPtr>();
   uint want; GetWindowThreadProcessId(parent, out want);
   EnumWindows(new Cb((h, p) => {
     uint pid; GetWindowThreadProcessId(h, out pid);
     if (pid == want) {
       var c = new StringBuilder(256); GetClassName(h, c, 256);
       if (c.ToString().StartsWith("Qt")) o.Add(h);
     }
     return true; }), IntPtr.Zero);
   return o; }
 public static IntPtr AskAccessible(IntPtr h) {
   IntPtr res = IntPtr.Zero;
   SendMessageTimeout(h, WM_GETOBJECT, IntPtr.Zero, OBJID_CLIENT, 2, 2000, out res);
   return res; }
 public static string Rect(IntPtr h) { RC r; GetWindowRect(h, out r);
   return string.Format("{0},{1} {2}x{3}", r.l, r.t, r.r-r.l, r.b-r.t); }
}
'@

$restored = $false
$wasIconic = $false
$main = [IntPtr]::Zero
# Defined before use on purpose: PowerShell binds a function only when execution reaches its
# definition, so an early-exit Finish() would otherwise be "not recognized".
function Finish {
  if ($restored -and $wasIconic -and -not $NoRestore) {
    [W]::ShowWindow($main, [W]::SW_MINIMIZE) | Out-Null
    Say "RESTORE  minimized again (that is how we found it)"
  }
  [IO.File]::WriteAllLines($Out, $script:lines)
}

$proc = Get-Process Weixin -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Say "ERR  no Weixin main window"; Finish; exit 0 }
$main = [IntPtr]$proc.MainWindowHandle
$wasIconic = [W]::IsIconic($main)
Say ("MAIN  hwnd={0} pid={1}" -f $main, $proc.Id)
Say ("STATE  minimized={0} visible={1} rect={2}" -f $wasIconic, [W]::IsWindowVisible($main), [W]::Rect($main))
Say ("QT    all Qt top-level windows: {0}" -f (([W]::Qt($main) | ForEach-Object { $_.ToString() }) -join ", "))

$anyCond = [System.Windows.Automation.Condition]::TrueCondition

function Dump($root, $tag) {
  $n = 0
  try { $n = $root.FindAll($TS::Descendants, $anyCond).Count } catch {}
  Say ("{0}  descendants={1}" -f $tag, $n)
  if ($n -gt 0 -and $n -le 60) {
    $kids = $root.FindAll($TS::Descendants, $anyCond)
    for ($i = 0; $i -lt $n; $i++) {
      $e = $kids.Item($i)
      $nm = [string]$e.Current.Name
      if ($nm.Length -gt 28) { $nm = $nm.Substring(0, 28) }
      Say ("   CTL {0,-26} id='{1}' name='{2}'" -f $e.Current.ControlType.ProgrammaticName,
           $e.Current.AutomationId, $nm)
    }
  }
  return $n
}

# Cell 1: as-found. If it is minimized, this is the ONLY cell the old probe ever really measured.
$nBefore = Dump ($AE::FromHandle($main)) "BEFORE(not-restored)"

# Cell 2: after restoring the display state (no focus steal).
if ($wasIconic) {
  [W]::ShowWindow($main, [W]::SW_SHOWNOACTIVATE) | Out-Null
  $restored = $true
  Start-Sleep -Milliseconds 900
  Say ("AFTER-RESTORE  minimized={0} fg={1} rect={2}" -f [W]::IsIconic($main), [W]::GetForegroundWindow(), [W]::Rect($main))
}
$root2 = $AE::FromHandle($main)
$nAfter = Dump $root2 "AFTER(restored)"

# Cell 3: explicitly run the accessibility handshake, then enumerate again.
$acc = [W]::AskAccessible($main)
Say ("HANDSHAKE  WM_GETOBJECT(OBJID_CLIENT) -> {0}" -f $acc)
Start-Sleep -Milliseconds 700
$root3 = $AE::FromHandle($main)
$nHand = Dump $root3 "AFTER-HANDSHAKE"

# Cell 4: is the composer there, and does it expose ValuePattern (the SetValue shortcut)?
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, "chat_input_field")
$box = $root3.FindFirst($TS::Descendants, $cond)
if ($null -eq $box) { $box = $root2.FindFirst($TS::Descendants, $cond) }
Say ("COMPOSER  chat_input_field found = {0}" -f ($null -ne $box))
if ($null -ne $box) {
  Say ("COMPOSER  name='{0}'" -f $box.Current.Name)
  $vp = $null
  try { $vp = $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
  if ($vp) {
    Say ("COMPOSER  ValuePattern YES  IsReadOnly={0}  valueLen={1}" -f $vp.Current.IsReadOnly, ([string]$vp.Current.Value).Length)
  } else {
    $sup = @()
    foreach ($p in @(
        @('ValuePattern', [System.Windows.Automation.ValuePattern]::Pattern),
        @('TextPattern', [System.Windows.Automation.TextPattern]::Pattern),
        @('LegacyIAccessible', [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern))) {
      try { $box.GetCurrentPattern($p[1]) | Out-Null; $sup += $p[0] } catch {}
    }
    Say ("COMPOSER  ValuePattern NO; others: {0}" -f ($sup -join ', '))
  }
}

Say ("SUMMARY  before={0} after={1} handshake={2}" -f $nBefore, $nAfter, $nHand)
Finish
