/**
 * Windows 抢前台：在**真正的外部应用**持有前台时，哪种办法有效。
 *
 * 上一版探针（probe-focus-steal.cjs）有个致命缺陷：notepad 是**本进程 spawn 的**，
 * Windows 允许进程把前台让给它启动的子进程，于是 `show()+focus()` 看起来"成功"了 ——
 * 那不是用户场景。用户场景是「Cursor / 浏览器 / 微信已经是前台，Lumii 在后台」。
 *
 * 本版用**已经在跑的、不是本进程启动的**窗口（Edge / 资源管理器）来制造场景，
 * 并且每个候选方法都重新把外部窗口抢回前台再测，避免"上一轮残留让下一轮白捡"。
 *
 * ## 判定标准
 *
 * 不看 `win.isFocused()`（Electron 自己的判断，会撒谎），一律看 Win32 的
 * `GetForegroundWindow()` 是不是我们窗口的 HWND。
 *
 * 用法：pnpm exec electron verify/listary-p3/probe-focus-win32.cjs
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { app, BrowserWindow } = require('electron')

const OUT = path.join(__dirname, 'focus-win32.out')
const lines = []
fs.rmSync(OUT, { force: true })
function log(s) {
  lines.push(s)
  process.stdout.write(s + '\n')
  fs.writeFileSync(OUT, lines.join('\n') + '\n')
}

function ps(script, timeout = 20000) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }).trim()
  } catch (e) {
    return `ERR:${String(e.message).split('\n')[0]}`
  }
}

/** 预编译的类型定义只加一次，省掉每轮 Add-Type 的开销 */
const WIN32_TYPES = `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LzFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
`

/** 当前前台 hwnd + 进程名 */
function foreground() {
  const out = ps(
    WIN32_TYPES +
      `
$h = [LzFg]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][LzFg]::GetWindowTextW($h, $sb, 512)
$procId = [UInt32]0
[void][LzFg]::GetWindowThreadProcessId($h, [IntPtr]::Zero)
# 用 C# 那段拿 pid 不方便，换个办法：拿所有进程的主窗 hwnd 反查
$pname = '?'
foreach ($p in Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }) {
  if ($p.MainWindowHandle -eq $h) { $pname = $p.ProcessName; break }
}
Write-Output ($h.ToInt64(), $pname, $sb.ToString() -join [char]9)
`,
  )
  if (out.startsWith('ERR:')) return { hwnd: 0, name: out, title: '' }
  const [hwnd, name, title] = out.split('\t')
  return { hwnd: Number(hwnd), name, title: title ?? '' }
}

/** 找某个进程名的一个主窗口 hwnd */
function hwndOfProcess(procName) {
  const out = ps(
    `
$p = Get-Process -Name '${procName}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) { Write-Output $p.MainWindowHandle.ToInt64() } else { Write-Output '0' }
`,
  )
  const n = Number(out)
  return Number.isFinite(n) ? n : 0
}

/** 把任意 hwnd 抢成前台（用 Alt 解锁，最可靠的那种） */
function forceForeground(hwnd) {
  return ps(
    WIN32_TYPES +
      `
[LzFg]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[LzFg]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[void][LzFg]::ShowWindow([IntPtr]${hwnd}, 9)
$r = [LzFg]::SetForegroundWindow([IntPtr]${hwnd})
Write-Output $r
`,
  )
}

/**
 * 候选方法：用 AttachThreadInput 借前台线程的输入队列，再设我们的窗口。
 * 这是 WeChat 自动化里用过的手法（docs/design/渠道与CLI 提到过风险，但这里是合规用途：
 * 用户主动双击 Ctrl 要求打开启动器）。
 */
function attachForeground(hwnd) {
  return ps(
    WIN32_TYPES +
      `
$target = [IntPtr]${hwnd}
$fg = [LzFg]::GetForegroundWindow()
$fgThread = [LzFg]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$myThread = [LzFg]::GetCurrentThreadId()
$att = [LzFg]::AttachThreadInput($myThread, $fgThread, $true)
[void][LzFg]::ShowWindow($target, 9)
[void][LzFg]::BringWindowToTop($target)
$ok = [LzFg]::SetForegroundWindow($target)
[void][LzFg]::SetActiveWindow($target)
[void][LzFg]::SetFocus($target)
[void][LzFg]::AttachThreadInput($myThread, $fgThread, $false)
Write-Output ($ok.ToString() + '|' + $att.ToString())
`,
    25000,
  )
}

