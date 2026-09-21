#!/usr/bin/env node
/**
 * lumii-cdp.mjs — 用 Chrome DevTools Protocol 驱动运行中的 Lumii 客户端
 *
 * 用法（先带调试端口启动客户端）：
 *   node apps/windows/scripts/run-dev.cjs --remoteDebuggingPort=9222
 *
 *   node scripts/lumii-cdp.mjs list
 *   node scripts/lumii-cdp.mjs eval  <目标子串> <js 表达式>
 *   node scripts/lumii-cdp.mjs shot  <目标子串> <输出.png> [x,y,w,h]
 *   node scripts/lumii-cdp.mjs click <目标子串> <x> <y>
 *   node scripts/lumii-cdp.mjs drag  <目标子串> <x1> <y1> <x2> <y2> [步数] [每步ms]
 *
 * ## 与 `apps/windows/resources/app-ui-cli/lumii-ui.mjs` 的分工
 *
 * 那个 CLI 是**语义级**的：`screenshot` 返回可交互元素的 `refs`，`click`/`act` 按 ref 操作。
 * 适合验证「设置页某个开关点了有没有生效」。
 *
 * 它做不到的是**坐标级**操作——尤其是宠物本体：宠物是 canvas 里画的图形，
 * **没有 DOM ref**，`click --ref` 够不着；而宠物窗口默认全窗穿透
 * （`setIgnoreMouseEvents(true)`），PowerShell 的鼠标模拟又会被窗口管理器拦掉。
 *
 * 所以两个工具是互补的，不是重复：**语义交互走 lumii-ui，像素级交互走这个**。
 *
 * ## 为什么需要它
 *
 * 宠物窗口、主窗口都是 Electron 的 BrowserWindow，没有浏览器地址栏，UI 自动化工具
 * （Playwright 等）接不进去。
 *
 * CDP 的 `Input` 域直接投递到渲染进程，绕过穿透那层；`Page.captureScreenshot`
 * 走合成器，拿到的是页面自己渲染的内容（透明背景与 WebGL 画布都在里面），
 * 不受桌面壁纸干扰——这点很重要，本机壁纸的暖色与宠物调色板相近，
 * 从整屏截图里找宠物会得到错误的包围盒。
 *
 * 目标子串匹配 url 或 title。宠物窗口是 `?mode=pet`，主窗口没有这个 query。
 */

const PORT = Number(process.env.CDP_PORT ?? 9222)
const [, , cmd, ...args] = process.argv

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  if (!r.ok) throw new Error(`CDP 列表失败：HTTP ${r.status}`)
  return r.json()
}

async function pickTarget(needle) {
  const targets = await listTargets()
  const hit = targets.find(
    (t) => t.type === 'page' && ((t.url || '').includes(needle) || (t.title || '').includes(needle)),
  )
  if (!hit) {
    throw new Error(
      `找不到目标 "${needle}"。现有：\n` +
        targets.map((t) => `  ${t.type} | ${t.title} | ${t.url}`).join('\n'),
    )
  }
  return hit
}

/** 极简 CDP 会话：串行发命令，每个命令等自己的响应 */
function session(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const ready = new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('WebSocket 连接失败（客户端没在跑？端口不对？）'))
  })
  let id = 0
  const send = async (method, params = {}) => {
    await ready
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
  return { send, close: () => ws.close(), ready }
}

async function main() {
  switch (cmd) {
    case 'list': {
      for (const t of await listTargets()) {
        console.log(`${t.type} | ${(t.title || '(无标题)').slice(0, 40)} | ${t.url}`)
      }
      return
    }

    case 'eval': {
      const [needle, expr] = args
      const t = await pickTarget(needle)
      const s = session(t.webSocketDebuggerUrl)
      const r = await s.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      })
      s.close()
      if (r.exceptionDetails) {
        throw new Error(
          `${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`,
        )
      }
      const v = r.result.value
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
      return
    }

    case 'shot': {
      const [needle, outPath, clipArg] = args
      const t = await pickTarget(needle)
      const params = { format: 'png', captureBeyondViewport: false }
      if (clipArg) {
        const [x, y, width, height] = clipArg.split(',').map(Number)
        params.clip = { x, y, width, height, scale: 1 }
      }
      const s = session(t.webSocketDebuggerUrl)
      const r = await s.send('Page.captureScreenshot', params)
      s.close()
      const buf = Buffer.from(r.data, 'base64')
      const fs = await import('node:fs')
      fs.writeFileSync(outPath, buf)
      console.log(`${outPath}  ${(buf.length / 1024).toFixed(1)} KB`)
      return
    }

    case 'click': {
      const [needle, x, y] = args.map((v, i) => (i === 0 ? v : Number(v)))
      const t = await pickTarget(needle)
      const s = session(t.webSocketDebuggerUrl)
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
      await s.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
      })
      await sleep(30)
      await s.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
      })
      s.close()
      console.log(`点击 (${x}, ${y})`)
      return
    }

    case 'drag': {
      const [needle, ...nums] = args
      const [x1, y1, x2, y2] = nums.slice(0, 4).map(Number)
      const steps = Number(nums[4] ?? 8)
      const stepMs = Number(nums[5] ?? 16)
      const t = await pickTarget(needle)
      const s = session(t.webSocketDebuggerUrl)

      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, buttons: 0 })
      await s.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1,
      })
      for (let i = 1; i <= steps; i++) {
        const k = i / steps
        await s.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(x1 + (x2 - x1) * k),
          y: Math.round(y1 + (y2 - y1) * k),
          button: 'left',
          buttons: 1,
        })
        await sleep(stepMs)
      }
      await s.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1,
      })
      s.close()
      // 速度决定宠物是被"抛出去"还是"原地落下"（阈值见 pet-core 的 isThrowable）
      const speed = Math.hypot(x2 - x1, y2 - y1) / ((steps * stepMs) / 1000)
      console.log(`拖拽 (${x1},${y1}) → (${x2},${y2})  约 ${Math.round(speed)} px/s`)
      return
    }

    default:
      console.error(
        '用法:\n' +
          '  lumii-cdp.mjs list\n' +
          '  lumii-cdp.mjs eval  <目标子串> <js 表达式>\n' +
          '  lumii-cdp.mjs shot  <目标子串> <输出.png> [x,y,w,h]\n' +
          '  lumii-cdp.mjs click <目标子串> <x> <y>\n' +
          '  lumii-cdp.mjs drag  <目标子串> <x1> <y1> <x2> <y2> [步数] [每步ms]',
      )
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err.message ?? err)
  process.exit(1)
})
