#!/usr/bin/env node
/**
 * pixel-anim.mjs — 在像素网格上做「区域位移」，生成动作帧
 *
 * ## 这是什么
 *
 * 从**一张**基准像素图派生出一组动作帧，全程不碰生图模型。
 * 拿手的是 `shift`：把网格里某个矩形区域整体挪几个像素，原位置留空。
 * 抬腿 = 把那条腿的区域往上一提；点头 = 把头那一块往下沉两格。
 *
 * 像素动画的帧本来就是这么来的——**同一张图，挪几个部位**。让模型"再画一张"
 * 是另一回事：它会连角色一起重画（实测相邻帧 47% 的像素在变）。
 *
 * ## 为什么区域要显式给坐标
 *
 * 自动分部件（连通域、骨架）在这个尺度上都不靠谱：猫的腿和肚子是**连在一起**的，
 * 按连通域切会把整只猫切出来。所以部件边界得**人指定**——给一次坐标，
 * 之后所有帧共用这套划分，改起来也只改一处。
 *
 * ## 位移的边界规则
 *
 * 目标格已经有内容时**不覆盖**（`keep` 模式）——腿往上抬会撞进肚子，
 * 这时保住肚子、丢掉腿的上缘，正是想要的（腿本来就被肚子挡住）。
 * 反过来用 `over` 让新内容盖上去（画在前面）。默认 `keep`。
 *
 * 用法：
 *   node pixel-anim.mjs <基准.txt> <输出目录> --spec <动作.json>
 */
import fs from 'node:fs'
import path from 'node:path'

const [base, outDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const si = process.argv.indexOf('--spec')
const specPath = si === -1 ? null : process.argv[si + 1]
if (!base || !outDir || !specPath) {
  throw new Error('用法：pixel-anim.mjs <基准.txt> <输出目录> --spec <动作.json>')
}

/**
 * 解析网格文本 → { W, H, at, palette, rows[] }，行都补齐到全宽
 *
 * ⚠ **不能靠"跳过空行"来过滤格式行**。角色在 64 行的画布里常常只占中间
 * （本站的猫占行 4-59），开头结尾各有若干**全透明的空行**——它们是网格的一部分。
 * 早先写成 `if (line.trim() === '') continue`，这些行被当格式行吃掉，
 * 整张图向上错位 4 像素，而且报出来的是"行数 56 与 size 的高 64 不符"，
 * 看上去像行数问题、指不到错位。改成：只认头部三行，`palette` 之后
 * **原样收下每一行**。
 */
function parseGrid(text) {
  const lines = text.split(/\r?\n/)
  let size = null
  let at = null
  let palette = null
  let inBody = false
  const rows = []
  for (const line of lines) {
    if (line.startsWith('size ')) size = line.slice(5).trim().split(/\s+/).map(Number)
    else if (line.startsWith('at ')) at = line.slice(3).trim().split(/\s+/).map(Number)
    else if (line.startsWith('palette ')) {
      palette = line.slice(8).trim().split(/\s+/)
      inBody = true
    } else if (inBody) rows.push(line)
  }
  const [W, H] = size
  // 末尾换行符会 split 出一个多余空行，从尾部削到正好 H 行
  while (rows.length > H) rows.pop()
  while (rows.length < H) rows.push('')
  return { W, H, at, palette, rows: rows.map((r) => r.padEnd(W, '.')) }
}

function serializeGrid(g) {
  const head = [`size ${g.W} ${g.H}`, `palette ${g.palette.join(' ')}`]
  if (g.at) head.splice(1, 0, `at ${g.at[0]} ${g.at[1]}`)
  // 尾部透明省略，和 pixel-grid.mjs 的输出保持一致
  return head.concat(g.rows.map((r) => r.replace(/\.+$/, ''))).join('\n') + '\n'
}

const clone = (g) => ({ ...g, rows: g.rows.map((r) => r) })

/**
 * 把 [x0..x1]×[y0..y1] 的矩形整体挪 (dx,dy)。
 * `keep`：目标格已有非透明内容时不覆盖；`over`：无条件覆盖。
 */
function shift(g, { x0, x1, y0, y1, dx, dy, mode = 'keep' }) {
  const src = []
  for (let y = y0; y <= y1; y++) src.push(g.rows[y].slice(x0, x1 + 1).split(''))
  // 先清空原位
  for (let y = y0; y <= y1; y++) {
    g.rows[y] = g.rows[y].slice(0, x0) + '.'.repeat(x1 - x0 + 1) + g.rows[y].slice(x1 + 1)
  }
  // 再写到新位置
  for (let i = 0; i < src.length; i++) {
    const ty = y0 + i + dy
    if (ty < 0 || ty >= g.H) continue
    const row = g.rows[ty].split('')
    for (let j = 0; j < src[i].length; j++) {
      const tx = x0 + j + dx
      if (tx < 0 || tx >= g.W) continue
      if (src[i][j] === '.') continue
      if (mode === 'keep' && row[tx] !== '.') continue
      row[tx] = src[i][j]
    }
    g.rows[ty] = row.join('')
  }
  return g
}

/** 直接把某些行整行替换掉（清理难看的锯齿、理平腿底时用） */
function setRows(g, map) {
  for (const [y, text] of Object.entries(map)) {
    const y2 = Number(y)
    if (y2 >= 0 && y2 < g.H) g.rows[y2] = text.padEnd(g.W, '.')
  }
  return g
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'))
const grid0 = parseGrid(fs.readFileSync(base, 'utf-8'))
if (spec.palette && spec.palette.join(' ') !== grid0.palette.join(' ')) {
  throw new Error('spec.palette 与基准不一致——换了调色板，帧之间颜色就对不上了')
}

fs.mkdirSync(outDir, { recursive: true })
const manifest = []
for (const frame of spec.frames) {
  const g = clone(grid0)
  if (frame.rows) setRows(g, frame.rows)
  for (const op of frame.ops ?? []) shift(g, op)
  const text = serializeGrid(g)
  const file = path.join(outDir, `${spec.prefix}_${String(frame.i).padStart(2, '0')}.txt`)
  fs.writeFileSync(file, text, 'utf-8')
  manifest.push({ i: frame.i, name: frame.name, txt: file })
  console.log(`✓ 帧 ${frame.i}  ${frame.name}  → ${path.basename(file)}`)
}
fs.writeFileSync(
  path.join(outDir, 'frames.json'),
  JSON.stringify({ prefix: spec.prefix, palette: grid0.palette, size: [grid0.W, grid0.H], at: grid0.at, frames: manifest }, null, 2),
)
console.log(`共 ${manifest.length} 帧 → ${outDir}`)
