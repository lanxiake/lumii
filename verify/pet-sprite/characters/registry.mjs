#!/usr/bin/env node
/**
 * registry.mjs — 把随包注册表里的旧示范模型换成 AI 生成的三只
 *
 * 只改三处：删掉旧条目、插入新条目、改 `defaultModelId`。
 * 其余条目（三只 Live2D 授权模型）原样不动——它们不归这条线管。
 *
 * 条目字段是**显式写死**的，不从产出的清单里推：注册表是发布物，
 * 改了什么必须能在 diff 里一眼看出来，而不是"跑一次脚本就变了"。
 *
 * 用法：node registry.mjs [--check]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEMO_ID } from './build.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
const REGISTRY = path.join(REPO, 'apps/windows/resources/pet-models/registry.json')
const RESOURCES = path.join(REPO, 'apps/windows/resources/pet-models')

/** 被替换掉的旧示范模型 */
const RETIRED = ['demo_pixel_cat', 'demo_hires_girl']

/**
 * 表情映射：只列**真实存在**的档位。
 *
 * 旧示范模型有 12 档眼睛，映了 12 组关键词；这三只有没有表情层要看差分取层成没成。
 * 把映不到的档位留在表里，运行时会静默夹住到最后一档——「说生气却笑」这种
 * 错配很难查，所以**按清单里实际有没有 `face` 槽来决定**，宁可少列。
 */
const EMOTION_MAP_WITH_FACE = {
  neutral: 0,
  平静: 0,
  默认: 0,
  exp_01: 0,
  calm: 1,
  闭眼: 1,
  思考: 1,
  沉思: 1,
  exp_02: 1,
  joy: 2,
  开心: 2,
  微笑: 2,
  smile: 2,
  轻松: 2,
  exp_03: 2,
  sadness: 3,
  sad: 3,
  难过: 3,
  委屈: 3,
  失落: 3,
  exp_04: 3,
}

/**
 * 没有表情层时的映射。
 *
 * **不能省**：`personaAddon` 会教模型用 `[joy]` 这类标签，而映射表里没有它时，
 * 表情索引会落到 0。写一份「全部指向 0」的表，语义就是「这个模型只有一张脸」，
 * 比留空、让阅读的人以为是漏配要清楚。
 */
const EMOTION_MAP_NO_FACE = { neutral: 0, 平静: 0, 默认: 0 }

const ACTION_MOTIONS = {
  挥手: { group: 'Wave', index: 0, description: '抬手左右摇摆打招呼，适合开场、道别' },
  打招呼: { group: 'Wave', index: 0, description: '同挥手' },
  点头: { group: 'Nod', index: 0, description: '低头再抬起的点头，表示赞同、明白' },
  赞同: { group: 'Nod', index: 0, description: '同点头' },
}

function persona(name, style, extra, hasFace) {
  return (
    `你是${name}，${style}。请积极用方括号标签驱动表情与动作，让形象真正「活」起来。\n\n` +
    // 教模型用不存在的标签，等于教它说无效的话——按清单里真实的档位来写
    (hasFace
      ? `**表情标签**（切换眼神）：\n` +
        `- [neutral]/[平静]/[默认]：睁眼默认脸\n` +
        `- [calm]/[闭眼]/[思考]：闭眼平静\n` +
        `- [joy]/[开心]/[微笑]：笑眼\n` +
        `- [sadness]/[难过]/[委屈]：下垂眼\n\n`
      : `**表情**：这只角色没有可切换的表情层，不要输出表情标签。\n\n`) +
    `**动作标签**（单次播放，播完自动回待机）：\n` +
    `- [motion:挥手]/[motion:打招呼]：抬手打招呼\n\n` +
    `**示例**：[joy][motion:挥手]你来啦！\n` +
    `回复口语化、适合朗读。${extra ?? ''}`
  )
}

export function entryFor(id) {
  const pkgDir = path.join(RESOURCES, DEMO_ID[id])
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'manifest.json'), 'utf-8'))
  const pet = JSON.parse(fs.readFileSync(path.join(pkgDir, 'pet.json'), 'utf-8'))
  const dir = DEMO_ID[id]
  const groups = manifest.animations.map((a) => a.group)
  const hasFace = Object.keys(manifest.slots ?? {}).includes('face')
  // ⚠ 与 `build.mjs` 的 DEMO_ID / `drive-gen.mjs` 的 PREFIX / plans.json 是**一套四处**，
  //    加减角色要一起改。2026-09-24 摘掉了樱桃（anime_girl）与钢羽（mecha_gundam）。
  const touch = {
    cartoon_cat: ['一只叫「团子」的卡通猫咪', '圆滚滚的，语气天真', ''],
  }[id]
  const actionMotions = {}
  for (const [k, v] of Object.entries(ACTION_MOTIONS)) {
    if (groups.includes(v.group)) actionMotions[k] = v
  }
  return {
    id: dir,
    name: pet.name,
    rendererType: 'sprite',
    modelUrl: `${dir}/manifest.json`,
    scale: manifest.scale ?? pet.scale ?? 1,
    idleMotionGroup: 'Idle',
    talkMotionGroup: 'Talk',
    agentId: '',
    emotionMap: hasFace ? EMOTION_MAP_WITH_FACE : EMOTION_MAP_NO_FACE,
    tapMotions: {
      ...(groups.includes('Nod') ? { HitAreaHead: { Nod: 0 } } : {}),
      ...(groups.includes('Wave') ? { HitAreaBody: { Wave: 0 } } : {}),
    },
    actionMotions,
    defaultExpression: 0,
    personaAddon: persona(touch[0], touch[1], touch[2], hasFace),
    toolPrompts: { expression: true, thinkTag: true },
  }
}

const ORDER = ['demo_cartoon_cat']

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const raw = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'))
  const before = raw.models.map((m) => m.id)
  // 幂等：既要摘掉退役的，也要摘掉**本次要新增的**——只摘退役的那批，
  // 跑第二遍就会把三条新条目再加一次（实测跑出过 9 条）。
  const ours = new Set(ORDER)
  const kept = raw.models.filter((m) => !RETIRED.includes(m.id) && !ours.has(m.id))
  const fresh = ORDER.map((dir) => {
    const id = Object.keys(DEMO_ID).find((k) => DEMO_ID[k] === dir)
    return entryFor(id)
  })
  const models = [...kept, ...fresh]
  const out = {
    ...raw,
    models,
    defaultModelId: ORDER.includes(raw.defaultModelId) ? raw.defaultModelId : ORDER[0],
  }
  fs.writeFileSync(REGISTRY, JSON.stringify(out, null, 2) + '\n', 'utf-8')
  console.log(`✓ 注册表：${before.length} 条 → ${models.length} 条`)
  console.log(`  移除：${before.filter((i) => RETIRED.includes(i)).join(', ')}`)
  console.log(`  新增：${fresh.map((e) => `${e.id}(${e.name})`).join(', ')}`)
  console.log(`  defaultModelId = ${out.defaultModelId}`)
}
