import { describe, expect, it } from 'vitest'

import {
  buildOutlinePrompt,
  buildReviewMarkdown,
  buildSceneSpecPrompt,
  checkSceneLayout,
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
    expect(s?.steps).toHaveLength(1)
    expect(s?.steps[0]?.elements[0]?.kind).toBe('rect')
  })

  it('坐标钳制在 0~100', () => {
    const s = parseSceneSpec({ steps: [{ elements: [{ kind: 'rect', x: -50, y: 300 }] }] }, 1)
    expect(s?.steps[0]?.elements[0]?.x).toBe(0)
    expect(s?.steps[0]?.elements[0]?.y).toBe(100)
  })

  it('未知 kind 与非法颜色被丢弃/忽略', () => {
    const s = parseSceneSpec(
      { steps: [{ elements: [{ kind: 'video' }, { kind: 'rect', color: 'red' }] }] },
      1,
    )
    expect(s?.steps[0]?.elements).toHaveLength(1)
    expect(s?.steps[0]?.elements[0]?.color).toBeUndefined()
  })

  // 回归：被丢掉的元素要报出来，否则「画面少了一块」无从追查
  it('不合格元素被丢弃时记 issue', () => {
    const s = parseSceneSpec({ steps: [{ elements: [{ kind: 'video' }, { kind: 'rect' }] }] }, 1)
    expect(s?.issues.some((i) => i.kind === 'dropped_element')).toBe(true)
  })

  it('text/formula 没有 content 时丢弃', () => {
    const s = parseSceneSpec({ steps: [{ elements: [{ kind: 'text' }] }, { elements: [{ kind: 'rect' }] }] }, 2)
    expect(s?.steps).toHaveLength(1)
  })

  it('步数按 stepCount 截断', () => {
    const s = parseSceneSpec(
      { steps: Array.from({ length: 9 }, () => ({ elements: [{ kind: 'rect' }] })) },
      3,
    )
    expect(s?.steps).toHaveLength(3)
  })

  // 回归：旧实现静默 slice(0,3)，实测 18% 的元素就这么没了
  it('元素超量时报 too_many_elements（不再静默截断）', () => {
    const s = parseSceneSpec(
      {
        steps: [
          {
            elements: [
              { kind: 'rect' },
              { kind: 'circle' },
              { kind: 'line' },
              { kind: 'text', content: '第4个' },
            ],
          },
        ],
      },
      1,
    )
    expect(s?.steps[0]?.elements).toHaveLength(3)
    const issue = s?.issues.find((i) => i.kind === 'too_many_elements')
    expect(issue?.detail).toContain('4')
  })

  it('画面步数少于讲义行时报 short_steps', () => {
    const s = parseSceneSpec({ steps: [{ elements: [{ kind: 'rect' }] }] }, 4)
    expect(s?.issues.some((i) => i.kind === 'short_steps')).toBe(true)
  })

  it('坏形状返回 null', () => {
    expect(parseSceneSpec(null, 1)).toBeNull()
    expect(parseSceneSpec({ steps: [] }, 1)).toBeNull()
    expect(parseSceneSpec({ steps: [{ elements: [] }] }, 1)).toBeNull()
  })
})

describe('checkSceneLayout', () => {
  it('不重叠的元素不报问题', () => {
    const issues = checkSceneLayout([
      { elements: [{ kind: 'text', content: 'A', x: 10, y: 10, w: 20, h: 10 }, { kind: 'text', content: 'B', x: 60, y: 60, w: 20, h: 10 }] },
    ])
    expect(issues).toHaveLength(0)
  })

  it('检出真实元素重叠（此前检查的是不存在的 3×3 面板）', () => {
    const issues = checkSceneLayout([
      { elements: [{ kind: 'text', content: 'A', x: 20, y: 20, w: 30, h: 20 }, { kind: 'text', content: 'B', x: 22, y: 22, w: 30, h: 20 }] },
    ])
    expect(issues.some((i) => i.kind === 'overlap')).toBe(true)
    expect(issues[0]?.indexes).toEqual([0, 1])
  })

  it('检出元素出界', () => {
    const issues = checkSceneLayout([{ elements: [{ kind: 'rect', x: 80, y: 20, w: 30, h: 20 }] }])
    expect(issues.some((i) => i.kind === 'out_of_bounds')).toBe(true)
  })

  // 回归：第 2 节把 w:80 h:8 的 rect 当数轴，渲染成空心长条
  it('检出把 rect 当线用的极扁形状', () => {
    const issues = checkSceneLayout([{ elements: [{ kind: 'rect', x: 10, y: 25, w: 80, h: 8 }] }])
    expect(issues.some((i) => i.kind === 'suspicious_span')).toBe(true)
  })

  it('正常比例的形状不误报', () => {
    const issues = checkSceneLayout([{ elements: [{ kind: 'rect', x: 10, y: 25, w: 30, h: 20 }] }])
    expect(issues.some((i) => i.kind === 'suspicious_span')).toBe(false)
  })

  it('line 类型的极扁不算可疑（线本来就该扁）', () => {
    const issues = checkSceneLayout([{ elements: [{ kind: 'line', x: 10, y: 25, w: 80, h: 8 }] }])
    expect(issues.some((i) => i.kind === 'suspicious_span')).toBe(false)
  })
})