function hwndOf(win) {
  const buf = win.getNativeWindowHandle()
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  log(`Electron ${process.versions.electron}\n`)

  // 找一个**不是本进程启动的**外部应用
  let outsideName = null
  for (const cand of ['msedge', 'explorer', 'chrome', 'Code', 'notepad']) {
    if (hwndOfProcess(cand) !== 0) {
      outsideName = cand
      break
    }
  }
  if (!outsideName) {
    log('找不到可用的外部应用窗口，无法验证。请开着浏览器或资源管理器再跑。')
    app.exit(1)
    return
  }
  log(`用作"外部前台应用"的是：${outsideName}\n`)

  const win = new BrowserWindow({
    width: 720,
    height: 480,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#1f1d1a',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  await win.loadURL(
    'data:text/html,' +
      encodeURIComponent(
        '<body style="background:#1f1d1a;color:#eee;font:18px sans-serif;padding:20px">' +
          '<input id="q" style="width:100%;font-size:20px">' +
          '<script>document.getElementById("q").focus()</script></body>',
      ),
  )
  const my = hwndOf(win)
  log(`启动器窗 hwnd=${my}`)

  /** 把外部应用抢回前台并确认，作为每一轮的起点 */
  async function resetToOutside() {
    const outHwnd = hwndOfProcess(outsideName)
    forceForeground(outHwnd)
    await sleep(450)
    return foreground()
  }

  const rows = []
  async function trial(label, fn) {
    const base = await resetToOutside()
    const startedFromOutside = base.name === outsideName || base.hwnd !== my
    win.hide()
    await sleep(150)
    const detail = await fn()
    await sleep(400)
    const fg = foreground()
    const ok = fg.hwnd === my
    rows.push({ label, ok })
    log(
      `  ${label.padEnd(30)} 起点前台=${base.name.padEnd(12)} → ${ok ? '✅ 抢到' : `❌ 仍是 ${fg.name}`}` +
        (detail ? `   [${detail}]` : '') +
        (startedFromOutside ? '' : '  ⚠️起点异常'),
    )
    return ok
  }

  log('\n' + '═'.repeat(78))
  log('[1] 现有实现的三层兜底')
  log('═'.repeat(78))

  await trial('A. show() + focus()', async () => {
    win.show()
    win.focus()
    return ''
  })

  await trial('B. onTop(screen-saver)+focus', async () => {
    win.show()
    win.setAlwaysOnTop(true, 'screen-saver')
    win.focus()
    return ''
  })

  await trial('C. app.focus({steal:true})', async () => {
    win.show()
    app.focus({ steal: true })
    win.focus()
    return 'darwin-only'
  })

  log('\n' + '═'.repeat(78))
  log('[2] 候选修复')
  log('═'.repeat(78))

  await trial('D. Alt 模拟 + SetForegroundWindow', async () => {
    win.show()
    return forceForeground(my)
  })

  await trial('E. AttachThreadInput 方案', async () => {
    win.show()
    return attachForeground(my)
  })

  await trial('F. showInactive → Alt → SetFg', async () => {
    win.showInactive()
    await sleep(80)
    return forceForeground(my)
  })

  // ── 关键验证：抢到前台后，键盘输入是不是真的进了输入框 ──
  log('\n' + '═'.repeat(78))
  log('[3] 抢到之后，DOM 焦点与 OS 前台是否一致')
  log('═'.repeat(78))
  await resetToOutside()
  win.hide()
  await sleep(150)
  win.show()
  forceForeground(my)
  await sleep(500)
  const fg = foreground()
  const domFocus = await win.webContents.executeJavaScript('document.hasFocus()')
  const activeTag = await win.webContents.executeJavaScript('document.activeElement?.tagName ?? "(无)"')
  log(`  GetForegroundWindow = ${fg.name}${fg.hwnd === my ? '  ← 是我' : '  ← 不是我'}`)
  log(`  document.hasFocus() = ${domFocus}`)
  log(`  activeElement       = ${activeTag}`)
  log(`  win.isFocused()     = ${win.isFocused()}`)

  win.destroy()

  log('\n' + '─'.repeat(78))
  const wins = rows.filter((r) => r.ok).map((r) => r.label)
  log(`在外部应用持前台时有效的：${wins.length > 0 ? wins.join(' | ') : '（无）'}`)
  log(fg.hwnd === my && domFocus ? '✅ 有效方案同时满足 OS 前台 + DOM 焦点' : '⚠️ 仍有不满足项')
  app.exit(0)
})
