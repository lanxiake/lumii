#!/usr/bin/env node
/**
 * stage-frame.mjs — 把一张角色图摆到 H3 的「生成画布」上
 *
 * ## 为什么必须摆
 *
 * H3 的 first_frame 不只是「一张图」，它是**机位标定**——模型会保持首帧里角色的
 * 大小、位置和朝向。精灵图要求所有动作、所有角色都在同一套坐标下（同一格、
 * 同一条脚底线），所以首帧必须先被摆到固定网格上。
 *
 * 参数照搬 sprite_h3 的 staging（fmmix/sprite_h3，MIT）：
 *   角色高度 = canvas_h × figure_height_ratio
 *   脚底落在 round(baseline_ratio × canvas_h) − 1 行
 *   水平居中
 *
 * ## 为什么要抠底后**重新铺**一层底色
 *
 * 源图那层"纯色底"其实不纯——实测一块 cyan 底的四角从 `28,220,227` 飘到
 * `51,202,216`，带渐变和噪声。抠底后重新铺一层**精确的** #00FFFF，后续
 * 每一帧的抠底阈值才有统一的分母，不然每张图都得重新估一次背景色。
 *
 * ## 为什么描边不能被啃掉
 *
 * `cutout()` 的容差是自动调的（`tuneSolid`），硬约束是「flood fill 容差必须
 * 小于描边色到底色的距离」。摆图前会打印实测的底色距离与容差，啃了描边
 * 一眼就能看出来（记忆「宠物渲染转精灵图」记过这个坑）。
 *
 * 用法：
 *   node stage-frame.mjs <源图> <输出.png> [--canvas WxH] [--ratio 0.70] [--baseline 0.856] [--bg 00ffff] [--keep-scale] [--src-h 448]
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { alphaBBox, cutout, distanceField, estimateBackground, floodOutside } from '../lib/cutout.mjs'

/**
 * 从可能含多只角色的源图里，框出**一只**。
 *
 * 为什么不按网格切：模型不总按你要的行列出图。实测 `cat-idle.png` 的提示词
 * 写的是"一行四列"，出来的却是 **2×2**——按 4 列切，每格横跨上下两只猫，
 * 包围盒变成 184×1145 这种又高又窄的怪比例，而且**看起来一切正常**
 * （切图没报错、staging 也没报错），只有比例数字透着不对劲。
 *
 * 改成认**连通域**：抠底后角色是一块连通的实心区域，取最大的那一块；
 * 再把与它包围盒相交的其他块并进来（辫子、尾巴这类可能跟身体断开）。
 */
function largestFigureBox(rgba, w, h, thr = 128) {
  const N = w * h
  const seen = new Uint8Array(N)
  const comps = []
  for (let i = 0; i < N; i++) {
    if (seen[i] || rgba[i * 4 + 3] <= thr) continue
    const q = [i]
    seen[i] = 1
    let minX = w, minY = h, maxX = -1, maxY = -1
    for (let head = 0; head < q.length; head++) {
      const j = q[head]
      const x = j % w
      const y = (j / w) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      const go = (k) => {
        if (!seen[k] && rgba[k * 4 + 3] > thr) {
          seen[k] = 1
          q.push(k)
        }
      }
      if (x > 0) go(j - 1)
      if (x < w - 1) go(j + 1)
      if (y > 0) go(j - w)
      if (y < h - 1) go(j + w)
    }
    comps.push({ minX, minY, maxX, maxY, area: q.length })
  }
  if (!comps.length) return null
  comps.sort((a, b) => b.area - a.area)
  const box = { ...comps[0] }
  const rest = comps.slice(1)
  const used = new Set()
  for (let changed = true; changed; ) {
    changed = false
    for (let i = 0; i < rest.length; i++) {
      if (used.has(i)) continue
      const c = rest[i]
      // 包围盒相交就并入；重新长出来的盒子可能又碰到别的块，所以循环到稳定
      if (c.minX <= box.maxX && c.maxX >= box.minX && c.minY <= box.maxY && c.maxY >= box.minY) {
        used.add(i)
        changed = true
        box.minX = Math.min(box.minX, c.minX)
        box.maxX = Math.max(box.maxX, c.maxX)
        box.minY = Math.min(box.minY, c.minY)
        box.maxY = Math.max(box.maxY, c.maxY)
      }
    }
  }
  return { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY, w: box.maxX - box.minX + 1, h: box.maxY - box.minY + 1, components: comps.length, merged: used.size }
}

