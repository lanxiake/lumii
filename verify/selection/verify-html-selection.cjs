#!/usr/bin/env node
/**
 * HTML 预览划词的真机验收脚本（CDP 驱动，不改产品代码）
 *
 * 为什么不用 `scripts/lumii-cdp.mjs`：它的 pickTarget 只认 `type === 'page'`，
 * 而 webview guest 在 CDP 里的 type 是 `webview` —— 够不着；那边又正是另一个会话的
 * 改动热点。所以这里自备一个最小 CDP 会话。
 *
 * 前提：
 *   1. 客户端带调试口启动：`powershell -File scripts/start-dev.ps1 -Force -RemoteDebug 9222`
 *   2. 应用里**已经打开着一个 .html 文件预览**（html-active 路由，`blob:` 的 webview）
 *
 * 跑法（仓库根）：
 *   node verify/selection/verify-html-selection.cjs
 *
 * 判据（对应 `docs/plans/客户端UI/2026-09-23-引用内联化与HTML划词修复.md` §四）：
 *   - 在 guest 里**真实拖拽**选中一段 → 宿主出现 `[data-selection-toolbar]`（浮条）
 *   - 在 guest 里右键 → 宿主出现自绘菜单，且 guest 的默认菜单被 preventDefault
 *
 * 注意这里拖的是**真鼠标事件**（`Input.dispatchMouseEvent`），不是合成 DOM 事件 ——
 * 走的正是用户操作那条路：guest 的 mouseup 捕获监听 → sendToHost → 宿主捕获监听。
 */

const PORT = Number(process.env.CDP_PORT ?? 9222)
const OUT_DIR = process.env.LUMII_VERIFY_OUT ?? process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  if (!res.ok) throw new Error(`CDP 列表失败：HTTP ${res.status}（客户端没带 --remoteDebuggingPort？）`)
  return res.json()
}

