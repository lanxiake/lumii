#!/usr/bin/env node
/**
 * measure-idle-sway.mjs — 待机时宠物**左右**在动吗，动的是哪一类
 *
 * 起因：上下浮动修掉之后，用户 2026-09-22 仍报「宠物看起来还是在左右摆动」。
 * 清单里 Idle 组只有 `breathe: 1.01` + `blink`，**没有任何 sway**——程序化那一层是干净的。
 * 那就得量屏幕，并且把"左右动"拆成两种**形状完全不同**的东西：
 *
 *   · **整体平移**：左缘与右缘同向、同幅地移动（角色在往右走）
 *   · **对称张缩**：左缘与右缘反向移动（呼吸/帧内的挤压拉伸，锚点在脚底中心）
 *   · **重心游移**：包围盒不动而质量分布变（尾巴/耳朵等部件在动）
 *
 * 光看"左缘跨度"分不出这三者，而它们的修法完全不同（对齐素材 / 删掉 breathe / 什么都不做）。
 * 所以本脚本同时报左缘、右缘、宽度、不透明重心，并打出时序。
 *
 * ## 采样窗口要盖住整圈动画，且要够长到能筛掉粒子
 *
 * 待机是 8 帧 × 125ms = **1 秒一圈**（清单里还写着 `fps: 4`，但逐帧时长才是引擎用的那个，
 * 8×125ms=1s ≠ 4fps 的 2s——**别照 fps 字段推算**）。
 * 采样间隔 120ms × 60 次 = 7.2 秒，盖住 7 圈多。
 * 间隔太大（250ms）会与 125ms 的帧长**拍频**，可能每次都在同一相位上，把动的东西量成静止。
 *
 * 采样次数还要够多：下面的"无粒子"过滤会丢掉一部分样本，跑 60 次大概能剩 45+。
 *
 * 用法（客户端带调试端口启动：pnpm dev:debug，且已进入宠物模式）
 *   node measure-idle-sway.mjs [采样次数] [间隔ms]
 */
import sharp from 'sharp'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const SAMPLES = Number(process.argv[2] ?? 60)
const INTERVAL = Number(process.argv[3] ?? 120)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = async () =>
  (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((x) => x.type === 'page')

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
 * 不透明像素的包围盒 + 水平重心 + 逐列质量（排除 dev 指标浮层）。
 *
 * 重心是**关键指标**：包围盒中心不变而重心在游移，说明动的是角色身上的部件
 * （尾巴/耳朵），不是整体在平移——这两种在"左缘跨度"上是同一个数。
 */
async function profileOf(pngBuffer) {
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let top = 1e9, bottom = -1, left = 1e9, right = -1, n = 0, sumX = 0
  for (let y = 120; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] > 16) {
        if (y < top) top = y
        if (y > bottom) bottom = y
        if (x < left) left = x
        if (x > right) right = x
        sumX += x
        n++
      }
    }
  }
  return n ? { top, bottom, left, right, w: right - left + 1, h: bottom - top + 1, n, cx: sumX / n } : null
}

const all = await targets()
// 只认应用自己的页面：CDP 的目标列表里还有 devtools 页，它没有 electronAPI，
// 连上去评估表达式只会得到 "Uncaught"（实测踩过）
const appPages = all.filter((t) => t.url.startsWith('http://127.0.0.1:5174'))
const main = appPages.find((t) => !t.url.includes('mode=pet'))
const pet = appPages.find((t) => t.url.includes('mode=pet'))
if (!pet) throw new Error('找不到宠物窗口（先打开宠物模式）')
const pc = await connect(pet)
const mc = main ? await connect(main) : null

// 关掉自主走动：开着的话它真的会走开（那是"走动"不是"摆动"，会把两种运动混在一个读数里）
const prev = mc ? await mc.ev('window.electronAPI.pet.getVirtualHumanSettings()') : null
if (mc) {
  await mc.ev('window.electronAPI.pet.setVirtualHumanSettings({ enableIdleMotion: false })')
  console.log(`自主走动已关（原值 ${prev?.enableIdleMotion}），测完恢复`)
  await sleep(600)
}

/**
 * **必须重载宠物窗口**，不能只是关掉开关。
 *
 * 关开关只让 PetWanderDriver 不再推进；宠物**停在它此刻所在的地方**。
 * 实测第一次跑没重载，量到的是"34×89 且右缘卡在屏幕最后一列"——宠物那时正
 * 贴在屏幕右墙上爬（perch 到屏幕边是设计行为），量到的是被屏幕裁掉一半的攀爬姿态，
 * 跟"待机摆动"根本不是一回事。重载后驱动 `start()` 会把 y 拉回地面线、
 * 首个活动固定是 stand（见 `ambient.initialPlan`），才是干净的待机样本。
 */
