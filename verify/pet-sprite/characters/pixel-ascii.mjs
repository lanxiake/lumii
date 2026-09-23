#!/usr/bin/env node
/**
 * pixel-ascii.mjs — 把任意一张图降采样成字符画
 *
 * ## 为什么需要（而不是"打开看看"）
 *
 * 本机 Read 工具读不了图（png/jpg 都报 Unsupported Image，转码也没用——见记忆
 * 「Lumii 实测入口与 dev 重载」）。所有"这个形状对不对"的判断都得落到字符上。
 * `sheet-ascii.mjs` 是给 shimeji 表写的（固定 128 格、按行取），单图用不了。
 *
 * ## 怎么读这幅画
 *
 * **默认取内容包围盒**再降采样——角色通常只占画面三分之一，画满画布等于浪费分辨率。
 * 每个字符格取该块内所有像素的**平均亮度**，映射到 ` .:-=+*#%@`（暗→亮）。
 * 完全透明的块打空格。所以：
 *
 *   · 空格的边界 = 抠底抠出来的轮廓
 *   · 字符的疏密 = 明暗，粗描边会显成一条深色边
 *
 * `--alpha` 换一种画法：忽略亮度，只按**不透明像素占比**打字符。判断
 * "这 4 帧的形状是不是真的在变"用这个，因为它不受配色影响。
 *
 * `--box` 只打印包围盒不画图，用来快速比对两张图的取景差多少。
 *
 * ## 三种"默认画不了"的图（都是实测撞上的）
 *
 * 1. **截屏**（宠物窗口 2560×1400）——按包围盒裁会把桌面/浮层全算进去，
 *    而且宠物只占几十像素。用 `--crop x,y,w,h` 指定取景框，**同时关掉自动裁剪**。
 * 2. **浅色角色压在浅色底上**（团子是奶白的，底色 242）——固定亮度映射会把整只猫
 *    塌成几个点。用 `--auto` 按 2%~98% 分位数拉伸。
 * 3. **没抠底的源图**（H3 出的 staged 帧是实心纯色底）——先 `--bg 00ccff` 抠一遍。
 *
 * 用法：
 *   node pixel-ascii.mjs <图...> [宽 默认 72] [--alpha] [--box]
 *                         [--crop x,y,w,h] [--auto] [--bg RRGGBB]
 */
import sharp from 'sharp'

const VALUED = new Set(['crop', 'bg'])
const argv = process.argv.slice(2)
const files = []
const opts = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const name = a.slice(2)
    if (VALUED.has(name)) opts.set(name, argv[++i])
    else opts.set(name, true)
  } else if (/^\d+$/.test(a) && files.length > 0 && !opts.has('width')) {
    // 位置参数里的纯数字当宽度（`<图> [宽]`），图名本身几乎不会是纯数字
    opts.set('width', a)
  } else {
    files.push(a)
  }
}
const useAlpha = opts.get('alpha') === true
const boxOnly = opts.get('box') === true
const autoLevel = opts.get('auto') === true
const CROP = opts.get('crop') ?? null
const BG = opts.get('bg') ?? null
if (files.length === 0) {
  throw new Error('用法：node pixel-ascii.mjs <图...> [宽] [--alpha] [--box] [--crop x,y,w,h] [--auto] [--bg RRGGBB]')
}

const CW = Number(opts.get('width') ?? 72)
const ALPHA_MIN = 8
const BG_TOL = 48
/** 亮度字符梯（暗 → 亮）。`--alpha` 模式复用它的后半段 */
const ramp = ' .:-=+*#%@'

/** 把纯色底抠成透明（H3 那套是精确纯色底，直接比通道距离就够） */
function keyOut(data, C, W, H, hex) {
  const h = hex.replace('#', '')
  const b = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16))
  for (let i = 0; i < W * H; i++) {
    const p = i * C
    const dist = Math.max(
      Math.abs(data[p] - b[0]),
      Math.abs(data[p + 1] - b[1]),
      Math.abs(data[p + 2] - b[2]),
    )
    data[p + 3] = dist < BG_TOL ? 0 : 255
  }
}

