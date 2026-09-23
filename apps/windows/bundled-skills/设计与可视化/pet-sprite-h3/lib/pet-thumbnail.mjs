#!/usr/bin/env node
/**
 * pet-thumbnail.mjs — 从装好的图集里裁一张形象缩略图
 *
 * ## 为什么需要
 *
 * 概览页右下角那块「虚拟人」卡片靠注册表的 `thumbnailUrl` 显示形象。内置注册表里
 * **三只 Live2D 有 `runtime/icon.png`，三只 sprite 全是空的**——于是选 sprite 宠物时
 * 卡片永远只画一个占位星标。用户报的「没显示当前被选中的宠物形象」就是它。
 *
 * ## 取哪一帧、裁到哪
 *
 * 取 `Idle` 组的**首帧**（`Idle` 是活动组名契约里必有的一组，见 SKILL.md 第八节），
 * 再按**不透明像素的外接矩形**裁紧——整格贴上去是有留白的，直接缩放成 78px 的圆
 * 会得到一只米粒大的猫。
 *
 * ⚠ 输出是**正方形**（不足的部分透明补齐）：卡片的 `border-radius: 50%` +
 * `object-fit: cover` 要求方形，给非方图会被裁掉两边。
 *
 * 用法：
 *   node pet-thumbnail.mjs <宠物包目录> [--size 128] [--name thumbnail.png]
 */

import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const ALPHA_THRESHOLD = 128

/**
 * 给一个宠物包生成缩略图，写进包目录。
 *
 * @returns `{ file, w, h, from }`；`from` 是取的那一帧（排错用）
 */
export async function makeThumbnail(pkgDir, id, { size = 128, file = 'thumbnail.png' } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'manifest.json'), 'utf-8'))
  const atlas = JSON.parse(fs.readFileSync(path.join(pkgDir, manifest.atlasJson), 'utf-8'))
  // 组名找不到就往后退：`Idle` 是契约里的基础组，但分层模型可能把它放在别处
  const group =
    manifest.animations?.find((a) => a.group === 'Idle') ??
    manifest.animations?.find((a) => a.kind === 'loop') ??
    manifest.animations?.[0]
  const base = group?.frames?.[0]?.base
  if (!base) throw new Error(`${id} 的清单里没有任何动作帧，做不出缩略图`)
  const fr = atlas.frames?.[base]?.frame
  if (!fr) throw new Error(`图集索引里没有 ${base}`)

  const cell = await sharp(path.join(pkgDir, manifest.atlas))
    .extract({ left: fr.x, top: fr.y, width: fr.w, height: fr.h })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // 不透明像素的外接矩形
  let minX = fr.w
  let minY = fr.h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < fr.h; y++) {
    for (let x = 0; x < fr.w; x++) {
      if (cell.data[(y * fr.w + x) * cell.info.channels + 3] <= ALPHA_THRESHOLD) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) throw new Error(`${base} 整格透明，裁不出缩略图`)

  const bw = maxX - minX + 1
  const bh = maxY - minY + 1
  // `contain` + 透明底：保持比例缩到能放进 size×size，四周留透明
  const body = await sharp(cell.data, {
    raw: { width: fr.w, height: fr.h, channels: cell.info.channels },
  })
    .extract({ left: minX, top: minY, width: bw, height: bh })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()

  fs.writeFileSync(path.join(pkgDir, file), body)
  return { file, w: size, h: size, from: base, contentBox: { bw, bh } }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('pet-thumbnail.mjs')
if (isMain) {
  const args = process.argv.slice(2)
  const dir = args.find((a) => !a.startsWith('--'))
  const opt = (n, d) => {
    const i = args.indexOf(`--${n}`)
    return i >= 0 && args[i + 1] ? args[i + 1] : d
  }
  if (!dir) {
    console.error('用法：node pet-thumbnail.mjs <宠物包目录> [--size 128] [--name thumbnail.png]')
    process.exit(2)
  }
  const pkgDir = path.resolve(dir)
  const r = await makeThumbnail(pkgDir, path.basename(pkgDir), {
    size: Number(opt('size', 128)),
    file: opt('name', 'thumbnail.png'),
  })
  console.log(
    `${pkgDir} → ${r.file} ${r.w}×${r.h}（取 ${r.from}，内容 ${r.contentBox.bw}×${r.contentBox.bh}）`,
  )
}
