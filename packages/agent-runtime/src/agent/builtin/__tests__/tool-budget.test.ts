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
import { ALL_BUILT_IN_TOOL_CONFIGS } from '../../../tools/built-in/index.js'

/**
 * 每个 Agent 的工具数上限。改大之前先问两个问题：
 * 1. 新工具与已有工具**语义是否重叠**？（重叠的话是改旧工具，不是加新的）
 * 2. 它是「唯一路径」吗？（`app_fill_form` 就是靠这条留下来的）
 *
 * **`assistant` 用 `["*"]`**（2026-09-18 批次 3 纳入）——它是主对话 Agent，
 * 工具面 = 全量注册表，因而最容易在"顺便加个工具"里悄悄膨胀。
 * 但它数到的只是**内置**那部分：宿主注册的工具（`app_*` / `screen_record_*` 等）
 * 在 `apps/windows`，这里看不见。所以这个预算守的是**内置工具面**的膨胀。
 */
const TOOL_BUDGET: Record<string, number> = {
  // 55 = 54 + `execute_skill`（2026-09-18 批次 3 接线：它此前从未注册，
  // 提示词却一直写着"MUST be invoked via execute_skill tool"）
  assistant: 55,
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
  const list = def.tools ?? []
  // `["*"]` 展开为内置工具全量（`filterToolsByDefinition` 对通配符不做白名单过滤）
  if (list.includes('*')) return ALL_BUILT_IN_TOOL_CONFIGS.length
  return list.length
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

  it('通配符 Agent 已纳入预算（2026-09-18 批次 3 起）', () => {
    const wildcard = BUILTIN_AGENT_DEFINITIONS.filter((a) => (a.tools ?? []).includes('*'))
    // 事实记录：仍然只有 assistant 用通配符
    expect(wildcard.map((a) => a.id)).toEqual(['assistant'])
    // 且它在 TOOL_BUDGET 里——此前这条用例记录的是"不参与预算"，
    // 而通配符恰恰是最容易膨胀的那种工具面（全量注册表），不该是唯一没守护的
    for (const a of wildcard) {
      expect(Object.keys(TOOL_BUDGET), `${a.id} 应纳入预算`).toContain(a.id)
    }
  })

  it('通配符展开用的是内置工具全量，不是 1', () => {
    // 元测试：防 `toolCount` 退回 `(def.tools ?? []).length`——
    // 那样 `["*"]` 会被数成 1，预算形同虚设且**测试仍会通过**（1 <= 54）
    expect(ALL_BUILT_IN_TOOL_CONFIGS.length).toBeGreaterThan(20)
    expect(toolCount('assistant')).toBe(ALL_BUILT_IN_TOOL_CONFIGS.length)
  })
})
