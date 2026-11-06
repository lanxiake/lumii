import { describe, expect, it } from 'vitest'

import {
  buildOutlinePrompt,
  buildSceneSpecPrompt,
  declutterSteps,
  parseSceneSpec,
  buildStoryboardPrompt,
  clampLectureLine,
  findOverlaps,
  LIMITS,
  overlapRatio,
  parseOutline,
  parseStoryboard,
} from './teaching-core'

describe('parseOutline', () => {
  it('收窄合法规格', () => {
    const o = parseOutline({
      topic: '线性变换',
      targetAudience: '大学新生',
      sections: [{ id: 'x', title: '什么是线性变换', content: '直观理解' }],
    })
    expect(o?.topic).toBe('线性变换')
    expect(o?.sections).toHaveLength(1)
    expect(o?.sections[0]?.id).toBe('section_1')
  })

  it('缺 topic/audience 时从第一节推导', () => {
    const o = parseOutline({ sections: [{ title: '只有标题' }] })
    expect(o?.topic).toBe('只有标题')
    expect(o?.targetAudience).toBe('general audience')
  })

  // 回归：模型常把内容放在 example 而不是 content
  it('content 缺失时退回 example', () => {
    const o = parseOutline({ sections: [{ title: 'T', example: '例子' }] })
    expect(o?.sections[0]?.content).toBe('例子')
  })

  it('坏形状返回 null（不补默认值）', () => {
    expect(parseOutline(null)).toBeNull()
    expect(parseOutline({})).toBeNull()
    expect(parseOutline({ sections: [] })).toBeNull()
    expect(parseOutline({ sections: [{ content: '没有标题' }] })).toBeNull()
  })

  it('小节数超限被截断', () => {
    const o = parseOutline({
      sections: Array.from({ length: LIMITS.maxSections + 5 }, (_, i) => ({ title: `T${i}` })),
    })
    expect(o?.sections).toHaveLength(LIMITS.maxSections)
  })
})

describe('parseStoryboard', () => {
  const ok = {
    sections: [
      { id: 's1', title: '第一节', lecture_lines: ['要点一', '要点二'], animations: ['出现', '移动'] },
    ],
  }

  it('收窄合法规格', () => {
    const b = parseStoryboard(ok)
    expect(b?.sections[0]?.lectureLines).toEqual(['要点一', '要点二'])
    expect(b?.sections[0]?.animations).toEqual(['出现', '移动'])
  })

  it('兼容 camelCase 的 lectureLines', () => {
    const b = parseStoryboard({
      sections: [{ title: 'T', lectureLines: ['a'], animations: ['x'] }],
    })
    expect(b?.sections[0]?.lectureLines).toEqual(['a'])
  })

  // 回归：动画数少于讲义数时右侧会空着
  it('动画数不足时用最后一条补齐', () => {
    const b = parseStoryboard({
      sections: [{ title: 'T', lecture_lines: ['a', 'b', 'c'], animations: ['只一步'] }],
    })
    expect(b?.sections[0]?.animations).toEqual(['只一步', '只一步', '只一步'])
  })

  it('动画数多于讲义数时丢弃多余', () => {
    const b = parseStoryboard({
      sections: [{ title: 'T', lecture_lines: ['a'], animations: ['x', 'y', 'z'] }],
    })
    expect(b?.sections[0]?.animations).toEqual(['x'])
  })

  it('没有讲义的小节被丢弃', () => {
    const b = parseStoryboard({
      sections: [{ title: 'T', lecture_lines: [], animations: ['x'] }, { title: 'U', lecture_lines: ['y'] }],
    })
    expect(b?.sections).toHaveLength(1)
    expect(b?.sections[0]?.title).toBe('U')
  })

  it('坏形状返回 null', () => {
    expect(parseStoryboard({})).toBeNull()
    expect(parseStoryboard({ sections: [{ animations: ['x'] }] })).toBeNull()
  })
})

describe('clampLectureLine', () => {
  it('超长截断并加省略号', () => {
    const long = '一'.repeat(100)
    const out = clampLectureLine(long, 10)
    expect(out.length).toBe(10)
    expect(out.endsWith('…')).toBe(true)
  })

  it('不超长时原样返回（去首尾空白）', () => {
    expect(clampLectureLine('  短句  ', 10)).toBe('短句')
  })
})