console.log('重载宠物窗口，让它回到地面站定…')
await pc.send('Page.reload', { ignoreCache: true })
await sleep(4000)
const pet2 = (await targets()).find((t) => t.url.includes('mode=pet'))
const pc2 = pet2?.webSocketDebuggerUrl === pet.webSocketDebuggerUrl ? pc : await connect(pet2)
await sleep(1200)

const samples = []
for (let i = 0; i < SAMPLES; i++) {
  const shot = await pc2.send('Page.captureScreenshot', { format: 'png' })
  const p = await profileOf(Buffer.from(shot.data, 'base64'))
  if (p) samples.push(p)
  await sleep(INTERVAL)
}

if (mc) {
  await mc.ev(`window.electronAPI.pet.setVirtualHumanSettings({ enableIdleMotion: ${prev?.enableIdleMotion === true} })`)
  console.log(`已恢复 enableIdleMotion=${prev?.enableIdleMotion}`)
}
if (samples.length < 4) {
  console.log(`❌ 有效样本 ${samples.length} 个，太少`)
  process.exit(1)
}

/**
 * **只保留"没有粒子"的样本**。
 *
 * 待机的星星/爱心粒子（随机 8~20 秒一次）从头顶升起，它们**也是不透明像素**：
 * 既把高度/顶边读数顶高，也把**重心**往粒子那一侧拉。实测污染量级：
 * 高度跨度会从 ~2px 跳到 58px，重心跨度多出约 1px——而"重心跨度"恰恰是本脚本
 * 唯一想量的东西，被粒子垫高会让"改好了"看起来像"没改好"。
 *
 * 判据取**高度中位数 + 3px**：粒子一定让轮廓变高（它飘在头顶之上），
 * 而角色自身的帧间高度差在本例里只有 2px（356~365 素材px × 0.2437 ≈ 2px）。
 */
const heights = samples.map((s) => s.h).sort((a, b) => a - b)
const medianH = heights[Math.floor(heights.length / 2)]
const clean = samples.filter((s) => s.h <= medianH + 3)
const dropped = samples.length - clean.length
console.log(
  `\n采样 ${samples.length} 次，其中 ${clean.length} 次无粒子（高度中位 ${medianH}px；` +
    `丢掉 ${dropped} 次被待机粒子污染的）`,
)
{
  const span = (k) => Math.max(...clean.map((s) => s[k])) - Math.min(...clean.map((s) => s[k]))
  const nz = (v) => v.toFixed(1)
  const L = span('left'), R = span('right'), W = span('w'), H = span('h'), CX = span('cx')
  console.log(`【只看无粒子样本】轮廓 ${clean[0].w}×${clean[0].h}`)
  console.log(`  左缘跨度 ${L}px   右缘跨度 ${R}px   宽度跨度 ${W}px   高度跨度 ${H}px`)
  console.log(`  重心跨度 ${nz(CX)}px`)
  const ls = clean.map((s) => s.left)
  const rs = clean.map((s) => s.right)
  console.log(`  左缘序列: ${ls.join(' ')}`)
  console.log(`  右缘序列: ${rs.join(' ')}`)

  // 平移 vs 张缩：左右缘的相关系数。同向 ⇒ +1（整体平移），反向 ⇒ −1（对称张缩）
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
  const ml = mean(ls), mr = mean(rs)
  let cov = 0, vl = 0, vr = 0
  for (let i = 0; i < ls.length; i++) {
    const dl = ls[i] - ml, dr = rs[i] - mr
    cov += dl * dr
    vl += dl * dl
    vr += dr * dr
  }
  const corr = vl > 0 && vr > 0 ? cov / Math.sqrt(vl * vr) : 0
  console.log(`  左右缘相关系数 ${corr.toFixed(2)}（+1=整体平移，−1=对称张缩，0=无关）`)

  const verdict = []
  if (CX <= 0.5) verdict.push('重心不游移')
  if (corr < -0.5 && W > 4) verdict.push(`对称张缩 ${W}px（呼吸/素材帧挤压，不是平移）`)
  if (corr > 0.5 && Math.abs(L - R) <= 2 && L > 4) verdict.push(`⚠️ 整体平移 ${L}px`)
  console.log(`\n判定：${verdict.join('；') || '——'}`)
}

pc2.close?.()
if (pc2 !== pc) pc.close()
mc?.close()