/**
 * 选 flood fill 的实心容差。默认 48，取自 sprite_h3 的实测值
 * （`background_tolerance = 48`）。
 *
 * **不用 `tuneSolid`**：它的策略是「逐步放宽容差、找填充面积突增的泄漏点」，
 * 那套在**背景很脏**时管用，在**背景很纯**时反而失效——面积压根不随容差变，
 * 它找不到突增点，于是退回上限 254（实测这张 base 图就是如此：距离分布
 * 76.8% 挤在 0~40，角色主体在 240 以上，中间 40~200 一个像素都没有，
 * 而 tuneSolid 给了 254，flood fill 直接把角色啃掉）。
 *
 * 48 落在那个空档里，两边都够不着。返回值里的 `bgMax` 是**实测**的背景
 * 距离上界（在 48 下 flood 一遍，取被填像素的 P99.5）——它离 48 多远，
 * 就是这次抠底有多少余量。
 */
function autoSolid(rgba, w, h, B, tSolid = 48) {
  const d = distanceField(rgba, w, h, B)
  const outside = floodOutside(d, w, h, tSolid)
  const vals = []
  for (let i = 0; i < d.length; i++) if (outside[i]) vals.push(d[i])
  if (!vals.length) return { tSolid, bgMax: 0, bgShare: 0 }
  vals.sort((a, b) => a - b)
  return {
    tSolid,
    bgMax: vals[Math.floor(vals.length * 0.995)],
    bgShare: vals.length / d.length,
  }
}

const argv = process.argv.slice(2)
const src = argv[0]
const dst = argv[1]
if (!src || !dst) {
  console.error('用法：node stage-frame.mjs <源图> <输出.png> [--canvas WxH] [--ratio 0.70] [--baseline 0.856] [--bg 00ffff] [--keep-scale] [--src-h 448]')
  process.exit(1)
}
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}
const canvasArg = opt('canvas', 'auto')
/** null = 按角色比例自动选（见 stageFrame 里的说明） */
const CANVAS = canvasArg === 'auto' ? null : canvasArg.split('x').map(Number)
const RATIO = Number(opt('ratio', 0.7))
const BASELINE = Number(opt('baseline', 0.856))
const BGC = opt('bg', '00ffff')
/**
 * `--keep-scale`：**不按 `--ratio` 重摆**，保持图形在**源画布里的比例**，
 * 只重新铺底 + 重新落位。
 *
 * 姿势图专用。几个侧身循环（walk/climb/crawl/fall）都从同一张侧身首帧生成，
 * **本来共用一个尺度**——H3 会把首帧的体型一路保持下去。如果每张姿势图都按
 * `--ratio 0.70` 重摆，等于把各自的高度强拉成一样：下落姿势本来就矮
 * （实测 388 vs 站立 472），强拉会让猫凭空放大 21%，切动作时肉眼可见地跳一下。
 *
 * ⚠ **"保持比例"是相对源画布，不是保持像素**（2026-09-22 修）。
 * 原先写的是 `targetH = box.h`（原样像素），这对**整幅帧**（源画布 768×672 →
 * 目标画布 768×672）恰好等价，但它对**拼条里裁出来的那一格**是错的：
 * 拼条的格是生成画布按 `cellH/canvasH` 缩过的（768×672 → 512×448），
 * 拿格的像素高度当画布像素高度，角色会**再缩 0.667 倍**。
 * 实测爬行就是这样：格空间里 229px（站立 313px 的 73%），
 * 摆完只剩 153px（49%）——**猫看着小一圈，头都比走路那格小**。
 * 所以改成按比例：`targetH = box.h / srcH × ch`，`--src-h` 说明源画布的参考高度。
 * 不传时默认等于目标画布高，与旧行为逐像素一致。
 */
const KEEP_SCALE = argv.includes('--keep-scale')

/**
 * `--src-h <n>`：**源图的参考画布高度**（`--keep-scale` 下用来换算比例）。
 *
 * 整幅帧就传画布高（或不传）；拼条里裁出来的格传**格高**。
 * 不传 = 目标画布高，即旧的"保持像素"语义。
 */
const SRC_H = Number(opt('src-h', 0)) || null

/**
 * 摆一张图。返回 staging 元数据（后续 frame-0 snap 要拿它当参考）。
 *
 * 元数据里的 `figureHeightPx` 是关键：H3 出的第 0 帧理应复现这张参考图，
 * 但实测总会有出入——用第 0 帧的角色高度除以这个值，就是这一整段的
 * 全局缩放系数（**整段共用一个变换**，逐帧对齐会让画面抖）。
 */
