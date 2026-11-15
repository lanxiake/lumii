/**
 * 图标与焦点两个实机问题的探针。
 *
 * 用户报告（2026-11-15）：
 *   1. 快捷方式的图标不是它原本的图标
 *   2. 光标在别的输入框时，双击 Ctrl 后焦点没进到搜索框
 *
 * 两件事都**必须在 Electron 里实测**：图标走的是 Win32 shell API，焦点是 Windows
 * 前台锁定策略，在 plain Node 里都不成立。
 *
 * 用法：pnpm exec electron verify/listary-p3/probe-icons-focus.cjs
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const OUT = path.join(__dirname, 'probe.out')
const lines = []
fs.rmSync(OUT, { force: true })
function log(s) {
  lines.push(s)
  process.stdout.write(s + '\n')
  fs.writeFileSync(OUT, lines.join('\n') + '\n')
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// 本机真实快捷方式
const START_MENU = path.join(
  process.env.APPDATA ?? '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
)

function sampleLinks(n = 6) {
  const out = []
  try {
    for (const e of fs.readdirSync(START_MENU, { withFileTypes: true })) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.lnk')) {
        out.push(path.join(START_MENU, e.name))
        if (out.length >= n) break
      }
    }
  } catch {
    /* 没开始菜单也无所谓 */
  }
  return out
}

/** PNG 的宽高从 IHDR 读，避免依赖图像库 */
function pngSize(buf) {
  if (buf.length < 24) return null
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

app.whenReady().then(async () => {
  log(`Electron ${process.versions.electron} / ABI ${process.versions.modules}\n`)

  log('═'.repeat(64))
  log('[1] app.getFileIcon 对 .lnk 取到的是什么')
  log('═'.repeat(64))

  const links = sampleLinks()
  if (links.length === 0) {
    log('  本机没有开始菜单快捷方式，跳过')
  } else {
    log(`  取样 ${links.length} 个 .lnk\n`)
    for (const lnk of links) {
      const name = path.basename(lnk)
      try {
        const img = await app.getFileIcon(lnk, { size: 'small' })
        const buf = img.toPNG()
        const size = pngSize(buf)
        // 通用快捷方式图标的一个特征：极小（通常 <1KB，纯箭头的简单图形）
        // 真图标（chrome/cursor/apifox）都是几百字节到几 KB 的多色位图
        const isTiny = buf.length < 400
        log(
          `    ${name.padEnd(22)} ${String(buf.length).padStart(6)} B` +
            `  ${size ? `${size.w}×${size.h}` : '?'}` +
            `  ${isTiny ? '← 疑似通用空白图标' : ''}`,
        )
      } catch (e) {
        log(`    ${name.padEnd(22)} 取图标失败：${e.message}`)
      }
    }

    // 对比：取 exe 本身的图标（若有可解析的目标）
    try {
      const exe = 'C:\\Windows\\System32\\notepad.exe'
      const img = await app.getFileIcon(exe, { size: 'small' })
      const buf = img.toPNG()
      log(`\n    对照 notepad.exe         ${String(buf.length).padStart(6)} B`)
      check('exe 能取到非空图标', buf.length > 400, `${buf.length} B`)
    } catch (e) {
      check('exe 能取到非空图标', false, e.message)
    }
  }

  log('\n' + '═'.repeat(64))
  log('[2] 取 .lnk 的目标路径（图标应当从这里取）')
  log('═'.repeat(64))
  log('  Windows 上解析 .lnk 的零依赖办法：PowerShell WScript.Shell')
  const { execFileSync } = require('node:child_process')
  for (const lnk of links.slice(0, 3)) {
    try {
      const outPs = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}'); ` +
            `Write-Output $s.TargetPath`,
        ],
        { encoding: 'utf8', timeout: 15_000, windowsHide: true },
      ).trim()
      log(`    ${path.basename(lnk).padEnd(22)} → ${outPs || '(空)'}`)
      if (outPs && fs.existsSync(outPs)) {
        const img = await app.getFileIcon(outPs, { size: 'small' })
        const buf = img.toPNG()
        log(`      └ 目标图标 ${String(buf.length).padStart(6)} B`)
      }
    } catch (e) {
      log(`    ${path.basename(lnk)} 解析失败：${String(e.message).split('\n')[0]}`)
    }
  }

  log('\n' + '═'.repeat(64))
  log('[3] 焦点：show + focus 在"别的输入框有光标"时能不能抢到')
  log('═'.repeat(64))
  log('  这一步**需要人工观察**：脚本会开一个测试窗，然后打印它是否 isFocused()。')
  log('  测试窗自动关闭。\n')

  const win = new BrowserWindow({
    width: 400,
    height: 200,
    show: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  await win.loadURL(
    'data:text/html,' +
      encodeURIComponent(
        '<body style="background:#222;color:#eee;font:16px sans-serif;padding:20px">' +
          '<input id="x" autofocus style="width:100%;font-size:18px">' +
          '<script>document.getElementById("x").focus()</script></body>',
      ),
  )

  const report = []
  win.show()
  win.focus()
  await new Promise((r) => setTimeout(r, 300))
  report.push(['show()+focus()', win.isFocused()])

  if (!win.isFocused()) {
    // 兜底尝试 1：setAlwaysOnTop 的 screen-saver 层级
    win.setAlwaysOnTop(true, 'screen-saver')
    win.focus()
    await new Promise((r) => setTimeout(r, 300))
    report.push(['screen-saver 层级 + focus()', win.isFocused()])
  }
  if (!win.isFocused()) {
    // 兜底尝试 2：minimize → restore（已知能打破某些前台锁）
    win.minimize()
    await new Promise((r) => setTimeout(r, 120))
    win.restore()
    win.focus()
    await new Promise((r) => setTimeout(r, 300))
    report.push(['minimize→restore→focus()', win.isFocused()])
  }
  if (!win.isFocused()) {
    // 兜底尝试 3：app.focus({steal:true})
    try {
      app.focus({ steal: true })
      await new Promise((r) => setTimeout(r, 300))
      report.push(['app.focus({steal:true})', win.isFocused()])
    } catch (e) {
      report.push([`app.focus({steal:true}) 抛错: ${e.message}`, false])
    }
  }

  for (const [label, ok] of report) log(`    ${ok ? 'PASS' : 'FAIL'}  ${label} → isFocused=${ok}`)
  check('至少一种方式能抢到焦点', report.some(([, ok]) => ok), report.map(([l]) => l).join(' | '))

  // 渲染进程里输入框真的有焦点吗（比 isFocused 更接近"用户能直接打字"）
  try {
    const hasDomFocus = await win.webContents.executeJavaScript('document.hasFocus()')
    const activeIsInput = await win.webContents.executeJavaScript(
      'document.activeElement && document.activeElement.tagName',
    )
    check('渲染层 document.hasFocus()', hasDomFocus === true, String(hasDomFocus))
    check('activeElement 是输入框', activeIsInput === 'INPUT', String(activeIsInput))
  } catch (e) {
    check('渲染层焦点检查', false, e.message)
  }

  win.destroy()

  const failed = results.filter((r) => !r.ok)
  log('\n' + '─'.repeat(64))
  log(failed.length === 0 ? `探针全部通过（${results.length} 项）` : `${failed.length} / ${results.length} 项失败`)
  for (const f of failed) log(`  - ${f.name}: ${f.detail ?? ''}`)
  app.exit(failed.length === 0 ? 0 : 1)
})
