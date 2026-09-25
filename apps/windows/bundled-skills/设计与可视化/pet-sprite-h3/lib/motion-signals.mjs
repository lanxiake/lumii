/**
 * motion-signals.mjs — 从**像素**反推动作素材的两件事：朝向、首尾重格
 *
 * 这两件事都没有元数据可查（清单里没写、装完之后包围盒也看不出差别），
 * 只能量。写在这里是为了**每个新角色自动复验**，不用靠人眼盯。
 *
 * ============================================================================
 * 一、朝向（`probeFacing`）
 * ============================================================================
 *
 * 约定是硬的：**素材一律朝右画，左右交给渲染器 `setFlip` 镜像**
 * （`PetWanderDriver.applyFacing` 写死「素材面朝右，故 facing=-1 时才翻转」）。
 * 素材画成朝左 → 宠物往右走时不镜像 → **朝左的脸配上朝右的位移**，
 * 用户看到的说法是「运动方向反了」。2026-09-25 月兔的 `Crawl` 就是这么翻车的
 * （提示词里写着 `facing the right of the frame`，模型没听）。
 *
 * 两个**互相独立**的信号，都只依赖卡通画法的物理事实：
 *
 * **信号 A｜眼睛落在脸那侧。** 侧身视图只画一只眼，它必然在脸的朝向那侧；
 *   正面视图两眼对称 → 暗像素质心 ≈ 包围盒中心。取头部条带（内容包围盒顶
 *   10%~45%）里亮度 < 85 的像素——她是银发白肤，那个区域里**最暗的就是眼睛**。
 *   `off = (暗像素质心 x − 包围盒中心 x) / 内容宽`，`> 0` → 朝右。
 *
 * **信号 B｜头 + 耳是全图最高的一竖条。** 趴姿/横构图里"头部条带"没有意义
 *   （横着的人像，包围盒顶部 10% 是她背而不是头），改用列高度：
 *   最高列落在包围盒左端 → 头在左。`hiRel` 越接近 0/1 越可信。
 *
 * ## 负对照是这套判据成立的前提，不许省
 *
 * 正面动作（Idle/Talk/Nod/Sit/Yawn/Purr…）左右近似对称，**两个信号都该读近 0 / 0.5**。
 * 月兔实测：`idle` 的眼睛偏移 −0.5% / +3.4%，最高列位置 0.38 / 0.40。
 * 正面动作读出大数，就说明检测器本身不可信，**下面所有读数一律作废**。
 * 校准则反过来用人眼确认过的动作钉死：`walk`（prose 明写 drifts to the right、
 * 用户看过没问题）实测 +32.5% → 正号 = 朝右 ✓。
 *
 * ## ⚠ 混淆动作：姿势会污染头部条带，这些只 warn 不判死
 *
 * | 动作 | 污染源 |
 * | --- | --- |
 * | `look` | 她**主动转头**，眼睛本来就不在中心 |
 * | `wave` / `cheer` / `climb` | 一只或两只手举到头侧，暗像素里混进袖口/阴影 |
 * | `playball` | 球在身前，暗色块进头部条带 |
 * | `picked` | 被拎起来，身体角度乱 |
 *
 * 对这些动作，只有**两个信号同号**才给结论，否则返回 `inconclusive` 交人眼
 * （出「原样 / 镜像」对照图，一次翻转正反都能用，人选错了改一个标志位）。
 *
 * 用法：
 *   node motion-signals.mjs --facing <表目录...>
 *   node motion-signals.mjs --facing --all          # 扫 outputs/pet-motion/moonrabbit-*-sheet
 */

import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

/** 与 perch-gaps / 出图闸门一致的 alpha 阈值（16 会把抗锯齿毛边算进来） */
const ALPHA = 24
/** 头部条带：内容包围盒顶 10% ~ 45%（兔耳从头顶往上，不落在这一带） */
const HEAD_BAND = [0.1, 0.45]
/** 「暗」的判据：银发白肤的角色，头部条带里最暗的就是眼睛 */
const DARK_LUMA = 85
/** 判定阈值（占内容宽的比例） */
const T_SYM = 0.08 // |off| 小于它 = 左右对称（正面动作）
const T_SIDE = 0.08 // off > +它 = 朝右；off < −它 = 朝左
const T_END = 0.35 // 最高列位置 <它 = 头在左端；> 1−它 = 头在右端
/** 少于这么多暗像素就不该相信眼睛信号（多半是发丝阴影，不是眼睛） */
const MIN_DARK = 8

