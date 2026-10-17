# READ-ONLY: report why the WeChat main window is not showing (minimized? off-screen? zero-size?).
# Windows can report a minimized window as vis=True with rect -32000,-32000 -- that is exactly the
# "window exists but you cannot see it" state, so print enough to tell those cases apart.
# ASCII only (PS 5.1 decodes BOM-less UTF-8 as GBK).
param([int]$Pid2 = 0)
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;using System.Collections.Generic;
public class W {
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
 [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WP p);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
 [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 public struct RC { public int l,t,r,b; }
 public struct PT { public int x,y; }
 public struct WP {
   public int length, flags, showCmd; public PT min, max; public RC normal; }
 public static string Dump(IntPtr h) {
   RC r; GetWindowRect(h, out r);
   WP p = new WP(); p.length = Marshal.SizeOf(typeof(WP));
   bool g = GetWindowPlacement(h, ref p);
   int st = GetWindowLong(h, -16);
   return string.Format(
     "hwnd={0} isWindow={1} visible={2} iconic={3} zoomed={4}\r\n" +
     "  style=0x{5:X8} WS_VISIBLE={6} WS_MINIMIZE={7}\r\n" +
     "  rect={8},{9} {10}x{11}\r\n" +
     "  place.ok={12} showCmd={13} ({14}) normalRect={15},{16} {17}x{18}\r\n" +
     "  screens: virtual={19}x{20} primary={21}x{22}",
     h, IsWindow(h), IsWindowVisible(h), IsIconic(h), IsZoomed(h),
     st, ((st & 0x10000000) != 0), ((st & 0x20000000) != 0),
     r.l, r.t, r.r - r.l, r.b - r.t,
     g, p.showCmd,
     (p.showCmd == 1 ? "normal" : p.showCmd == 2 ? "MINIMIZED" : p.showCmd == 3 ? "maximized" : "?"),
     p.normal.l, p.normal.t, p.normal.r - p.normal.l, p.normal.b - p.normal.t,
     GetSystemMetrics(78), GetSystemMetrics(79), GetSystemMetrics(0), GetSystemMetrics(1));
 } }
'@
$procs = if ($Pid2 -ne 0) { Get-Process -Id $Pid2 } else { Get-Process Weixin | Sort-Object WS -Descending }
foreach ($pr in $procs) {
  if ($pr.MainWindowHandle -eq 0) { continue }
  Write-Output "== pid $($pr.Id)  MainWindowHandle=$($pr.MainWindowHandle)"
  Write-Output ([W]::Dump([IntPtr]$pr.MainWindowHandle))
}
