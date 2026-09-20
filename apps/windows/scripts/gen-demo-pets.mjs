/**
 * gen-demo-pets.mjs — 程序化生成双示范模型与三方案变体
 *
 * 用法：node scripts/gen-demo-pets.mjs [--out <目录>]
 * 默认输出到 apps/windows/resources/pet-models/
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §4.2 / §7
 *
 * **两个示范模型共用一份几何描述，只是光栅化方式不同**（设计 §7：「两个模型共用动作集与
 * 清单结构，仅美术风格不同；实质是同一份清单跑两条采样路径」）。因此：
 *
 *   像素模型   → 手写扫描转换，硬边、无抗锯齿、固定调色板
 *   2D 高清模型 → 同一份几何描述转成 SVG，由 sharp 光栅化，有抗锯齿与渐变
 *
 * 三方案变体也从同一份几何描述派生，**差异只来自资源组织方式**，不来自美术内容——
 * 否则对比就失去意义。
 *
 * 这是**占位素材**：设计 §7 明确「本期用占位素材验证渲染链路，量产链路单独立项」。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = path.resolve(__dirname, '..', 'resources', 'pet-models')

// ---------------------------------------------------------------------------
// 角色几何描述（与美术风格无关）
// ---------------------------------------------------------------------------
//
// 形状原语只有三种，够画一个可辨认的小角色，也够让两种光栅化后端各自实现。
// 坐标全部在「清单画布」坐标系里，锚点取脚底中心。

/** 角色画布 */
const CANVAS = { w: 48, h: 56 }
/** 锚点：脚底中心 */
const ANCHOR = [CANVAS.w / 2, CANVAS.h - 2]

/** 身体姿态：三帧，靠轻微起伏区分 */
const BODY_POSES = [
  { name: 'body_00', lift: 0 },
  { name: 'body_01', lift: 1 },
  { name: 'body_02', lift: 0 },
]

/**
 * 动作专用姿态。与待机姿态分开列：待机是循环的身体起伏，动作是「抬手/低头/左右摇」
 * 这类有语义的单次姿态，混在一起会让待机轮播随机播到挥手。
 */
const ACTION_POSES = {
  wave: [
    { name: 'wave_00', lift: 0, pawLift: 0 },
    { name: 'wave_01', lift: 1, pawLift: 7 },
  ],
  nod: [
    { name: 'nod_00', lift: 0 },
    { name: 'nod_01', lift: -2 },
  ],
  shake: [
    { name: 'shake_00', lift: 0, lean: -2 },
    { name: 'shake_01', lift: 0, lean: 2 },
  ],
}

/** 表情（眼睛层）：四款，供 P0-b 对比用；量产按设计 §4.2 的 12 款外推 */
const EYES = [
  'eye_open', 'eye_shut', 'eye_happy', 'eye_sad',
  'eye_angry', 'eye_surprised', 'eye_wink', 'eye_half',
  'eye_sparkle', 'eye_sleepy', 'eye_cry', 'eye_love',
]
/** 口型（嘴层）：四档，对应 setMouthOpen 的四个等分档 */
const MOUTHS = ['m0', 'm1', 'm2', 'm3']

/**
 * 身体形状表。
 *
 * @param {number} lift 整体上抬像素（做上下浮动）
 * @param {number} pawLift 左前爪抬高像素（挥手用）
 * @param {number} lean 整体水平偏移（摇头/歪头用）
 */
function bodyShapes(lift, pawLift = 0, lean = 0) {
  const cx = CANVAS.w / 2 + lean
  const headY = 20 - lift
  const bodyY = 40 - lift
  return [
    // 耳朵（先画，让头部盖住根部）
    { kind: 'poly', points: [[12 + lean, headY - 4], [18 + lean, headY - 16], [26 + lean, headY - 6]], fill: '#6b4a2f', stroke: '#2a1c12' },
    { kind: 'poly', points: [[36 + lean, headY - 4], [30 + lean, headY - 16], [22 + lean, headY - 6]], fill: '#6b4a2f', stroke: '#2a1c12' },
    // 身体
    { kind: 'ellipse', cx, cy: bodyY + 6, rx: 15, ry: 13, fill: '#a9743f', stroke: '#2a1c12' },
    // 头
    { kind: 'ellipse', cx, cy: headY + 6, rx: 16, ry: 13, fill: '#c98f52', stroke: '#2a1c12' },
    // 前爪（左爪可抬）
    { kind: 'ellipse', cx: cx - 13, cy: bodyY + 15 - pawLift, rx: 6, ry: 4, fill: '#e8d3b0', stroke: '#2a1c12' },
    { kind: 'ellipse', cx: cx + 13, cy: bodyY + 15, rx: 6, ry: 4, fill: '#e8d3b0', stroke: '#2a1c12' },
    // 尾巴
    { kind: 'ellipse', cx: cx + 16, cy: bodyY + 2, rx: 7, ry: 4, fill: '#a9743f', stroke: '#2a1c12' },
  ]
}

