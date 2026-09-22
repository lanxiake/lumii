#!/usr/bin/env node
/**
 * design-cat.mjs — 手工重绘的基准像素猫（站姿 / 坐姿）
 *
 * ## 为什么要重绘，而不是继续用缩小版
 *
 * 缩小版是"插画的采样"：657×851 缩 16 倍后，眼睛只是 6×5 的黑块，脸上没有
 * 五官可言；三条腿长短不齐（右腿还缺一条描边）。这些不是瑕疵，是
 * "每像素代表 16×16 原图"的必然结果。重绘则是**每个像素都有意图**。
 *
 * ## 角色设定（沿用 AI 原图）：橘白相间、圆脸、大眼睛、粗描边
 *
 * 橘色分布照搬原图：**头顶到眼睛上方是一顶"橘帽"**，耳朵外侧橘、内侧粉，其余白。
 *
 * ## 画布 64×64，角色只占中段
 *
 * 上下左右都留了余量——给动作用的。上一版 39×52 里角色贴边，连"整体上移 1 像素"
 * 都做不到（会切掉耳朵尖），只能做局部挪部位。
 *
 * ## ⚠ 上色顺序踩过的坑
 *
 * 第一版写的是 `flood(头, 橘)` 然后 `flood(身体, 白)` ——**头与身体在几何上连通**，
 * 第一次 flood 就把整只猫染成了橘，第二次发现起点不是占位符、直接返回，
 * 于是白色一个像素都没上。判据是字符分布：`4`（白）的计数必须是 0 以外的数。
 * 正确顺序是**先全身铺白，再用 `only='4'` 盖局部**。
 *
 * 输出：<out>/cat-<pose>.txt（网格，喂给 pixel-anim）+ .png
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Grid, PAL } from './pixel-draw.mjs'
const require = createRequire('C:/myself/projects/my/open-source/lumii/package.json')
const sharp = require('sharp')

const W = 64
const H = 64
const X = 'x' // 形状占位符：不是调色板里的色，等描边包完再统一上色

/**
 * 三档姿势的部件坐标，动作帧在这三档之间插值。
 *
 * 「坐下」在正面视角没有透视可言，唯一能表达的是**整体变矮 + 身体变宽**：
 * 站姿身体高 22（行 29-51），坐姿高 14（行 39-53）且宽了 4 像素。
 * `earDy` 是耳朵跟着头下沉的量——它不在 `head` 里，因为耳朵的坐标原本是
 * 相对站姿写死的，加个偏移比重新算三个顶点省事。
 *
 * ⚠ 相邻两档的头与身体**必须重叠**（这里 29<31、34<35、39=39）。第一版坐姿
 * 写成 head 到 35、body 从 37，中间空 2 行，flood 从身体出发够不到头，
 * 366 个占位符没上色。
 */
export const POSES = {
  stand: {
    head: { cx: 32, cy: 20, rx: 13, ry: 11 },
    body: { cx: 32, cy: 40, rx: 14, ry: 11 },
    legs: [
      { x0: 21, y0: 46, x1: 27, y1: 58 },
      { x0: 37, y0: 46, x1: 43, y1: 58 },
    ],
    earDy: 0,
  },
  mid: {
    head: { cx: 32, cy: 25, rx: 13, ry: 11 },
    body: { cx: 32, cy: 45, rx: 15, ry: 10 },
    legs: [
      { x0: 21, y0: 50, x1: 27, y1: 58 },
      { x0: 37, y0: 50, x1: 43, y1: 58 },
    ],
    earDy: 5,
  },
  sit: {
    head: { cx: 32, cy: 30, rx: 13, ry: 11 }, // 行 19-41
    // 身体**底部直接压到地面**（行 58）——这是"坐"和"蹲"的唯一区别。
    // 蹲下只是整体下移，腿还撑着；坐下来是重心落在屁股上，腿收在身下看不见。
    body: { cx: 32, cy: 49, rx: 16, ry: 9 }, // 行 40-58
    legs: [], // 正面视角看不到收在身下的腿，画了反而像站着
    earDy: 10,
  },
}