describe('declutterSteps', () => {
  it('完全重合的元素会被挪开', () => {
    const out = declutterSteps([
      { elements: [{ kind: 'text', content: 'A', x: 20, y: 20, w: 20, h: 10 }, { kind: 'text', content: 'B', x: 20, y: 20, w: 20, h: 10 }] },
    ])
    const [a, b] = out[0]!.elements
    // 挪到哪都行（横向或纵向），只要不再完全重合
    expect(a!.x === b!.x && a!.y === b!.y).toBe(false)
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

describe('buildReviewMarkdown', () => {
  const outline = {
    topic: '勾股定理',
    targetAudience: '初中生',
    sections: [
      { id: 'section_1', title: '直角三角形', content: '三边' },
      { id: 'section_2', title: '平方和', content: 'a²+b²' },
    ],
  }
  const board = {
    sections: [
      { id: 'section_1', title: '直角三角形', lectureLines: ['三条边'], animations: ['画出来'], targetSeconds: 15 },
      { id: 'section_2', title: '平方和', lectureLines: ['平方和'], animations: ['写公式'], targetSeconds: 15 },
    ],
  }

  it('包含主题、受众与节数', () => {
    const md = buildReviewMarkdown(outline, board)
    expect(md).toContain('勾股定理')
    expect(md).toContain('初中生')
    expect(md).toContain('2 节')
  })

  it('逐节列出讲义与对应画面', () => {
    const md = buildReviewMarkdown(outline, board)
    expect(md).toContain('**三条边**')
    expect(md).toContain('画面：画出来')
    expect(md).toContain('### 1. 直角三角形')
  })

  // 审阅稿是给「要不要往下走」做判断用的，必须写清下一步怎么操作
  it('给出「确认后如何出片」的指引，且指向 fromDir', () => {
    const md = buildReviewMarkdown(outline, board)
    expect(md).toContain('fromDir')
    expect(md).toContain('草稿')
  })

  it('大纲与分镜节数不一致时自检里点出来', () => {
    const md = buildReviewMarkdown(
      { ...outline, sections: [outline.sections[0]!] },
      board,
    )
    expect(md).toContain('不一致')
  })

  // 不夹带渲染细节：审阅者要在 30 秒内判断要不要往下走
  it('不含渲染相关的噪音', () => {
    const md = buildReviewMarkdown(outline, board)
    expect(md).not.toContain('fps')
    expect(md).not.toContain('ffmpeg')
    expect(md).not.toContain('__seek')
  })
})

describe('buildOutlinePrompt：受众', () => {
  // 回归：受众只覆盖了输出字段、没进提示词，模型按自己猜的水平写了整份大纲
  it('给定受众时写进提示词', () => {
    const p = buildOutlinePrompt('勾股定理', 3, '初中生')
    expect(p).toContain('目标受众：初中生')
    expect(p).toContain('已掌握什么')
    expect(p).not.toContain('由你判断')
  })

  it('未给受众时让模型自己判断', () => {
    const p = buildOutlinePrompt('勾股定理', 3)
    expect(p).toContain('由你判断')
  })

  it('受众首尾空白被裁掉', () => {
    expect(buildOutlinePrompt('x', 3, '  高中生  ')).toContain('目标受众：高中生')
  })
})

describe('declutterSteps：不变量', () => {
  /** 直接检查避让后是否真的没有重叠（用与实现相同的判定口径） */
  const overlapping = (els: Array<{ x?: number; y?: number; w?: number; h?: number }>) => {
    const b = (e: { x?: number; y?: number; w?: number; h?: number }) => ({
      x: e.x ?? 30, y: e.y ?? 40, w: e.w ?? 24, h: Math.max(8, e.h ?? 14),
    })
    const out: number[] = []
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = b(els[i]!), c = b(els[j]!)
        const ix = Math.max(0, Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x))
        const iy = Math.max(0, Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y))
        if (ix * iy > 0) out.push(i * 100 + j)
      }
    }
    return out
  }

  // 回归：实测 3 个公式元素叠成「x10 x x×x=0x099」——旧实现挪到底再换列，换列后重撞
  it('3 个同位置元素避让后零重叠', () => {
    const out = declutterSteps([
      {
        elements: [
          { kind: 'formula', content: '10x = 9.999…', x: 30, y: 20, w: 30, h: 10 },
          { kind: 'formula', content: 'x = 0.999…', x: 30, y: 20, w: 30, h: 10 },
          { kind: 'formula', content: '9x = 9', x: 30, y: 20, w: 30, h: 10 },
        ],
      },
    ])
    expect(overlapping(out[0]!.elements)).toEqual([])
  })

  it('5 个同位置元素也能全部摆开', () => {
    const els = Array.from({ length: 5 }, () => ({
      kind: 'text' as const,
      content: 'x',
      x: 40,
      y: 40,
      w: 20,
      h: 10,
    }))
    const out = declutterSteps([{ elements: els }])
    expect(overlapping(out[0]!.elements)).toEqual([])
  })

  it('保证不越出右区（x + w <= 100）', () => {
    const out = declutterSteps([
      { elements: Array.from({ length: 4 }, () => ({ kind: 'rect' as const, x: 90, y: 40, w: 20, h: 10 })) },
    ])
    for (const e of out[0]!.elements) {
      expect((e.x ?? 0) + (e.w ?? 24)).toBeLessThanOrEqual(100)
    }
  })

  it('本来不重叠的保持原位（不为了整齐去动模型给的坐标）', () => {
    const out = declutterSteps([
      {
        elements: [
          { kind: 'text', content: 'A', x: 10, y: 10, w: 20, h: 10 },
          { kind: 'text', content: 'B', x: 60, y: 70, w: 20, h: 10 },
        ],
      },
    ])
    expect(out[0]!.elements[0]!.x).toBe(10)
    expect(out[0]!.elements[1]!.y).toBe(70)
  })
})