/**
 * 眼睛形状表：12 款，对齐设计 §4.2 的目标表情数。
 *
 * 全部用现有的三种图元（圆 / 圆角矩形 / 多边形）拼出来，不引入新的绘制能力——
 * 素材是占位用的，重点是让「12 表情 × 4 口型」的组合数成立，不是画得多好看。
 */
function eyeShapes(kind) {
  const cx = CANVAS.w / 2
  const y = 24
  const dx = 7
  const ink = '#2a1c12'
  const white = '#ffffff'
  const fur = '#c98f52'

  /** 一只圆眼：白底 + 黑瞳 */
  const openEye = (x, r = 4, ry = 5, pupil = 2) => [
    { kind: 'ellipse', cx: x, cy: y + 2, rx: r, ry, fill: white, stroke: ink },
    { kind: 'ellipse', cx: x, cy: y + 2, rx: pupil, ry: pupil + 1, fill: ink },
  ]
  /** 一条横线眼 */
  const lineEye = (x, w = 8) => [{ kind: 'rect', x: x - w / 2, y: y + 1, w, h: 2, r: 1, fill: ink }]
  /** 上凸弧（笑眼） */
  const arcEye = (x) => [
    { kind: 'ellipse', cx: x, cy: y + 3, rx: 4, ry: 3, fill: ink },
    { kind: 'ellipse', cx: x, cy: y + 5, rx: 4, ry: 3, fill: fur },
  ]
  /** 眉毛：角度用两端高度差表达 */
  const brow = (x, inner, outer) => [
    { kind: 'poly', points: [[x - 5, y - 5 - inner], [x + 5, y - 5 - outer], [x + 5, y - 2 - outer], [x - 5, y - 2 - inner]], fill: ink },
  ]

  switch (kind) {
    case 'eye_shut':
      return [...lineEye(cx - dx), ...lineEye(cx + dx)]
    case 'eye_happy':
      return [...arcEye(cx - dx), ...arcEye(cx + dx)]
    case 'eye_sad':
      return [...openEye(cx - dx, 3, 4, 3), ...openEye(cx + dx, 3, 4, 3), ...brow(cx - dx, 0, 3), ...brow(cx + dx, 3, 0)]
    case 'eye_angry':
      return [...openEye(cx - dx, 4, 3, 2), ...openEye(cx + dx, 4, 3, 2), ...brow(cx - dx, 3, 0), ...brow(cx + dx, 0, 3)]
    case 'eye_surprised':
      return [...openEye(cx - dx, 5, 6, 1), ...openEye(cx + dx, 5, 6, 1)]
    case 'eye_wink':
      return [...openEye(cx - dx), ...lineEye(cx + dx)]
    case 'eye_half':
      return [
        ...openEye(cx - dx, 4, 5, 2),
        ...openEye(cx + dx, 4, 5, 2),
        // 上眼皮压下来一半
        { kind: 'ellipse', cx: cx - dx, cy: y - 1, rx: 5, ry: 3, fill: fur },
        { kind: 'ellipse', cx: cx + dx, cy: y - 1, rx: 5, ry: 3, fill: fur },
      ]
    case 'eye_sparkle':
      return [
        ...openEye(cx - dx, 5, 6, 3),
        ...openEye(cx + dx, 5, 6, 3),
        // 高光点
        { kind: 'ellipse', cx: cx - dx - 1, cy: y, rx: 1, ry: 1, fill: white },
        { kind: 'ellipse', cx: cx + dx - 1, cy: y, rx: 1, ry: 1, fill: white },
      ]
    case 'eye_sleepy':
      return [
        ...lineEye(cx - dx, 8),
        ...lineEye(cx + dx, 8),
        // 半睁的下缘
        { kind: 'rect', x: cx - dx - 4, y: y + 3, w: 8, h: 1, fill: ink },
        { kind: 'rect', x: cx + dx - 4, y: y + 3, w: 8, h: 1, fill: ink },
      ]
    case 'eye_cry':
      return [
        ...lineEye(cx - dx),
        ...lineEye(cx + dx),
        // 泪滴
        { kind: 'poly', points: [[cx - dx, y + 4], [cx - dx - 2, y + 9], [cx - dx + 2, y + 9]], fill: '#5aa9e6' },
        { kind: 'poly', points: [[cx + dx, y + 4], [cx + dx - 2, y + 9], [cx + dx + 2, y + 9]], fill: '#5aa9e6' },
      ]
    case 'eye_love':
      return [
        // 心形：两个圆 + 一个倒三角
        { kind: 'ellipse', cx: cx - dx - 2, cy: y, rx: 3, ry: 3, fill: '#e0466e' },
        { kind: 'ellipse', cx: cx - dx + 2, cy: y, rx: 3, ry: 3, fill: '#e0466e' },
        { kind: 'poly', points: [[cx - dx - 5, y + 1], [cx - dx + 5, y + 1], [cx - dx, y + 8]], fill: '#e0466e' },
        { kind: 'ellipse', cx: cx + dx - 2, cy: y, rx: 3, ry: 3, fill: '#e0466e' },
        { kind: 'ellipse', cx: cx + dx + 2, cy: y, rx: 3, ry: 3, fill: '#e0466e' },
        { kind: 'poly', points: [[cx + dx - 5, y + 1], [cx + dx + 5, y + 1], [cx + dx, y + 8]], fill: '#e0466e' },
      ]
    case 'eye_open':
    default:
      return [...openEye(cx - dx), ...openEye(cx + dx)]
  }
}

