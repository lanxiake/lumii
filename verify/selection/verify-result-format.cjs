#!/usr/bin/env node
/**
 * L2 结果的**排版**验收（真机，CDP 驱动）
 *
 * 前提：客户端带调试口启动（`scripts/start-dev.ps1 -Force -RemoteDebug 9222`）。
 * 跑法（仓库根）：`node verify/selection/verify-result-format.cjs`
 *
 * 判据（对应 `docs/plans/客户端UI/2026-09-23-引用内联化与HTML划词修复.md` §七）：
 *   1. 结果里的 Markdown **标记不漏成文字** —— 渲染器没认出来的话用户会看到一屏 `**` 与 `##`，
 *      这正是替换成纯文本渲染之前的样子，也是最容易悄悄回归的一条。
 *   2. 结构真的被渲染出来（标题 / 列表 / 荧光笔标记 / 引用便签里至少出现一种），
 *      说明"手绘笔记"那套样式挂在真节点上。
 *
 * 会挑页面上**最长**的一段正文来选，好让解释这类动作真的产出一篇结构化长文。
 */

const PORT = Number(process.env.CDP_PORT ?? 9222)
const MODEL_TIMEOUT_MS = Number(process.env.LUMII_FORMAT_TIMEOUT_MS ?? 120000)
const OUT_DIR = process.env.LUMII_VERIFY_OUT ?? process.cwd()
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
    async clickAt(x, y) {
      const base = { x, y, button: 'left', clickCount: 1 }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...base })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...base })
    },
    async drag(x1, y1, x2, y2, steps = 14) {
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
    async screenshot(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      const fs = await import('node:fs')
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
      return file
    },
  }
}

