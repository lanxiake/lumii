#!/usr/bin/env node
/**
 * patch-hit-areas.mjs — 给**已经装好的**宠物包补 `hitAreas`（只动清单，不动图集）
 *
 * ## 为什么需要单独一个修复脚本
 *
 * 新产出的包已经由 `pet-creator/run.ts` 与 `compose-review.mjs` 自带命中区了。
 * 但这个仓库里躺着三只**早于那次改动**的示范宠物，它们的清单里没有 `hitAreas`：
 * 渲染器的 `hitTestPolygons` 在 `hitAreas` 为空时恒返回 null，而注册表里的
 * `tapMotions` 按 `HitAreaHead` / `HitAreaBody` 索引——**两边对不上，点击一路静默
 * 走到 return**。实测日志里从头到尾没有过 `[playMotion] group="Wave"`。
 *
 * ## 为什么不能直接重跑 compose-review
 *
 * 试过，不行：`cartoon_cat` / `mecha_gundam` 的**原始图是旧网格**（待机 2×2、挥手 3×2），
 * 而当前 `plans.json` 写的是 4×1 / 2×2。照计划重切会得到完全错的帧——图集会被改坏。
 * 这两只的原始图必须重新出图才能对齐计划，那是另一件事。
 *
 * 所以这里**只从现有图集里取待机首帧、推命中区、写回清单**，其余字段与图集一个字节不动。
 *
 * 用法：node patch-hit-areas.mjs <宠物包目录> [...]
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { op } from '../lib/control.mjs'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error('用法：node patch-hit-areas.mjs <宠物包目录> [...]')
  process.exit(1)
}

for (const dir of dirs) {
  const manifestPath = path.join(dir, 'manifest.json')
  const atlasJsonPath = path.join(dir, 'atlas.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`没有清单：${manifestPath}`)

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  const atlas = JSON.parse(fs.readFileSync(atlasJsonPath, 'utf-8'))

  // 待机首帧：命中区是**待机姿态**的轮廓。用其它动作会把区域撑开或收窄，
  // 于是点同一个位置时灵时不灵。
  const idle = manifest.animations?.find((a) => a.group === 'Idle')
  const baseName = idle?.frames?.[0]?.base
  if (!baseName) {
    console.log(`- ${manifest.id}：没有待机首帧，跳过`)
    continue
  }
  const entry = atlas.frames?.[baseName]
  if (!entry) {
    console.log(`- ${manifest.id}：图集里没有条目 "${baseName}"，跳过`)
    continue
  }
  const box = entry.frame ?? entry

  // 把这一帧从图集里切出来，交给工具链——它要读 PNG，不认图集
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'hitarea-'))
  const framePath = path.join(tmp, `${baseName}.png`)
  await sharp(path.join(dir, atlas.meta?.image ?? manifest.atlas))
    .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
    .png()
    .toFile(framePath)

  const r = await op('hitAreas', { dir: tmp, base: baseName })
  fs.rmSync(tmp, { recursive: true, force: true })
  if (!r.ok) throw new Error(`${manifest.id} 推命中区失败：${r.error}`)
  for (const w of r.result.warnings) console.log(`  ⚠ ${manifest.id}: ${w}`)
  if (r.result.hitAreas.length === 0) {
    console.log(`- ${manifest.id}：推导结果为空，清单未改动`)
    continue
  }

  manifest.hitAreas = r.result.hitAreas
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  const desc = r.result.hitAreas
    .map((a) => {
      const ys = a.points.map((p) => p[1])
      return `${a.id}(y ${Math.min(...ys)}..${Math.max(...ys)})`
    })
    .join(' ')
  console.log(`✓ ${manifest.id}：补上 ${desc}`)
}