/**
 * 道具形状表（scene 槽的部件）。
 *
 * 画在角色右爪附近——scene 槽在图层顺序上排在身体之后，所以道具会**压在角色身上**，
 * 看起来像被拿着/举着，而不是飘在旁边。
 *
 *  返回空形状表 → 整张图全透明。这是不显示道具的表达方式，
 * 不需要为它加任何特判：对齐时全透明帧会被排除出基准计算，打包时照常占一个格子。
 */
function propShapes(kind) {
  const x = 34
  const y = 33
  const ink = '#2a1c12'
  switch (kind) {
    case 'prop_ball':
      return [
        { kind: 'ellipse', cx: x, cy: y, rx: 5, ry: 5, fill: '#4a9de0', stroke: ink },
        { kind: 'ellipse', cx: x - 1, cy: y - 1, rx: 2, ry: 2, fill: '#bfe3ff' },
      ]
    case 'prop_star':
      return [
        {
          kind: 'poly',
          points: [[x, y - 6], [x + 2, y - 2], [x + 6, y - 2], [x + 3, y + 1], [x + 4, y + 5], [x, y + 3], [x - 4, y + 5], [x - 3, y + 1], [x - 6, y - 2], [x - 2, y - 2]],
          fill: '#f2c744',
          stroke: ink,
        },
      ]
    case 'prop_heart':
      return [
        { kind: 'ellipse', cx: x - 2, cy: y - 2, rx: 3, ry: 3, fill: '#e0466e', stroke: ink },
        { kind: 'ellipse', cx: x + 2, cy: y - 2, rx: 3, ry: 3, fill: '#e0466e', stroke: ink },
        { kind: 'poly', points: [[x - 5, y - 1], [x + 5, y - 1], [x, y + 5]], fill: '#e0466e', stroke: ink },
      ]
    case 'prop_none':
    default:
      return []
  }
}

const PROPS = ['prop_none', 'prop_ball', 'prop_star', 'prop_heart']

/**
 * 场景/道具动画：同一段动作里切换道具，演示 scene 槽是能被帧驱动的普通槽位。
 *
 * 刻意不给它设计新 API——帧本来就能声明任意槽位，为 scene 单独开一套接口等于
 * 承认槽位抽象漏了东西（那要改的是抽象，不是打补丁）。
 */
function buildSceneAnimations() {
  return [
    {
      group: 'PlayBall', index: 0, kind: 'once', next: 'Idle', fps: 6,
      frames: [
        { base: 'body_00', scene: { prop: 'prop_ball' }, face: { eyes: 'eye_sparkle', mouth: 'm1' } },
        { base: 'body_01', scene: { prop: 'prop_star' } },
        { base: 'body_00', scene: { prop: 'prop_none' }, face: { eyes: 'eye_open', mouth: 'm0' } },
      ],
    },
  ]
}

/** 嘴形状表：档位越高张得越大 */
function mouthShapes(level) {
  const cx = CANVAS.w / 2
  const y = 34
  const ink = '#2a1c12'
  if (level === 0) {
    return [{ kind: 'rect', x: cx - 4, y, w: 8, h: 2, r: 1, fill: ink }]
  }
  const ry = [0, 2, 4, 7][level]
  return [
    { kind: 'ellipse', cx, cy: y + 1, rx: 3 + level, ry, fill: '#7a2b2b', stroke: ink },
  ]
}

