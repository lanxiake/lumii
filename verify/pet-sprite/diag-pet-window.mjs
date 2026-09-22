#!/usr/bin/env node
/**
 * diag-pet-window.mjs — 宠物窗口此刻到底渲染了什么（ASCII 缩略图 + DOM 概览）
 *
 * 起因：量横向摆动时量到「轮廓 34×89 @x≈2525」，明显不是几百像素大的宠物。
 * 光看包围盒数字分不清"宠物没渲染出来"和"量到了别的东西"，得把画面粗看一眼。
 *
 * 用法：node diag-pet-window.mjs
 */
import sharp from 'sharp'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pet = targets.find((t) => t.type === 'page' && t.url.includes('mode=pet'))
if (!pet) throw new Error('找不到宠物窗口')

const ws = new WebSocket(pet.webSocketDebuggerUrl)
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
  if (r.exceptionDetails) return `⚠️ ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description?.slice(0, 200) ?? ''}`
  return r.result.value
}

console.log('视口:', await ev('JSON.stringify({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})'))
console.log(
  '画布:',
  await ev(
    `JSON.stringify([...document.querySelectorAll('canvas')].map(c => ({cls: c.className, w: c.width, h: c.height, r: c.getBoundingClientRect().toJSON()})))`,
  ),
)
console.log(
  '可见元素:',
  await ev(`JSON.stringify([...document.body.querySelectorAll('*')].filter(e => {
    const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.05
  }).slice(0, 25).map(e => ({tag: e.tagName, cls: (e.className||'').toString().slice(0,40), rect: [Math.round(e.getBoundingClientRect().x), Math.round(e.getBoundingClientRect().y), Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]})))`),
)

const shot = await send('Page.captureScreenshot', { format: 'png' })
const buf = Buffer.from(shot.data, 'base64')
const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })

let n = 0
for (let i = 3; i < data.length; i += 4) if (data[i] > 16) n++
console.log(`\n截图 ${info.width}×${info.height}，不透明像素 ${n}`)

// ASCII 缩略图：先求包围盒，再按包围盒裁出网格（只看非透明）
let top = 1e9, bottom = -1, left = 1e9, right = -1
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] > 16) {
      if (y < top) top = y
      if (y > bottom) bottom = y
      if (x < left) left = x
      if (x > right) right = x
    }
  }
}
if (bottom < 0) {
  console.log('整个窗口全透明 —— 宠物窗口里什么都没有')
} else {
  console.log(`包围盒 x∈[${left},${right}] y∈[${top},${bottom}]  (${right - left + 1}×${bottom - top + 1})`)
  const COLS = 100
  const cw = Math.max(1, Math.ceil((right - left + 1) / COLS))
  const ch = cw * 2 // 字符高宽比
  console.log(`\nASCII（每字符 ${cw}×${ch}px，左上角对齐包围盒原点）`)
  for (let y = top; y <= bottom; y += ch) {
    let line = ''
    for (let x = left; x <= right; x += cw) {
      let hit = 0
      for (let yy = y; yy < Math.min(y + ch, bottom + 1); yy++) {
        for (let xx = x; xx < Math.min(x + cw, right + 1); xx++) {
          if (data[(yy * info.width + xx) * 4 + 3] > 16) hit++
        }
      }
      const ratio = hit / (cw * ch)
      line += ratio > 0.6 ? '#' : ratio > 0.25 ? '+' : ratio > 0.05 ? '.' : ' '
    }
    console.log(line)
  }
}
ws.close()
