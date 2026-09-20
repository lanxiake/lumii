/**
 * pet-frame.mjs — 宠物窗口的取帧与像素测量（`check-gaze-response.mjs` 用）
 *
 * 三件事都是实测逼出来的，别绕过：
 *
 * 1. **截图是 0.5 倍的整屏 JPEG**：控制口返回的 `previewPath` 是 3200/2560 宽缩到
 *    1280 的图（`resizeImageIfNeeded` 干的），宠物窗口又全屏且 `bounds=(0,0)`，
 *    所以**图内坐标 ×2 就是屏幕坐标**。
 *
 * 2. **量位移要用「最大连通域」，不能用「窗口内所有亮点」**。后者会把控制坞按钮
 *    和暗色 UI 文字一起算进去：实测把注视位移稀释掉一个数量级（6.3 → 2.1 半像素），
 *    锚点还被坞的下沿带到宠物下方 **280px**。宠物是一整块连通像素，取最大域即可。
 *
 * 3. **光标用常驻 PowerShell 进程移动**。每次新起进程要 ~0.5s，采样上百次受不了；
 *    常驻进程读一行动一次，成本可忽略。
 */

import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

/** 读控制口的 port/token（与控制口 CLI 同一份来源） */
export function readAppUiConfig() {
  const cfg = JSON.parse(
    readFileSync(join(homedir(), '.lumii', 'runtime', 'app-ui.json'), 'utf-8'),
  )
  if (typeof cfg?.port !== 'number' || typeof cfg?.token !== 'string') {
    throw new Error('app-ui.json 里没有 port/token —— 客户端没在跑？')
  }
  return cfg
}

/** POST 控制口路由（认证是 Bearer token，不是自定义头） */
export function makeAppUiPost(cfg) {
  return async function post(route, body) {
    const res = await fetch(`http://127.0.0.1:${cfg.port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body ?? {}),
    })
    return res.json()
  }
}

/** 截宠物窗口，返回可读的 JPEG 路径（图内坐标 = 屏幕坐标 / 2） */
export async function shootPet(post) {
  const j = await post('/screenshot', { target: 'pet' })
  if (!j?.previewPath) throw new Error(`截图失败：${JSON.stringify(j).slice(0, 200)}`)
  return j.previewPath
}

/**
 * 常驻光标服务：写一行 `"x,y"` 就移动一次，读到 `ok` 表示已生效。
 * 用完必须 `close()`（不然 PowerShell 进程会一直挂着）。
 */
export function startCursorServer() {
  const ps = spawn(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.Windows.Forms
       while ($true) {
         $line = [Console]::ReadLine()
         if ($null -eq $line) { break }
         $p = $line.Split(',')
         [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$p[0], [int]$p[1])
         [Console]::Out.WriteLine('ok')
         [Console]::Out.Flush()
       }`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true },
  )
  const rl = createInterface({ input: ps.stdout })
  const queue = []
  rl.on('line', (line) => {
    const resolve = queue.shift()
    if (resolve && line.trim() === 'ok') resolve()
  })
  return {
    /** 把光标移到屏幕坐标 (x, y) */
    move(x, y) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('光标移动超时')), 5000)
        queue.push(() => {
          clearTimeout(timer)
          resolve()
        })
        ps.stdin.write(`${Math.round(x)},${Math.round(y)}\n`)
      })
    },
    close() {
      ps.kill()
    },
  }
}

/**
 * 取最大连通域的统计量（这就是宠物本体）。
 *
 * 返回的 `g*` 是**图内坐标**，调用方 ×2 得屏幕坐标。
 * 用 8 邻接：宠物的身体与眼睛层是贴在一起的，4 邻接会把它们切成两块。
 *
 * **`tiltDeg` 才是判据该用的量**（`tiltDeg` 为正是顺时针，与 `gazeOffset` 同号）：
 * 实测宠物会在测量期间**自己挪位置**（右移 800px、下移 350px，疑似被抛过一次），
 * 那样基于绝对坐标的"重心位移"整个作废；而行重心对 y 的回归斜率只反映**倾斜**，
 * 与宠物站在哪儿无关。`centroid` 仅作参考量输出。
 *
 * @param opts.minPixels 小于此像素数的连通域不算宠物（控制坞按钮约 300、宠物约 1400）
 * @param opts.maxSide   单边超过此值的也不算（防止把大片 UI 当成宠物）
 */