// ---------------------------------------------------------------------------
// 光栅化后端 1：像素（手写扫描转换，硬边无抗锯齿）
// ---------------------------------------------------------------------------

function createPixelBuffer(w, h) {
  return { w, h, data: Buffer.alloc(w * h * 4) }
}

function px(buf, x, y, rgb, a = 255) {
  if (x < 0 || y < 0 || x >= buf.w || y >= buf.h) return
  const i = (y * buf.w + x) * 4
  buf.data[i] = rgb[0]
  buf.data[i + 1] = rgb[1]
  buf.data[i + 2] = rgb[2]
  buf.data[i + 3] = a
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function fillEllipse(buf, cx, cy, rx, ry, rgb) {
  const x0 = Math.floor(cx - rx)
  const x1 = Math.ceil(cx + rx)
  const y0 = Math.floor(cy - ry)
  const y1 = Math.ceil(cy + ry)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx
      const dy = (y + 0.5 - cy) / ry
      if (dx * dx + dy * dy <= 1) px(buf, x, y, rgb)
    }
  }
}

function fillRect(buf, x, y, w, h, rgb, r = 0) {
  for (let yy = Math.floor(y); yy < Math.ceil(y + h); yy++) {
    for (let xx = Math.floor(x); xx < Math.ceil(x + w); xx++) {
      if (r > 0) {
        // 圆角：四角超出圆的部分跳过
        const inCornerX = Math.min(xx - x, x + w - 1 - xx) < r
        const inCornerY = Math.min(yy - y, y + h - 1 - yy) < r
        if (inCornerX && inCornerY) {
          const ccx = xx - x < r ? x + r : x + w - 1 - r
          const ccy = yy - y < r ? y + r : y + h - 1 - r
          const ddx = xx + 0.5 - ccx
          const ddy = yy + 0.5 - ccy
          if (ddx * ddx + ddy * ddy > r * r) continue
        }
      }
      px(buf, xx, yy, rgb)
    }
  }
}

/** 扫描线填充凸/凹多边形（偶奇规则） */
function fillPoly(buf, points, rgb) {
  const ys = points.map((p) => p[1])
  const y0 = Math.floor(Math.min(...ys))
  const y1 = Math.ceil(Math.max(...ys))
  for (let y = y0; y <= y1; y++) {
    const xs = []
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i]
      const [xj, yj] = points[j]
      if (yi > y + 0.5 !== yj > y + 0.5) {
        xs.push(((xj - xi) * (y + 0.5 - yi)) / (yj - yi) + xi)
      }
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.floor(xs[k]); x <= Math.ceil(xs[k + 1]); x++) {
        if (x + 0.5 >= xs[k] && x + 0.5 <= xs[k + 1]) px(buf, x, y, rgb)
      }
    }
  }
}

/**
 * 把形状表画到像素缓冲。
 *
 * 描边的做法是**先画一圈放大的同形**再画填充——像素画的常规手法，
 * 比实现真正的 stroke 简单得多，效果也正是那种「一圈硬描边」。
 */
function drawShapesPixel(buf, shapes) {
  // 先描边（全部放大一圈画完），再画填充，避免后画的描边盖住先画的填充
  for (const s of shapes) {
    if (!s.stroke) continue
    const rgb = hexToRgb(s.stroke)
    drawOne(buf, s, rgb, 1)
  }
  for (const s of shapes) {
    drawOne(buf, s, hexToRgb(s.fill), 0)
  }
}

function drawOne(buf, s, rgb, inflate) {
  if (s.kind === 'ellipse') {
    fillEllipse(buf, s.cx, s.cy, s.rx + inflate, s.ry + inflate, rgb)
  } else if (s.kind === 'rect') {
    fillRect(buf, s.x - inflate, s.y - inflate, s.w + inflate * 2, s.h + inflate * 2, rgb, s.r ?? 0)
  } else if (s.kind === 'poly') {
    if (inflate === 0) {
      fillPoly(buf, s.points, rgb)
    } else {
      // 多边形的描边：把顶点沿质心外推 inflate 像素
      const cx = s.points.reduce((a, p) => a + p[0], 0) / s.points.length
      const cy = s.points.reduce((a, p) => a + p[1], 0) / s.points.length
      const grown = s.points.map(([x, y]) => {
        const dx = x - cx
        const dy = y - cy
        const len = Math.hypot(dx, dy) || 1
        return [x + (dx / len) * inflate, y + (dy / len) * inflate]
      })
      fillPoly(buf, grown, rgb)
    }
  }
}

