/**
 * 生成契约（出图提示词 + 底色推导）的单元测试
 *
 * 这一批判据是替代「写在 SKILL.md 里请 Agent 遵守」的：规则本身是确定性的，
 * 靠散文约束 LLM 等于没约束，出一次图要一分钟和一次真金白银。
 */
import { describe, expect, it } from 'vitest'
import { colorDistance, parseHexColor } from './cutout.js'
import {
  BG_MIN_SAFE_DISTANCE,
  buildSheetPlan,
  buildSheetPrompt,
  checkCharacterDirection,
  cnNumber,
  pickBackgroundColor,
} from './sheet-prompt.js'

describe('cnNumber', () => {
  it('个位与整十', () => {
    expect(cnNumber(0)).toBe('零')
    expect(cnNumber(1)).toBe('一')
    expect(cnNumber(9)).toBe('九')
    expect(cnNumber(10)).toBe('十')
    expect(cnNumber(20)).toBe('二十')
  })

  it('十几不说「一十」', () => {
    expect(cnNumber(11)).toBe('十一')
    expect(cnNumber(16)).toBe('十六')
    expect(cnNumber(36)).toBe('三十六')
  })

  it('越界原样返回（不静默给个错的中文数）', () => {
    expect(cnNumber(-1)).toBe('-1')
    expect(cnNumber(100)).toBe('100')
    expect(cnNumber(1.5)).toBe('1.5')
  })
})

