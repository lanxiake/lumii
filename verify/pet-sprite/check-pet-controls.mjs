#!/usr/bin/env node
/**
 * check-pet-controls.mjs — 顶栏宠物开关 + 右键菜单的点后行为
 *
 * ## 守的三条回归（都来自用户 2026-09-22 的反馈）
 *
 * 1. **顶栏开关能开关宠物模式**。开关本身没什么好说的，要守的是它的**状态来源**：
 *    状态在主进程（托盘 / Ctrl+Shift+P / 控制坞都能改），按钮只是镜像。所以这里
 *    用「点一下 → 看 `[pet] mode:switch` 日志 + 按钮自己翻没翻」判定，而不是只看 DOM。
 *
 * 2. **点开关类项不收菜单**。用户的原话是「点击右键菜单中的选项除了需要跳转打开其他
 *    窗口的，都不需要自动关闭……只有打开对话才需要」。判据就是点完菜单还在不在。
 *    反例同样要守：点「打开对话」后菜单**必须**消失。
 *
 * 3. **点「文字回复朗读」不许起通话**。以前的实现里这个开关会顺手预建 micless 管线，
 *    于是主进程 VoiceStateMachine 直接进 thinking、`voice:call:state` 广播到所有窗口。
 *    用户报的就是这条：「点击开启语音朗读，客户端却打开了麦克风，进入了语音对话模式」。
 *    判据是日志增量里**没有** `ensureMiclessVoicePipeline` / `voice:call:start`。
 *
 * ## 为什么点菜单项要用 CDP 的真实鼠标
 *
 * 宠物窗口整窗穿透，`dispatchEvent`/`el.click()` 绕过穿透那层，验不出「用户点得动」。
 * 用 `Input.dispatchMouseEvent` 走真实 hitTest。右键开菜单同理。
 *
 * ## 用法（需客户端带调试端口启动：pnpm dev:debug）
 *
 *   node check-pet-controls.mjs e2e      # 一条龙，结束后把宠物模式关回去
 *   node check-pet-controls.mjs menu     # 只做第 2、3 条（需已在宠物模式）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const LOG = path.resolve(fileURLToPath(new URL('../../.lumii-dev.log', import.meta.url)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 日志增量：先记长度，跑完再读尾巴——「没起通话」只能靠增量证明 */
function logOffset() {
  try {
    return fs.statSync(LOG).size
  } catch {
    return 0
  }
}
function logSince(offset) {
  try {
    const buf = fs.readFileSync(LOG)
    return buf.subarray(offset).toString('utf8')
  } catch {
    return ''
  }
}

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(
    (x) => x.type === 'page' && x.url.startsWith('http://127.0.0.1:5174'),
  )
}

/** 连一个 CDP 目标，返回 {send, evaluate, close} */
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
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
  return { send, evaluate, close: () => ws.close() }
}

/** 点某个坐标（真实鼠标事件，走 hitTest） */
async function clickAt(c, x, y, button = 'left') {
  const buttons = button === 'right' ? 2 : 1
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await c.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button, buttons, clickCount: 1,
  })
  await c.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1,
  })
}

// ── 主窗口：顶栏那个宠物开关 ───────────────────────────────────────────────

const TITLE_BTN_JS = `(()=>{
  const b=[...document.querySelectorAll("button")].find(x=>(x.getAttribute("aria-label")||"").includes("宠物模式"));
  if(!b) return null;
  const r=b.getBoundingClientRect();
  return JSON.stringify({mode:b.dataset.petMode, label:b.getAttribute("aria-label"),
    cx:Math.round(r.x+r.width/2), cy:Math.round(r.y+r.height/2)});
})()`

// ── 宠物窗口：右键菜单 ────────────────────────────────────────────────────

const MENU_JS = `(()=>{
  const all=[...document.querySelectorAll("button")];
  const items=all.map(b=>{
    const r=b.getBoundingClientRect();
    return {text:b.textContent, cx:Math.round(r.x+r.width/2), cy:Math.round(r.y+r.height/2)};
  }).filter(i=>i.text);
  return JSON.stringify(items);
})()`

/**
 * 沿几条横线扫一遍，用真实右键找出能弹出菜单的 x。
 *
 * **不能只扫地面线那一行**：宠物会自己走，还会爬到墙上、天花板上待着（实测两次
 * 空扫就是因为它正沿着屏幕上边缘爬）。所以从地面往上铺几行，天花板附近也留一行。
 */
async function openMenu(c) {
  const rows = [1390, 1340, 1290, 1240, 1190, 900, 600, 300, 60]
  for (const y of rows) {
    for (let x = 20; x <= 2540; x += 60) {
      await clickAt(c, x, y, 'right')
      await sleep(70)
      const items = JSON.parse(await c.evaluate(MENU_JS))
      if (items.some((i) => i.text.includes('更换宠物'))) return { x, y, items }
    }
  }
  return null
}

function itemNamed(items, name) {
  return items.find((i) => i.text.includes(name))
}

async function waitForTarget(pred, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const t = (await targets()).find(pred)
    if (t) return t
    await sleep(300)
  }
  return null
}

// ── 三个检查 ──────────────────────────────────────────────────────────────

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

