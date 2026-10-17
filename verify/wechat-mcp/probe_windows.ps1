param([string]$Out = "$env:TEMP\wx_windows.txt")
# E0 side-quest: the accessibility tree came back EMPTY while the WeChat window was visible but
# covered by another app. Before concluding "Qt exposes nothing when occluded", rule out the
# boring explanation: that we enumerated the wrong window. WeChat 4.x is Qt + a web-content
# surface, so the real UI may live in a child/second top-level window, not in MainWindowHandle.
# This lists every top-level window owned by the main Weixin process with class, title and rect.
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;using System.Collections.Generic;
public class E {
 public delegate bool Cb(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(Cb cb, IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RC r);
 public struct RC { public int l,t,r,b; }
 static List<string> o;
 public static List<string> Go(uint want) {
   o = new List<string>();
   EnumWindows(new Cb(Hit), (IntPtr)(int)want);
   return o; }
 static bool Hit(IntPtr h, IntPtr p) {
   uint pid; GetWindowThreadProcessId(h, out pid);
   if (pid == (uint)(int)p) {
     var c = new StringBuilder(256); GetClassName(h, c, 256);
     var t = new StringBuilder(256); GetWindowText(h, t, 256);
     RC r; GetWindowRect(h, out r);
     o.Add(string.Format("hwnd={0,-10} vis={1,-6} parent={2,-10} class={3,-28} rect={4},{5} {6}x{7}  title={8}",
       h, IsWindowVisible(h), GetParent(h), c, r.l, r.t, r.r-r.l, r.b-r.t, t));
   }
   return true; } }
'@
$main = Get-Process Weixin | Sort-Object WS -Descending | Select-Object -First 1
$lines = @("main pid = $($main.Id)  MainWindowHandle = $($main.MainWindowHandle)")
$lines += [E]::Go([uint32]$main.Id)
[IO.File]::WriteAllLines($Out, $lines)
$lines | ForEach-Object { $_ }
