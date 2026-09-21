#!/usr/bin/env node
/**
 * build.mjs — 把出好的图集走完整流水线，产出可直接随包分发的宠物包
 *
 * 为什么要直接 spawn `run.ts` 而不是让 Agent 调 `execute_skill`：
 * 流水线本身是确定性的（抠底→切格→归一→差分→打包→校验→安装），判断部分
 * （哪批是哪个动作、格叫什么名）已经由本文件固定下来了。再插一层 Agent 只是
 * 让同一件事多一次模型往返。
 *
 * `run.ts` 的入参走 `SKILL_PARAMS` 环境变量，结果以 `__SKILL_RESULT__:` 前缀打到 stdout。
 *
 * 用法：node build.mjs [characterId ...]
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PREFIX, RAW_DIR } from './drive-gen.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
const RUN_TS = path.join(REPO, 'apps/windows/bundled-skills/设计与可视化/pet-creator/run.ts')
const RESOURCES = path.join(REPO, 'apps/windows/resources/pet-models')

const plans = JSON.parse(fs.readFileSync(new URL('./plans.json', import.meta.url), 'utf-8'))

/** 每只角色在注册表里的目录名（= id，安装守卫会核对目录名与 id 一致） */
export const DEMO_ID = {
  anime_girl: 'demo_anime_girl',
  cartoon_cat: 'demo_cartoon_cat',
  mecha_gundam: 'demo_mecha_gundam',
}

/** 表情批的档位名，按读序。索引即 `emotionMap` 里的数字。 */
const FACE_NAMES = ['eye_open', 'eye_shut', 'eye_happy', 'eye_sad']

export function buildParams(id, { withFace = true } = {}) {
  const c = plans[id]
  const p = PREFIX[id]
  const raw = (s) => path.join(RAW_DIR, `${p}-${s}.png`)
  const base = (i) => `${p}_body_${String(i).padStart(2, '0')}`
  return {
    action: 'build',
    id: DEMO_ID[id],
    name: c.name,
    canvas: c.canvas,
    anchor: [Math.round(c.canvas.w / 2), c.canvas.h - 6],
    scale: c.scale,
    batches: [
      {
        file: raw('idle'),
        cols: 2,
        rows: 2,
        slot: 'base',
        names: [0, 1, 2, 3].map(base),
      },
      {
        file: raw('wave'),
        cols: 3,
        rows: 2,
        slot: 'base',
        group: 'Wave',
        kind: 'once',
        next: 'Idle',
        fps: 8,
        names: [0, 1, 2, 3, 4, 5].map((i) => `${p}_wave_${String(i).padStart(2, '0')}`),
      },
      ...(withFace
        ? [
            {
              file: raw('face'),
              cols: 2,
              rows: 2,
              slot: 'face',
              category: 'eyes',
              diffBase: base(0),
              names: FACE_NAMES,
            },
          ]
        : []),
    ],
    personaAddon: c.persona,
  }
}

function runSkill(params) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUN_TS], {
      env: { ...process.env, SKILL_PARAMS: JSON.stringify(params) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('__SKILL_RESULT__:'))
      let result = null
      if (line) {
        try {
          result = JSON.parse(line.slice('__SKILL_RESULT__:'.length))
        } catch (e) {
          result = { ok: false, error: `结果不是合法 JSON：${e.message}` }
        }
      }
      resolve({ code, result, out, err })
    })
  })
}

/**
 * **顶层构建必须关在 main 守卫里。**
 *
 * 这个模块被 `registry.mjs` import 一个常量（`DEMO_ID`）。没有守卫的话，
 * 光是 import 就会把整个构建跑一遍——实测踩过：跑注册表脚本时顺带跑了三次构建，
 * 还是对着旧版 App 的控制口跑的，三行报错看着像真的失败。
 * 与 `drive-gen.mjs` 同一套写法（那里也有同样的守卫，理由同此）。
 */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const withFace = !process.argv.includes('--no-face')
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const targets = ids.length > 0 ? ids : Object.keys(plans)

  for (const id of targets) {
    if (!plans[id]) throw new Error(`未知角色 ${id}`)
    console.log(`\n${'='.repeat(70)}\n### 构建 ${DEMO_ID[id]}（${plans[id].name}）\n${'='.repeat(70)}`)
    const { code, result, err, out } = await runSkill(buildParams(id, { withFace }))
    if (!result) {
      console.error(`✗ 没有结果行（exit ${code}）\n${out.slice(-800)}\n${err.slice(-800)}`)
      continue
    }
    if (!result.ok) {
      console.error('✗ 失败：', result.error)
      if (result.warnings?.length) console.error('  warnings:', JSON.stringify(result.warnings, null, 1))
      continue
    }
    console.log(
      `✓ ${result.frames} 帧 · 槽位 ${JSON.stringify(result.slots)} · 动作组 ${JSON.stringify(result.animationGroups)}` +
        ` · 图集 ${result.atlasSize.w}×${result.atlasSize.h}`,
    )
    console.log(`  装到 ${result.installedDir}`)
    if (result.warnings?.length) {
      console.log('  warnings:')
      for (const w of result.warnings) console.log(`   - ${w}`)
    }
    // 随包资源是**直接落盘**的（注册表守卫会核对目录名 = id）
    const dest = path.join(RESOURCES, DEMO_ID[id])
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(dest, { recursive: true })
    for (const f of ['manifest.json', 'atlas.png', 'atlas.json', 'pet.json']) {
      fs.copyFileSync(path.join(result.packageDir, f), path.join(dest, f))
    }
    console.log(`  → 随包资源 ${path.relative(REPO, dest)}`)
  }
}