/** 把横排表读成一次性 raw（每格再解码一次 = 16 次全解码，实测慢到不能用） */
export async function loadStrip(png, cols) {
  const m = await sharp(png).metadata()
  const raw = await sharp(png).ensureAlpha().raw().toBuffer()
  return { raw, W: m.width, H: m.height, cols, CW: Math.round(m.width / cols) }
}
/**
 * 量一格。返回两个朝向信号 + 包围盒。
 *
 * @returns {{bw:number,bh:number,prone:boolean,darkN:number,eyeOff:number|null,
 *            hiRel:number,hiPx:number}|null} 整格透明返回 null
 */
export function probeCell(strip, c) {
  const { raw, W, H, CW } = strip
  let minX = 1e9
  let maxX = -1
  let minY = 1e9
  let maxY = -1
  const colH = new Array(CW).fill(0)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < CW; x++) {
      const i = ((y * W) + c * CW + x) << 2
      if (raw[i + 3] < ALPHA) continue
      colH[x]++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  const bw = maxX - minX + 1
  const bh = maxY - minY + 1
  const b0 = minY + Math.round(bh * HEAD_BAND[0])
  const b1 = minY + Math.round(bh * HEAD_BAND[1])
  let ds = 0
  let dn = 0
  for (let y = b0; y <= b1; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = ((y * W) + c * CW + x) << 2
      if (raw[i + 3] < ALPHA) continue
      const L = 0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2]
      if (L > DARK_LUMA) continue
      ds += x
      dn++
    }
  }
  let hi = minX
  let hv = -1
  for (let x = minX; x <= maxX; x++) if (colH[x] > hv) { hv = colH[x]; hi = x }
  return {
    bw,
    bh,
    // 横构图（趴姿/云载）：头部条带没意义，只能靠信号 B
    prone: bw > bh * 1.15,
    darkN: dn,
    eyeOff: dn >= MIN_DARK ? (ds / dn - (minX + bw / 2)) / bw : null,
    hiRel: (hi - minX) / bw,
    hiPx: hv,
  }
}

const med = (a) => a.filter((v) => Number.isFinite(v)).sort((x, y) => x - y)[(a.length / 2) | 0]

/**
 * 量一整张表（逐格取中位数，单格会被某一帧的乱姿势带跑）。
 *
 * @param expect `'front'` 期望左右对称（正面动作）；`'side'` 期望朝右；`'auto'` 只报数
 * @param opts   `{ confounded: true }` 姿势会污染头部条带的动作 → 结论保守
 */
export async function probeFacing(png, cols, expect = 'auto', opts = {}) {
  const strip = typeof png === 'string' ? await loadStrip(png, cols) : png
  const ps = []
  for (let c = 0; c < strip.cols; c++) {
    const p = probeCell(strip, c)
    if (p) ps.push(p)
  }
  if (!ps.length) return { ok: false, why: '整张表都是空的' }
  const eye = med(ps.map((p) => p.eyeOff))
  const hi = med(ps.map((p) => p.hiRel))
  const prone = ps.filter((p) => p.prone).length > ps.length / 2
  // 信号 B 的有符号化：0.5 为中心，>0 头在右
  const headSign = (hi - 0.5) * 2
  const eyeTxt = Number.isFinite(eye) ? `${(eye * 100).toFixed(1)}%` : '暗像素不足'

  let verdict
  let confident = true
  if (!Number.isFinite(eye)) {
    verdict = 'inconclusive'
    confident = false
  } else if (expect === 'front') {
    // 正面动作：两个信号都该读近中心
    if (Math.abs(eye) <= T_SYM && Math.abs(headSign) <= 1 - 2 * T_END + 0.3) verdict = '✓ 对称（正面）'
    else if (Math.abs(eye) > T_SYM && opts.confounded) {
      verdict = `⚠ 不对称但这是混淆动作（${eyeTxt}）—— 只 warn`
      confident = false
    } else if (Math.abs(headSign) > 1 - 2 * T_END) verdict = `✗ 正面动作却明显偏一侧（头在${hi < 0.5 ? '左' : '右'}端）`
    else verdict = `⚠ 正面动作不对称 ${eyeTxt} —— 检查是不是转了身/侧面出图`
  } else {
    // 侧身动作：必须朝右
    const eyeRight = eye > T_SIDE
    const eyeLeft = eye < -T_SIDE
    const headRight = headSign > 1 - 2 * T_END
    const headLeft = headSign < -(1 - 2 * T_END)
    if (eyeRight && (headRight || !prone)) verdict = '✓ 朝右'
    else if (eyeLeft && (headLeft || !prone)) verdict = '✗ 朝左 —— 违反朝右约定，要镜像这张素材'
    else if (eyeRight) verdict = '✓ 朝右（信号 B 弱，姿势干扰）'
    else if (eyeLeft) verdict = '✗ 朝左（信号 B 弱）'
    else {
      verdict = `inconclusive（眼睛 ${eyeTxt}、最高列 ${hi.toFixed(2)}）`
      confident = false
    }
  }
  return { ok: true, expect, eye, hi, prone, verdict, confident, cells: ps.length, darkN: med(ps.map((p) => p.darkN)) }
}