describe('pickBackgroundColor', () => {
  it('挑出的底色确实离所有角色色最远（回算验证，不信它自报的数）', () => {
    const colors = ['#d9218f', '#2b1a12', '#f3e2c7']
    const pick = pickBackgroundColor(colors)
    const chosen = parseHexColor(pick.hex)!
    // 自报的 minDistance 必须等于实际最近距离
    const actual = Math.min(...colors.map((c) => colorDistance(chosen, parseHexColor(c)!)))
    expect(pick.minDistance).toBe(Math.round(actual))
    // 且它比任意其它候选都好：随机撒 200 个颜色都不该超过它
    for (let i = 0; i < 200; i++) {
      const rnd: [number, number, number] = [
        (i * 37) % 256,
        (i * 91) % 256,
        (i * 53) % 256,
      ]
      const d = Math.min(...colors.map((c) => colorDistance(rnd, parseHexColor(c)!)))
      expect(d).toBeLessThanOrEqual(pick.minDistance + 1e-9)
    }
  })

  /**
   * 这条判据现实中很少亮：真实角色配色到最近色的距离通常远在 150 以上
   * （实测描边距洋红底色 191–201）。它是「出了大问题才亮」的兜底，
   * 所以这里用一个人造的极密配色来保证这条分支确实可达。
   * （顺带一个反例：只放色立方八个角是**不够**的——它们之间的中灰有 176 的距离。）
   */
  it('配色极密时给出 safe=false（兜底分支要能触发）', () => {
    const dense: string[] = []
    for (const r of [0, 128, 255]) {
      for (const g of [0, 128, 255]) {
        for (const b of [0, 128, 255]) {
          dense.push('#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''))
        }
      }
    }
    const pick = pickBackgroundColor(dense)
    expect(pick.safe).toBe(false)
    expect(pick.minDistance).toBeLessThan(BG_MIN_SAFE_DISTANCE)
  })

  it('同色系角色不会配到同色系底色', () => {
    // 粉紫色角色：这正是写死洋红会踩的坑
    const pick = pickBackgroundColor(['#e84f9a', '#ffb3d9', '#7a2b52'])
    const chosen = parseHexColor(pick.hex)!
    for (const c of ['#e84f9a', '#ffb3d9', '#7a2b52']) {
      expect(colorDistance(chosen, parseHexColor(c)!)).toBeGreaterThan(100)
    }
  })

  it('同一个配色永远得到同一个底色（可复现）', () => {
    const colors = ['#c9a227', '#3b2f1e']
    expect(pickBackgroundColor(colors)).toEqual(pickBackgroundColor(colors))
  })

  it('不给配色 / 配色全非法时抛错，而不是悄悄用兜底色', () => {
    expect(() => pickBackgroundColor([])).toThrow(/至少一个合法的角色配色/)
    expect(() => pickBackgroundColor(['not-a-color', ''])).toThrow(/至少一个合法的角色配色/)
  })

  it('配色里的非法项被忽略，合法的仍然生效', () => {
    const pick = pickBackgroundColor(['#ff0000', 'garbage'])
    expect(pick.nearest).toBe('#ff0000')
  })
})

describe('buildSheetPrompt', () => {
  const prompt = buildSheetPrompt({
    cols: 2,
    rows: 2,
    action: '挥手',
    character: '一只奶油色的小狗，深棕色粗描边',
    background: '#1d5fa8',
  })

  it('六个技术段落齐备', () => {
    for (const section of ['FORMAT:', 'FORBIDDEN:', 'CONSISTENCY:', 'CAMERA:', 'BACKGROUND:', 'MOTION:']) {
      expect(prompt).toContain(section)
    }
  })

  it('网格用中文数字，尺寸与格数都由参数推出', () => {
    expect(prompt).toContain('等分为二行二列')
    expect(prompt).toContain('全部四格')
  })

  it('除 BACKGROUND 的色值外不出现阿拉伯数字', () => {
    const withoutBgLine = prompt
      .split('\n')
      .filter((l) => !l.startsWith('BACKGROUND:'))
      .join('\n')
    expect(withoutBgLine).not.toMatch(/[0-9]/)
  })

  it('写进了底色与动作名，创作段原样接在最后', () => {
    expect(prompt).toContain('#1d5fa8')
    expect(prompt).toContain('只表现一个动作：挥手')
    expect(prompt.trimEnd().endsWith('一只奶油色的小狗，深棕色粗描边')).toBe(true)
  })

  it('明确要求「同一只角色、位置与尺寸不变、不越格」——这是桌宠与 302Sprite 的分野', () => {
    expect(prompt).toContain('同一只角色')
    expect(prompt).toContain('位置和大小完全相同')
    expect(prompt).toContain('不得碰到或越过格子边界')
    expect(prompt).toContain('正视角')
    // 不该出现等距视角那套（那是动作 RPG 精灵的需求）
    expect(prompt).not.toMatch(/等距|三\/四|isometric/i)
  })

  /**
   * 这条是**实测改过的判据**，两版说的是相反的事。
   *
   * 早先写的是「相邻两格之间的差异应当小且均匀」——意图是防「四个互不相干的姿势」，
   * 但它同时在教模型**把四格画成一样的**。实测代价：待机四格相邻差只有 242/404/319
   * 个像素（角色总共 ~4350），四格几乎是同一张图，播起来像没动。
   *
   * 现在要的是「每格是一个**关键姿态**、相邻格有**一眼看得出**的变化」，
   * 防跑题那句挪到「全部格子必须能连成同一个动作」上。
   */
  it('MOTION 段要求首尾闭合与「关键姿态、变化看得见」', () => {
    expect(prompt).toContain('最末一格要能无缝接回最初一格')
    expect(prompt).toContain('关键姿态')
    expect(prompt).toContain('一眼就能看出')
    expect(prompt).toContain('全部格子必须能连成同一个动作')
    // 老那句必须消失：它是在教模型画四张一样的图
    expect(prompt).not.toContain('相邻两格之间的差异应当小且均匀')
  })

  /**
   * 只给动作名（「挥手」）模型会自由发挥成四个看着像挥手的姿势；
   * 给了经过才有东西照着排，而格子的读序就是时间序。
   */
  it('给了动作经过就写进 MOTION 段，并要求按时间均分', () => {
    const withMotion = buildSheetPrompt({
      cols: 3,
      rows: 2,
      action: '挥手',
      motion: '右前爪抬到耳侧 → 向左摆 → 摆回右侧 → 缓慢落回身侧',
      character: '一只猫',
      background: '#1d5fa8',
    })
    expect(withMotion).toContain('这个动作的经过是：右前爪抬到耳侧')
    expect(withMotion).toContain('把这段经过按时间均分到六格里')
  })

  it('不给动作经过时，提示词里不出现「经过」那句（不留空壳）', () => {
    expect(prompt).not.toContain('这个动作的经过是')
  })
})

describe('checkCharacterDirection', () => {
  it('干净的一段话不报', () => {
    expect(checkCharacterDirection('一只坐着的小猫，尾巴轻轻摆动，重心落在后腿')).toEqual([])
  })

  it('阿拉伯数字会被点出来', () => {
    const w = checkCharacterDirection('第1格抬右手')
    expect(w.some((x) => x.includes('阿拉伯数字'))).toBe(true)
  })

  it('技术词会被点出来（创作段不该抢技术段的活）', () => {
    const w = checkCharacterDirection('每一帧都要保持一致，注意分辨率和画布')
    expect(w.some((x) => x.includes('技术词'))).toBe(true)
    expect(w.some((x) => x.includes('帧'))).toBe(true)
  })

  it('中文数字不算越界', () => {
    expect(checkCharacterDirection('第一格抬右手，第二格放下')).toEqual([])
  })
})

describe('buildSheetPlan', () => {
  const base = {
    character: '一只奶油色的小狗，深棕色粗描边',
    characterColors: ['#f3e2c7', '#4a3520', '#1a1a1a'],
  }

  it('一批 = 一个动作，文件名按序且互不相同', () => {
    const plan = buildSheetPlan({
      ...base,
      batches: [
        { action: '待机呼吸', cols: 2, rows: 2 },
        { action: '挥手', cols: 2, rows: 2 },
      ],
    })
    expect(plan.batches.map((b) => b.filename)).toEqual(['pet-sheet-1.png', 'pet-sheet-2.png'])
    expect(plan.batches[0]!.prompt).toContain('只表现一个动作：待机呼吸')
    expect(plan.batches[1]!.prompt).toContain('只表现一个动作：挥手')
  })

  it('所有批次共用同一个底色', () => {
    const plan = buildSheetPlan({
      ...base,
      batches: [
        { action: '待机', cols: 2, rows: 2 },
        { action: '挥手', cols: 2, rows: 2 },
      ],
    })
    for (const b of plan.batches) expect(b.prompt).toContain(plan.background.hex)
  })

  it('显式给底色时不再推导，且不声称安全', () => {
    const plan = buildSheetPlan({ ...base, background: '#123456', batches: [{ action: '待机', cols: 1, rows: 1 }] })
    expect(plan.background.hex).toBe('#123456')
    expect(plan.background.safe).toBe(false)
    expect(plan.warnings.some((w) => w.includes('安全线'))).toBe(true)
  })

  it('动作名里带数字也会报警（它会原样进提示词）', () => {
    const plan = buildSheetPlan({ ...base, batches: [{ action: '动作2', cols: 2, rows: 2 }] })
    expect(plan.warnings.some((w) => w.includes('动作2') && w.includes('阿拉伯数字'))).toBe(true)
  })

  it('没给动作经过会提醒（只给名字，模型容易画成互不相干的姿势）', () => {
    const plan = buildSheetPlan({
      ...base,
      batches: [{ action: '挥手', cols: 2, rows: 2 }],
    })
    expect(plan.warnings.some((w) => w.includes('没给 motion'))).toBe(true)
  })

  it('给了动作经过就不再提醒，且经过里的数字也会被查', () => {
    const ok = buildSheetPlan({
      ...base,
      batches: [{ action: '挥手', motion: '抬起 → 左摆 → 回摆 → 落下', cols: 2, rows: 2 }],
    })
    expect(ok.warnings.some((w) => w.includes('没给 motion'))).toBe(false)

    const bad = buildSheetPlan({
      ...base,
      batches: [{ action: '挥手', motion: '第1拍抬起', cols: 2, rows: 2 }],
    })
    expect(bad.warnings.some((w) => w.includes('动作经过') && w.includes('阿拉伯数字'))).toBe(true)
  })

  it('六格（3×2）的网格也支持，中文数字是「六」', () => {
    const plan = buildSheetPlan({
      ...base,
      batches: [{ action: '挥手', motion: '抬起 → 左摆 → 回摆 → 落下', cols: 3, rows: 2 }],
    })
    expect(plan.batches[0]!.prompt).toContain('等分为二行三列')
    expect(plan.batches[0]!.prompt).toContain('全部六格')
  })

  it('网格非法或没有批次时抛错', () => {
    expect(() => buildSheetPlan({ ...base, batches: [] })).toThrow(/至少要有一个批次/)
    expect(() =>
      buildSheetPlan({ ...base, batches: [{ action: '待机', cols: 0, rows: 2 }] }),
    ).toThrow(/网格不合法/)
  })
})

/**
 * 表情批与动作批的格子语义**相反**：动作批要「每格是上一格的下一时刻」，
 * 表情批要「每格除了那一个部位之外逐像素一致」。共用一套模板等于让模型去编时间顺序。
 */
describe('buildSheetPrompt / expression 批', () => {
  const expr = buildSheetPrompt({
    kind: 'expression',
    cols: 2,
    rows: 2,
    action: '眼神差分',
    part: '眼睛',
    variants: ['睁眼', '闭眼', '笑眼', '难过'],
    character: '一只奶油色的小狗',
    background: '#1d5fa8',
  })

  it('用 FACES 段而不是 MOTION 段', () => {
    expect(expr).toContain('FACES:')
    expect(expr).not.toContain('MOTION:')
    expect(expr).toContain('并列的几种表情')
  })

  it('明确要求「身体姿势不要跟着变」并点名变化的部位', () => {
    expect(expr).toContain('身体姿势不要跟着变')
    expect(expr).toContain('各格之间只有眼睛不同')
  })

  it('各格取值按读序写进去', () => {
    expect(expr).toContain('按顺序依次是：睁眼、闭眼、笑眼、难过')
  })

  it('不给 variants 时不留空壳', () => {
    const bare = buildSheetPrompt({
      kind: 'expression', cols: 2, rows: 2, action: 'x',
      character: 'c', background: '#000000',
    })
    expect(bare).not.toContain('按顺序依次是')
    expect(bare).not.toContain('MOTION:')
  })

  it('缺 part / variants 数量对不上时报警', () => {
    const missingPart = buildSheetPlan({
      character: 'c', characterColors: ['#ff0000'],
      batches: [{ kind: 'expression', action: '差分', variants: ['a', 'b', 'c', 'd'], cols: 2, rows: 2 }],
    })
    expect(missingPart.warnings.some((w) => w.includes('没给 part'))).toBe(true)

    const wrongCount = buildSheetPlan({
      character: 'c', characterColors: ['#ff0000'],
      batches: [{ kind: 'expression', action: '差分', part: '眼睛', variants: ['a', 'b'], cols: 2, rows: 2 }],
    })
    expect(wrongCount.warnings.some((w) => w.includes('与网格 2×2（4 格）不符'))).toBe(true)
  })

  it('expression 批不会因为「没给 motion」被误报', () => {
    const plan = buildSheetPlan({
      character: 'c', characterColors: ['#ff0000'],
      batches: [{ kind: 'expression', action: '差分', part: '眼睛', variants: ['a', 'b', 'c', 'd'], cols: 2, rows: 2 }],
    })
    expect(plan.warnings.some((w) => w.includes('没给 motion'))).toBe(false)
  })
})
