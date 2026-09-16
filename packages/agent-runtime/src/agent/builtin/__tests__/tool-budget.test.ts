/**
 * 各 Agent 工具面的**预算守卫**。
 *
 * 这条测试的价值不在于「今天数字对不对」，而在于它是**唯一能阻止工具面重新膨胀的机制**：
 * 没有它，今天的收敛半年后会被一条条「顺便加个工具」加回去，而且没人会发现——
 * 直到某个 Agent 越过 Anthropic 说的 30–50 条退化区间（维护已经越过一次）。
 *
 * 加工具不是不可以，但要**显式改这里的预算**，让「工具面又变大了」这件事在 diff 里看得见。
 *
 * 另：预算里含 `...APP_UI_TOOL_NAMES` 展开（运行时才算得准，数字面量会漏掉常量引用——
 * 12a 第一版就是这么把 33 数成 31 的）。
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENT_DEFINITIONS } from '../definitions.js'

/**
 * 每个 Agent 的工具数上限。改大之前先问两个问题：
 * 1. 新工具与已有工具**语义是否重叠**？（重叠的话是改旧工具，不是加新的）
 * 2. 它是「唯一路径」吗？（`app_fill_form` 就是靠这条留下来的）
 */
const TOOL_BUDGET: Record<string, number> = {
  'system-keeper': 31,
  'info-curator': 14,
  chronicler: 10,
  'code-dev': 18,
}

/** 2026-09-16 收敛掉的名字；它们不该再出现在任何白名单里 */
const RETIRED_TOOLS = ['skill_list', 'app_scroll_to_bottom']

function toolCount(agentId: string): number {
  const def = BUILTIN_AGENT_DEFINITIONS.find((a) => a.id === agentId)
  if (!def) throw new Error(`找不到 Agent 定义: ${agentId}`)
  return (def.tools ?? []).length
}

describe('Agent 工具面预算', () => {
  for (const [agentId, budget] of Object.entries(TOOL_BUDGET)) {
    it(`${agentId} 不超过 ${budget} 个工具`, () => {
      const n = toolCount(agentId)
      expect(
        n,
        `${agentId} 现有 ${n} 个工具，超预算 ${budget}。` +
          `若确实要加，请连同本文件的预算一起改并在提交信息里说明理由。`,
      ).toBeLessThanOrEqual(budget)
    })
  }

  it('预算不是摆设：当前数量与预算贴得很近（差太远说明预算没在维护）', () => {
    for (const [agentId, budget] of Object.entries(TOOL_BUDGET)) {
      const n = toolCount(agentId)
      // 允许留 2 个余量；超出说明悄悄涨过，低于太多说明预算该往下调了
      expect(budget - n, `${agentId} 预算 ${budget} 与实际 ${n} 差得太多`).toBeLessThanOrEqual(2)
    }
  })

  it('已收敛的工具名不在任何白名单里', () => {
    for (const def of BUILTIN_AGENT_DEFINITIONS) {
      const tools = def.tools ?? []
      for (const retired of RETIRED_TOOLS) {
        expect(
          tools.includes(retired),
          `${def.id} 的白名单里还有已收敛的 ${retired}`,
        ).toBe(false)
      }
    }
  })

  it('通配符 Agent 不参与预算（它的工具面是全量注册表，另有开关控制）', () => {
    const wildcard = BUILTIN_AGENT_DEFINITIONS.filter((a) => (a.tools ?? []).includes('*'))
    // 记录这个事实：预算守护只覆盖显式白名单的 Agent
    expect(wildcard.map((a) => a.id)).toContain('assistant')
  })
})
