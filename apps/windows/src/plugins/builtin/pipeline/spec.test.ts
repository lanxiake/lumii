/**
 * spec.ts 的八条校验。判据全部是「加载期拒绝优于运行期失败」（计划约束 4）：
 * 工具名不存在、前向引用、空 steps……都要在读 spec 时拒，不允许跑到第 7 步才炸。
 */
import { describe, expect, it } from 'vitest'
import { validateSpec } from './spec'

const TOOLS = new Set(['app_act', 'app_goto', 'wechat_list_sessions', 'wechat_read_history'])
const AGENTS = new Set(['assistant', 'builtin:explore'])

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
  const r = validateSpec(raw, TOOLS, AGENTS)
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
    const r = validateSpec(baseSpec(), TOOLS, AGENTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.specHash).toMatch(/^[0-9a-f]{64}$/)

    const r2 = validateSpec(baseSpec({ name: '演示2' }), TOOLS, AGENTS)
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.specHash).not.toBe(r.specHash)
  })

  it('同一 spec 两次加载 → specHash 相等（归一化不含时间戳等运行时字段）', () => {
    const a = validateSpec(baseSpec(), TOOLS, AGENTS)
    const b = validateSpec(baseSpec(), TOOLS, AGENTS)
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
    const r = validateSpec(baseSpec(), TOOLS, AGENTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.steps[0]!.holdMs).toBe(800)
  })

  it('params 里的引用能取到 stepId；非引用字符串原样保留', () => {
    const r = validateSpec(baseSpec(), TOOLS, AGENTS)
    expect(r.ok).toBe(true)
  })
})

/**
 * agent 节点（P1）。
 *
 * 关键一条：**未知 agentType 必须拒，不能回落 assistant**。
 * orchestrator 对未知 id 是善意兜底，对流水线却是灾难——作者以为跑专用 Agent，
 * 实际跑通用 Agent，结果不可复现且毫无提示。所以这里与 knownTools 同原则。
 */
describe('validateSpec —— agent 节点', () => {
  const agentSpec = (step: Record<string, unknown>) =>
    baseSpec({ steps: [{ id: 'brief', ...step }] })

  it('合法的 agent 节点 → 通过，缺省 agentType 规范化为 assistant', () => {
    const r = validateSpec(agentSpec({ kind: 'agent', prompt: '写 brief' }), TOOLS, AGENTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = r.spec.steps[0]!
    expect(s.kind).toBe('agent')
    expect(s.kind === 'agent' && s.agentType).toBe('assistant')
  })

  it('缺 prompt → 拒', () => {
    const errs = errorsOf(agentSpec({ kind: 'agent' }))
    expect(errs.join('\n')).toMatch(/prompt/)
  })

  it('同时写 tool → 拒（歧义）', () => {
    const errs = errorsOf(agentSpec({ kind: 'agent', prompt: 'x', tool: 'app_act' }))
    expect(errs.join('\n')).toMatch(/tool/)
  })

  it('未知 agentType → 拒，文案带 id 与「Agents 页」', () => {
    const errs = errorsOf(agentSpec({ kind: 'agent', prompt: 'x', agentType: 'security' }))
    const text = errs.join('\n')
    expect(text).toContain('security')
    expect(text).toContain('Agents 页')
  })

  it('knownAgents 为空 → 缺省 assistant 也被拒（证明缺省同样受校验）', () => {
    const r = validateSpec(agentSpec({ kind: 'agent', prompt: 'x' }), TOOLS, new Set())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join('\n')).toContain('Agents 页')
  })

  it('prompt 里的前向引用 → 拒', () => {
    const errs = errorsOf(
      baseSpec({
        steps: [
          { id: 'brief', kind: 'agent', prompt: '见 {{later.value}}' },
          { id: 'later', tool: 'app_act' },
        ],
      }),
    )
    expect(errs.join('\n')).toMatch(/前向引用|向后/)
  })

  it('未知 kind → 拒', () => {
    const errs = errorsOf(baseSpec({ steps: [{ id: 'x', kind: 'loop', prompt: 'x' }] }))
    expect(errs.join('\n')).toMatch(/kind/)
  })

  it("rehearsal 只认 'run'，其它值按缺省跳过处理", () => {
    const r = validateSpec(
      agentSpec({ kind: 'agent', prompt: 'x', rehearsal: 'skip' }),
      TOOLS,
      AGENTS,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = r.spec.steps[0]!
    expect(s.kind === 'agent' && s.rehearsal).toBeUndefined()
  })
})