const findings = []
function check(name, ok, detail) {
  findings.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

const BUBBLE = '[data-selection-bubble]'

async function main() {
  const targets = await listTargets()
  const hostTarget = targets.find((t) => t.type === 'page' && /^https?:\/\/127\.0\.0\.1:5174\//.test(t.url || ''))
  if (!hostTarget) throw new Error('找不到宿主页面')
  const host = session(hostTarget.webSocketDebuggerUrl)
  await host.ready
  await host.send('Runtime.enable')

  await host.eval(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    window.getSelection()?.removeAllRanges()
    return true
  })()`)
  await sleep(300)

  // 挑**最长**的一段（解释类动作要长文本才谈得上结构）
  const line = await host.eval(`(() => {
    let best = null
    for (const el of document.querySelectorAll('p, li, blockquote')) {
      const r = el.getBoundingClientRect()
      if (!(r.width > 200 && r.height > 12 && r.top > 90 && r.bottom < innerHeight - 320)) continue
      const x = Math.round(r.x + 20)
      const y = Math.round(r.y + r.height / 2)
      const hit = document.elementFromPoint(x, y)
      if (!hit || !el.contains(hit)) continue
      const len = (el.textContent || '').trim().length
      if (!best || len > best.len) best = { x: r.x, y: r.y, w: r.width, h: r.height, len, head: (el.textContent || '').slice(0, 24) }
    }
    return best
  })()`)
  if (!line) throw new Error('页面上找不到可拖选的正文')
  console.log(`选中段落：${line.len} 字 ·「${line.head}…」`)

  await host.eval('window.getSelection()?.removeAllRanges(), true')
  await host.drag(line.x + 4, line.y + line.h / 2, line.x + line.w - 6, line.y + line.h / 2)
  await sleep(400)
  const selected = await host.eval('(window.getSelection()?.toString() ?? "").length')
  console.log(`  实际选中 ${selected} 字`)
  if (selected < 20) throw new Error(`选区太小（${selected} 字），解释动作产不出结构`)

  const explainButton = await host.eval(`(() => {
    const el = document.querySelector('[data-selection-action="explain"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (!explainButton) throw new Error('浮条上的「解释」没出现')
  await host.clickAt(explainButton.x, explainButton.y)
  console.log('  已点「解释」，等模型返回…')

  const deadline = Date.now() + MODEL_TIMEOUT_MS
  let status = null
  while (Date.now() < deadline) {
    status = await host.eval(`document.querySelector('[data-selection-bubble-status]')?.getAttribute('data-selection-bubble-status') ?? null`)
    if (status === 'done' || status === 'error') break
    await sleep(1000)
  }
  console.log(`  结果状态：${status}`)
  if (status !== 'done') throw new Error(`没等到结果（状态 ${status}）`)

  const report = await host.eval(`(() => {
    // 注意：真实构建里 CSS Module 的类名是哈希的（\`_sr-root_xxx\`），只能按子串认，
    // 写 \`.sr-root\` 会永远查不到（菜单那次已经栽过一回）
    const root = document.querySelector('${BUBBLE} [class*="sr-root"]')
    if (!root) return { missing: true }
    const count = (fragment) => root.querySelectorAll('[class*="' + fragment + '"]').length
    return {
      missing: false,
      text: root.textContent ?? '',
      headings: root.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
      paragraphs: root.querySelectorAll('p').length,
      listItems: root.querySelectorAll('li').length,
      marks: count('sr-mark'),
      quotes: count('sr-quote'),
      codeBlocks: count('sr-pre'),
      html: root.innerHTML.slice(0, 700),
    }
  })()`)

  if (report.missing) throw new Error('气泡里没有 Markdown 渲染层（.sr-root 没挂上？）')

  // 判据 1：标记漏成文字
  const leaks = ['**', '##', '- '].filter((token) => report.text.includes(token))
  check(
    'Markdown 标记没漏成文字',
    leaks.length === 0,
    leaks.length ? `正文里出现 ${JSON.stringify(leaks)}` : `正文 ${report.text.length} 字`,
  )

  // 判据 2：结构真的渲染出来了
  const structural = report.headings + report.listItems + report.marks + report.quotes
  check(
    '结构渲染出来了（标题/列表/荧光笔/引用便签至少一种）',
    structural > 0,
    `标题 ${report.headings} · 段落 ${report.paragraphs} · 列表项 ${report.listItems} · 荧光笔 ${report.marks} · 引用 ${report.quotes} · 代码块 ${report.codeBlocks}`,
  )

  // 判据 3：样式**真的生效**，不只是类名挂上了（CSS 没加载时类名照样在）
  const paint = await host.eval(`(() => {
    const mark = document.querySelector('${BUBBLE} [class*="sr-mark"]')
    const li = document.querySelector('${BUBBLE} li[class*="sr-li"]')
    if (!mark) return null
    const markStyle = getComputedStyle(mark)
    const bulletStyle = li ? getComputedStyle(li, '::before') : null
    return {
      markBackground: markStyle.backgroundColor,
      markRadius: markStyle.borderTopLeftRadius,
      markWeight: markStyle.fontWeight,
      bulletBackground: bulletStyle?.backgroundColor ?? null,
      bulletContent: bulletStyle?.content ?? null,
    }
  })()`)
  const transparent = (color) => !color || color === 'rgba(0, 0, 0, 0)' || color === 'transparent'
  check(
    '荧光笔与列表圆点的样式真的生效（不是只有类名）',
    !transparent(paint?.markBackground) && !transparent(paint?.bulletBackground),
    paint
      ? `荧光笔底色=${paint.markBackground} 圆角=${paint.markRadius} 字重=${paint.markWeight} 列表圆点=${paint.bulletBackground}`
      : '没取到样式',
  )

  // 判据 4：颜色**跟着主题走**（不是"蓝色 App 里贴一张固定颜色的便签"）
  const themeColors = await host.eval(`(() => {
    const mark = document.querySelector('${BUBBLE} [class*="sr-mark"]')
    if (!mark) return null
    // 主题属性要在 html 与 body 上**同时**改：应用的 ThemeContext 两处都写，
    // 而 body 上的声明离元素更近、会盖过 html 的（第一版只改了 html，三种主题读出来一模一样）
    const targets = [document.documentElement, document.body]
    const previous = targets.map((el) => el.getAttribute('data-theme'))
    const out = {}
    for (const theme of ['dark', 'light', 'eye-care']) {
      for (const el of targets) el.setAttribute('data-theme', theme)
      out[theme] = getComputedStyle(mark).backgroundColor
    }
    targets.forEach((el, index) => {
      if (previous[index] === null) el.removeAttribute('data-theme')
      else el.setAttribute('data-theme', previous[index])
    })
    return out
  })()`)
  const themeValues = themeColors ? Object.values(themeColors) : []
  check(
    '荧光笔颜色随主题变化（三主题下不只一种颜色，且都不透明）',
    themeValues.length === 3 && themeValues.every((c) => !transparent(c)) && new Set(themeValues).size >= 2,
    themeColors ? Object.entries(themeColors).map(([k, v]) => `${k}=${v}`).join(' · ') : '没取到',
  )

  const shot = `${OUT_DIR}/verify-result-format.png`
  await host.screenshot(shot)
  console.log(`\n截图：${shot}`)
  console.log('— 渲染片段 —')
  console.log(report.html.replace(/></g, '>\n<'))

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
