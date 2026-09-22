#!/usr/bin/env node
/**
 * pose-pick.mjs — 从「姿势生成」的帧序列里挑一帧当新首帧
 *
 * ## 为什么需要它
 *
 * 管线只有**正面**立绘，而走动/攀爬/爬行要侧身。做法是先跑一轮 `--free-end`
 * （I2VA，末帧自由）让角色转过去，再取其中一帧摆正当新首帧。
 *
 * 本机看不了图，所以"哪一帧转过来了"必须靠几何量判：
 *
 *   宽高比 = 包围盒宽 / 包围盒高
 *
 * 四足动物正面是**高>宽**、侧身是**宽>高**。实测团子的正面立绘 412×526 = 0.78，
 * 而 Shimeji 参考素材的侧身行都是 45×36 = 1.25。所以宽高比一越过 1 就是转过来了。
 *
 * ⚠ **镜像不对称度不能当判据**。一度想用它（正面左右对称、侧身不对称），
 * 实测团子正面素材也有 24~36%，与 Shimeji 侧身行的 34~60% 完全重叠——
 * 因为尾巴、抬起的手臂本来就打破对称。只有宽高比能分开。
 *
 * ## 挑哪一帧
 *
 * 不看单帧的极值，看**尾部连续几帧是否稳定**：转身是一次性动作，转到位之后
 * 角色会停住（提示词里写了 "holds it for the rest of the shot"）。所以取
 * 「最后 N 帧里宽高比的中位数最高、且帧间波动最小」的那一段的中间帧——
 * 单看某一帧的极值会挑到转身途中的扭曲帧。
 *
 * 用法：
 *   node pose-pick.mjs <帧目录>                    # 只报指标
 *   node pose-pick.mjs <帧目录> --window 8         # 尾部多少帧算"已稳定"
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { alphaBBox, cutout, estimateBackground } from '../lib/cutout.mjs'

const SOLID_TOLERANCE = 48

async function measure(file, rect = null) {
  let pipe = sharp(file)
  if (rect) pipe = pipe.extract(rect)
  const { data, info } = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  const B = estimateBackground(data, w, h)
  const { data: cut } = cutout(data, w, h, B, { tSolid: SOLID_TOLERANCE })
  const box = alphaBBox(cut, w, h, 16)
  if (!box) return null
  // 镜像不对称度：只作参考，不作判据（见头注释）
  let diff = 0
  let n = 0
  for (let y = box.minY; y <= box.maxY; y++) {
    for (let x = 0; x <= box.maxX - box.minX; x++) {
      const a = cut[(y * w + box.minX + x) * 4 + 3] > 16
      const b = cut[(y * w + box.maxX - x) * 4 + 3] > 16
      if (!a && !b) continue
      n++
      if (a !== b) diff++
    }
  }
  return {
    w: box.w,
    h: box.h,
    aspect: box.w / box.h,
    asym: n ? diff / n : 0,
    cx: box.minX + box.w / 2,
    bottom: box.maxY,
  }
}

const argv = process.argv.slice(2)
const dir = argv[0]
if (!dir) {
  console.error('用法：node pose-pick.mjs <帧目录> [--window 8]')
  process.exit(1)
}
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}
const win = Number(opt('window', 8))
/**
 * 挑哪一头。
 * - `desc`（默认）宽高比**最大**：从正面转身到侧身那一轮，越宽说明转得越到位。
 * - `asc` 宽高比**最小**：贴墙姿势，身体竖起来之后是窄高的。
 *
 * 判据不能反过来用——同一套指标，目标方向不同。
 */
const pickDir = opt('pick', 'desc')
/**
 * `--cols N`：输入是**一张拼条**而不是帧目录（`pose` 命令的产出）。
 *
 * 拼条是 `pose` 命令直接把「抽帧 + 拼条」做进 ComfyUI 图里出来的，过一次隧道
 * 只拉一张图；按格切开逐格量即可。格宽 = 图宽 / N。
 */
const cols = Number(opt('cols', 0))

/** 待测量的单元：帧目录下每张图，或拼条里的每一格 */
const cells = []
if (cols > 0) {
  const meta = await sharp(dir).metadata()
  const cw = Math.floor(meta.width / cols)
  for (let c = 0; c < cols; c++) {
    cells.push({ file: path.basename(dir), rect: { left: c * cw, top: 0, width: cw, height: meta.height } })
  }
} else {
  const names = fs
    .readdirSync(dir)
    .filter((f) => /\.png$/i.test(f))
    .sort()
  for (const f of names) cells.push({ file: path.join(dir, f), rect: null })
}

const rows = []
for (const [i, c] of cells.entries()) {
  const m = await measure(c.rect ? dir : c.file, c.rect)
  rows.push({ i, file: c.file, ...(m ?? {}) })
}

