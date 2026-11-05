/**
 * 探针：逐个窗口源试 getUserMedia，看是「所有窗口都不行」还是个别窗口不行。
 *
 * 用法：node electron.exe verify/screen-record/probe-windows.cjs [名字子串...]
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, desktopCapturer } = require('electron')

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-win-probe-')))

async function main() {
  const needles = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
  })
  const picked = needles.length
    ? sources.filter((s) => needles.some((n) => s.name.includes(n)))
    : sources

  const html = path.join(app.getPath('userData'), 'index.html')
  fs.writeFileSync(html, '<html><body>probe</body></html>')
  const win = new BrowserWindow({ show: true, webPreferences: { backgroundThrottling: false } })
  await win.loadFile(html)

  for (const s of picked) {
    const r = await win.webContents.executeJavaScript(`(async () => {
      try {
        const st = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: ${JSON.stringify(s.id)} } },
        })
        const t = st.getVideoTracks()[0]
        const out = { ok: true, settings: t.getSettings(), state: t.readyState }
        st.getTracks().forEach((x) => x.stop())
        return out
      } catch (e) {
        return { ok: false, name: e.name, message: e.message }
      }
    })()`)
    console.log(r.ok ? `OK    ${s.name}` : `FAIL  ${s.name}  <- ${r.name}: ${r.message}`)
  }
  app.quit()
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  app.quit()
})