/** 像素后端：把若干层（各自独立缓冲）合成一张图，返回图集装配所需的形状 */
function rasterizePixel(layers) {
  const out = createPixelBuffer(CANVAS.w, CANVAS.h)
  for (const shapes of layers) {
    const layer = createPixelBuffer(CANVAS.w, CANVAS.h)
    drawShapesPixel(layer, shapes)
    // 按 alpha 合成到输出
    for (let i = 0; i < out.w * out.h; i++) {
      if (layer.data[i * 4 + 3] === 0) continue
      out.data.set(layer.data.subarray(i * 4, i * 4 + 4), i * 4)
    }
  }
  return { buffer: out.data, width: out.w, height: out.h }
}

const ACTION_POSE_LIST = Object.values(ACTION_POSES).flat()

/**
 * 动作组（单次型，播完回 Idle）。
 *
 * 这三个是「补齐动作丰富度」的落点：此前示范模型只有 Idle/Talk/Jump，
 * 控制坞里可点的动作标签很少。
 */
function buildActionAnimations(face) {
  const f = face ?? { eyes: 'eye_happy', mouth: 'm0' }
  return [
    {
      group: 'Wave', index: 0, kind: 'once', next: 'Idle', fps: 6,
      frames: [
        { base: 'wave_00' },
        { base: 'wave_01', face: f },
        { base: 'wave_01' },
        { base: 'wave_00' },
      ],
    },
    {
      group: 'Nod', index: 0, kind: 'once', next: 'Idle', fps: 6,
      frames: [{ base: 'nod_00' }, { base: 'nod_01' }, { base: 'nod_00' }],
    },
    {
      group: 'Shake', index: 0, kind: 'once', next: 'Idle', fps: 6,
      frames: [{ base: 'shake_00' }, { base: 'shake_01' }, { base: 'shake_00' }],
    },
  ]
}

/** 命名 + 光栅化（像素后端）。返回的 `raw` 让 sharp 知道这是裸像素而非已编码图片。 */
function pixelImage(name, layers) {
  const { buffer, width, height } = rasterizePixel(layers)
  return { name, buffer, width, height, raw: { width, height, channels: 4 } }
}

// ---------------------------------------------------------------------------
// 光栅化后端 2：2D 高清（同一份几何描述转 SVG，由 sharp 光栅化）
// ---------------------------------------------------------------------------

const HIRES_SCALE = 3 // 高清模型的画布是像素版的 3 倍
const HI = { w: CANVAS.w * HIRES_SCALE, h: CANVAS.h * HIRES_SCALE }

/** 把形状表的坐标放大到高清画布 */
function scaleShapes(shapes, k) {
  return shapes.map((s) => {
    if (s.kind === 'ellipse') {
      return { ...s, cx: s.cx * k, cy: s.cy * k, rx: s.rx * k, ry: s.ry * k }
    }
    if (s.kind === 'rect') {
      return { ...s, x: s.x * k, y: s.y * k, w: s.w * k, h: s.h * k, r: (s.r ?? 0) * k }
    }
    return { ...s, points: s.points.map(([x, y]) => [x * k, y * k]) }
  })
}

function shapeToSvg(s) {
  const stroke = s.stroke ? ` stroke="${s.stroke}" stroke-width="2"` : ''
  if (s.kind === 'ellipse') {
    return `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}" fill="${s.fill}"${stroke}/>`
  }
  if (s.kind === 'rect') {
    return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r ?? 0}" fill="${s.fill}"${stroke}/>`
  }
  const pts = s.points.map(([x, y]) => `${x},${y}`).join(' ')
  return `<polygon points="${pts}" fill="${s.fill}"${stroke} stroke-linejoin="round"/>`
}