/**
 * ============================================================================
 * 二、首尾重格（`probeWrap`）
 * ============================================================================
 *
 * **这不是模型偶尔犯错，是管线构造出来的**：
 *  1. FL2VA 把同一张图钉死在片子的首尾两端（`loopAnchor: 'first-last'`），
 *     而且所有循环动作的提示词都明写 "settles into the exact starting pose
 *     by {deadline} seconds"；
 *  2. 抽帧走 `RandomImageFromBatch(randomness=0)`，沿整段均匀取、**含首尾两端**
 *     （`h3-motion.mjs:1472`）——于是**最后一格必然取到那个复件**。
 *
 * 后果：`kind:'loop'` 的组播完第 15 格再回到第 0 格，同一个姿势连播两遍
 * （@8fps 就是 125ms 的顿），用户看到的是「循环播放时顿一下」。
 *
 * ## 判据必须**按包围盒对齐**之后比像素
 *
 * 直接在格子原位比会虚高：腾云（`Climb`）那组载她的云在格内会横向漂，
 * 原位比对给出 MAD 23.5，看着像"完全不同的一张"，其实姿势是同一张。
 * 所以先把两格按各自内容包围盒的**中心**对齐，再在重叠且两边都不透明的像素上比。
 * 同一张图 → 对齐后 MAD ≈ 0；只是姿势相似 → 有几个单位。
 *
 * 月兔实测（原位 MAD ｜ 0↔末 vs 0↔末-1，越大越能说明"末格异常像首格"）：
 *   walk 2.73 vs 10.77、crawl 4.38 vs 22.38、fall 4.77 vs 32.90、
 *   sit 3.41 vs 9.08、picked 4.49 vs 11.29、idle 4.61 vs 10.37、purr 2.70 vs 2.75
 * —— 除 purr（姿势本来就几乎不动，两个数都小）之外**全部是循环组**，
 * 而所有 `once` 动作两个数都接近（wave 3.59/3.70、cheer 4.73/4.84）——
 * 这个对比本身就是判据的负对照。
 */

/** 一格的包围盒 + 亮度图（透明处 -1） */
function cellInfo(strip, c) {
  const { raw, W, H, CW } = strip
  let minX = 1e9
  let maxX = -1
  let minY = 1e9
  let maxY = -1
  const g = new Float64Array(CW * H).fill(-1)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < CW; x++) {
      const i = ((y * W) + c * CW + x) << 2
      if (raw[i + 3] < ALPHA) continue
      g[y * CW + x] = 0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { g, W: CW, H, box: { minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1 } }
}

/** 给定整数位移下比像素（透明/NaN 都不参与） */
function madAt(A, B, dx, dy) {
  let s = 0
  let n = 0
  for (let y = 0; y < A.H; y++) {
    const y2 = y + dy
    if (y2 < 0 || y2 >= B.H) continue
    for (let x = 0; x < A.W; x++) {
      const x2 = x + dx
      if (x2 < 0 || x2 >= B.W) continue
      const a = A.g[y * A.W + x]
      const b = B.g[y2 * B.W + x2]
      // `!(a >= 0)` 而不是 `a < 0`：NaN / undefined 都进不来（透明处记的是 -1）
      if (!(a >= 0) || !(b >= 0)) continue
      s += Math.abs(a - b)
      n++
    }
  }
  return { d: n ? s / n : 999, n }
}

/**
 * 在「包围盒中心对齐」附近搜 ±`range` 的整数位移，取最小 MAD。
 *
 * ⚠ **为什么要搜，而不是直接用包围盒中心对齐**（2026-09-25 实测踩的）：
 *   · 位移必须是整数——拿 0.5 去索引 `Float64Array` 得到 `undefined`，
 *     `undefined < 0` 又是 false，于是污染成 NaN（第一版就死在这）；
 *   · 而且包围盒中心**会被耳朵尖、飘起的发丝带跑**：`Sit` 末格按中心对齐平移 1px
 *     之后 MAD 从原位的 3.41 **涨到 16.56**——1px 错位在高对比描边上就够翻倍。
 *     按中心对齐会把"其实是复件"误判成"不重"，正是要避免的那类漏判。
 *   · 搜最小 MAD 则把姿势相同、只差几像素的两格真正认出来；`shift` 用去了多少
 *     仍作为信息返回（要平移很多才重合 = 不是复件，只是像）。
 */
