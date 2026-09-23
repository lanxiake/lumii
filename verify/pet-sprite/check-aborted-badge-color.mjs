#!/usr/bin/env node
/**
 * 主窗「回复已中断」徽标的三主题实际计算色 + 对比度。
 *
 * 背景：用户实测反馈「中断的标识卡片字体颜色太黄了，看不清楚」。原样式
 * `.message-aborted-badge` = `--color-warning-light`(#fde047 亮黄) 压在
 * `--color-warning-15`(淡黄底) 上 —— **同色相只剩明度差**。改用 fg 令牌后三套主题
 * 各自解析出不同值，所以**必须逐主题读**：只看 dark 会漏掉浅色主题下的塌陷。
 *
 * ## 三个踩过的坑（都写进注释，别再踩）
 *
 * 1. **必须改 `<html>` 的 `data-theme`**，不能只改某个祖先容器。`tokens.css` 的
 *    映射层（`--color-text-secondary: var(--mt-fg-3)` 那一批）声明在 `:root`，
 *    自定义属性在**声明它的元素上**解析 —— 嵌套容器上改 data-theme 不会让它重算。
 * 2. **`color-mix()` 的计算值是 `color(srgb 0.39 0.45 0.55 / 0.16)`**，不是
 *    `rgba()`。逗号分隔的解析器在这里会静默返回 null（首版就这么挂的）。
 *    值域也是 0~1 而不是 0~255。
 * 3. **徽标底是半透明的**，对比度必须拿"合成后的有效背景"算，否则 16% 的灰底
 *    会被当成纯灰，算出来的对比度是假的。这里逐层向上合成到第一个不透明祖先。
 *
 * 判据：文字与合成背景的对比度 ≥ 4.5:1（WCAG AA 正文），三主题都要过。
 * 用法（客户端需带调试端口启动）：node verify/pet-sprite/check-aborted-badge-color.mjs
 */
const PORT = Number(process.env.CDP_PORT ?? 9222)

const PROBE = `
(() => {
  const themes = ['dark', 'light', 'eye-care']
  const html = document.documentElement
  const prevHtml = html.getAttribute('data-theme')
  const body = document.body
  const prevBody = body.getAttribute('data-theme')

  // ── 颜色解析：同时吃 rgb()/rgba() 与 color(srgb ...) ──
  const parse = (s) => {
    if (typeof s !== 'string') return null
    const a = s.indexOf('('), b = s.indexOf(')')
    if (a < 0 || b < 0) return null
    const inner = s.slice(a + 1, b)
    if (s.startsWith('color(')) {
      // color(srgb r g b / alpha) —— 值域 0~1
      const [rgbPart, alphaPart] = inner.split('/')
      const nums = rgbPart.trim().split(/\\s+/).slice(1).map(Number)
      if (nums.length < 3 || nums.some(Number.isNaN)) return null
      return { rgb: nums.map((n) => n * 255), a: alphaPart === undefined ? 1 : Number(alphaPart.trim()) }
    }
    const p = inner.split(',').map((x) => parseFloat(x))
    if (p.length < 3 || p.some((x) => Number.isNaN(x))) return null
    return { rgb: [p[0], p[1], p[2]], a: p[3] === undefined ? 1 : p[3] }
  }
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a)
    if (a === 0) return [0, 0, 0]
    return top.rgb.map((c, i) => (c * top.a + bottom.rgb[i] * bottom.a * (1 - top.a)) / a)
  }
  const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  const lum = (rgb) => 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2])
  const ratio = (f, b) => {
    const l1 = lum(f), l2 = lum(b)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }
  /** 逐层向上合成到第一个不透明背景（半透明徽标压在任意容器上都要算对） */
  const effectiveBgBehind = (el) => {
    let acc = { rgb: [0, 0, 0], a: 0 }
    let node = el.parentElement
    while (node) {
      const c = parse(getComputedStyle(node).backgroundColor)
      if (c && c.a > 0) {
        acc = { rgb: over(acc, c), a: acc.a + c.a * (1 - acc.a) }
        if (acc.a >= 0.999) return acc.rgb
      }
      node = node.parentElement
    }
    // 兜底：合成到画布底色（不透明）
    const canvas = parse(getComputedStyle(document.documentElement).backgroundColor) || { rgb: [255, 255, 255], a: 1 }
    return over(acc, canvas)
  }

  const sample = document.querySelector('[class*="message-aborted-badge"]')
  if (!sample) return { error: '页面上没有 .message-aborted-badge —— 先造一条中断的消息（或改成注入式探针）' }

  const out = []
  for (const t of themes) {
    html.setAttribute('data-theme', t)
    body.setAttribute('data-theme', t)
    const cs = getComputedStyle(sample)
    const fg = parse(cs.color)
    const ownBg = parse(cs.backgroundColor) || { rgb: [0, 0, 0], a: 0 }
    const behind = effectiveBgBehind(sample)
    const eff = over(ownBg, { rgb: behind, a: 1 })
    out.push({
      theme: t,
      color: cs.color,
      background: cs.backgroundColor,
      borderColor: cs.borderColor,
      effectiveBg: 'rgb(' + eff.map((x) => Math.round(x)).join(', ') + ')',
      contrast: Math.round(ratio(fg.rgb, eff) * 100) / 100,
      fg3: getComputedStyle(html).getPropertyValue('--mt-fg-3').trim(),
      mapped: getComputedStyle(html).getPropertyValue('--color-text-secondary').trim(),
    })
  }
  if (prevHtml === null) html.removeAttribute('data-theme')
  else html.setAttribute('data-theme', prevHtml)
  if (prevBody === null) body.removeAttribute('data-theme')
  else body.setAttribute('data-theme', prevBody)
  return { restored: { html: html.getAttribute('data-theme'), body: body.getAttribute('data-theme') }, results: out }
})()
`

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const main = list.find(
    (t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:5174') && !t.url.includes('mode=pet'),
  )
  if (!main) throw new Error('找不到主窗（http://127.0.0.1:5174/）')

  const ws = new WebSocket(main.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('CDP 连接失败'))
  })
  let myId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++myId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: true })
  ws.close()
  if (r.result?.exceptionDetails) {
    const d = r.result.exceptionDetails
    throw new Error(`evaluate 异常: ${d.exception?.description ?? d.text}`)
  }
  const res = r.result?.result?.value
  if (res?.error) {
    console.error('✗', res.error)
    process.exit(1)
  }
  console.log(`主题已恢复：html=${res.restored.html} body=${res.restored.body}\n`)
  let fail = 0
  const seen = new Set()
  for (const x of res.results) {
    const ok = x.contrast >= 4.5
    if (!ok) fail++
    seen.add(x.mapped)
    console.log(
      `${ok ? '✅' : '❌'} ${x.theme.padEnd(9)} 字=${x.color.padEnd(22)} 底(合成)=${x.effectiveBg.padEnd(18)} 对比度=${String(x.contrast).padEnd(6)} --mt-fg-3=${x.fg3}`,
    )
  }
  const themeSensitive = seen.size === res.results.length
  console.log(
    themeSensitive
      ? '\n✅ 映射层确实跟主题变（--color-text-secondary 三主题各不相同）'
      : `\n❌ 映射层没跟主题变：三主题只解析出 ${seen.size} 个值 —— tokens.css 的映射层钉在 :root，检查 <html> 的 data-theme`,
  )
  if (!themeSensitive) fail++
  console.log(fail === 0 ? '\n全部通过（对比度 ≥ 4.5:1）' : `\n${fail} 项不达标`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