export async function stageFrame(srcPath, dstPath, { canvas = CANVAS, ratio = RATIO, baseline = BASELINE, bg = BGC, keepScale = KEEP_SCALE, srcH = SRC_H } = {}) {
  const bgRGB = [0, 2, 4].map((i) => parseInt(bg.slice(i, i + 2), 16))
  const { data, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })

  const B = estimateBackground(data, info.width, info.height)
  const { tSolid, bgMax, bgShare } = autoSolid(data, info.width, info.height, B)
  // ⚠ cutout() 返回的是 { data, tuning, opaqueCount, semiCount }，**不是** Buffer。
  // 把它当像素缓冲用会得到一整片 undefined，症状是 alphaBBox 返回 null、
  // 「抠底后没有找到任何前景」——这个坑踩过一次。
  const { data: cut } = cutout(data, info.width, info.height, B, { tSolid })
  const box = largestFigureBox(cut, info.width, info.height, 128)
  if (!box) throw new Error('抠底后没有找到任何前景——源图可能整张都是背景色')

  // 画布比例跟着**客户端的宠物格**走。
  //
  // 客户端宠物格统一是 0.857 的宽高比（`demo_cartoon_cat` 144×168、
  // `demo_anime_girl` 384×448，两个都是 0.857）。生成画布用同一比例，
  // 缩到格子时既不裁切也不留空边——比例对不上就得二选一。
  //
  // 576×672 与 640×640 像素量相当（0.39MP vs 0.41MP），但格子能开到
  // 384×448（角色 313px）而不是 128×128（角色 96px），放大后清楚得多。
  const aspect = box.w / box.h
  const [cw, ch] = canvas || [576, 672]
  // ⚠ 这里**不能**拿「图形宽高比 vs 画布宽高比」判溢出。那个判据假设图形按高度
  // 撑满画布，而 `ratio < 1` 时图形根本没占满高度——实测侧身下落姿势宽高比 1.33
  // 就被它拦下，而按 ratio 0.70 摆出来只有 625px 宽，768 的画布绰绰有余。
  // 真正的判据是**摆完之后的实际尺寸**，由下面 `targetW > cw` 那道负责。
  // 保留这一句只为了把"这个画布形状根本装不下这个体型"提早说清楚。
  // 比例口径：源画布高 → 目标画布高。不传 `--src-h` 时退化成"保持像素"（旧行为）
  const refH = srcH ?? ch
  const targetH = keepScale ? Math.round((box.h / refH) * ch) : Math.round(ratio * ch)
  const scale = targetH / box.h
  const targetW = Math.round(box.w * scale)
  if (targetW > cw || targetH > ch) {
    throw new Error(
      `角色 ${targetW}×${targetH}px 在 ${cw}×${ch} 画布上放不下（宽高比 ${aspect.toFixed(2)}）；` +
        `用 --canvas 指定更大的画布，或调小 --ratio`,
    )
  }

  const figure = await sharp(cut, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract({ left: box.minX, top: box.minY, width: box.w, height: box.h })
    .resize(targetW, targetH, { kernel: 'lanczos3' })
    .png()
    .toBuffer()

  const baselineRow = Math.min(ch - 1, Math.max(0, Math.round(baseline * ch) - 1))
  const top = baselineRow - targetH + 1
  const left = Math.round((cw - targetW) / 2)
  if (top < 0 || targetW > cw) {
    throw new Error(
      `角色 ${targetW}×${targetH}px（ratio ${ratio}）在 ${cw}×${ch} 画布上放不下：` +
        `脚底线在第 ${baselineRow} 行，头顶会跑到第 ${top} 行。调小 --ratio 或调大 --baseline`,
    )
  }

  fs.mkdirSync(path.dirname(path.resolve(dstPath)), { recursive: true })
  await sharp({ create: { width: cw, height: ch, channels: 3, background: { r: bgRGB[0], g: bgRGB[1], b: bgRGB[2] } } })
    .composite([{ input: figure, left, top }])
    .png()
    .toFile(dstPath)

  const meta = {
    source: path.basename(srcPath),
    canvas: { w: cw, h: ch },
    aspect: Number(aspect.toFixed(3)),
    // 记**实际**占比，不是 `--ratio` 的入参：`--keep-scale` 下没按 ratio 缩放，
    // 而下游（buildPrompt 的 "fills about N percent"）读的就是这个字段，
    // 记成入参会写出跟画面矛盾的提示词。
    figureHeightRatio: Number((targetH / ch).toFixed(3)),
    baselineRatio: baseline,
    keepScale,
    background: `#${bg}`,
    estimatedBackground: `rgb(${B.join(',')})`,
    solidTolerance: tSolid,
    backgroundMaxDistance: Number(bgMax.toFixed(1)),
    backgroundShare: Number((bgShare * 100).toFixed(1)),
    sourceBBox: box,
    figureHeightPx: targetH,
    figureWidthPx: targetW,
    placement: { left, top, baselineRow },
  }
  return meta
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const meta = await stageFrame(src, dst)
  // snap 要拿这份元数据当参考（角色高度、基线行），所以得能落盘
  const metaPath = opt('meta')
  if (metaPath) {
    fs.mkdirSync(path.dirname(path.resolve(metaPath)), { recursive: true })
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8')
    console.log(`元数据 → ${metaPath}`)
  }
  console.log(JSON.stringify(meta, null, 2))
  console.log(`\n✓ ${dst}`)
}