describe('overlapRatio / findOverlaps', () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

  it('不相交为 0', () => {
    expect(overlapRatio(box(0, 0, 10, 10), box(20, 0, 10, 10))).toBe(0)
  })

  it('完全重合为 1', () => {
    expect(overlapRatio(box(0, 0, 10, 10), box(0, 0, 10, 10))).toBe(1)
  })

  it('按较小者面积归一（大框包住小框 = 1）', () => {
    expect(overlapRatio(box(0, 0, 100, 100), box(10, 10, 10, 10))).toBe(1)
  })

  it('零面积不算相交（避免除零）', () => {
    expect(overlapRatio(box(0, 0, 0, 10), box(0, 0, 10, 10))).toBe(0)
  })

  it('findOverlaps 按比例降序，低于阈值的不报', () => {
    const pairs = findOverlaps(
      [
        { id: 'a', box: box(0, 0, 100, 100) },
        { id: 'b', box: box(0, 0, 100, 100) }, // 与 a 完全重合
        { id: 'c', box: box(5, 5, 100, 100) }, // 与 a/b 高度重合
        { id: 'd', box: box(1000, 1000, 10, 10) }, // 不相交
      ],
      0.35,
    )
    expect(pairs.length).toBeGreaterThan(0)
    expect(pairs[0]!.ratio).toBeGreaterThanOrEqual(pairs[pairs.length - 1]!.ratio)
    expect(pairs.some((p) => p.a === 'd' || p.b === 'd')).toBe(false)
  })

  it('空输入返回空数组', () => {
    expect(findOverlaps([])).toEqual([])
  })
})

describe('提示词', () => {
  it('大纲提示词带上知识点与时长，并要求 JSON', () => {
    const p = buildOutlinePrompt('TCP 三次握手', 5)
    expect(p).toContain('TCP 三次握手')
    expect(p).toContain('5 分钟')
    expect(p).toContain('"sections"')
  })

  it('分镜提示词带大纲正文，并强调行数对齐', () => {
    const p = buildStoryboardPrompt({
      topic: 'T',
      targetAudience: 'A',
      sections: [{ id: 'section_1', title: 'S', content: 'C' }],
    })
    expect(p).toContain('"topic": "T"')
    expect(p).toContain('数量必须相等')
  })

  it('画面 JSON 提示词带讲义与步骤数', () => {
    const p = buildSceneSpecPrompt({ id: 'section_1', title: 'S', lectureLines: ['a', 'b'], animations: ['x', 'y'] })
    expect(p).toContain('只输出 JSON')
    expect(p).toContain('steps 数量必须等于 2')
  })
})

describe('parseSceneSpec', () => {
  it('收窄合法规格', () => {
    const s = parseSceneSpec(
      { steps: [{ elements: [{ kind: 'rect', color: '#3b82f6', x: 20, y: 25, w: 18, h: 18 }] }] },
      1,
    )
    expect(s).toHaveLength(1)
    expect(s?.[0]?.elements[0]?.kind).toBe('rect')
  })

  it('坐标钳制在 0~100', () => {
    const s = parseSceneSpec({ steps: [{ elements: [{ kind: 'rect', x: -50, y: 300 }] }] }, 1)
    expect(s?.[0]?.elements[0]?.x).toBe(0)
    expect(s?.[0]?.elements[0]?.y).toBe(100)
  })

  it('未知 kind 与非法颜色被丢弃/忽略', () => {
    const s = parseSceneSpec(
      { steps: [{ elements: [{ kind: 'video' }, { kind: 'rect', color: 'red' }] }] },
      1,
    )
    expect(s?.[0]?.elements).toHaveLength(1)
    expect(s?.[0]?.elements[0]?.color).toBeUndefined()
  })

  it('text/formula 没有 content 时丢弃', () => {
    const s = parseSceneSpec({ steps: [{ elements: [{ kind: 'text' }] }, { elements: [{ kind: 'rect' }] }] }, 2)
    expect(s).toHaveLength(1)
  })

  it('步数按 stepCount 截断', () => {
    const s = parseSceneSpec(
      { steps: Array.from({ length: 9 }, () => ({ elements: [{ kind: 'rect' }] })) },
      3,
    )
    expect(s).toHaveLength(3)
  })

  it('坏形状返回 null', () => {
    expect(parseSceneSpec(null, 1)).toBeNull()
    expect(parseSceneSpec({ steps: [] }, 1)).toBeNull()
    expect(parseSceneSpec({ steps: [{ elements: [] }] }, 1)).toBeNull()
  })
})

describe('declutterSteps', () => {
  it('完全重合的元素会被挪开', () => {
    const out = declutterSteps([
      { elements: [{ kind: 'text', content: 'A', x: 20, y: 20, w: 20, h: 10 }, { kind: 'text', content: 'B', x: 20, y: 20, w: 20, h: 10 }] },
    ])
    const [a, b] = out[0]!.elements
    expect(a!.y).not.toBe(b!.y)
  })

  it('本来就不重叠的元素不动', () => {
    const out = declutterSteps([
      { elements: [{ kind: 'text', content: 'A', x: 10, y: 10, w: 20, h: 10 }, { kind: 'text', content: 'B', x: 60, y: 60, w: 20, h: 10 }] },
    ])
    expect(out[0]!.elements[1]!.y).toBe(60)
  })

  it('全部坐标保持在画面内', () => {
    const els = Array.from({ length: 5 }, (_, i) => ({ kind: 'rect' as const, x: 30, y: 30, w: 20, h: 10 }))
    const out = declutterSteps([{ elements: els }])
    for (const e of out[0]!.elements) {
      expect(e.x!).toBeGreaterThanOrEqual(0)
      expect(e.x!).toBeLessThanOrEqual(100)
      expect(e.y!).toBeGreaterThanOrEqual(0)
      expect(e.y!).toBeLessThanOrEqual(100)
    }
  })
})