async function checkTitleToggle() {
  const main = (await targets()).find((t) => !t.url.includes('mode=pet'))
  if (!main) throw new Error('找不到主窗口')
  const c = await connect(main)
  try {
    const before = JSON.parse(await c.evaluate(TITLE_BTN_JS))
    if (!before) {
      record('顶栏宠物开关存在', false, '主窗口里找不到 aria-label 含「宠物模式」的按钮')
      return null
    }
    record('顶栏宠物开关存在', true, `当前 ${before.mode} / ${before.label}`)
    return { c, before }
  } catch (e) {
    c.close()
    throw e
  }
}

/** 点一下顶栏开关，返回点完的状态 */
async function clickTitleButton(c) {
  const btn = JSON.parse(await c.evaluate(TITLE_BTN_JS))
  const off = logOffset()
  await clickAt(c, btn.cx, btn.cy)
  await sleep(1500)
  const after = JSON.parse(await c.evaluate(TITLE_BTN_JS))
  return { after, tail: logSince(off) }
}

async function checkMenu() {
  const pet = await waitForTarget((t) => t.url.includes('mode=pet'))
  if (!pet) throw new Error('找不到宠物窗口（要先打开宠物模式）')
  const c = await connect(pet)
  try {
    const opened = await openMenu(c)
    if (!opened) {
      record('右键能弹出菜单', false, '沿地面线扫了一遍都没弹出来')
      return
    }
    record('右键能弹出菜单', true, `在 x=${opened.x} 弹出，${opened.items.length} 项`)
    console.log('   菜单项：' + opened.items.map((i) => i.text).join(' | '))

    const readAloud = itemNamed(opened.items, '文字回复朗读')
    record('朗读项的用词是「文字回复朗读」', !!readAloud, readAloud ? '' : '没找到这一项')
    const call = itemNamed(opened.items, '开始语音对话')
    record(
      '通话项标了「麦克风」hint',
      !!call && call.text.includes('麦克风'),
      call ? call.text : '没找到这一项',
    )
    if (!readAloud) return

    // 第 3 条：点朗读不许起通话
    const off = logOffset()
    await clickAt(c, readAloud.cx, readAloud.cy)
    await sleep(1800)
    const tail = logSince(off)
    const started = /ensureMiclessVoicePipeline|voice:call:start|\[startCall\]/.test(tail)
    record('点「文字回复朗读」不起通话', !started, started ? '日志里出现了起呼' : '日志里没有起呼')

    // 第 2 条：菜单还在
    const afterToggle = JSON.parse(await c.evaluate(MENU_JS))
    const stillOpen = afterToggle.some((i) => i.text.includes('更换宠物'))
    record('点完朗读菜单还开着', stillOpen, stillOpen ? '' : '菜单被收起来了')

    // 反例：打开对话必须收
    const dock = itemNamed(afterToggle, '打开对话') ?? itemNamed(afterToggle, '隐藏对话')
    if (dock) {
      await clickAt(c, dock.cx, dock.cy)
      await sleep(600)
      const afterDock = JSON.parse(await c.evaluate(MENU_JS))
      const closed = !afterDock.some((i) => i.text.includes('更换宠物'))
      record('点「打开对话」菜单收起来', closed, closed ? '' : '菜单没收')
    } else {
      record('点「打开对话」菜单收起来', false, '没找到「打开对话」')
    }
  } finally {
    c.close()
  }
}

// ── 入口 ──────────────────────────────────────────────────────────────────

const cmd = process.argv[2] ?? 'e2e'

if (cmd === 'menu') {
  await checkMenu()
} else if (cmd === 'on' || cmd === 'off') {
  // 单独把宠物模式打开/关掉（手工调试菜单时用：菜单只在宠物窗口里）
  const main = (await targets()).find((t) => !t.url.includes('mode=pet'))
  const c = await connect(main)
  const btn = JSON.parse(await c.evaluate(TITLE_BTN_JS))
  if (btn.mode !== (cmd === 'on' ? 'on' : 'off')) {
    const { after } = await clickTitleButton(c)
    console.log(`宠物模式 ${btn.mode} → ${after.mode}`)
  } else {
    console.log(`宠物模式已经是 ${btn.mode}`)
  }
  c.close()
} else {
  const opened = await checkTitleToggle()
  if (opened) {
    const { c, before } = opened
    // 先确保处于宠物模式（菜单得在宠物窗口里点）
    if (before.mode === 'off') {
      const { after, tail } = await clickTitleButton(c)
      record(
        '点一下打开宠物模式',
        after.mode === 'on' && /\[pet\] mode:switch/.test(tail),
        `按钮=${after.mode}，日志 mode:switch=${/\[pet\] mode:switch/.test(tail)}`,
      )
    }
    await checkMenu()
    // 收尾：关回桌面模式（顺带验另一个方向；脚本不该给用户留下满屏的宠物）
    const { after: back, tail: backTail } = await clickTitleButton(c)
    record(
      '再点一下关回桌面模式',
      back.mode === 'off' && /\[pet\] mode:switch/.test(backTail),
      `按钮=${back.mode}`,
    )
    c.close()
  }
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
