#!/usr/bin/env node
/**
 * observe-pet-behavior.mjs — 让宠物自己跑一段，录下"它这段时间在做什么"
 *
 * ## 为什么要这个
 *
 * 用户 2026-09-22 报「宠物看起来还是在左右摆动」。已知两条横向来源，量级差两个数量级：
 *
 *   · **素材帧间的整体平移**：±5 素材px = **±1.2 屏幕px**（见 `measure-sheet-drift.mjs`、
 *     `measure-idle-sway.mjs`）——肉眼几乎看不出
 *   · **自主走动**：60 px/s × 3~10s = **180~600 屏幕px** 一段，每 20~35 秒掷一次签
 *
 * 用户抱怨的显然更像后者。但"走动"是**有开关的设计行为**（`enableIdleMotion`），
 * 不能靠猜就把它关掉或改频率。所以先把时间线录下来：这段时间里宠物到底走了几次、
 * 爬没爬墙、每次多久。
 *
 * ## 两条独立证据，互相兜底
 *
 * 1. **控制台**：`PetWanderDriver` 在每次活动切换、吸附、落地时都打日志
 *    （`[PetWander] [tick] stand → walk` / `[perch] 吸附到屏幕右墙` / `[fall] 落地`）。
 *     走 CDP 的 `Runtime.consoleAPICalled` **直接在渲染进程里收**——不经过
 *     `pnpm → node → tee` 那条块缓冲的管道，所以是实时的（日志文件那边会压几十秒）。
 * 2. **截图**：每 1 秒一张**降采样**截图（`clip.scale=0.25`，像素量 1/16），量不透明包围盒。
 *     控制台能告诉你"它决定走"，截图能告诉你"它真走了多远"——两者都要，
 *     因为驱动报的活动与实际画面不一致时，问题就在两者之间。
 *
 * 用法（客户端带调试端口启动：pnpm dev:debug，且已进入宠物模式）
 *   node observe-pet-behavior.mjs [秒数]
 */
import sharp from 'sharp'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const SECONDS = Number(process.argv[2] ?? 90)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pet = list.find((x) => x.type === 'page' && x.url.includes('mode=pet'))
if (!pet) throw new Error('找不到宠物窗口（先打开宠物模式）')

const ws = new WebSocket(pet.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('ws'))
})
let id = 0
const pending = new Map()
const consoleLines = []
/**
 * **监听器必须容错**，否则整个脚本会以"顶层 await 永不 settle"的形态挂死。
 *
 * 踩过：直接 `JSON.parse(e.data)`，遇到二进制帧会**抛在事件监听器里**——
 * 那是个没有 catch 的地方，异常被吞掉，而对应的 Promise 永远等不到 resolve
 * （Node 只留下一句 `Detected unsettled top-level await`，看不出是谁）。
 * 而 `Page.captureScreenshot` 的响应有 ~2MB base64，正是最容易走二进制帧的那种。
 */
ws.addEventListener('message', async (e) => {
  let raw = e.data
  try {
    if (typeof raw !== 'string') {
      // Node 的 WebSocket 默认把二进制帧给成 Blob；ArrayBuffer 也要能兜住
      raw = typeof raw?.text === 'function' ? await raw.text() : Buffer.from(raw).toString('utf8')
    }
    const msg = JSON.parse(raw)
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? [])
        .map((a) => (a.value !== undefined ? a.value : (a.description ?? '')))
        .join(' ')
      consoleLines.push({ t: Date.now(), text })
      return
    }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
  } catch (err) {
    console.warn('[cdp] 消息解析失败（已忽略）:', String(err).slice(0, 120))
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const my = ++id
    pending.set(my, { resolve, reject })
    ws.send(JSON.stringify({ id: my, method, params }))
  })

await send('Runtime.enable')
const t0 = Date.now()

/**
 * 降采样截图里量宠物位置。
 *
 * `clip.scale` 在 CDP 里是**缩放**而不是"裁剪后缩放"——`width/height` 仍是未缩放前的
 * 尺寸，输出图是 `width*scale`。所以这里按 1/4 采样，图是 640×350，
 * 量到的坐标要 **÷0.25 换回屏幕坐标**。像素量降到 1/16，采样才跑得动。
 */
const SCALE = 0.25
async function petBox() {
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 2560, height: 1400, scale: SCALE },
  })
  const { data, info } = await sharp(Buffer.from(shot.data, 'base64'))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let top = 1e9, bottom = -1, left = 1e9, right = -1, n = 0
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      // 排掉左上角的 dev 指标浮层（原图 8..85 → 缩放后 2..21）
      if (x < 24 && y < 24) continue
      if (data[(y * info.width + x) * info.channels + 3] > 16) {
        if (y < top) top = y
        if (y > bottom) bottom = y
        if (x < left) left = x
        if (x > right) right = x
        n++
      }
    }
  }
  if (bottom < 0) return null
  const inv = 1 / SCALE
  return {
    left: Math.round(left * inv),
    right: Math.round(right * inv),
    top: Math.round(top * inv),
    bottom: Math.round(bottom * inv),
    cx: Math.round(((left + right) / 2) * inv),
    w: Math.round((right - left + 1) * inv),
    h: Math.round((bottom - top + 1) * inv),
    n,
  }
}

console.log(`观察 ${SECONDS}s（每秒一张降采样截图 + 实时控制台）…\n`)
const track = []
for (let i = 0; i < SECONDS; i++) {
  const b = await petBox()
  if (b) track.push({ sec: i, ...b })
  await sleep(1000 - Math.min(900, 0))
}

const INTERESTING = /PetWander|\[perch\]|\[fall\]|SpritePetRenderer|\[setFlip\]|tick\]/
console.log('=== 行为时间线（控制台，秒为相对起点）===')
for (const l of consoleLines) {
  if (!INTERESTING.test(l.text)) continue
  console.log(`  +${((l.t - t0) / 1000).toFixed(1)}s  ${l.text}`)
}

console.log('\n=== 位置轨迹（每秒，屏幕坐标）===')
console.log('  秒   中心X   左   右   顶   底   宽   高')
for (const s of track) {
  console.log(
    `  ${String(s.sec).padStart(2)}  ${String(s.cx).padStart(6)}${String(s.left).padStart(6)}${String(s.right).padStart(6)}${String(s.top).padStart(6)}${String(s.bottom).padStart(6)}${String(s.w).padStart(6)}${String(s.h).padStart(6)}`,
  )
}

if (track.length > 1) {
  const cxs = track.map((s) => s.cx)
  const cxSpan = Math.max(...cxs) - Math.min(...cxs)
  // 逐步位移：走动是连续同向的多步，抖动是来回的小步
  const steps = []
  for (let i = 1; i < track.length; i++) steps.push(track[i].cx - track[i - 1].cx)
  const moving = steps.filter((d) => Math.abs(d) > 8)
  const dir = moving.filter((d) => d > 0).length
  console.log(
    `\n中心X 极差 ${cxSpan}px；逐秒位移 >8px 的有 ${moving.length} 步` +
      `（向右 ${dir} / 向左 ${moving.length - dir}）`,
  )
  const perchCount = consoleLines.filter((l) => /\[perch\] 吸附/.test(l.text)).length
  const walkCount = consoleLines.filter((l) => /→ walk/.test(l.text)).length
  console.log(`观察窗口内：进入 walk ${walkCount} 次，吸附攀爬 ${perchCount} 次`)
}
ws.close()
