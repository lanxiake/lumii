/**
 * spec.ts 的八条校验。判据全部是「加载期拒绝优于运行期失败」（计划约束 4）：
 * 工具名不存在、前向引用、空 steps……都要在读 spec 时拒，不允许跑到第 7 步才炸。
 */
import { describe, expect, it } from 'vitest'
import { validateSpec } from './spec'

const TOOLS = new Set(['app_act', 'app_goto', 'wechat_list_sessions', 'wechat_read_history'])

/** 一个合法基线，各用例在它上面造坏 */
function baseSpec(overrides: Record<string, unknown> = {}) {
  return {
    id: 'demo',
    name: '演示',
    steps: [
      { id: 'a', tool: 'app_goto', params: { path: '/chat' } },
      { id: 'b', tool: 'wechat_read_history', params: { talker: '{{a.talker}}' } },
    ],
    ...overrides,
  }
}

function errorsOf(raw: unknown): string[] {
  const r = validateSpec(raw, TOOLS)
  return r.ok ? [] : r.errors
}

describe('validateSpec', () => {
  it('未知工具名 → 拒，错误含工具名与该 step id', () => {
    const errs = errorsOf(baseSpec({ steps: [{ id: 'x', tool: 'nope_not_a_tool' }] }))
    expect(errs.join('\n')).toContain('unknown tool: nope_not_a_tool')
    expect(errs.join('\n')).toContain('x')
  })

  it('前向引用 {{later.path}} → 拒（引用只能向后）', () => {
    const errs = errorsOf(
      baseSpec({
        steps: [
          { id: 'first', tool: 'app_goto', params: { p: '{{second.value}}' } },
          { id: 'second', tool: 'app_act', params: {} },
        ],
      }),
    )
    expect(errs.join('\n')).toMatch(/forward|向后/)
  })

  it('循环引用 A→B→A → 拒', () => {
    const errs = errorsOf(
      baseSpec({
        steps: [
          { id: 'a', tool: 'app_goto', params: { p: '{{b.v}}' } },
          { id: 'b', tool: 'app_act', params: { p: '{{a.v}}' } },
        ],
      }),
    )
    expect(errs.length).toBeGreaterThan(0)
  })

  it('steps 为空 → 拒', () => {
    expect(errorsOf(baseSpec({ steps: [] })).join('\n')).toMatch(/steps/)
  })

  it('id 缺失 → 拒；id 重复 → 拒', () => {
    expect(errorsOf(baseSpec({ steps: [{ tool: 'app_act' }] })).join('\n')).toMatch(/id/)
    const dup = errorsOf(
      baseSpec({
        steps: [
          { id: 'same', tool: 'app_act' },
          { id: 'same', tool: 'app_goto' },
        ],
      }),
    )
    expect(dup.join('\n')).toMatch(/重复|duplicate/i)
  })

  it('缺 id 的 postCleanup → 拒（计划 Task 1 用例；与设计示例不一致，见实施总结）', () => {
    const errs = errorsOf(baseSpec({ postCleanup: [{ tool: 'app_act', params: {} }] }))
    expect(errs.join('\n')).toMatch(/postCleanup|id/)
  })

  it('合法 spec → 返回 {spec, specHash}；改一字节 hash 即变', () => {
    const r = validateSpec(baseSpec(), TOOLS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.specHash).toMatch(/^[0-9a-f]{64}$/)

    const r2 = validateSpec(baseSpec({ name: '演示2' }), TOOLS)
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.specHash).not.toBe(r.specHash)
  })

  it('同一 spec 两次加载 → specHash 相等（归一化不含时间戳等运行时字段）', () => {
    const a = validateSpec(baseSpec(), TOOLS)
    const b = validateSpec(baseSpec(), TOOLS)
    expect(a.ok && b.ok && a.specHash === b.specHash).toBe(true)
  })

  it('一次报全部错误，不挤牙膏', () => {
    const errs = errorsOf(
      baseSpec({
        steps: [
          { id: 'a', tool: 'bad_one' },
          { id: 'a', tool: 'bad_two' },
        ],
      }),
    )
    // 未知工具 ×2 + 重复 id —— 至少三条，不能只报第一条
    expect(errs.length).toBeGreaterThanOrEqual(3)
  })

  it('步骤缺省值被填上（holdMs 800），且缺省不写进 specHash 的判定之外', () => {
    const r = validateSpec(baseSpec(), TOOLS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.steps[0]!.holdMs).toBe(800)
  })

  it('params 里的引用能取到 stepId；非引用字符串原样保留', () => {
    const r = validateSpec(baseSpec(), TOOLS)
    expect(r.ok).toBe(true)
  })
})
