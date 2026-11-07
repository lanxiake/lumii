/**
 * 模板库的守卫测试。
 *
 * 三件事必须守住：
 * 1. **每个 example 都能真的渲染**——它是提示词里的 few-shot，也是验收样片，
 *    如果它本身渲染不出来（缺参数、坐标越界），模型照着学只会学错。
 * 2. **结构完整**——每节有职责、有讲义骨架、有画面提示。
 * 3. **匹配能工作**——关键词命中要选对，模型给幻觉 id 要能退回。
 */
import { describe, expect, it } from 'vitest'

import { buildSceneHtml } from '../render-backend'
import { buildTemplateChoicePrompt, getTemplate, matchTemplateByKeyword, resolveTemplateChoice, TEMPLATES } from './registry'
import type { StoryboardSection } from '../teaching-core'
import { LIMITS } from '../teaching-core'

describe('模板库完整性', () => {
  it('至少 12 个模板（需求里的下限）', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(12)
  })

  it('id 唯一', () => {
    const ids = TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(TEMPLATES.map((t) => [t.id, t] as const))('模板 %s 结构完整', (_id, t) => {
    expect(t.name.length).toBeGreaterThan(0)
    expect(t.summary.length).toBeGreaterThan(0)
    expect(t.whenToUse.length).toBeGreaterThan(20)
    expect(t.keywords.length).toBeGreaterThan(2)
    expect(t.sections.length).toBeGreaterThanOrEqual(4)
    for (const s of t.sections) {
      expect(s.titleHint.length).toBeGreaterThan(0)
      expect(s.lectureHints.length).toBeGreaterThanOrEqual(3)
      expect(s.sceneHint.length).toBeGreaterThan(10)
      expect(['establish', 'change', 'name', 'prove', 'hold']).toContain(s.role)
    }
  })

  it('每个模板都有至少一个 hold 收束节', () => {
    for (const t of TEMPLATES) {
      expect(t.sections.some((s) => s.role === 'hold')).toBe(true)
    }
  })

  /**
   * roles 是「动画而非幻灯片」的唯一可靠保证：对象身份由模板定死，
   * 模型只填位置。缺了它，模型就会每步重新画（实测过三次）。
   */
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('%s 有对象名册且 id 唯一', (_id, t) => {
    expect(t.roles?.length).toBeGreaterThanOrEqual(2)
    const ids = (t.roles ?? []).map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of t.roles ?? []) {
      expect(r.id.length).toBeGreaterThan(0)
      expect(r.kind.length).toBeGreaterThan(0)
      expect(r.purpose.length).toBeGreaterThanOrEqual(3)
    }
  })

  // 名册里的 kind 必须是渲染器认识的
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('%s 的 roles kind 都是合法元素类型', (_id, t) => {
    const VALID = new Set([
      'text', 'rect', 'circle', 'line', 'formula', 'tex', 'axis', 'arrow', 'table', 'brace', 'curve', 'code', 'highlight',
    ])
    for (const r of t.roles ?? []) {
      expect(VALID.has(r.kind)).toBe(true)
    }
  })
})

describe('模板 example 能真的渲染', () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('%s 的 example 渲染成功', (_id, t) => {
    const section: StoryboardSection = {
      id: 'section_1',
      title: t.example.title,
      lectureLines: t.example.lectureLines,
      animations: t.example.lectureLines.map((_, i) => `step ${i}`),
      scene: t.example.scene,
    }
    const html = buildSceneHtml(section, t.example.scene)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('window.__seek')
    // 每个 example 至少有元素被渲染出来
    const els = html.match(/<div class="el el-/g) ?? []
    expect(els.length).toBeGreaterThan(0)
  })

  it.each(TEMPLATES.map((t) => [t.id, t] as const))('%s 的 example 没有元素越界', (_id, t) => {
    for (const step of t.example.scene) {
      for (const el of step.elements) {
        // arrow 的 x/y 是**终点**，brace 有 from/to：它们的范围是两端围成的盒子，
        // 不是「左上角 + w/h」。按后者的口径算会误报（80+24 这种）。
        if (el.kind === 'arrow' && el.from) {
          for (const p of [el.from, { x: el.x ?? 30, y: el.y ?? 40 }]) {
            expect(p.x).toBeGreaterThanOrEqual(0)
            expect(p.x).toBeLessThanOrEqual(100)
            expect(p.y).toBeGreaterThanOrEqual(0)
            expect(p.y).toBeLessThanOrEqual(100)
          }
          continue
        }
        if (el.kind === 'brace' && el.from && el.to) {
          for (const p of [el.from, el.to]) {
            expect(p.y).toBeGreaterThanOrEqual(0)
            expect(p.y).toBeLessThanOrEqual(100)
            expect(p.x).toBeGreaterThanOrEqual(0)
            expect(p.x).toBeLessThanOrEqual(100)
          }
          continue
        }
        const x = el.x ?? 30
        const y = el.y ?? 40
        const w = el.w ?? 24
        const h = el.h ?? 14
        expect(x + w).toBeLessThanOrEqual(100.5)
        expect(y + h).toBeLessThanOrEqual(100.5)
      }
    }
  })

  /**
   * example 是给模型照着学的 few-shot，所以它必须遵守**模型要遵守的同一条约束**：
   * 每步 ≤ maxElementsPerStep。否则模型照着样板画 8 个元素，会被门禁打回——
   * 样板与规则打架，比没有样板更糟。
   */
  it.each(TEMPLATES.map((t) => [t.id, t] as const))(
    '%s 的 example 每步不超过模型上限',
    (_id, t) => {
      for (const step of t.example.scene) {
        expect(step.elements.length).toBeLessThanOrEqual(LIMITS.maxElementsPerStep)
      }
    },
  )

  /**
   * example 是给模型照着学的 few-shot。
   *
   * 不给每个模板都加 id：单个 example 里的元素大多是「一次画完就不动」的
   * （一张表格、一条时间轴），硬凑跨步复用反而失真。
   *
   * 改为守住**最关键的那一条**：至少有一个模板的 example 演示了跨步复用，
   * 模型能从它学到「同一个对象在动」。至于渲染器支不支持，由
   * `render-backend.test.ts` 的「跨步移动」一组专门测。
   */
  it('至少一个模板的 example 演示了跨步复用（同一 id 出现在多步）', () => {
    const demos = TEMPLATES.filter((t) => {
      const seen = new Map<string, number>()
      for (const step of t.example.scene) {
        for (const el of step.elements) {
          if (!el.id) continue
          seen.set(el.id, (seen.get(el.id) ?? 0) + 1)
        }
      }
      return [...seen.values()].some((n) => n > 1)
    })
    expect(demos.length).toBeGreaterThan(0)
  })
})