/** 极简 CDP 会话：串行发命令，每个命令等自己的响应 */
function session(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const ready = new Promise((resolve, reject) => {
    // 超时兜底：目标可能已经没了（预览被关掉），只等 error 事件会挂死
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error(`WebSocket 连接超时：${wsUrl}`))
    }, 8000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('WebSocket 连接失败（目标可能已经没了）'))
    }, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    let msg
    try { msg = JSON.parse(event.data) } catch { return }
    if (msg.id == null) return
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`))
    else entry.resolve(msg.result)
  })
  const send = (method, params = {}) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  return {
    ready,
    send,
    close: () => ws.close(),
    async eval(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
      if (result.exceptionDetails) {
        throw new Error(`页面里求值抛错：${result.exceptionDetails.exception?.description ?? '未知'}`)
      }
      return result.result?.value
    },
    /** 一次按下-移动-抬起的真实拖拽 */
    async drag(x1, y1, x2, y2, steps = 12) {
      const base = { button: 'left', buttons: 1, clickCount: 1 }
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, ...base })
      for (let i = 1; i <= steps; i++) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: x1 + ((x2 - x1) * i) / steps,
          y: y1 + ((y2 - y1) * i) / steps,
          button: 'left',
          buttons: 1,
        })
        await sleep(12)
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, ...base })
    },
    async rightClick(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 2, clickCount: 1 })
    },
    async screenshot(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      const fs = await import('node:fs')
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
      return file
    },
  }
}

function findHostTarget(targets) {
  return targets.find(
    (t) => t.type === 'page' && /^https?:\/\/127\.0\.0\.1:5174\//.test(t.url || ''),
  )
}

const findings = []
function check(name, ok, detail) {
  findings.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

/**
 * 菜单根节点的查找表达式。
 *
 * ⚠️ **不能写 `.context-menu`**：那是 vitest 的 `css.modules.classNameStrategy: 'non-scoped'` 下的
 * 样子；真实构建里 CSS Module 的类名是哈希过的（`_context-menu_1h4xv_3`）。第一版脚本就栽在这，
 * 明明菜单已经渲染出来（6 项齐全），却报了"没出现"。
 * 这里按「类名里含 context-menu 但不是它的子元素」认根节点。
 */
const MENU_ROOT_EXPR = `(() => {
  const all = Array.from(document.querySelectorAll('[class*="context-menu"]'))
  return all.find((el) => !/-item|-icon|-label|-separator/.test(el.className)) ?? null
})()`

const MENU_STATE_EXPR = `(() => {
  const root = ${MENU_ROOT_EXPR}
  if (!root) return { present: false }
  const r = root.getBoundingClientRect()
  const style = getComputedStyle(root)
  return {
    present: true,
    labels: Array.from(root.querySelectorAll('[class*="context-menu-label"]')).map((e) => e.textContent),
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && r.width > 0,
  }
})()`

async function main() {
  const targets = await listTargets()
  const hostTarget = findHostTarget(targets)
  const guestTarget = targets.find((t) => t.type === 'webview')
  if (!hostTarget) throw new Error('找不到宿主页面（type=page 且 url 是 127.0.0.1:5174）')
  if (!guestTarget) {
    throw new Error('找不到 webview guest。请先在应用里打开一个 .html 文件预览。')
  }

  const host = session(hostTarget.webSocketDebuggerUrl)
  const guest = session(guestTarget.webSocketDebuggerUrl)
  await Promise.all([host.ready, guest.ready])
  await host.send('Runtime.enable')
  await guest.send('Runtime.enable')

  // ── 0. preload 是真正的 file: URL（修复 1 的判据） ──
  const preload = await host.eval(
    'document.querySelector("webview")?.getAttribute("preload") ?? null',
  )
  check(
    'webview 的 preload 是 file: URL（不是从 location 拼出来的 http）',
    typeof preload === 'string' && preload.startsWith('file:///') && preload.endsWith('webview-selection.js'),
    preload ?? '(没有 preload 属性)',
  )

  // ── 1. guest 的 preload 真的跑了吗：靠划词链路本身证明 ──
  const rect = await host.eval(`(() => {
    const el = document.querySelector('webview')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, vh: innerHeight }
  })()`)
  if (!rect || rect.w < 50) throw new Error('webview 不可见（预览没开着？）')
  console.log(`\n宿主视口里的 webview：x=${Math.round(rect.x)} y=${Math.round(rect.y)} ${Math.round(rect.w)}×${Math.round(rect.h)}`)

  // guest 里挑一段够宽的正文来拖
  const line = await guest.eval(`(() => {
    const nodes = Array.from(document.querySelectorAll('p,h1,h2,h3,li,td'))
    for (const el of nodes) {
      const r = el.getBoundingClientRect()
      if (r.width > 200 && r.height > 10 && r.top > 4 && r.bottom < innerHeight - 4) {
        return { x: r.x, y: r.y, w: r.width, h: r.height, text: (el.textContent || '').slice(0, 40) }
      }
    }
    return null
  })()`)
  if (!line) throw new Error('guest 里找不到可拖选的正文块')
  console.log(`guest 里的目标行：「${line.text}…」 x=${Math.round(line.x)} y=${Math.round(line.y)} w=${Math.round(line.w)}`)

  // 清掉上一轮可能留着的浮条/菜单，让每次跑的起点一致。
  // **不能按 Escape** —— 预览弹窗自己也听 Escape，会把整个预览关掉
  // （第一版就栽在这：预览没了 → webview 目标消失 → 脚本卡在连不上的 WebSocket 上）。
  // 派一次宿主 mousedown 就够：划词层的既定行为是「任何一次按下先收起」。
  await host.eval(`(() => {
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    return true
  })()`)
  // guest 里的选区也要清掉：在**已有选区内部**按下再拖是「拖动这段已选内容」，
  // 不会产生新选区，于是浮条不弹（第二版脚本就栽在这，同一段代码时好时坏）。
  await guest.eval('window.getSelection()?.removeAllRanges(), true')
  await sleep(200)

  console.log('\n— 判据 1：预览里拖拽选中 → 浮条 —')
  const barBefore = await host.eval('!!document.querySelector("[data-selection-toolbar]")')
  await guest.drag(line.x + 4, line.y + line.h / 2, line.x + Math.min(line.w - 4, 300), line.y + line.h / 2)
  await sleep(400)

  const afterDrag = await host.eval(`(() => {
    const bar = document.querySelector('[data-selection-toolbar]')
    if (!bar) return { present: false }
    const r = bar.getBoundingClientRect()
    const style = getComputedStyle(bar)
    return {
      present: true,
      items: Array.from(bar.querySelectorAll('[data-selection-action]')).map(e => e.getAttribute('data-selection-action')),
      at: [Math.round(r.x), Math.round(r.y)],
      // 「渲染出来了但看不见」是这个浮层的典型翻车方式，所以判可见性而不是只判存在
      visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && r.width > 0 && r.height > 0,
    }
  })()`)
  check(
    '拖拽选中后宿主出现了划词浮条（且拖拽之前没有）',
    !barBefore && afterDrag.present && afterDrag.visible,
    afterDrag.present ? `动作=${afterDrag.items.join(',')} 位置=${afterDrag.at.join(',')}` : '没出现',
  )
  await host.screenshot(`${OUT_DIR}/verify-html-selection-1-toolbar.png`)

  // ── 2. 右键：应出自绘菜单 ──
  console.log('\n— 判据 2：预览里右键 → 自绘菜单 —')
  const menuBefore = await host.eval(MENU_STATE_EXPR)
  await guest.rightClick(line.x + 30, line.y + line.h / 2)
  await sleep(400)
  const afterRight = await host.eval(MENU_STATE_EXPR)
  const barAfterRight = await host.eval('!!document.querySelector("[data-selection-toolbar]")')
  const EXPECTED = ['引用', '复制', '翻译', '解释', '总结', '润色']
  check(
    '右键弹出自绘划词菜单（且右键之前没有）',
    !menuBefore.present && afterRight.present && afterRight.visible,
    afterRight.present
      ? `位置=${afterRight.x},${afterRight.y} 项=${afterRight.labels.join('/')}`
      : '没出现',
  )
  check(
    '菜单项与注册表一致',
    Array.isArray(afterRight.labels) && EXPECTED.every((label) => afterRight.labels.includes(label)),
  )
  check('右键时浮条已收起（两者互斥）', !barAfterRight)
  await host.screenshot(`${OUT_DIR}/verify-html-selection-2-menu.png`)

  // ── 3. 静态预览（iframe）那条路 ──
  //
  // 工作区里没有 .css/.svg，而测试文件不该写进用户 workspace，所以这里不绕文件预览：
  // 直接**动态 import 正在跑的那个模块**（vite dev 按模块服务），用组件自己那段注入逻辑
  // 建一个同款 iframe，再用真实鼠标事件拖选。
  // 这条验的是最不确定的一环：`sandbox="allow-scripts"` + 那条 nonce CSP 在**应用真实的
  // CSP 环境**（index.html 里有宽松 CSP，srcdoc 会继承）下，到底放不放行我们那段脚本。
  console.log('\n— 判据 3：静态预览（iframe）里的划词 —')
  const injected = await host.eval(`(async () => {
    const mod = await import('/selection/webview-bridge.ts')
    const nonce = crypto.randomUUID().replace(/-/g, '')
    const body = '<p id="probe-text" style="font:16px sans-serif;margin:8px">这是一段静态预览里的正文，用来验证 iframe 那条取词路是否通。</p>'
    const frame = document.createElement('iframe')
    frame.id = 'lumii-verify-iframe'
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('srcdoc', mod.buildIframeSelectionInjection(nonce) + body)
    frame.style.cssText = 'position:fixed;left:300px;top:420px;width:560px;height:120px;border:2px solid #f0f;z-index:100000;background:#fff'
    document.body.appendChild(frame)
    await new Promise((r) => setTimeout(r, 600))
    const rect = frame.getBoundingClientRect()
    return { nonce, x: rect.x, y: rect.y }
  })()`)
  check('注入脚本能在应用真实 CSP 下建出 iframe（模块可导入）', typeof injected?.x === 'number', `nonce=${injected?.nonce}`)

  await host.eval('document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), true')
  // 真实鼠标事件由合成器按命中测试投递 —— 会落进 iframe，所以 iframe 里是真的选区
  await host.drag(injected.x + 16, injected.y + 24, injected.x + 420, injected.y + 24)
  await sleep(400)
  const iframeBar = await host.eval(`(() => {
    const bar = document.querySelector('[data-selection-toolbar]')
    if (!bar) return { present: false }
    const r = bar.getBoundingClientRect()
    return {
      present: true,
      items: Array.from(bar.querySelectorAll('[data-selection-action]')).map(e => e.getAttribute('data-selection-action')),
      at: [Math.round(r.x), Math.round(r.y)],
    }
  })()`)
  check(
    '在 iframe 静态预览里拖选也弹得出浮条',
    iframeBar.present,
    iframeBar.present ? `动作=${iframeBar.items.join(',')} 位置=${iframeBar.at.join(',')}` : '没出现',
  )
  await host.screenshot(`${OUT_DIR}/verify-html-selection-3-iframe.png`)

  // 收尾：把探针 iframe 拆掉，别留在界面上
  await host.eval('document.getElementById("lumii-verify-iframe")?.remove(), true')

  host.close()
  guest.close()

  const failed = findings.filter((f) => !f.ok)
  console.log(`\n================ ${findings.length - failed.length}/${findings.length} 通过 ================`)
  if (failed.length > 0) {
    console.log('未通过：')
    for (const f of failed) console.log(`  - ${f.name}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`\n验收脚本自身出错：${err?.message ?? err}`)
  process.exit(2)
})
