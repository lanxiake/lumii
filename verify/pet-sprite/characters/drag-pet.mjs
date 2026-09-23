/**
 * drag-pet.mjs — 拍一帧找到宠物、立刻从它身上拖到目标点
 *
 * 用来验证拖动那条路（夹取、贴边吸附、抛掷）。**三件事都是实测撞出来的**：
 *
 * 1. **拍摄与拖拽必须在同一个进程里连着做**：分两次调用（先 shot-probe 再 drag）
 *    中间要重启进程，而天花板爬行是 45px/s，两次之间它已经走开 90px，
 *    `isPointerOverModel` 判空 → 拖拽根本不开始。
 * 2. **速度必须落在「丢」与「抛」之间**：`isThrowable` 的线是 320px/s
 *    （见 pet-core 的 throw-physics）。快了变成「抛出去」（宠物被甩到地上，
 *    测不到吸附），慢了拖太久、暴露在杂散事件下的窗口变长。
 * 3. **真鼠标会打断合成拖拽**：指针 hover 到模型上时主进程会把穿透关掉，
 *    于是同一台机器上真鼠标的每一次移动都送进这个页面，带着 `buttons: 0`——
 *    而 `PetCanvas` 把它当「左键已松开」直接 `abandonDrag`。所以这里在**测试侧**
 *    挂一个捕获阶段的监听把不带按下的移动吃掉（**不动产品代码**）。
 *
 * 用法：
 *   node drag-pet.mjs <目标x> <目标y> [--speed 260]
 */
import sharp from 'sharp'


const target = { x: Number(process.argv[2]), y: Number(process.argv[3]) }
const PORT = 9222
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('mode=pet'))
if (!t) throw new Error('宠物窗口不在')

const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const my = ++id
    const on = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== my) return
      ws.removeEventListener('message', on)
      m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id: my, method, params }))
  })

// 垫底色（与 lumii-cdp.mjs 同一套，拍完撤掉）
const BG_ID = 'tmp-grab-bg'
await send('Runtime.evaluate', {
  expression: `(()=>{const s=document.createElement('style');s.id='${BG_ID}';s.textContent='html,body,#root,#root>div,#root>div>div{background:#f2f2f7 !important}';document.head.appendChild(s)})()`,
})
const shot = await send('Page.captureScreenshot', { format: 'png' })
await send('Runtime.evaluate', {
  expression: `(()=>{const s=document.getElementById('${BG_ID}');if(s)s.remove()})()`,
})
const { data, info } = await sharp(Buffer.from(shot.data, 'base64'))
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true })

