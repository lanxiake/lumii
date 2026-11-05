/**
 * 探针：窗口捕获为什么一律 NotReadableError。
 *
 * 已确认的事实（2026-11-05 本机）：
 *   - desktopCapturer.getSources(thumbnailSize 320x180) 能拿到每个窗口的缩略图
 *   - getUserMedia({chromeMediaSource:'desktop', sourceId: window:*}) 一律 NotReadableError
 *   - 同一台机器、同一进程里 screen:0:0 成功，能录 6 秒拿到 2 个分片
 * 所以不是「窗口不可读」，是「窗口的实时视频轨起不来」。
 *
 * 这里再摸三件事：GPU 特性状态、getDisplayMedia 路径、以及 Electron 显示的 source 结构。
 *
 * 用法：node electron.exe verify/screen-record/probe-wgc.cjs [名字子串]
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, desktopCapturer, session } = require('electron')

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-wgc-probe-')))

app.whenReady().then(async () => {
  const needle = process.argv[2] || 'LiteShell'
  console.log('=== GPU 特性 ===')
  try {
    console.log(JSON.stringify(app.getGPUFeatureStatus(), null, 2))
  } catch (e) {
    console.log('  读取失败:', e.message)
  }

  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
  const target = sources.find((s) => s.name.includes(needle))
  if (!target) {
    console.log(`找不到 "${needle}"`)
    app.quit()
    return
  }
  console.log(`\n目标源: ${target.id} | ${target.name} | display_id=${target.display_id}`)

  const html = path.join(app.getPath('userData'), 'index.html')
  fs.writeFileSync(html, '<html><body>probe</body></html>')
  const win = new BrowserWindow({ show: true, webPreferences: { backgroundThrottling: false } })
  await win.loadFile(html)

  // 路径二：getDisplayMedia + setDisplayMediaRequestHandler（Electron 现代推荐）
  session.defaultSession.setDisplayMediaRequestHandler(
    (_req, callback) => callback({ video: target }),
    { useSystemPicker: false },
  )
  const viaDisplayMedia = await win.webContents.executeJavaScript(`(async () => {
    try {
      const st = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const t = st.getVideoTracks()[0]
      const out = { ok: true, settings: t.getSettings() }
      st.getTracks().forEach((x) => x.stop())
      return out
    } catch (e) {
      return { ok: false, name: e.name, message: e.message }
    }
  })()`)
  console.log('\n=== getDisplayMedia（setDisplayMediaRequestHandler 直给窗口源）===')
  console.log('  ' + JSON.stringify(viaDisplayMedia))

  app.quit()
})