export function designCat(pose = 'stand') {
  const P = POSES[pose]
  if (!P) throw new Error(`未知姿势 ${pose}，可选 ${Object.keys(POSES).join(' / ')}`)
  const g = new Grid(W, H)

  // ---- 1. 纯形状（全用占位符，先不谈颜色）----
  const earL = { a: { x: 18, y: 19 }, b: { x: 24, y: 5 }, c: { x: 30, y: 19 } }
  const earR = { a: { x: 34, y: 19 }, b: { x: 40, y: 5 }, c: { x: 46, y: 19 } }
  const dy = P.earDy // 耳朵与五官跟着头一起下沉的量
  for (const e of [earL, earR]) {
    g.triangle({ ...e.a, y: e.a.y + dy }, { ...e.b, y: e.b.y + dy }, { ...e.c, y: e.c.y + dy }, X)
  }
  g.ellipse(P.head.cx, P.head.cy, P.head.rx, P.head.ry, X)
  g.ellipse(P.body.cx, P.body.cy, P.body.rx, P.body.ry, X)
  for (const L of P.legs) g.rect(L.x0, L.y0, L.x1, L.y1, X)

  // 尾巴：阶梯状斜线（像素画里的斜线只能这么画），末尾收个圆头。
  // 整体跟着身体下沉，免得坐姿时尾巴飘在半空。
  const t = P.earDy
  g.rect(44, 42 + t, 48, 46 + t, X)
  g.rect(46, 37 + t, 50, 43 + t, X)
  g.rect(48, 32 + t, 52, 38 + t, X)
  g.rect(50, 27 + t, 54, 33 + t, X)
  g.ellipse(53, 27 + t, 3, 4, X)

  // ---- 2. 包 1 像素描边（只往外长，不动已画的形状）----
  g.outline('1')

  // ---- 3. 上色：**先全身铺白**，再局部盖色 ----
  // 顺序不能反，理由见文件头。头和身体各 flood 一次：**不假设它们一定连通**——
  // 某个姿势把它们拉开 1 像素，只 flood 一次就会剩一大片占位符（坐姿踩过）。
  // 第二次落在已填过的区域是无害的（起点已是目标色，直接返回）。
  g.flood(P.head.cx, P.head.cy, '4', X)
  g.flood(P.body.cx, P.body.cy, '4', X)

  // 橘帽：头顶到眼睛上方
  g.ellipse(32, 15 + dy, 12, 7, '2', '4')
  // 耳朵外侧橘（盖住耳朵的上半，留出根部一圈白当过渡）
  g.ellipse(23, 11 + dy, 4, 5, '2', '4')
  g.ellipse(41, 11 + dy, 4, 5, '2', '4')
  // 耳内粉
  g.triangle({ x: 22, y: 18 + dy }, { x: 25, y: 9 + dy }, { x: 29, y: 18 + dy }, '6', '4')
  g.triangle({ x: 35, y: 18 + dy }, { x: 39, y: 9 + dy }, { x: 42, y: 18 + dy }, '6', '4')
  // 尾巴刷橘（和上面画尾巴用同一组形状，only='4' 保证不碰描边）
  for (const [x0, y0, x1, y1] of [
    [44, 42 + t, 48, 46 + t],
    [46, 37 + t, 50, 43 + t],
    [48, 32 + t, 52, 38 + t],
    [50, 27 + t, 54, 33 + t],
  ]) {
    g.rect(x0, y0, x1, y1, '2', '4')
  }
  g.ellipse(53, 27 + t, 3, 4, '2', '4')

  // 暗部：右侧脸颊、身体下缘。像素画靠这点暗部撑体积，全平涂会像贴纸
  g.ellipse(44, 25 + dy, 3, 6, '3', '4')
  g.ellipse(32, P.body.cy + P.body.ry - 2, P.body.rx - 2, 2, '5', '4')

  // ---- 4. 五官（直接落笔，only=null 表示无条件盖上去）----
  for (const ex of [25, 39]) {
    const ey = 24 + dy
    g.ellipse(ex, ey, 4, 5, '1', null)
    g.set(ex - 2, ey - 2, '7')
    g.set(ex - 1, ey - 2, '7')
    g.set(ex - 2, ey - 1, '7')
  }
  const ny = 29 + dy
  g.triangle({ x: 30, y: ny }, { x: 34, y: ny }, { x: 32, y: ny + 2 }, '6', null)
  for (const [dx2, dy2] of [[-2, 4], [-1, 5], [0, 4], [1, 5], [2, 4]]) g.set(32 + dx2, ny + dy2, '1')

  return g
}

/** 把 Grid 写成 PNG（透明背景） */
export async function gridToPng(g, file) {
  const buf = Buffer.alloc(g.W * g.H * 4, 0)
  for (let y = 0; y < g.H; y++) {
    for (let x = 0; x < g.W; x++) {
      const hex = PAL[g.at(x, y)]
      if (!hex) continue
      const i = (y * g.W + x) * 4
      buf[i] = parseInt(hex.slice(0, 2), 16)
      buf[i + 1] = parseInt(hex.slice(2, 4), 16)
      buf[i + 2] = parseInt(hex.slice(4, 6), 16)
      buf[i + 3] = 255
    }
  }
  await sharp(buf, { raw: { width: g.W, height: g.H, channels: 4 } }).png().toFile(file)
}

// ⚠ Windows 上 import.meta.url 是 `file:///C:/...`（三斜杠），
// 手拼 `file://` + 路径会得到两斜杠的版本、永不相等——脚本会静默什么都不做。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = process.argv[2] ?? '.'
  fs.mkdirSync(outDir, { recursive: true })
  for (const pose of ['stand', 'mid', 'sit']) {
    const g = designCat(pose)
    fs.writeFileSync(path.join(outDir, `cat-${pose}.txt`), g.toGridText(), 'utf-8')
    await gridToPng(g, path.join(outDir, `cat-${pose}.png`))
    const hist = {}
    for (let y = 0; y < g.H; y++) for (let x = 0; x < g.W; x++) hist[g.at(x, y)] = (hist[g.at(x, y)] ?? 0) + 1
    const dist = Object.entries(hist)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    // 'x' 还在 = 有地方漏了上色；'4' 缺失 = 白没铺上（就是踩过的那个坑）
    const bad = []
    if (hist.x) bad.push(`⚠ 还有 ${hist.x} 个未上色的占位符`)
    if (!hist['4']) bad.push('⚠ 一点白都没有——上色顺序反了')
    console.log(`✓ cat-${pose}.{txt,png}  ${W}×${H}  ${dist}${bad.length ? '  ' + bad.join('；') : ''}`)
  }
}
