#!/usr/bin/env node
/**
 * eye-region-scan.mjs — 逐格扫一张拼条，判**每格的眼是不是睁的**
 *
 * ## 为什么需要它（而不是看一眼）
 *
 * 硬规则 13：循环动作要靠**独立姿势图**做首帧，否则"整段闭眼"变不成——
 * FL2VA 把首帧钉在首尾两端，睁眼的立绘会让循环每一圈睁一次眼（那是眨眼，
 * 不是持续状态）。所以"这 16 格到底闭没闭"是**验收判据**，得能量。
 *
 * ## 判据：同一行里近黑像素有没有两个"宽簇"
 *
 * 团子的眼睛是两颗大黑圆（实测宽约 51px @ 368px 宽的身子，占身宽 **13.9%**），
 * 闭眼只剩描边（宽度是个位数）。所以数"宽度 ≥ 身宽 8% 的近黑簇"有几个：
 * **2 个 = 睁眼，0~1 个 = 闭着**。取内容包围盒的**上 45%**（头），避开身上的暗块。
 *
 * ## ⚠ 这是**筛子不是证明**——两个实测过的坑
 *
 * 1. **有假阳性**。实测团子的呼噜表（整段闭眼）有 **2/16** 被判成"睁眼"，
 *    肉眼复核那两格与相邻格**完全一致**（阈值噪声）。所以**判成"睁眼"的格子
 *    必须再肉眼核一遍**（`pixel-ascii.mjs --crop` 取眼部横带），别直接当结论。
 * 2. **要有正负对照**。决定性的一半是**同一条拼条上的对照格**——团子的姿势图拼条
 *    里格 0~3 是站着睁眼、格 4 起闭上，那条弧线本身就证明了判据在起作用。
 *    只看一张表"判出来都是闭着"，分不清是"真闭着"还是"判据坏了"。
 *
 * ⚠ **阈值是团子量出来的**，换角色要重新量（`WIDTH_RATIO` 那个 8% 是按
 * "眼睛占身宽 13.9%"留的余量）。别的角色眼睛小、或者有别的宽黑特征（深色尾巴、
 * 花纹），判据都会失准。
 *
 * 用法：
 *   node eye-region-scan.mjs <拼条.png> <列数>
 */
import fs from 'node:fs'
import sharp from 'sharp'
import { alphaBBox } from '../lib/cutout.mjs'

/** 眼睛的等效宽度下限，占内容包围盒宽的比例（团子实测 13.9%，取一半留余量） */
const WIDTH_RATIO = 0.08
/** 只扫内容包围盒的上这么多（头）——避开身上的暗块 */
const HEAD_FRACTION = 0.45
/** 近黑的亮度上限 */
const DARK_LUMA = 50
/** 同一簇内允许的像素间隙（抗锯齿会让实心黑圆断成一串） */
const GAP = 2

const file = process.argv[2]
const cols = Number(process.argv[3])
if (!file || !Number.isInteger(cols) || cols <= 0) {
  console.error('用法：node eye-region-scan.mjs <拼条.png> <列数>')
  process.exit(1)
}

const meta = await sharp(file).metadata()
const cw = Math.floor(meta.width / cols)
const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const C = info.channels
const W = info.width

for (let c = 0; c < cols; c++) {
  const cell = Buffer.alloc(cw * meta.height * 4)
  for (let y = 0; y < meta.height; y++) {
    data.copy(cell, y * cw * 4, (y * W + c * cw) * 4, (y * W + c * cw + cw) * 4)
  }
  const b = alphaBBox(cell, cw, meta.height, 128)
  if (!b) {
    console.log(`格 ${String(c).padStart(2)}  （空帧）`)
    continue
  }
  const minW = b.w * WIDTH_RATIO
  let mostWide = 0
  for (let y = b.minY; y < b.minY + Math.round(b.h * HEAD_FRACTION); y++) {
    const xs = []
    for (let x = b.minX; x <= b.maxX; x++) {
      const p = (y * cw + x) * 4
      if (cell[p + 3] < 128) continue
      if (0.299 * cell[p] + 0.587 * cell[p + 1] + 0.114 * cell[p + 2] < DARK_LUMA) xs.push(x)
    }
    const clusters = []
    let cur = xs.length ? [xs[0]] : []
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] - xs[i - 1] <= GAP) cur.push(xs[i])
      else {
        clusters.push(cur)
        cur = [xs[i]]
      }
    }
    if (xs.length) clusters.push(cur)
    mostWide = Math.max(mostWide, clusters.filter((k) => k.length >= minW).length)
  }
  console.log(
    `格 ${String(c).padStart(2)}  身宽 ${String(b.w).padStart(3)}  宽近黑簇 ${mostWide} 个  → ` +
      `${mostWide >= 2 ? '睁眼（⚠ 有假阳性，肉眼复核）' : '闭着'}`,
  )
}
