#!/usr/bin/env node
/**
 * check-context-menu.mjs — 验证「右键菜单打开期间窗口**不穿透**」
 *
 * ## 它守的是哪条回归
 *
 * 宠物窗口默认整窗穿透（`setIgnoreMouseEvents(true, { forward: true })`），主进程按
 * "有没有 UI 组件在交互"聚合决定何时恢复可点。菜单原先不在那份白名单里，于是指针
 * 从宠物身上移到菜单的一瞬间窗口就恢复穿透——菜单**看得见、点不动**
 * （forward 只转发 mousemove，不含 mousedown/click）。用户 2026-09-22 报的
 * 「更换宠物没展开」「打开对话没展开」都是这一条。修法是菜单挂载期间上报
 * `pet-context-menu`（见 `PetContextMenu.tsx`）。
 *
 * ## 为什么不能用 `dispatchEvent` / `b.click()`
 *
 * 那两条路**绕过窗口穿透**——它们能让菜单展开，但展开≠用户点得动。要复现问题必须让
 * **真实鼠标**去打菜单项。而真实鼠标要有坐标，宠物又是 canvas 画的、没有 DOM ref，
 * 所以先用 CDP 的 `Input` 域（走真实 hitTest，绕过穿透）沿地面线扫出宠物位置、把菜单
 * 打开，再用真实鼠标碰菜单项，看 hover 高亮有没有出现。
 *
 * **判据是 hover 背景色**：菜单项用 `onMouseEnter` 直接改 `style.background`，
 * 所以「背景从 transparent 变成 hover 色」等价于「这次真实 mousemove 到达了渲染进程」
 * 等价于「窗口没有穿透」。
 *
 * ## 用法（需客户端带调试端口启动：pnpm dev:debug）
 *
 *   node check-context-menu.mjs e2e         # 一条龙：扫描 → 真实鼠标 hover → 判定
 *   node check-context-menu.mjs probe       # 只扫描并弹出菜单，打印菜单项与坐标
 *   node check-context-menu.mjs hovercheck  # 只查当前 hover 背景色
 *
 * `e2e` 会把三步压在几秒内做完：**中间任何停顿都可能被用户的真实鼠标打断**
 *（菜单在 window 捕获阶段监听 mousedown，用户随手一点就把它关了）。
 */
const PORT = Number(process.env.CDP_PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const t = targets.find((x) => x.type === 'page' && (x.url || '').includes('mode=pet'))
if (!t) throw new Error('找不到宠物窗口')

const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('WebSocket 连接失败'))
})
let id = 0
const send = (method, params = {}) => {
  const myId = ++id
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== myId) return
      ws.removeEventListener('message', onMsg)
      msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
}
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

const MENU_JS = `(()=>{
  const all=[...document.querySelectorAll("button")];
  const mi=all.find(b=>b.textContent.includes("更换宠物"));
  if(!mi) return null;
  const open=all.find(b=>b.textContent.includes("打开对话")||b.textContent.includes("隐藏对话"));
  const r=open?open.getBoundingClientRect():null;
  return JSON.stringify({
    items:all.map(b=>b.textContent),
    openDock: open? open.textContent : null,
    openCx: r?Math.round(r.x+r.width/2):null,
    openCy: r?Math.round(r.y+r.height/2):null,
    openBg: open? open.style.background : null
  });
})()`

const cmd = process.argv[2] ?? 'probe'

if (cmd === 'hovercheck') {
  console.log(await evaluate(MENU_JS))
  ws.close()
  process.exit(0)
}

/** 沿地面线上方扫一遍，找到能弹出右键菜单的 x（走真实 hitTest，绕过穿透那层） */
async function probeOpenMenu() {
  const Y = 1300
  for (let x = 20; x <= 2560; x += 60) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: Y, buttons: 0 })
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y: Y,
      button: 'right',
      buttons: 2,
      clickCount: 1,
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y: Y,
      button: 'right',
      buttons: 0,
      clickCount: 1,
    })
    await sleep(90)
    const menu = await evaluate(MENU_JS)
    if (menu) return { x, y: Y, menu: JSON.parse(menu) }
  }
  return null
}

if (cmd === 'e2e') {
  // 三步必须**连着**做完：中间任何停顿都会被用户的真实鼠标打断
  //（菜单在 window 捕获阶段监听 mousedown，用户随手一点就把它关了）。
  const { execSync } = await import('node:child_process')
  const opened = await probeOpenMenu()
  if (!opened) {
    console.log('扫完整条地面线都没弹出菜单——宠物可能不在这一行')
    process.exit(1)
  }
  const { openCx, openCy, openBg } = opened.menu
  console.log(`菜单在 x=${opened.x} 弹出；"${opened.menu.openDock}" 位于 (${openCx}, ${openCy})`)
  console.log(`移动前背景: ${openBg}`)

  execSync(
    `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; ` +
      `Add-Type -AssemblyName System.Drawing; ` +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${openCx},${openCy})"`,
    { stdio: 'ignore' },
  )
  await sleep(700)

  const after = await evaluate(MENU_JS)
  if (!after) {
    console.log('复查时菜单已关（多半被用户的鼠标点掉了），本轮不作数')
    process.exit(1)
  }
  const a = JSON.parse(after)
  console.log(`移动后背景: ${a.openBg}`)
  const hovered = a.openBg && a.openBg !== 'transparent'
  console.log(
    hovered
      ? '✓ 真实鼠标在菜单项上触发了 hover —— 菜单打开期间窗口确实不穿透'
      : '✗ 菜单项没有 hover —— 窗口仍然是穿透的，菜单点不动',
  )
  ws.close()
  process.exit(hovered ? 0 : 2)
}

// probe：沿地面线上方扫一遍，找到能弹出右键菜单的 x
const opened = await probeOpenMenu()
if (!opened) {
  console.log('扫完整条地面线（y=1300）都没弹出菜单——宠物可能不在这一行')
} else {
  console.log(`菜单在 x=${opened.x}（y=1300）弹出`)
  console.log(JSON.stringify(opened.menu, null, 2))
}
ws.close()
