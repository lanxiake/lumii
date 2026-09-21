/**
 * 调控制口 /pet/asset 的 sheetPlan，把三只角色的出图提示词打出来。
 *
 * 用法：node verify/pet-sprite/plan-characters.mjs [1|2|3]
 */
import { op } from './lib/control.mjs'

export { op }

export const CHARACTERS = {
  1: {
    id: 'anime_girl',
    name: '樱桃',
    canvas: { w: 144, h: 168 },
    scale: 0.65,
    // 角色与画风的完整描述（就是进创作段的那段话，不得出现阿拉伯数字）
    character:
      '一位日式动画风格的少女，深栗色齐刘海双马尾长发，浅蓝色水手领短袖上衣配藏青百褶裙，' +
      '明亮的大眼睛，白净肤色，整体赛璐璐平涂上色，黑色细描边，画风清爽明快',
    colors: ['#f7dcc4', '#5a3a2e', '#eaf2fb', '#2b3a5c', '#241a16'],
    persona: '你是一位叫樱桃的少女，日式动画风格，性格明快活泼。',
  },
  2: {
    id: 'cartoon_cat',
    name: '团子',
    canvas: { w: 144, h: 168 },
    scale: 0.65,
    character:
      '一只适合儿童观看的卡通猫咪，圆滚滚的身体配大脑袋，橘黄与奶白相间的毛色，' +
      '又大又圆的黑色眼睛，粉色内耳与肉垫，粗而圆润的深棕色描边，简洁明快的扁平配色',
    colors: ['#f5a33c', '#fdf6e8', '#f2a8b8', '#4a2f1c'],
    persona: '你是一只叫团子的卡通猫咪，圆滚滚的，语气天真活泼，说话口语化适合朗读。',
  },
  3: {
    id: 'mecha_gundam',
    name: '钢羽',
    canvas: { w: 144, h: 168 },
    scale: 0.65,
    character:
      '一台三维渲染质感的机甲机器人，蓝白红经典配色，方正的头盔与发光的黄色眼睛，' +
      '胸口红色装甲配金色装饰，肩甲宽大方正，金属光泽与硬边倒角，柔和的体积光照',
    colors: ['#2a5fb0', '#eef2f7', '#c8322e', '#f2c33c', '#2a2f38'],
    persona: '你是一台叫钢羽的机甲，说话简洁有力，偶尔带点机械感，适合朗读。',
  },
}

/**
 * 每只角色的批次：一个动作一批，格子的读序就是时间序。
 *
 * 表情批的 `part`/`variants` 按角色给：**机甲没有「闭眼笑眼」**，
 * 硬套人脸的说法会让模型画出不存在的东西。机甲的对应语义是眼部指示灯的明暗，
 * 档位顺序仍与另两只对齐（0 常规 / 1 熄灭 / 2 高兴 / 3 低落），
 * 这样注册表的 `emotionMap` 三只可以共用一份。
 */
export function batchesFor(c) {
  const isMecha = c?.id === 'mecha_gundam'
  return [
    {
      action: '待机呼吸',
      motion:
        '保持站姿不动，胸口缓缓向上起伏 → 起伏到最高处 → 开始缓慢回落 → 回落到最低处 → 回到起始位置',
      cols: 2,
      rows: 2,
    },
    {
      action: '挥手',
      motion:
        '右手从身侧自然下垂 → 抬起到胸前 → 继续抬到肩膀高度 → 举到耳侧并向左边摆 → 摆回右边 → 缓慢落回身侧',
      cols: 3,
      rows: 2,
    },
    isMecha
      ? {
          kind: 'expression',
          action: '眼部灯光差分',
          part: '眼睛',
          variants: ['黄色常亮', '灯光熄灭', '明亮高光', '转暗闪烁'],
          cols: 2,
          rows: 2,
        }
      : {
          kind: 'expression',
          action: '眼神差分',
          part: '眼睛',
          variants: ['睁眼', '闭眼', '笑眼', '难过'],
          cols: 2,
          rows: 2,
        },
  ]
}

const which = process.argv[2]
const asJson = process.argv.includes('--json')
const targets = which && !asJson ? [CHARACTERS[which]] : Object.values(CHARACTERS)

const out = {}
for (const c of targets) {
  const r = await op('sheetPlan', {
    character: c.character,
    characterColors: c.colors,
    batches: batchesFor(c),
  })
  if (!r.ok) {
    console.error(`✗ ${c.id}:`, r.error)
    continue
  }
  out[c.id] = { ...c, plan: r.result }
  if (asJson) continue
  const plan = r.result
  console.log(
    `\n${'='.repeat(70)}\n### ${c.id}（${c.name}）底色 ${plan.background.hex}` +
      `（离角色色最近 ${plan.background.minDistance} / ${plan.background.nearest}）\n${'='.repeat(70)}`,
  )
  if (plan.warnings?.length) console.log('warnings:', JSON.stringify(plan.warnings, null, 1))
  for (const b of plan.batches) {
    console.log(`\n--- [${b.kind ?? 'motion'}] ${b.action} ${b.cols}×${b.rows} → ${b.filename}`)
    if (b.warnings?.length) console.log('  ⚠', JSON.stringify(b.warnings))
    console.log(b.prompt)
  }
}

if (asJson) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    new URL('./characters/plans.json', import.meta.url),
    JSON.stringify(out, null, 2) + '\n',
    'utf-8',
  )
  console.log(`✓ 写出 ${Object.keys(out).length} 只角色的计划 → verify/pet-sprite/characters/plans.json`)
}
