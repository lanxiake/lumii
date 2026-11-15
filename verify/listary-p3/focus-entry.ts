/**
 * 验 `launcher-window.ts` + `foreground.ts` 的真实接线。
 *
 * 前两个探针分别证明了：
 *   - 三层 Electron 兜底在外部应用持前台时全无效
 *   - Alt 模拟 + SetForegroundWindow 有效
 *
 * 本探针验的是**接入生产代码之后**还行不行：直接实例化真实的 `LauncherWindow`，
 * 在 msedge/explorer 已持前台时调 `show()`，然后检查 OS 前台是不是真到了我这边。
 *
 * 用法：
 *   node verify/listary-p3/build-focus.mjs
 *   pnpm exec electron verify/listary-p3/focus-bundle.cjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { app, BrowserWindow } from 'electron'

import { LauncherWindow } from '../../apps/windows/src/plugins/builtin/listary/launcher-window'

const OUT = path.join(__dirname, 'focus-launcher.out')
const lines: string[] = []
fs.rmSync(OUT, { force: true })
function log(s: string): void {
  lines.push(s)
  process.stdout.write(s + '\n')
  fs.writeFileSync(OUT, lines.join('\n') + '\n')
}

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (!ok) failures++
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

function ps(script: string, timeout = 20000): string {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }).trim()
  } catch (e) {
    return `ERR:${String((e as Error).message).split('\n')[0]}`
  }
}

const TYPES = `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Fq {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
'@
`

function foregroundHwnd(): number {
  const out = ps(TYPES + `Write-Output ([Fq]::GetForegroundWindow().ToInt64())`)
  const n = Number(out)
  return Number.isFinite(n) ? n : 0
}

function hwndOfProcess(name: string): number {
  const out = ps(
    `$p = Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) { Write-Output $p.MainWindowHandle.ToInt64() } else { Write-Output '0' }`,
  )
  return Number(out) || 0
}

function forceTo(hwnd: number): void {
  ps(
    TYPES +
      `[Fq]::keybd_event(0x12,0,0,[UIntPtr]::Zero)
[Fq]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 25
[void][Fq]::ShowWindow([IntPtr]${hwnd}, 9)
[void][Fq]::SetForegroundWindow([IntPtr]${hwnd})`,
  )
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  log(`Electron ${process.versions.electron}\n`)

  let outside: string | null = null
  for (const c of ['msedge', 'explorer', 'chrome', 'Code']) {
    if (hwndOfProcess(c) !== 0) {
      outside = c
      break
    }
  }
  if (!outside) {
    log('找不到外部应用窗口，跳过')
    app.exit(1)
    return
  }
  log(`外部前台应用：${outside}\n`)

  // 真实的 LauncherWindow —— 只把页面换成一个带输入框的 data URL
  const launcher = new LauncherWindow({
    preloadPath: '',
    rendererUrl:
      'data:text/html,' +
      encodeURIComponent(
        '<body style="background:#1f1d1a;color:#eee;font:18px sans-serif;padding:16px">' +
          '<input id="q" placeholder="搜索文件、应用…" style="width:100%;font-size:20px">' +
          '<script>document.getElementById("q").focus()</script></body>',
      ),
    indexHtmlPath: '',
  })

  log('═'.repeat(78))
  log('[1] 外部应用持前台时，LauncherWindow.show() 能否抢到')
  log('═'.repeat(78))

  let won = 0
  for (const round of [1, 2, 3]) {
    // 每轮都先把外部应用抢回前台，避免上一轮残留
    const oh = hwndOfProcess(outside)
    forceTo(oh)
    await sleep(450)
    const before = foregroundHwnd()
    log(`  第 ${round} 轮起点前台 hwnd=${before}（期望 ≠0 且不是启动器）`)

    launcher.hide()
    await sleep(120)
    await launcher.show()
    await sleep(500)

    const win = launcher.getWindow()
    const mine = win ? Number(win.getNativeWindowHandle().readBigUInt64LE(0)) : 0
    const after = foregroundHwnd()
    const ok = after === mine && mine !== 0
    if (ok) won++
    log(`    show() 之后前台 hwnd=${after}  我的=${mine}  ${ok ? '✅' : '❌'}  win.isFocused=${win?.isFocused()}`)
    if (win) {
      const dom = await win.webContents.executeJavaScript('document.hasFocus()')
      const tag = await win.webContents.executeJavaScript('document.activeElement?.tagName ?? "?"')
      log(`    document.hasFocus()=${dom}  activeElement=${tag}`)
      if (ok) check(`第 ${round} 轮：OS 前台 + DOM 输入框焦点`, dom === true && tag === 'INPUT', `dom=${dom} tag=${tag}`)
    }
    launcher.hide()
    await sleep(150)
  }

  check('外部应用持前台时能稳定抢到前台', won === 3, `${won} / 3 轮`)

  launcher.dispose()
  // 收尾：清掉可能残留的窗口
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.destroy()
    } catch {
      /* 已销毁 */
    }
  }

  log('\n' + '─'.repeat(78))
  log(failures === 0 ? '全部通过' : `${failures} 项失败`)
  app.exit(failures === 0 ? 0 : 1)
})