console.log(
  cols > 0
    ? `拼条 ${cols} 格（宽高比 >1 = 转过来了；团子正面基准 0.78）\n`
    : `帧数 ${rows.length}（宽高比 >1 = 转过来了；团子正面基准 0.78）\n`,
)
console.log('  下标  宽x高       宽高比  不对称  中心x   底边y')
for (const r of rows) {
  if (r.w === undefined) {
    console.log(`  ${String(r.i).padStart(4)}  （空帧）`)
    continue
  }
  console.log(
    `  ${String(r.i).padStart(4)}  ${String(`${r.w}x${r.h}`).padEnd(10)} ` +
      `${r.aspect.toFixed(3).padStart(6)}  ${(r.asym * 100).toFixed(1).padStart(5)}%  ` +
      `${r.cx.toFixed(0).padStart(6)}  ${r.bottom.toFixed(0).padStart(6)}`,
  )
}

// 尾部窗口：宽高比中位数最高、且波动最小的一段
const valid = rows.filter((r) => r.w !== undefined)
let best = null
for (let s = 0; s + win <= valid.length; s++) {
  const seg = valid.slice(s, s + win)
  const ar = seg.map((r) => r.aspect).sort((a, b) => a - b)
  const med = ar[ar.length >> 1]
  const spread = ar[ar.length - 1] - ar[0]
  // 分数 = 目标方向上的极值 − 波动惩罚。波动大说明还在动，不在稳定段里。
  const reach = pickDir === 'asc' ? 1 - med : med
  const score = reach - spread * 2
  if (!best || score > best.score) best = { score, med, spread, seg, start: s }
}
if (best) {
  const mid = best.seg[Math.floor(best.seg.length / 2)]
  console.log(
    `\n最稳的一段：下标 ${best.start}~${best.start + win - 1}` +
      `（宽高比中位 ${best.med.toFixed(3)}、波动 ${best.spread.toFixed(3)}）`,
  )
  console.log(`推荐取中间帧：${mid.file}${cols > 0 ? ` 第 ${mid.i} 格` : ''}（下标 ${mid.i}，宽高比 ${mid.aspect.toFixed(3)}）`)

  // 拼条模式下挑中的是**一格**，得先裁出来 stage-frame 才吃得到
  let pickedPath = cols > 0 ? null : mid.file
  if (cols > 0) {
    const out = opt('emit') || path.join(path.dirname(dir), `pick-${String(mid.i).padStart(2, '0')}.png`)
    await sharp(dir).extract(cells[mid.i].rect).png().toFile(out)
    pickedPath = out
    console.log(`已裁出 → ${out}`)
  }

  // ---- 画布该开多大 ----
  //
  // 这一步不能省：客户端的 normalize 按**高度**归一（`targetH = canvas.h × 0.94`），
  // 宽度是跟着高度走的——宽高比一旦超过 `canvas.w / (canvas.h × 0.94)`，
  // 侧身素材会被**横向裁掉**，而 run.ts 只记一条 clipped 警告、不报错。
  //
  // **`canvas.h` 不动**：宠物在屏幕上的大小 = `canvas.h × scale`。
  //
  // ⚠ 这里**故意不给**一个可以照抄的画布值。画布是整个模型**一个值**，
  // 而这个工具一次只看得到**一个**姿势的拼条——按它算出来的数会被下一个更宽的
  // 姿势推翻，而推翻的代价是重跑全部动作（改画布牵动归一化）。早先这里打印过
  // 一个具体值（还写死了某个角色的数字），等于让调用方去踩这个坑。
  const H = 448
  const needW = Math.ceil((H * 0.94 * mid.aspect) / 16) * 16
  const staged = path.join(dir, '..', 'staged')
  console.log(
    `\n这一格（宽高比 ${mid.aspect.toFixed(2)}）至少要 ${needW}px 宽 —— 这是**下界，不是答案**`,
  )
  console.log(
    `⚠ 画布按**所有姿势里最宽的那个**定：宽度 ≥ ${H} × 0.94 × max(各姿势宽高比)。\n` +
      `   把每个姿势的拼条都过一遍本工具，取最大的那个宽高比再定；\n` +
      `   宁可一次开宽一点——改画布要重出全部动作。`,
  )
  console.log(
    `\n下一步（把 <宽> 换成**按最宽姿势**定下来的值）：\n` +
      `  node stage-frame.mjs "${pickedPath}" "${path.join(staged, '<角色>-<姿势>.png')}" --keep-scale \\\n` +
      `    --canvas <宽>x${H} --meta "${path.join(staged, '<角色>-<姿势>.json')}"`,
  )
}