/** 字符梯的下标：**两头都要夹**。`--auto` 会让拉伸后的亮度落到 0 以下
 *  （2% 分位之外本来就有更暗的像素），只夹上界的话 `ramp[-3]` 是 `undefined`，
 *  画面上直接打出 "undefined" 字样。 */
const at = (v) => ramp[Math.max(0, Math.min(9, v))]

for (const file of files) {
  let img = sharp(file)
  if (CROP) {
    const [cx, cy, cw, ch] = CROP.split(',').map(Number)
    const meta = await sharp(file).metadata()
    img = sharp(
      await img
        .extract({
          left: cx,
          top: cy,
          width: Math.min(cw, meta.width - cx),
          height: Math.min(ch, meta.height - cy),
        })
        .png()
        .toBuffer(),
    )
  }
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H, channels: C } = info
  if (BG) keyOut(data, C, W, H, BG)

  // 取景框：`--crop` 已经裁好了，就用整幅；否则取内容包围盒
  let x0 = 0
  let y0 = 0
  let x1 = W - 1
  let y1 = H - 1
  if (!CROP) {
    x0 = W
    x1 = -1
    y0 = H
    y1 = -1
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * C + 3] <= ALPHA_MIN) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    if (x1 < 0) {
      console.log(`${file}: 整张全透明`)
      continue
    }
  }
  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1
  const tag = files.length > 1 ? `\n=== ${file}` : `${file}`
  console.log(`${tag}  ${W}×${H}  取景 ${bw}×${bh} @ (${x0},${y0})  占比 ${((100 * bw * bh) / (W * H)).toFixed(1)}%`)
  if (boxOnly) continue

  // `--auto`：按分位数拉伸亮度。截屏里的角色往往只比底深一点点
  // （实测宠物窗口底色 242、猫身 210、描边 60），固定映射会把整只猫塌成几个点。
  let lo = 0
  let hi = 255
  if (autoLevel) {
    const g = []
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = (y * W + x) * C
        if (data[p + 3] <= ALPHA_MIN) continue
        g.push(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2])
      }
    }
    g.sort((a, b) => a - b)
    lo = g[Math.floor(g.length * 0.02)] ?? 0
    hi = g[Math.floor(g.length * 0.98)] ?? 255
    if (hi - lo < 8) hi = lo + 8
  }

  // 终端字符高约为宽的两倍，纵向压一半补偿
  const CH = Math.max(1, Math.round((CW * bh) / bw / 2))
  const stepX = bw / CW
  const stepY = bh / CH

  const lines = []
  for (let gy = 0; gy < CH; gy++) {
    let line = ''
    for (let gx = 0; gx < CW; gx++) {
      let alphaSum = 0
      let lumSum = 0
      let total = 0
      const sx = Math.floor(x0 + gx * stepX)
      const ex = Math.max(sx + 1, Math.floor(x0 + (gx + 1) * stepX))
      const sy = Math.floor(y0 + gy * stepY)
      const ey = Math.max(sy + 1, Math.floor(y0 + (gy + 1) * stepY))
      for (let y = sy; y < ey && y < H; y++) {
        for (let x = sx; x < ex && x < W; x++) {
          const i = (y * W + x) * C
          total++
          if (data[i + 3] > ALPHA_MIN) {
            alphaSum++
            lumSum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
          }
        }
      }
      if (total === 0) {
        line += ' '
        continue
      }
      if (useAlpha) {
        const v = alphaSum / total
        line += v < 0.08 ? ' ' : at(1 + Math.floor(v * 9))
      } else if (alphaSum / total < 0.35) {
        // 块内多半是透明 → 当轮廓外的空格，别让零星残留把形状糊掉
        line += ' '
      } else {
        let lum = lumSum / alphaSum
        if (autoLevel) lum = ((lum - lo) / (hi - lo)) * 255
        line += at(Math.floor((lum / 255) * 10))
      }
    }
    lines.push(line)
  }
  console.log(lines.join('\n'))
}
