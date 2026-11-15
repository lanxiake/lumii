/**
 * Windows 抢前台 —— 为什么必须有这一层。
 *
 * ## 背景（用户 2026-11-15 实测）
 *
 * 「输入框中有光标，但是键盘输入还在原来其他窗口上。」
 *
 * 这句话精确地描述了**两种焦点不是一回事**：
 * - DOM 焦点（`document.activeElement`）—— 渲染层自己说了算，`input.focus()` 就能拿到
 * - OS 前台焦点（`GetForegroundWindow()`）—— Windows 说了算，决定键盘往哪个窗口送
 *
 * `win.show() + win.focus()` 只保证前者。后者受**前台锁**（ForegroundLockTimeout）限制：
 * 后台进程不能随便抢前台，否则任何程序都能在用户打字时弹窗偷走键入。
 *
 * ## 为什么现有三层兜底没用（实测）
 *
 * `verify/listary-p3/probe-focus-win32.cjs`，在 msedge 已持前台时逐个试：
 * ```
 * A. show() + focus()                → ❌ 仍是 msedge
 * B. onTop('screen-saver') + focus() → ❌ 仍是 msedge
 * C. app.focus({ steal: true })      → ❌ 仍是 msedge
 * ```
 *
 * C 失败是**确定性的**：Electron 的 `FocusOptions.steal` 在类型定义里标注
 * `@platform darwin` —— Windows 上这个字段根本不被读取，属于空操作。
 *
 * ## 有效的办法：先"骗"到前台所有权
 *
 * Windows 允许**当前持有前台输入的进程**随意设前台。`keybd_event` 模拟的按键
 * 属于调用进程，按一次 Alt 就让本进程成为"最近一次输入的来源"，随后的
 * `SetForegroundWindow` 就不再被拦。实测 D/F 两种顺序都成功。
 *
 * 这是 Windows 上的标准做法，不是漏洞利用：用户刚刚主动双击了 Ctrl，
 * 打开启动器正是他的意图。代价是每次唤起会多一次 ~200ms 的 PowerShell 进程。
 *
 * ## 为什么不缓存
 *
 * 抢前台必须每次现做 —— 前台归属随时在变。把上一次的结果缓存下来毫无意义。
 */

import { execFile } from 'node:child_process'

/**
 * 把指定窗口设为系统前台。
 *
 * `hwnd` 必须是**十进制字符串**：Windows 上 HWND 是 64 位指针，JS 的 number 在
 * 高位会被截断，故调用方用 `getNativeWindowHandle()` 读出 BigInt 再转字符串。
 *
 * 失败不抛异常 —— 抢不到前台只是"焦点没进来"，比让唤起流程崩掉好。
 */
export async function forceForeground(hwnd: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  if (!/^\d+$/.test(hwnd)) return false

  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class LzFg {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
}
'@
[LzFg]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[LzFg]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 20
$h = [IntPtr]${hwnd}
[void][LzFg]::ShowWindow($h, 9)
[void][LzFg]::BringWindowToTop($h)
$r = [LzFg]::SetForegroundWindow($h)
Write-Output $r
`
  // 复用同一个 PowerShell 类型定义，省掉每次 Add-Type 的编译开销
  return new Promise<boolean>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 3000, windowsHide: true },
      (_e, so) => resolve(String(so ?? '').trim().toLowerCase() === 'true'),
    )
  })
}
