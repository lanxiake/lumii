/**
 * mock-perch —— 把「客户端此刻会画成什么样」合成出来看
 *
 * 宠物窗口是透明 + WebGL，`lumii-ui screenshot` 抓到全黑（见实施记录 §六.4），
 * 而宠物动作的对错（头朝哪、脚够不够得到天花板、离墙几像素）**只能看**——
 * 数字算不出朝向。所以退一步：按 manifest 的 canvas/anchor/scale 与 pet-core 的
 * 摆位公式，把图集里的格贴到一个模拟屏幕上，再交给 `pixel-ascii --auto` 看。
 *
 * 屏幕上的一切都按**真实像素**算（贴边、缝隙、翻转绕锚点），只在输出时乘
 * `--zoom`，这样"宠物有没有压到墙"与屏幕上看到的是同一个数。
 *
 * 用法：
 *   node mock-perch.mjs <模型目录> <out.png> [选项]
 *     --case 现状|未翻转|对比  贴哪几路（见下）
 *     --view x,y,w,h          模拟屏幕的取景框，屏幕坐标（默认 0,0,320,320）
 *     --zoom 3                输出倍率
 *     --scale 0.2437          宠物缩放（默认取 registry 常见值）
 *     --silhouette            只留剪影——浅色角色压在浅色底上，只按亮度看会糊成一片
 *   然后：
 *     node pixel-ascii.mjs /tmp/mock.png 100 --auto
 */
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const dir = argv[0]
const outPng = argv[1]
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const SCALE = Number(opt('scale', 0.2437))
const CASE = opt('case', '现状')
const ZOOM = Number(opt('zoom', 3))
const [VX, VY, VW, VH] = opt('view', '0,0,320,320').split(',').map(Number)
const SILHOUETTE = argv.includes('--silhouette')

const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
const atlas = JSON.parse(fs.readFileSync(path.join(dir, 'atlas.json'), 'utf8'))
const [ANC_X, ANC_Y] = man.anchor
const MODEL_H = man.canvas.h * SCALE

const W = Math.round(VW * ZOOM)
const H = Math.round(VH * ZOOM)
const base = await sharp({
  create: { width: W, height: H, channels: 4, background: { r: 250, g: 250, b: 252, alpha: 1 } },
})
  .png()
  .toBuffer()
const layers = []

// 屏幕的边缘画成实心深色带（屏外区域），好看清"贴到没有"
function band(x, y, w, h) {
  if (w <= 0 || h <= 0) return
  layers.push({
    input: { create: { width: Math.round(w), height: Math.round(h), channels: 4, background: { r: 40, g: 40, b: 48, alpha: 1 } } },
    left: Math.round((x - VX) * ZOOM),
    top: Math.round((y - VY) * ZOOM),
  })
}
band(VX, VY, -VX, VH) // 屏幕左边之外
band(VX, VY, VW, -VY) // 屏幕上边之外

/**
 * 把一格摆到屏幕上，锚点落在 `(ax, ay)`（屏幕坐标，真实像素）。
 *
 * 翻转**绕锚点**做——与 `SpritePetRenderer` 一致（`root.scale` 与 pivot 的关系，
 * 见那里的注释）。整格翻完之后锚点自身的位置也跟着挪了，要补回来：
 * `flop` 把列 x 送到 `w-1-x`，`flip` 把行 y 送到 `h-1-y`。
 */
async function place(name, ax, ay, flipX = false, flipY = false, ink = [0.15, 0.15, 0.2]) {
  const fr = atlas.frames[name].frame
  let buf = await sharp(path.join(dir, 'atlas.png'))
    .extract({ left: fr.x, top: fr.y, width: fr.w, height: fr.h })
    .png()
    .toBuffer()
  let ancX = ANC_X
  let ancY = ANC_Y
  if (flipX) {
    buf = await sharp(buf).flop().png().toBuffer()
    ancX = fr.w - 1 - ANC_X
  }
  if (flipY) {
    buf = await sharp(buf).flip().png().toBuffer()
    ancY = fr.h - 1 - ANC_Y
  }
  const w = Math.max(1, Math.round(fr.w * SCALE * ZOOM))
  const h = Math.max(1, Math.round(fr.h * SCALE * ZOOM))
  let small = await sharp(buf).resize(w, h).png().toBuffer()
  if (SILHOUETTE) {
    const { data, info } = await sharp(small).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    for (let i = 0; i < info.width * info.height; i++) {
      if (data[i * 4 + 3] > 8) {
        data[i * 4] = Math.round(ink[0] * 255)
        data[i * 4 + 1] = Math.round(ink[1] * 255)
        data[i * 4 + 2] = Math.round(ink[2] * 255)
      }
    }
    small = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
  }
  layers.push({
    input: small,
    left: Math.round((ax - ancX * SCALE - VX) * ZOOM),
    top: Math.round((ay - ancY * SCALE - VY) * ZOOM),
  })
}

/**
 * 攀附几何**从清单读**，不要写死。
 *
 * 写死的那一套（`0.43 / 0.99`）是 Shimeji 素材的实测值，而这张图要回答的正是
 * "**这只**宠物贴边的几何对不对"。清单里没写时退化成 `PERCH_DEFAULTS`——
 * 于是"没量过"这件事会在图上自己暴露出来（宠物悬在半空），而不是被悄悄画对。
 */
const gapRatios = man.perchGaps ?? { wall: 0.43, ceiling: 0.99 }
if (!man.perchGaps) {
  console.log('⚠ 清单里没有 perchGaps → 按 pet-core 兜底值 0.43 / 0.99 画（那是 Shimeji 的实测值）')
}
const gap = MODEL_H * gapRatios.wall // screenWallX('left')
const ceilingGap = MODEL_H * gapRatios.ceiling // ceilingY

const GREY = [0.45, 0.45, 0.5]

if (CASE === '现状') {
  // 现在装的就是这一路：清单里的 perchGaps + 已经翻好的 Crawl 行
  await place('cat_climb_00', gap, 260, true)
  await place('cat_crawl_00', 230, ceilingGap, false, false, GREY)
} else if (CASE === '未翻转') {
  // 对照：同一套几何，但把倒挂那一行翻回来（= 用户报的"反了"）
  await place('cat_climb_00', gap, 260, true)
  await place('cat_crawl_00', 230, ceilingGap, false, true, GREY)
} else if (CASE === '对比') {
  // 同一条上沿上摆两路，直接对比"翻"与"不翻"
  await place('cat_crawl_00', 120, 60, false, true, GREY)
  await place('cat_crawl_00', 240, 60, false, false)
}

fs.writeFileSync(outPng, await sharp(base).composite(layers).png().toBuffer())
console.log(
  `wrote ${outPng}  ${W}x${H}  zoom=${ZOOM}  scale=${SCALE}  modelH=${MODEL_H.toFixed(1)}  ` +
    `perchGaps=${JSON.stringify(gapRatios)} → 离墙 ${gap.toFixed(1)}px、上沿下 ${ceilingGap.toFixed(1)}px`,
)