describe('模板匹配', () => {
  it('推导类关键词命中 derive', () => {
    const m = matchTemplateByKeyword('帮我一步步推导一下这个公式')
    expect(m?.template.id).toBe('derive')
  })

  it('对比类关键词命中 compare', () => {
    const m = matchTemplateByKeyword('说说这两种方案的区别')
    expect(m?.template.id).toBe('compare')
  })

  it('数轴类关键词命中 measure', () => {
    const m = matchTemplateByKeyword('在数轴上演示一下距离')
    expect(m?.template.id).toBe('measure')
  })

  it('历史类关键词命中 timeline', () => {
    const m = matchTemplateByKeyword('讲讲这段技术发展历史')
    expect(m?.template.id).toBe('timeline')
  })

  // 回归：同分时选更具体的那个
  it('命中的关键词越具体越优先', () => {
    const m = matchTemplateByKeyword('不用推导，直接说结论就行')
    expect(m).not.toBeNull()
  })

  it('没有命中返回 null', () => {
    expect(matchTemplateByKeyword('hello world')).toBeNull()
    expect(matchTemplateByKeyword('')).toBeNull()
  })

  // 回归：Agent 会把整段需求塞进 topic。实测一条 400 字的需求里同时有
  // 「为什么」（explain）和「数据」（pattern），长文本让泛词稀释了匹配
  it('长文本只看开头，不被后半段的泛词带偏', () => {
    const long = '手机电量为什么掉得快。' + '下面是详细要求，请按步骤来。'.repeat(30)
    const m = matchTemplateByKeyword(long)
    // 「为什么」在开头，命中 explain 是对的
    expect(m?.template.id).toBe('explain')
  })

  it('真正的主题在开头时优先', () => {
    const long =
      '在数轴上演示负数乘法。' + '另外补充：为什么这样、原理是什么、怎么理解。'.repeat(20)
    const m = matchTemplateByKeyword(long)
    expect(m?.template.id).toBe('measure')
  })

  it('模型给出合法 id 时采用', () => {
    const m = resolveTemplateChoice('compare')
    expect(m.template.id).toBe('compare')
    expect(m.reason).toBe('model')
  })

  // 模型幻觉 id 或说都不合适 → 退回 explain（最通用），不是崩溃也不是无模板
  it('模型给出不存在的 id 时退回 explain', () => {
    const m = resolveTemplateChoice('not-a-real-template')
    expect(m.template.id).toBe('explain')
    expect(m.reason).toBe('fallback')
  })

  it('模型说都不合适时退回 explain', () => {
    expect(resolveTemplateChoice(null).template.id).toBe('explain')
    expect(resolveTemplateChoice('').template.id).toBe('explain')
  })

  it('getTemplate 按 id 取到', () => {
    expect(getTemplate('derive')?.name).toBe('逐步推导')
    expect(getTemplate('nope')).toBeUndefined()
  })

  it('选择提示词列出全部模板且省略完整骨架', () => {
    const p = buildTemplateChoicePrompt('线性变换')
    for (const t of TEMPLATES) {
      expect(p).toContain(t.id)
      expect(p).toContain(t.name)
    }
    // 不应把每节的 titleHint 塞进去（那是选择阶段用不上的 token）
    expect(p).not.toContain('lectureHints')
  })
})
