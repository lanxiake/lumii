#!/usr/bin/env node
/**
 * check-pet-passthrough.mjs — 宠物窗口"该穿透时真穿透"（点得到后面的程序）
 *
 * ## 守的是哪条回归
 *
 * 用户 2026-09-22 报：「打开宠物模式有时候有一个 BUG，全屏都被覆盖了，无法点击到非宠物
 * 后方的程序」。宠物窗口是全屏 + 置顶的，`setIgnoreMouseEvents(false)` 一旦卡住，
 * 整个桌面就点不动——只有重启应用能救。
 *
 * ## 卡住的机制（本脚本前半段就是把它复现出来）
 *
 * `PetCanvas.onMouseMove` 在 `dragRef.pressed` 为真时**无条件**上报 `live2d-model`
 * hover，而 `pressed` 只在 `mouseup` 里复位。**mouseup 是会丢的**：指针在窗口外松手
 * （拖到任务栏、另一块屏、切窗口）时渲染进程收不到那一下，于是此后每次 mousemove
 * 都把整个全屏窗口重新点开。
 *
 * 修法有两处（见 PetCanvas 的 `abandonDrag` / `onWindowLeave`）：
 *   · `e.buttons === 0` 而 `pressed` 仍为真 ⇒ mouseup 丢了，立刻复位
 *   · 指针离开**窗口**（挂在 document 上，canvas 是 pointer-events:none 收不到）
 *
 * ## 判据：直接问主进程，不读日志
 *
 * 这段逻辑的可见产物只有一句 `setIgnoreMouseEvents(...)`，而那个状态**没有 getter**。
 * 三条路都试过：
 *   · CDP 的 `Input.dispatchMouseEvent` 绕过窗口属性（走渲染进程内部命中测试），
 *     "点得到后面的窗口吗"它答不了；
 *   · 真实鼠标（`SetCursorPos` + `mouse_event`）在这台机器上点主窗口标题栏按钮没反应
 *     （同一套代码点宠物本体却能触发 `[onMouseDown]`），不适合当判据；
 *   · 日志里有状态翻转的行，但日志经 `pnpm → node → tee` 是**块缓冲**落盘——
 *     应用安静时要攒够 4KB 才写一次，实测压过几十秒，断言会误判成"没恢复"。
 *
 * 所以补了一个只读 getter（`PET_IPC.getMouseIgnoreState`，主进程侧就一行），
 * 由本脚本直接问。日志那行留着——那是给下次排查用的。
 *
 * 用法（需客户端带调试端口启动：pnpm dev:debug，且已进入宠物模式）
 *   node check-pet-passthrough.mjs
 */
import sharp from 'sharp'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const petT = targets.find((x) => x.type === 'page' && x.url.includes('mode=pet'))
if (!petT) throw new Error('找不到宠物窗口（先打开宠物模式）')
const ws = new WebSocket(petT.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('ws'))
})
let id = 0
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const my = ++id
    const on = (e) => {
      const x = JSON.parse(e.data)
      if (x.id !== my) return
      ws.removeEventListener('message', on)
      x.error ? reject(new Error(JSON.stringify(x.error))) : resolve(x.result)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id: my, method, params }))
  })
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200))
  return r.result.value
}

/**
 * 直接问主进程"此刻窗口是不是在吃整个屏幕的点击"。
 *
 * **不读日志**：那个状态没有 getter，第一版只好去日志里数行数，而日志经
 * `pnpm → node → tee` 落盘是**块缓冲**——几行要攒够一个 4KB 块才落盘，
 * 应用安静时能压几十秒。实测踩过两次：状态确实翻转了，断言却判成"没恢复"。
 * 所以补了一个只读 getter（`PET_IPC.getMouseIgnoreState`）。
 */
async function readMouseState() {
  const raw = await ev(
    'window.electronAPI.pet.getMouseIgnoreState().then(s => JSON.stringify(s))',
  )
  return JSON.parse(raw)
}

// 先让状态回到"穿透"这个已知基线：把指针挪到空白处并声明左键已松
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1300, y: 400, buttons: 0 })
await sleep(600)

/**
 * 测量期间关掉自主走动。
 *
 * **不关就没法测**：宠物会自己走开（还会爬到墙上），截图量到的位置下一秒就失效，
 * 于是"按在宠物身上"这一步时灵时不灵——实测两次跑出完全相反的结果，
 * 都是它自己走开导致的。特效/穿透这两件事都不受这个开关影响。
 */
const settings = JSON.parse(
  await ev('window.electronAPI.pet.getVirtualHumanSettings().then(s => JSON.stringify(s))'),
)
await ev('window.electronAPI.pet.setVirtualHumanSettings({ enableIdleMotion: false })')
await sleep(800)

// 定位宠物（不透明像素的包围盒；排掉左上角的 dev 指标浮层）
const shot = await send('Page.captureScreenshot', { format: 'png' })
const { data, info } = await sharp(Buffer.from(shot.data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
let top = 1e9, bottom = -1, left = 1e9, right = -1
for (let y = 120; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] > 16) {
      if (y < top) top = y
      if (y > bottom) bottom = y
      if (x < left) left = x
      if (x > right) right = x
    }
  }
}
if (bottom < 0) throw new Error('宠物没渲染出来（量不到轮廓）')
const petX = Math.round((left + right) / 2)
const petY = Math.round((top + bottom) / 2)
console.log(`宠物在 @(${petX},${petY})（轮廓 ${right - left + 1}×${bottom - top + 1}）`)

// ---- 复现：按下宠物但**不给 mouseup**（等价于在窗口外松手）----
console.log('基线穿透状态:', JSON.stringify(await readMouseState()))
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: petX, y: petY, buttons: 0 })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: petX, y: petY, button: 'left', buttons: 1, clickCount: 1 })
await sleep(400)
// 拖到远处：这一帧仍然"按着"（buttons=1），窗口会被点开——这就是缺陷的现场
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: petX + 400, y: petY - 300, buttons: 1 })
await sleep(500)
// 挪到空白处（仍在"按住"态）：窗口此刻是**可点**的，整个屏幕的点击都被吃掉
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1300, y: 400, buttons: 1 })
await sleep(500)
const during = await readMouseState()
record(
  '复现：按住不放时窗口"吃掉整个屏幕"（用户报的现象）',
  during.clickable === true,
  `clickable=${during.clickable} 来自 ${during.components.join('+') || '(无)'}`,
)

// ---- 修复：OS 说左键已经松了（buttons=0）——渲染进程该自己发现 mouseup 丢了 ----
//
// **终点必须落在空白处**：拖拽时宠物是跟着指针走的，所以松手那一刻宠物就在指针底下，
// 此时 hover=true 是**正确**的（窗口该可点，好让你再抓它）。
// 要验的是"mouseup 丢了之后不会一直卡在可点"，所以把指针挪到宠物上方很远的地方再问。
const emptyY = Math.max(80, top - 500)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: petX, y: emptyY, buttons: 0 })
await sleep(500)
const after = await readMouseState()
record(
  '修复：左键已松开而没收到 mouseup 时，窗口自动恢复穿透',
  after.clickable === false,
  `clickable=${after.clickable} 来自 ${after.components.join('+') || '(无)'}（空白点 ${petX},${emptyY}）`,
)

await ev(
  `window.electronAPI.pet.setVirtualHumanSettings({ enableIdleMotion: ${settings.enableIdleMotion === true} })`,
)

ws.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