/** 高清后端：输出 SVG 字符串（带渐变与抗锯齿，由 sharp 光栅化） */
function toSvg(layers) {
  const body = layers.flat().map(shapeToSvg).join('\n  ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${HI.w}" height="${HI.h}" viewBox="0 0 ${HI.w} ${HI.h}">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e8c9a0"/>
      <stop offset="100%" stop-color="#a9743f"/>
    </linearGradient>
    <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f2d9b8"/>
      <stop offset="100%" stop-color="#c98f52"/>
    </linearGradient>
  </defs>
  ${body}
</svg>`
}

async function rasterizeHires(layers) {
  const svg = toSvg(layers.map((l) => scaleShapes(l, HIRES_SCALE)))
  return sharp(Buffer.from(svg)).png().toBuffer()
}

// ---------------------------------------------------------------------------
// 图集装配
// ---------------------------------------------------------------------------

/**
 * 把小图横向排进图集。
 *
 * 网格排布（每行最多 8 张，格子取所有图的统一尺寸）——简单、可预测，
 * 而且格子尺寸一致时 `atlas.json` 的矩形一眼能看懂。
 */
async function packAtlas(images) {
  const cellW = Math.max(...images.map((i) => i.width))
  const cellH = Math.max(...images.map((i) => i.height))
  const cols = Math.min(8, images.length)
  const rows = Math.ceil(images.length / cols)
  const W = cellW * cols
  const H = cellH * rows

  const composites = images.map((img, i) => ({
    input: img.buffer,
    // 像素后端给的是裸 RGBA，须显式声明 raw；高清后端给的是已编码 PNG，不能带 raw
    ...(img.raw ? { raw: img.raw } : {}),
    left: (i % cols) * cellW,
    top: Math.floor(i / cols) * cellH,
  }))

  const png = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png()
    .toBuffer()

  const frames = {}
  images.forEach((img, i) => {
    frames[img.name] = {
      frame: { x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH, w: img.width, h: img.height },
    }
  })

  return {
    png,
    atlasJson: { frames, meta: { image: 'atlas.png', size: { w: W, h: H } } },
  }
}

// ---------------------------------------------------------------------------
// 三方案变体
// ---------------------------------------------------------------------------

/**
 * 造三份清单：差异**只在槽位声明与图集内容**，美术几何完全相同。
 *
 *   A 整体帧 —— 只有 base，每个「身体帧 × 表情 × 口型」预合成为一整张
 *   B 分层差分 —— 身体、眼、嘴全部是独立层，运行时叠加
 *   C 混合 —— 身体用整体帧，面部用分层覆盖
 */
function buildVariants() {
  const variants = []

  // ---- A 整体帧 ----
  {
    const images = []
    const frames = []
    for (const pose of BODY_POSES) {
      for (const eye of EYES) {
        for (const mouth of MOUTHS) {
          const name = `${pose.name}__${eye}__${mouth}`
          images.push(pixelImage(name, [bodyShapes(pose.lift, pose.pawLift ?? 0, pose.lean ?? 0), eyeShapes(eye), mouthShapes(mouthToLevel(mouth))]))
          frames.push({ base: name })
        }
      }
    }
    variants.push({ key: 'A', images, animFrames: frames, slots: undefined, note: '整体帧（每组合预合成）' })
  }

  // ---- B 分层差分 ----
  {
    const images = []
    for (const pose of BODY_POSES) images.push(pixelImage(pose.name, [bodyShapes(pose.lift, pose.pawLift ?? 0, pose.lean ?? 0)]))
    for (const eye of EYES) images.push(pixelImage(eye, [eyeShapes(eye)]))
    for (const mouth of MOUTHS) images.push(pixelImage(mouth, [mouthShapes(mouthToLevel(mouth))]))
    const frames = BODY_POSES.map((pose, i) => ({
      body: pose.name,
      ...(i === 0 ? { face: { eyes: EYES[0], mouth: MOUTHS[0] } } : {}),
    }))
    variants.push({
      key: 'B',
      images,
      animFrames: frames,
      slots: {
        body: { kind: 'layered', at: [0, 0], parts: { pose: BODY_POSES.map((p) => p.name) } },
        face: { kind: 'layered', at: [0, 0], parts: { eyes: EYES, mouth: MOUTHS } },
      },
      note: '分层差分（身体/眼/嘴各自成层）',
    })
  }

  // ---- C 混合 ----
  {
    const images = []
    for (const pose of BODY_POSES) images.push(pixelImage(pose.name, [bodyShapes(pose.lift, pose.pawLift ?? 0, pose.lean ?? 0)]))
    for (const eye of EYES) images.push(pixelImage(eye, [eyeShapes(eye)]))
    for (const mouth of MOUTHS) images.push(pixelImage(mouth, [mouthShapes(mouthToLevel(mouth))]))
    const frames = BODY_POSES.map((pose, i) => ({
      base: pose.name,
      ...(i === 0 ? { face: { eyes: EYES[0], mouth: MOUTHS[0] } } : {}),
    }))
    variants.push({
      key: 'C',
      images,
      animFrames: frames,
      slots: { face: { kind: 'layered', at: [0, 0], parts: { eyes: EYES, mouth: MOUTHS } } },
      note: '混合（身体整体帧 + 面部覆盖）',
    })
  }

  return variants
}

function mouthToLevel(name) {
  return Number(name.replace('m', ''))
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 造一份完整的安装包目录（P0-a 的包结构） */
async function writePackage(dir, { id, name, images, animFrames, extraAnimations, slots, pixelArt, canvas, anchor, scale, variantNote }) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  const { png, atlasJson } = await packAtlas(images)
  fs.writeFileSync(path.join(dir, 'atlas.png'), png)
  fs.writeFileSync(path.join(dir, 'atlas.json'), JSON.stringify(atlasJson, null, 2))

  const manifest = {
    id,
    rendererType: 'sprite',
    pixelArt,
    canvas,
    anchor,
    atlas: 'atlas.png',
    atlasJson: 'atlas.json',
    ...(slots ? { slots } : {}),
    animations: [
      {
        group: 'Idle',
        index: 0,
        kind: 'loop',
        fps: 4,
        frames: animFrames,
        params: { bob: pixelArt ? 1 : 2, breathe: 1.01 },
      },
      {
        group: 'Talk',
        index: 0,
        kind: 'loop',
        fps: 8,
        frames: animFrames,
        params: { bob: 1 },
      },
      {
        group: 'Jump',
        index: 0,
        kind: 'once',
        next: 'Idle',
        fps: 8,
        frames: [animFrames[1] ?? animFrames[0], animFrames[0]],
      },
      ...(extraAnimations ?? []),
    ],
    // 方案 A 没有独立嘴层（口型烘在整帧里），声明 mouthLevels 只会指向不存在的图集条目。
    ...(slots ? { mouthLevels: MOUTHS } : {}),
    hitAreas: [
      { id: 'HitAreaHead', frames: ['Idle', 'Talk', 'Jump'], points: [[14, 6], [34, 6], [34, 24], [14, 24]] },
      { id: 'HitAreaBody', frames: ['Idle', 'Talk', 'Jump'], points: [[12, 26], [36, 26], [36, 50], [12, 50]] },
    ],
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  fs.writeFileSync(
    path.join(dir, 'pet.json'),
    JSON.stringify(
      {
        name,
        scale,
        idleMotionGroup: 'Idle',
        talkMotionGroup: 'Talk',
        emotionMap: { neutral: 0, joy: 1, 开心: 1, sad: 3, 难过: 3, calm: 2, 平静: 2 },
        tapMotions: { HitAreaHead: { Jump: 0 }, HitAreaBody: { Talk: 0 } },
        personaAddon: `你是${name}。${variantNote}`,
      },
      null,
      2,
    ),
  )

  return { manifest, atlasJson, bytes: png.length + fs.statSync(path.join(dir, 'atlas.json')).size }
}

async function main() {
  const outArgIdx = process.argv.indexOf('--out')
  const outRoot = outArgIdx >= 0 ? path.resolve(process.argv[outArgIdx + 1]) : DEFAULT_OUT
  fs.mkdirSync(outRoot, { recursive: true })

  const report = []

  // ---- 双示范模型：同一套几何，两种光栅化 ----
  const pixelImages = []
  for (const pose of BODY_POSES) pixelImages.push(pixelImage(pose.name, [bodyShapes(pose.lift, pose.pawLift ?? 0, pose.lean ?? 0)]))
  for (const eye of EYES) pixelImages.push(pixelImage(eye, [eyeShapes(eye)]))
  for (const mouth of MOUTHS) pixelImages.push(pixelImage(mouth, [mouthShapes(mouthToLevel(mouth))]))
  for (const pose of ACTION_POSE_LIST) {
    pixelImages.push(pixelImage(pose.name, [bodyShapes(pose.lift ?? 0, pose.pawLift ?? 0, pose.lean ?? 0)]))
  }
  for (const prop of PROPS) pixelImages.push(pixelImage(prop, [propShapes(prop)]))
  const demoFrames = BODY_POSES.map((pose, i) => ({
    base: pose.name,
    ...(i === 0 ? { face: { eyes: EYES[0], mouth: MOUTHS[0] } } : {}),
  }))
  const demoSlots = {
    face: { kind: 'layered', at: [0, 0], parts: { eyes: EYES, mouth: MOUTHS } },
    // 场景/道具层。顺序在 face 之后 → 道具画在最上层（像被举着）
    scene: { kind: 'layered', at: [0, 0], parts: { prop: PROPS } },
  }

  const variantsRoot = path.join(outRoot, '_variants')
  fs.mkdirSync(variantsRoot, { recursive: true })

  const pixelPkg = await writePackage(path.join(outRoot, 'demo_pixel_cat'), {
    id: 'demo_pixel_cat',
    name: '像素猫',
    images: pixelImages,
    animFrames: demoFrames,
    extraAnimations: [...buildActionAnimations(), ...buildSceneAnimations()],
    slots: demoSlots,
    pixelArt: true,
    canvas: CANVAS,
    anchor: ANCHOR,
    scale: 3,
    variantNote: '像素风格，缩放按整数倍吸附。',
  })
  report.push({ 模型: 'demo_pixel_cat（像素）', 帧数: pixelImages.length, 图集字节: pixelPkg.bytes })

  // 高清版：把同一份几何用矢量重画
  const hiresImages = []
  for (const pose of BODY_POSES) {
    hiresImages.push({ name: pose.name, buffer: await rasterizeHires([bodyShapes(pose.lift, pose.pawLift ?? 0, pose.lean ?? 0)]), width: HI.w, height: HI.h })
  }
  for (const eye of EYES) {
    hiresImages.push({ name: eye, buffer: await rasterizeHires([eyeShapes(eye)]), width: HI.w, height: HI.h })
  }
  for (const mouth of MOUTHS) {
    hiresImages.push({ name: mouth, buffer: await rasterizeHires([mouthShapes(mouthToLevel(mouth))]), width: HI.w, height: HI.h })
  }
  for (const pose of ACTION_POSE_LIST) {
    hiresImages.push({
      name: pose.name,
      buffer: await rasterizeHires([bodyShapes(pose.lift ?? 0, pose.pawLift ?? 0, pose.lean ?? 0)]),
      width: HI.w,
      height: HI.h,
    })
  }
  for (const prop of PROPS) {
    hiresImages.push({
      name: prop,
      buffer: await rasterizeHires([propShapes(prop)]),
      width: HI.w,
      height: HI.h,
    })
  }
  const hiresPkg = await writePackage(path.join(outRoot, 'demo_hires_girl'), {
    id: 'demo_hires_girl',
    name: '高清少女',
    images: hiresImages,
    animFrames: demoFrames,
    extraAnimations: [...buildActionAnimations(), ...buildSceneAnimations()],
    slots: demoSlots,
    pixelArt: false,
    canvas: HI,
    anchor: [HI.w / 2, HI.h - HIRES_SCALE * 2],
    scale: 1,
    variantNote: '2D 高清风格，连续缩放。',
  })
  report.push({ 模型: 'demo_hires_girl（2D 高清）', 帧数: hiresImages.length, 图集字节: hiresPkg.bytes })

  // ---- 三方案变体 ----
  const variants = buildVariants()
  for (const v of variants) {
    const id = `demo_variant_${v.key.toLowerCase()}`
    const pkg = await writePackage(path.join(variantsRoot, id), {
      id,
      name: `方案 ${v.key}（${v.note}）`,
      images: v.images,
      animFrames: v.animFrames,
      slots: v.slots,
      pixelArt: true,
      canvas: CANVAS,
      anchor: ANCHOR,
      scale: 3,
      variantNote: v.note,
    })
    report.push({ 模型: `${id} — ${v.note}`, 帧数: v.images.length, 图集字节: pkg.bytes })
  }

  // ---- 对比数据 ----
  // 表情数用 EYES.length 而不是写死的数：P1-d 把表情从 4 扩到 12 之后，
  // 这里若还写 4，表就会与真实产出对不上（演示帧数是按 EYES 实际生成的）。
  const EXPR = EYES.length
  const MOUTH = MOUTHS.length
  const BODY = BODY_POSES.length
  const projection = [
    { 方案: 'A 整体帧', 演示帧数: BODY * EXPR * MOUTH, 公式: '身体帧 × 表情 × 口型' },
    { 方案: 'B 分层差分', 演示帧数: BODY + EXPR + MOUTH, 公式: '身体 + 表情 + 口型' },
    { 方案: 'C 混合', 演示帧数: BODY + EXPR + MOUTH, 公式: '身体帧 + 表情 + 口型' },
  ]

  console.log('\n=== 生成结果 ===')
  console.table(report)
  console.log(
    `\n=== 场景 B 资源量（${EXPR} 表情 × ${MOUTH} 口型 × ${BODY} 身体帧，即设计 §4.2 的目标规模）===`,
  )
  console.table(projection)
  console.log(`阈值 150 帧/角色：A ${BODY * EXPR * MOUTH < 150 ? '未超' : '**超出**'}，B/C ${BODY + EXPR + MOUTH < 150 ? '未超' : '**超出**'}`)
  console.log(`\n输出目录：${outRoot}`)
  console.log('注意：这是占位素材（设计 §7），量产链路单独立项。')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