export async function petBlob(file, window, opts = {}) {
  const { threshold = 60, minPixels = 400, minSide = 12, maxSide = 260 } = opts
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
  const { width: IW, channels: C } = info
  const { x0: wx0, y0: wy0, x1: wx1, y1: wy1 } = window
  const W = wx1 - wx0
  const H = wy1 - wy0
  const mask = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = ((y + wy0) * IW + (x + wx0)) * C
      if (Math.max(data[i], data[i + 1], data[i + 2]) > threshold) mask[y * W + x] = 1
    }
  }

  const seen = new Uint8Array(W * H)
  const stack = []
  let best = null
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || seen[seed]) continue
    stack.length = 0
    stack.push(seed)
    seen[seed] = 1
    let n = 0
    let sx = 0
    let sy = 0
    let x0 = W
    let x1 = -1
    let y0 = H
    let y1 = -1
    const rowSum = new Map() // y → {sum, count}，用于倾斜拟合
    while (stack.length) {
      const p = stack.pop()
      const px = p % W
      const py = (p - px) / W
      n += 1
      sx += px
      sy += py
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py
      const row = rowSum.get(py)
      if (row) {
        row.sum += px
        row.count += 1
      } else {
        rowSum.set(py, { sum: px, count: 1 })
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx
          const ny = py + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const q = ny * W + nx
          if (mask[q] && !seen[q]) {
            seen[q] = 1
            stack.push(q)
          }
        }
      }
    }
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    const plausible = n >= minPixels && w >= minSide && h >= minSide && w <= maxSide && h <= maxSide
    if (plausible && (!best || n > best.n)) {
      best = { n, cx: sx / n, cy: sy / n, x0, x1, y0, y1, rowSum }
    }
  }
  if (!best) return null

  // 行重心对 y 的加权最小二乘拟合：斜率 = tan(倾斜)。
  //
  // **权重必须是该行的像素数**：头顶与脚边的行只有几个像素（形状随动画帧变化），
  // 实测它们的逐行位移在 −2~+18 之间乱跳，等权拟合会被它们主导，
  // 把 ±6° 的旋转拟合出 4°（增益只剩 0.4）。按像素数加权后中段实体行说了算。
  const rows = [...best.rowSum.entries()]
    .filter(([, r]) => r.count >= 6)
    .map(([y, r]) => ({ y, cx: r.sum / r.count, w: r.count }))
  let tiltDeg = NaN
  if (rows.length >= 8) {
    let sw = 0
    let swx = 0
    let swy = 0
    let swxx = 0
    let swxy = 0
    for (const r of rows) {
      sw += r.w
      swx += r.w * r.y
      swy += r.w * r.cx
      swxx += r.w * r.y * r.y
      swxy += r.w * r.y * r.cx
    }
    const denom = sw * swxx - swx * swx
    const slope = denom === 0 ? 0 : (sw * swxy - swx * swy) / denom
    // 图内 y 向下：斜率>0 表示"底比顶更靠右"= 逆时针。取负号换成「顺时针为正」，
    // 与 gazeOffset 的 tiltDeg 同号，读数可以直接跟预期符号对照。
    tiltDeg = (-Math.atan(slope) * 180) / Math.PI
  }

  return {
    ...best,
    rowSum: undefined,
    tiltDeg,
    gx0: best.x0 + wx0,
    gx1: best.x1 + wx0,
    gy0: best.y0 + wy0,
    gy1: best.y1 + wy0,
    gcx: best.cx + wx0,
    gcy: best.cy + wy0,
  }
}

/** 均值和标准误——判据里用得上（要区分"真位移"和"抖动"） */
export function stats(values) {
  const xs = values.filter(Number.isFinite)
  if (!xs.length) return { mean: NaN, sem: NaN, n: 0 }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const varr = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1)
  return { mean, sem: Math.sqrt(varr / xs.length), n: xs.length }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
