#!/usr/bin/env node
/**
 * check-idle-stillness.mjs — 待机时宠物**真的**不动吗（量屏幕像素，不是量清单）
 *
 * `measure-idle-motion.mjs` 量的是素材（清单里几帧、有没有 bob），回答的是
 * 「素材允许它动多少」。这个脚本量的是**跑起来的宠物**：一连串截图里，宠物
 * 轮廓的顶边/左缘/高度有没有变。两者都要——素材干净不代表链路上没有别的东西在推它
 * （驱动、编排器、程序化原语的调用方式都可能）。
 *
 * ## 怎么量
 *
 * 宠物窗口是全屏透明的，`Page.captureScreenshot` **保留 alpha**（实测：357 万像素
 * alpha=0，4300 个不透明像素——就是那只猫）。于是「不透明像素的包围盒」就是宠物轮廓，
 * 顶边一变就是它在上下动。
 *
 * ## 两个必须做的预处理
 *
 * 1. **关掉自主走动**（VH 设置 `enableIdleMotion`）。开着的话宠物会走开，左缘一直变，
 *    而行走帧本身也会动——那就分不清"待机在飘"还是"它在走路"。测完**恢复原值**。
 * 2. **重进宠物模式**。清单是进模式时读的，改了磁盘上的 manifest 而进程还开着，
 *    量到的仍是旧的那份（第一次跑就踩了这个：数字和没改一样）。
 *
 * 用法（需客户端带调试端口启动：pnpm dev:debug）
 *   node check-idle-stillness.mjs [采样次数] [间隔ms]
 */
const PORT = Number(process.env.CDP_PORT ?? 9222)
const SAMPLES = Number(process.argv[2] ?? 20)
const INTERVAL = Number(process.argv[3] ?? 250)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(
    (x) => x.type === 'page' && x.url.startsWith('http://127.0.0.1:5174'),
  )
}

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('WebSocket 连接失败'))
  })
  let id = 0
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id !== myId) return
        ws.removeEventListener('message', onMsg)
        msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result)
      }
      ws.addEventListener('message', onMsg)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }
  return { send, ev, close: () => ws.close() }
}

/**
 * 不透明像素的包围盒（宠物轮廓）。
 *
 * **必须排除 y<120 的顶带**：dev 模式下宠物窗口左上角常驻一块
 * `PetDebugOverlay`（`rgba(0,0,0,0.55)` 的圆角小卡片，显示 switch/load/lip/fps，
 * 约 77×83 @(8,8)）——它是不透明的，算进去会让包围盒横跨整个屏幕。
 * 实测踩过：不排除时量出"轮廓 2552×1384"，看着像宠物铺满了屏幕。
 */
function boundsOfAlpha(pngBuffer) {
  return import('sharp').then(async ({ default: sharp }) => {
    const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let top = 1e9, bottom = -1, left = 1e9, right = -1, n = 0
    for (let y = 120; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * info.channels + 3] > 16) {
          if (y < top) top = y
          if (y > bottom) bottom = y
          if (x < left) left = x
          if (x > right) right = x
          n++
        }
      }
    }
    return n ? { top, bottom, left, right, h: bottom - top + 1, w: right - left + 1, n } : null
  })
}

const main = (await targets()).find((t) => !t.url.includes('mode=pet'))
const pet = (await targets()).find((t) => t.url.includes('mode=pet'))
if (!main) throw new Error('找不到主窗口（要先 pnpm dev:debug 起来）')
if (!pet) throw new Error('找不到宠物窗口（要先打开宠物模式）')

const mc = await connect(main)
const pc = await connect(pet)

// 1. 关掉自主走动（记下原值，结束恢复）
const before = await mc.ev('window.electronAPI.pet.getVirtualHumanSettings()')
const prevIdleMotion = before?.enableIdleMotion
console.log(`原 enableIdleMotion=${prevIdleMotion}，测量期间关掉（否则它走开，左缘一直变）`)
await mc.ev('window.electronAPI.pet.setVirtualHumanSettings({ enableIdleMotion: false })')
await sleep(400)

// 2. 重载宠物窗口：清单是**加载模型那一刻**读的，进程还开着就一直是内存里那份。
//    ⚠️ 这里不能用「退出再进宠物模式」代替（第一版就是这么写的，白跑一轮）——
//    进出只是 show/hide 窗口，`PetCanvas` 的加载 effect 依赖的是 config/renderer，
//    两者都没变，于是根本不重新读清单（日志里 `开始加载模型` 只有一次）。
console.log('重载宠物窗口以重新读取清单…')
await pc.send('Page.reload', { ignoreCache: true })
await sleep(4000)

const pet2 = (await targets()).find((t) => t.url.includes('mode=pet'))
const pc2 = pet2 === pet ? pc : await connect(pet2)
await sleep(1000)

const samples = []
for (let i = 0; i < SAMPLES; i++) {
  const shot = await pc2.send('Page.captureScreenshot', { format: 'png' })
  const b = await boundsOfAlpha(Buffer.from(shot.data, 'base64'))
  if (b) samples.push(b)
  await sleep(INTERVAL)
}

// 3. 恢复原设置
await mc.ev(`window.electronAPI.pet.setVirtualHumanSettings({ enableIdleMotion: ${prevIdleMotion === true} })`)
console.log(`已恢复 enableIdleMotion=${prevIdleMotion}`)

if (samples.length < 2) {
  console.log('❌ 有效样本不足（宠物没渲染出来？）')
  process.exit(1)
}

const span = (key) => Math.max(...samples.map((s) => s[key])) - Math.min(...samples.map((s) => s[key]))
console.log(`\n采样 ${samples.length} 次（每 ${INTERVAL}ms 一次，覆盖 ${((samples.length * INTERVAL) / 1000).toFixed(1)} 秒）`)
console.log(`  顶边跨度 ${span('top')}px   底边跨度 ${span('bottom')}px   高度跨度 ${span('h')}px   左缘跨度 ${span('left')}px`)
console.log(`  轮廓尺寸样本：${samples[0].w}×${samples[0].h}`)

const topSpan = span('top')
const heightSpan = span('h')
const pass = topSpan <= 4 && heightSpan <= 4
console.log(
  pass
    ? `✅ 轮廓稳定（顶边 ${topSpan}px、高度 ${heightSpan}px 的变化，来自 breathe 的 2% 缩放）`
    : `❌ 还在动：顶边 ${topSpan}px、高度 ${heightSpan}px`,
)

pc2.close?.()
if (pc2 !== pc) pc.close()
mc.close()
process.exit(pass ? 0 : 1)
