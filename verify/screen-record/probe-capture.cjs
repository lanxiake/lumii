/**
 * 探针：本机窗口/整屏捕获链路到底断在哪一步。
 *
 * 背景（2026-11-05）：用户在面板里选 LiteShell 窗口点「开始录制」，录制立刻结束、
 * 不产出文件、界面没有任何提示。形如「`getUserMedia` 抛错 → 渲染层把 err.message
 * 当 reason 上报 → 主进程按 capture_failed 停录」。但上报路径不落日志，无法从日志确认。
 *
 * 这个探针把同一条链路（desktopCapturer → getUserMedia(mandatory) → 画布合成 →
 * MediaRecorder）在干净实例里逐段跑一遍，把每一步的真实结果打出来：
 *   - 哪个源拿得到、id 长什么样
 *   - 带系统声 / 纯视频 两种约束各自的成败与错误名
 *   - 视频轨是否在 N 秒内自己 ended
 *   - MediaRecorder 3 秒分片是否拿到数据
 *
 * 用法：node verify/screen-record/probe-capture.cjs [源名子串，默认 LiteShell]
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

/** electron.exe <script> [needle]：argv[0]=electron argv[1]=script，这里只认 .cjs 之后的 */
const NEEDLE = process.argv.slice(2).find((a) => !a.endsWith('.cjs') && !a.startsWith('-')) || 'LiteShell'

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-capture-probe-')))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const { desktopCapturer } = require('electron')
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 },
  })
  console.log(`\n=== 捕获源 ${sources.length} 个 ===`)
  for (const s of sources) {
    const mark = s.name.includes(NEEDLE) ? ' <== 目标' : ''
    console.log(`  ${s.id}  ${s.name}${mark}`)
  }
  const target = sources.find((s) => s.name.includes(NEEDLE))
  if (!target) {
    console.log(`\n!! 找不到名字含 "${NEEDLE}" 的源`)
    app.quit()
    return
  }
  const screen = sources.find((s) => s.id.startsWith('screen:'))

  // 页面必须是 file:（data: 的不透明源在 Chromium 里拿不到 navigator.mediaDevices）
  const html = path.join(app.getPath('userData'), 'index.html')
  fs.writeFileSync(html, '<html><body>probe</body></html>')

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  })
  await win.loadFile(html)

  /** 在一个源上跑完整链路，返回每一步的结果 */
  async function run(label, sourceId, withAudio) {
    const result = await win.webContents.executeJavaScript(`(async () => {
        const out = { steps: [] }
        const log = (k, v) => out.steps.push([k, v])
        try {
          log('mediaDevices', typeof navigator.mediaDevices?.getUserMedia)
          const constraints = {
            audio: ${withAudio}
              ? { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: ${JSON.stringify(sourceId)} } }
              : false,
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: ${JSON.stringify(sourceId)}, maxFrameRate: 30 } },
          }
          const stream = await navigator.mediaDevices.getUserMedia(constraints)
          log('gum', 'ok')
          const vt = stream.getVideoTracks()[0]
          const at = stream.getAudioTracks()
          log('videoTrack', vt ? vt.getSettings() : null)
          log('audioTracks', at.length)
          out.ended = false
          vt?.addEventListener('ended', () => { out.ended = true })

          // 画布合成（与生产同构）：定尺寸 + setInterval 绘帧 + captureStream
          const v = document.createElement('video')
          v.muted = true; v.autoplay = true; v.playsInline = true
          v.srcObject = new MediaStream([vt])
          document.body.appendChild(v)
          await new Promise((res) => {
            if (v.videoWidth) return res()
            v.onloadedmetadata = () => res()
            setTimeout(res, 1500)
          })
          log('videoElement', v.videoWidth + 'x' + v.videoHeight)
          try { await v.play() } catch (e) { log('play', 'rejected: ' + e.name) }

          const canvas = document.createElement('canvas')
          canvas.width = Math.max(2, Math.min(1920, v.videoWidth || 1280) & ~1)
          canvas.height = Math.max(2, Math.min(1080, v.videoHeight || 720) & ~1)
          const ctx = canvas.getContext('2d', { alpha: false })
          let drawn = 0
          const timer = setInterval(() => {
            if (v.videoWidth < 2) return
            const scale = Math.min(canvas.width / v.videoWidth, canvas.height / v.videoHeight)
            ctx.drawImage(v, 0, 0, v.videoWidth * scale, v.videoHeight * scale)
            drawn++
          }, 33)
          const comp = canvas.captureStream(30)
          log('composite', comp.getVideoTracks().length + ' track')

          const mime = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm']
            .find((m) => MediaRecorder.isTypeSupported(m))
          log('mime', mime)
          if (!mime) { clearInterval(timer); return out }

          // 只录合成后的视频轨（生产还会混音频，这里先看视频链）
          const mr = new MediaRecorder(new MediaStream([comp.getVideoTracks()[0]]), { mimeType: mime })
          let chunks = 0
          let bytes = 0
          mr.ondataavailable = (e) => { chunks++; bytes += e.data.size }
          mr.onerror = () => log('mrError', 'error event')
          mr.start(3000)
          // 在页面内等 6.2s 再一次性返回（不能把 Promise 塞进返回值：跨进程克隆会失败）
          await new Promise((r) => setTimeout(r, 6200))
          log('after6s', { chunks, bytes, drawn, ended: out.ended, mrState: mr.state })
          clearInterval(timer)
          try { mr.stop() } catch {}
          stream.getTracks().forEach((t) => t.stop())
          return out
        } catch (e) {
          log('error', { name: e.name, message: e.message })
          return out
        }
      })()`, true)
    console.log(`\n=== ${label} ===`)
    for (const [k, v] of result.steps || []) console.log(`  ${k}: ${JSON.stringify(v)}`)
    await sleep(300)
  }

  await run('窗口源 · 带系统声', target.id, true)
  await run('窗口源 · 纯视频', target.id, false)
  if (screen) await run('整屏 · 带系统声', screen.id, true)

  console.log('\n完成')
  app.quit()
}

app.whenReady().then(main).catch((e) => {
  console.error('探针失败:', e)
  app.quit()
})