function bestShiftMad(A, B, range = 4) {
  const sx = Math.round(B.box.minX + B.box.w / 2 - (A.box.minX + A.box.w / 2))
  const sy = Math.round(B.box.minY + B.box.h / 2 - (A.box.minY + A.box.h / 2))
  let best = { d: Infinity, n: 0, dx: sx, dy: sy }
  for (let dy = sy - range; dy <= sy + range; dy++) {
    for (let dx = sx - range; dx <= sx + range; dx++) {
      const m = madAt(A, B, dx, dy)
      if (m.d < best.d) best = { d: m.d, n: m.n, dx, dy }
    }
  }
  const boxDiff = Math.max(
    Math.abs(A.box.w - B.box.w) / Math.max(A.box.w, B.box.w),
    Math.abs(A.box.h - B.box.h) / Math.max(A.box.h, B.box.h),
  )
  return { d: best.d, n: best.n, boxDiff, shift: Math.round(Math.hypot(best.dx, best.dy)) }
}

/**
 * 末格是不是首格的复件。
 *
 * 判据三条同时成立才算复件（少一条就宁可保留，丢错一格会把循环跳变做得更糟）：
 *  1. 对齐后 MAD < `T_DUP`（同一张图）
 *  2. 明显比「0 ↔ 末-1」低一半以上（不是整个动作本来就静止）
 *  3. 包围盒尺寸差 < 6%（同一姿势）且对齐位移 < 25px
 *
 * ⚠ 反例（不能丢）：腾云原位 MAD 23.5，**如果只看原位 MAD 会判成"不重"**；
 *    而反过来 purr 两格都 2.7（整段近乎静止），只看第 1 条会误判——
 *    第 2 条就是拦它的。
 */
export async function probeWrap(png, cols, opts = {}) {
  const T_DUP = opts.tDup ?? 6
  const strip = typeof png === 'string' ? await loadStrip(png, cols) : png
  const c0 = cellInfo(strip, 0)
  const cE = cellInfo(strip, strip.cols - 1)
  const cP = cellInfo(strip, strip.cols - 2)
  if (!c0 || !cE || !cP) return { ok: false, why: '有格是空的' }
  const end = bestShiftMad(c0, cE, opts.range ?? 4)
  const prev = bestShiftMad(c0, cP, opts.range ?? 4)
  const dup = end.d < T_DUP && end.d < prev.d * 0.55 && end.boxDiff < 0.06 && end.shift <= 6
  return {
    ok: true,
    dup,
    dEnd: +end.d.toFixed(2),
    dPrev: +prev.d.toFixed(2),
    boxDiff: +(end.boxDiff * 100).toFixed(1),
    shift: end.shift,
    ratio: +(end.d / Math.max(prev.d, 0.01)).toFixed(2),
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('motion-signals.mjs')
if (isMain) {
  const argv = process.argv.slice(2)
  const mode = argv[0] === '--wrap' ? 'wrap' : 'facing'
  const dirs = argv.slice(1).filter((a) => !a.startsWith('--'))
  if (!dirs.length) {
    console.error('用法：node motion-signals.mjs [--facing|--wrap] <表目录...>（目录里有 f0000.png + f0000.json）')
    process.exit(2)
  }
  for (const d of dirs) {
    const png = path.join(d, 'f0000.png')
    if (!fs.existsSync(png)) {
      console.log(`${path.basename(d)}  ✗ 没有 f0000.png`)
      continue
    }
    let cols = 16
    try {
      cols = JSON.parse(fs.readFileSync(path.join(d, 'f0000.json'), 'utf8')).cols || 16
    } catch { /* 按 16 */ }
    const name = path.basename(d).replace(/^moonrabbit-/, '').replace(/-sheet$/, '')
    if (mode === 'wrap') {
      const r = await probeWrap(png, cols)
      console.log(
        `${name.padEnd(10)} ${r.ok ? `末格 MAD ${r.dEnd}｜末-1 ${r.dPrev}（比 ${r.ratio}）包围盒差 ${r.boxDiff}% 位移 ${r.shift}px  ${r.dup ? '✗ 是首格复件 → 循环该丢掉末格' : '✓ 不是复件'}` : r.why}`,
      )
    } else {
      const r = await probeFacing(png, cols, 'auto')
      console.log(
        `${name.padEnd(10)} ${r.ok ? `眼睛 ${Number.isFinite(r.eye) ? (r.eye * 100).toFixed(1) + '%' : 'n/a'}  最高列 ${r.hi.toFixed(2)}  ${r.prone ? '横构图 ' : ''}${r.verdict}` : r.why}`,
      )
    }
  }
  // sharp 的 libvips 线程池在 Windows 上会让进程赖着不退（实测活干完了还挂着几百秒），
  // 被别的脚本 import 时不会走到这里，只有直接跑 CLI 才需要主动退出。
  process.exit(0)
}