// 最大连通域（4 邻域）：左上角那块 85×105 的常驻提示条会赢过宠物，所以要按"像不像宠物"筛
const W = info.width, H = info.height, C = info.channels
const ink = new Uint8Array(W * H)
for (let i = 0; i < W * H; i++) {
  const p = i * C
  if (Math.abs(data[p] - 242) + Math.abs(data[p + 1] - 242) + Math.abs(data[p + 2] - 247) > 24) ink[i] = 1
}
const seen = new Uint8Array(W * H)
const stack = new Int32Array(W * H)
let best = null
for (let i = 0; i < W * H; i++) {
  if (!ink[i] || seen[i]) continue
  let sp = 0
  stack[sp++] = i
  seen[i] = 1
  let n = 0, x0 = W, x1 = -1, y0 = H, y1 = -1
  while (sp) {
    const p = stack[--sp]
    const x = p % W, y = (p - x) / W
    n++
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
    if (x > 0 && ink[p - 1] && !seen[p - 1]) (seen[p - 1] = 1), (stack[sp++] = p - 1)
    if (x < W - 1 && ink[p + 1] && !seen[p + 1]) (seen[p + 1] = 1), (stack[sp++] = p + 1)
    if (y > 0 && ink[p - W] && !seen[p - W]) (seen[p - W] = 1), (stack[sp++] = p - W)
    if (y < H - 1 && ink[p + W] && !seen[p + W]) (seen[p + W] = 1), (stack[sp++] = p + W)
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1
  if (w < 25 || w > 600 || h < 40 || h > 700) continue
  // 贴左上角那块提示条：宽高比固定、位置固定，按"左上角 100px 内"排除
  if (x0 < 100 && y0 < 100) continue
  if (!best || n > best.n) best = { n, x0, x1, y0, y1 }
}
ws.close()
if (!best) throw new Error('没找到宠物')

const cx = Math.round((best.x0 + best.x1) / 2)
const cy = Math.round((best.y0 + best.y1) / 2)
// **抓在哪一侧很重要**：拖动是"跟着光标走"，抓得离锚点越远、能推的余量越小
// （见 PetCanvas 的 `clampDrag`）。验"贴边吸附"时要两侧都试。
const grabArg = process.argv.indexOf('--grab')
const [gdx, gdy] = grabArg > 0 ? process.argv[grabArg + 1].split(',').map(Number) : [0, 0]
const gx = Math.max(1, Math.min(2558, cx + (gdx || 0)))
const gy = Math.max(1, Math.min(1399, cy + (gdy || 0)))
console.log(
  `宠物 x[${best.x0},${best.x1}] y[${best.y0},${best.y1}] → 抓 (${gx},${gy})` +
    (gdx || gdy ? `（相对中心 ${gdx},${gdy}）` : '') +
    ` 拖到 (${target.x},${target.y})`,
)

// 派发拖拽。**自己发，不走 lumii-cdp 的 drag**：那个是"按下就连续走"，
// 而 `PetCanvas` 要按住 `GRAB_HOLD_MS`(100ms) 才跟手——先停 220ms 再动，
// 保证每一步都在抓取态里。
//
// 更要紧的是**整段要短**：真鼠标在屏幕上一动就产生 `buttons: 0` 的 mousemove，
// 而 `PetCanvas` 把它当"左键已松开"直接 `abandonDrag`。窗口越短越不容易被打断。
const s2 = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r) => (s2.onopen = r))
let id2 = 1000
const send2 = (method, params = {}) =>
  new Promise((res, rej) => {
    const my = ++id2
    const on = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== my) return
      s2.removeEventListener('message', on)
      m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)
    }
    s2.addEventListener('message', on)
    s2.send(JSON.stringify({ id: my, method, params }))
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// **只在测试侧**挡掉杂散事件：真鼠标一动就送进这个页面的 `buttons: 0` mousemove
// 会被 `PetCanvas` 当成"左键已松开"，把合成拖拽打断（改产品代码就为了跑测试不值得）。
// 捕获阶段挂到 window 上，比 PetCanvas 的监听先跑，`stopImmediatePropagation`
// 就够了；**不吃掉带按下的移动**，所以被测的那条路一点没变。
//
//   window.__stray = { on: false, blocked: 0 }
await send2('Runtime.evaluate', {
  expression: `(() => {
    if (window.__stray) return 'already'
    const st = window.__stray = { on: false, blocked: 0 }
    addEventListener('mousemove', (e) => {
      if (!st.on || e.buttons !== 0) return
      st.blocked++
      e.stopImmediatePropagation()
    }, true)
    return 'installed'
  })()`,
  returnByValue: true,
})
await send2('Runtime.evaluate', { expression: 'window.__stray.on = true' })

await send2('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gx, y: gy, buttons: 0 })
await send2('Input.dispatchMouseEvent', { type: 'mousePressed', x: gx, y: gy, button: 'left', buttons: 1, clickCount: 1 })
await sleep(220) // 过 GRAB_HOLD_MS
// ⚠ **速度要落在「丢」与「抛」之间**：`isThrowable` 的线是 320px/s
// （见 pet-core 的 throw-physics），快了变成「抛出去」（宠物被甩到地上，测不到
// 吸附），慢了拖太久。按距离算步数，恒速、每步固定节拍。
// 节拍不能太长：`estimateVelocity` 只看最近一小段窗口，窗口里只剩一个采样点时
// 会除出天文数字的速度（实测遇到过 -360769 px/s），宠物当场被判定为「抛出去」。
const speedArg = process.argv.indexOf('--speed')
const SPEED = speedArg > 0 ? Number(process.argv[speedArg + 1]) : 260
const STEP_MS = 60
const dist = Math.hypot(target.x - gx, target.y - gy)
const STEPS = Math.max(6, Math.round(dist / SPEED / (STEP_MS / 1000)))
console.log(`  距离 ${Math.round(dist)}px → ${STEPS} 步 × ${STEP_MS}ms ≈ ${(STEPS * STEP_MS / 1000).toFixed(1)}s（${SPEED}px/s）`)
for (let i = 1; i <= STEPS; i++) {
  const k = i / STEPS
  await send2('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(gx + (target.x - gx) * k),
    y: Math.round(gy + (target.y - gy) * k),
    button: 'left',
    buttons: 1,
  })
  await sleep(STEP_MS)
}
await sleep(120) // 停在目标点上几帧，让夹取/贴边判定看到最终位置
await send2('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 })
const stray = await send2('Runtime.evaluate', {
  expression: '(() => { const s = window.__stray.blocked; window.__stray.on = false; return s })()',
  returnByValue: true,
})
s2.close()
console.log(`拖拽已派发（测试侧挡掉杂散 mousemove ${stray.result.value} 条）`)
