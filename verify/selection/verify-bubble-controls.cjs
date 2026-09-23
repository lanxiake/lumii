#!/usr/bin/env node
/**
 * 划词气泡的两个交互判据（真机，CDP 驱动）
 *
 * 前提：客户端带调试口启动（`scripts/start-dev.ps1 -Force -RemoteDebug 9222`）。
 * 跑法（仓库根）：`node verify/selection/verify-bubble-controls.cjs`
 *
 * 判据：
 *   1. pending 气泡的「关闭」按得动（点了气泡就没）—— 这条**必须用真实鼠标事件**点：
 *      该 bug 的真因是指针捕获把 click 抢到了头部，用 `element.click()` 复现不出来。
 *   2. 结果到达后点「复制」，按钮要变成「已复制」。
 *
 * 第 2 条要等一次真实的 L2 调用（端点排队可能几秒到几十秒），脚本会轮询等待。
 */

const PORT = Number(process.env.CDP_PORT ?? 9222)
const MODEL_TIMEOUT_MS = Number(process.env.LUMII_BUBBLE_TIMEOUT_MS ?? 90000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  if (!res.ok) throw new Error(`CDP 列表失败：HTTP ${res.status}`)
  return res.json()
}

function session(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error(`WebSocket 连接超时：${wsUrl}`))
    }, 8000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')) }, { once: true })
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
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(`页面里求值抛错：${r.exceptionDetails.exception?.description ?? '未知'}`)
      return r.result?.value
    },
    /** 真实鼠标点击（走完整指针事件链，能复现指针捕获那类问题） */
    async clickAt(x, y) {
      const base = { x, y, button: 'left', clickCount: 1 }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...base })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...base })
    },
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
  }
}

