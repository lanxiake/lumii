param([string]$Out = "$env:TEMP\e3_uia.txt")
# E3: WHERE does WeChat 4.x actually hang its accessibility tree?
#
# probe_uia_gate.ps1 measured main-window descendants = 2 ("Weixin" + "MMUIRenderSubWindowHW")
# in every state, including after a restore and after the WM_GETOBJECT handshake. But that probe
# only ever asked ONE root: the process main window. This one asks every root the app owns --
# the other Qt top-level windows, and the child windows of the main one -- because a Qt app that
# renders through a sub-surface often puts the real widget tree under the CHILD, not the top.
#
# Read-only: UIA enumeration only. No window state change, no input, no injection.
#
# Keep this file PURE ASCII (PS 5.1 reads a BOM-less UTF-8 .ps1 as GBK; a multi-byte comment can
# decode into a backtick that escapes the newline and eats the next line -- measured).
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$lines = @()
function Say($s) { $script:lines += $s }

Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;using System.Collections.Generic;
public class W3 {
 public delegate bool Cb(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, Cb cb, IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
 public struct RC { public int l,t,r,b; }
 public const uint GW_OWNER = 4, GW_HWNDNEXT = 2;
 public static List<IntPtr> SamePid(IntPtr parent, bool children) {
   var o = new List<IntPtr>();
   uint want; GetWindowThreadProcessId(parent, out want);
   Cb cb = (h, p) => {
     uint pid; GetWindowThreadProcessId(h, out pid);
     if (pid == want) o.Add(h);
     return true; };
   if (children) EnumChildWindows(parent, cb, IntPtr.Zero); else EnumWindows(cb, IntPtr.Zero);
   return o; }
 public static IntPtr Owner(IntPtr h) { return GetWindow(h, GW_OWNER); }
 public static string Cls(IntPtr h) { var c = new StringBuilder(256); GetClassName(h, c, 256); return c.ToString(); }
 public static string Txt(IntPtr h) { var t = new StringBuilder(512); GetWindowText(h, t, 512); return t.ToString(); }
 public static string Rect(IntPtr h) { RC r; GetWindowRect(h, out r);
   return string.Format("{0},{1} {2}x{3}", r.l, r.t, r.r-r.l, r.b-r.t); }
}
'@

$proc = Get-Process Weixin -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Say "ERR  no Weixin main window"; [IO.File]::WriteAllLines($Out, $lines); exit 0 }
$main = [IntPtr]$proc.MainWindowHandle
Say ("MAIN  hwnd={0} pid={1} class={2} rect={3} iconic={4} visible={5}" -f `
     $main, $proc.Id, [W3]::Cls($main), [W3]::Rect($main), [W3]::IsIconic($main), [W3]::IsWindowVisible($main))

$any = [System.Windows.Automation.Condition]::TrueCondition

# Ask one root, print the count, and (when small) the elements -- reusing the same SHAPE the
# report's E3 checklist asks for: do message rows exist anywhere as UIA elements?
function Ask($h, $tag) {
  $root = $null
  try { $root = $AE::FromHandle($h) } catch { Say ("{0}  hwnd={1}  FromHandle THREW" -f $tag, $h); return 0 }
  if ($null -eq $root) { Say ("{0}  hwnd={1}  FromHandle null" -f $tag, $h); return 0 }
  $n = 0
  try { $n = $root.FindAll($TS::Descendants, $any).Count } catch {}
  Say ("{0}  hwnd={1} class={2} rect={3} iconic={4} vis={5} descendants={6}" -f `
       $tag, $h, [W3]::Cls($h), [W3]::Rect($h), [W3]::IsIconic($h), [W3]::IsWindowVisible($h), $n)
  if ($n -gt 0 -and $n -le 80) {
    try {
      $all = $root.FindAll($TS::Descendants, $any)
      for ($i = 0; $i -lt $n; $i++) {
        try {
          $e = $all.Item($i)
          $nm = [string]$e.Current.Name
          if ($nm.Length -gt 30) { $nm = $nm.Substring(0, 30) }
          $nwh = 0
          try { $nwh = $e.Current.NativeWindowHandle } catch {}
          Say ("     CTL {0,-26} id='{1}' nwh={2} name='{3}'" -f `
               $e.Current.ControlType.ProgrammaticName, $e.Current.AutomationId, $nwh, $nm)
        } catch {}
      }
    } catch {}
  }
  return $n
}

Say ""
Say "== A. every top-level window of the process =="
foreach ($h in [W3]::SamePid($main, $false)) { Ask $h "TOP" | Out-Null }

Say ""
Say "== B. every child window of the main one =="
foreach ($h in [W3]::SamePid($main, $true)) { Ask $h "CHILD" | Out-Null }

Say ""
Say "== C. MSAA bridge on the render sub-surface =="
# MMUIRenderSubWindowHW is the surface the Qt renderer actually paints into. If the widget tree is
# exported over MSAA (AccessibleObjectFromWindow) rather than UIA, this is where it shows up.
Add-Type @'
using System;using System.Runtime.InteropServices;
public class M {
 [DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(
   IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
 public const uint OBJID_CLIENT = 0xFFFFFFFC;
}
'@
Add-Type -AssemblyName Accessibility
$iid = [Guid]"618736E0-3C3D-11CF-810C-00AA00389B71"   # IAccessible
foreach ($h in [W3]::SamePid($main, $false) + [W3]::SamePid($main, $true)) {
  if ([W3]::Cls($h) -notmatch 'MMUIRender|Qt') { continue }
  $obj = $null
  $hr = 0
  try { $hr = [M]::AccessibleObjectFromWindow($h, [M]::OBJID_CLIENT, [ref]$iid, [ref]$obj) } catch { $hr = -1 }
  if ($hr -ne 0 -or $null -eq $obj) { Say ("MSAA  hwnd={0} class={1} hr={2} (no IAccessible)" -f $h, [W3]::Cls($h), $hr); continue }
  $acc = [Accessibility.IAccessible]$obj
  $cn = -1
  try { $cn = $acc.accChildCount } catch {}
  Say ("MSAA  hwnd={0} class={1} childCount={2}" -f $h, [W3]::Cls($h), $cn)
  if ($cn -gt 0 -and $cn -le 60) {
    for ($i = 1; $i -le $cn; $i++) {
      $nm, $rl, $st = '', '', ''
      try { $nm = [string]$acc.get_accName($i) } catch {}
      try { $rl = [string]$acc.get_accRole($i) } catch {}
      try { $st = [string]$acc.get_accState($i) } catch {}
      if ($nm.Length -gt 30) { $nm = $nm.Substring(0, 30) }
      Say ("     ACC  {0,-3} role={1} state={2} name='{3}'" -f $i, $rl, $st, $nm)
    }
  }
}

[IO.File]::WriteAllLines($Out, $lines)
