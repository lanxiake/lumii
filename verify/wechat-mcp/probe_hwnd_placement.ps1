# READ-ONLY: print GetWindowPlacement (showCmd + rcNormalPosition) for explicit hwnds.
# A minimized window restores to rcNormalPosition -- if that got poisoned to -32000,-32000
# then "restore" always lands off-screen. ASCII only.
param([string[]]$Hwnds = @("132192","131852"))
Add-Type @'
using System;using System.Runtime.InteropServices;
public class P {
 [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WP p);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
 public struct PT { public int x,y; }
 public struct RC { public int l,t,r,b; }
 public struct WP { public int length, flags, showCmd; public PT min, max; public RC normal; }
 public static string T(IntPtr h){ var s=new System.Text.StringBuilder(256); GetWindowTextW(h,s,256); return s.ToString(); }
 public static string Dump(IntPtr h) {
   RC r; GetWindowRect(h, out r);
   WP p = new WP(); p.length = Marshal.SizeOf(typeof(WP));
   bool g = GetWindowPlacement(h, ref p);
   string sc = p.showCmd==1?"normal":p.showCmd==2?"MINIMIZED":p.showCmd==3?"maximized":"?"+p.showCmd;
   return string.Format(
     "hwnd={0} title='{1}' vis={2} iconic={3} rect={4},{5} {6}x{7}\r\n   place.ok={8} showCmd={9} normalRect={10},{11} {12}x{13} flags=0x{14:X}",
     h, T(h), IsWindowVisible(h), IsIconic(h), r.l,r.t,(r.r-r.l),(r.b-r.t),
     g, sc, p.normal.l,p.normal.t,(p.normal.r-p.normal.l),(p.normal.b-p.normal.t), p.flags);
 } }
'@
foreach ($s in $Hwnds) {
  $h = [IntPtr][int]$s
  Write-Output ([P]::Dump($h))
}