const findings = []
function check(name, ok, detail) {
  findings.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

const BUBBLE = '[data-selection-bubble]'
const centerOf = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0) return null
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})()`

async function main() {
  const targets = await listTargets()
  const hostTarget = targets.find((t) => t.type === 'page' && /^https?:\/\/127\.0\.0\.1:5174\//.test(t.url || ''))
  if (!hostTarget) throw new Error('找不到宿主页面')
  const host = session(hostTarget.webSocketDebuggerUrl)
  await host.ready
  await host.send('Runtime.enable')

  // 起点：清掉可能挂着的浮条/气泡/预览弹窗。
  //
  // - Escape 走的是应用自己的既定行为（预览弹窗与气泡都听它），比自己找关闭按钮稳。
  // - **不要直接 remove 气泡节点** —— 那是 React 的 portal 容器，绕过它删会让 React
  //   之后更新到一个已脱离文档的节点上。
  await host.eval(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    window.getSelection()?.removeAllRanges()
    return true
  })()`)
  await sleep(300)

  // 在页面里挑一段正文来选。
  // 不限定在消息区：`data-lumii-source` 标记只打在消息正文上，页面上别处也有可读文字，
  // 而这条判据只关心「气泡的按钮能不能点」，跟出处无关。
  const line = await host.eval(`(() => {
    for (const el of document.querySelectorAll('p, li, h1, h2, h3')) {
      const r = el.getBoundingClientRect()
      if (!(r.width > 160 && r.height > 12 && r.top > 90 && r.bottom < innerHeight - 380)) continue
      // 被浮层盖住的候选直接跳过：拖上去只会选中浮层里的东西，宿主选区是空的
      const x = Math.round(r.x + 20)
      const y = Math.round(r.y + r.height / 2)
      const hit = document.elementFromPoint(x, y)
      if (!hit || !el.contains(hit)) continue
      return { x: r.x, y: r.y, w: r.width, h: r.height, text: (el.textContent || '').slice(0, 30) }
    }
    return null
  })()`)
  if (!line) throw new Error('消息区里找不到可拖选的正文')
  console.log(`选中的正文：「${line.text}…」`)

  // ── 判据 1：pending 气泡的关闭按钮 ──
  console.log('\n— 判据 1：pending 气泡点「关闭」要能关掉 —')
  await host.drag(line.x + 4, line.y + line.h / 2, line.x + Math.min(line.w - 4, 260), line.y + line.h / 2)
  await sleep(400)
  const selLen = await host.eval('(window.getSelection()?.toString() ?? "").length')
  console.log(`  拖拽后宿主选区长度：${selLen}`)
  const translateButton = await host.eval(centerOf('[data-selection-action="translate"]'))
  if (!translateButton) throw new Error(`浮条上的「翻译」没出现（选区长度 ${selLen}）`)
  await host.clickAt(translateButton.x, translateButton.y)
  await sleep(500)

  const pendingState = await host.eval(`(() => {
    const bubble = document.querySelector(${JSON.stringify(BUBBLE)})
    const body = bubble?.querySelector('[data-selection-bubble-status]')
    return { present: !!bubble, status: body?.getAttribute('data-selection-bubble-status') ?? null }
  })()`)
  check('点「翻译」后出现了 pending 气泡', pendingState.present, `status=${pendingState.status}`)

  const closeButton = await host.eval(centerOf(`${BUBBLE} button[aria-label="关闭"]`))
  if (!closeButton) throw new Error('气泡上没有关闭按钮')
  await host.clickAt(closeButton.x, closeButton.y)
  await sleep(400)
  const afterClose = await host.eval(`!!document.querySelector(${JSON.stringify(BUBBLE)})`)
  check('用真实鼠标点「关闭」，气泡消失', !afterClose, afterClose ? '气泡还在' : null)

  // ── 判据 2：复制后的「已复制」标记 ──
  console.log('\n— 判据 2：结果出来后点「复制」要有标记 —')
  await host.eval('window.getSelection()?.removeAllRanges(), true')
  await host.drag(line.x + 4, line.y + line.h / 2, line.x + Math.min(line.w - 4, 260), line.y + line.h / 2)
  await sleep(400)
  const translateAgain = await host.eval(centerOf('[data-selection-action="translate"]'))
  if (!translateAgain) throw new Error('第二次浮条没出来')
  await host.clickAt(translateAgain.x, translateAgain.y)

  const deadline = Date.now() + MODEL_TIMEOUT_MS
  let status = null
  while (Date.now() < deadline) {
    status = await host.eval(`document.querySelector('[data-selection-bubble-status]')?.getAttribute('data-selection-bubble-status') ?? null`)
    if (status === 'done' || status === 'error') break
    await sleep(1000)
  }
  console.log(`  结果状态：${status}（等待上限 ${MODEL_TIMEOUT_MS / 1000}s）`)
  if (status !== 'done') {
    check('等到模型结果', false, `状态是 ${status}（模型端点没返回？）`)
  } else {
    check('等到模型结果', true)
    const copyButton = await host.eval(centerOf(`${BUBBLE} button[title="复制"]`))
    if (!copyButton) throw new Error('结果气泡上没有复制按钮')
    await host.clickAt(copyButton.x, copyButton.y)
    await sleep(400)
    const copied = await host.eval(`(() => {
      const bubble = document.querySelector(${JSON.stringify(BUBBLE)})
      const button = bubble?.querySelector('button[title="已复制到剪贴板"]')
      return { label: button?.textContent?.trim() ?? null }
    })()`)
    check('点「复制」后按钮变成「已复制」', copied.label === '已复制', copied.label ?? '没找到已复制状态的按钮')
  }

  // 收尾：把气泡关掉
  const closeAgain = await host.eval(centerOf(`${BUBBLE} button[aria-label="关闭"]`))
  if (closeAgain) await host.clickAt(closeAgain.x, closeAgain.y)
  host.close()

  const failed = findings.filter((f) => !f.ok)
  console.log(`\n================ ${findings.length - failed.length}/${findings.length} 通过 ================`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`  - ${f.name}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`\n验收脚本自身出错：${err?.message ?? err}`)
  process.exit(2)
})
