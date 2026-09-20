/**
 * 上下文占用卡片：页脚要按真实触发口径说话。
 *
 * 原先一律写「超过 78% 自动压缩对话历史」，但压缩判断比的是「对话历史 vs 留给
 * 对话的空间 × 比例」（见 shared/context-budget.ts）——固定开销吃掉大半窗口时，
 * 整窗 74% 可能早已越过触发线。有触发线快照时就该报 token 数，而不是让人拿整窗
 * 百分比去对那个比例。
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import ContextUsageCard from '../../renderer/pages/ChatPage/components/ChatInput/ContextUsageCard'
import type { ContextUsage } from '../../renderer/hooks/business/useAgentRuntime/agent-runtime-store'

const BASE: ContextUsage = {
  usedTokens: 190_000,
  contextWindow: 256_000,
  triggerThreshold: 0.78,
  isNearThreshold: true,
}

describe('ContextUsageCard 的触发线页脚', () => {
  it('没有触发线快照时退回整窗百分比话术', () => {
    render(<ContextUsageCard contextUsage={BASE} contextWindow={256_000} />)

    expect(screen.getByText(/超过 78% 自动压缩对话历史/)).toBeInTheDocument()
  })

  it('有快照时报对话历史与触发线的 token 数', () => {
    render(
      <ContextUsageCard
        contextUsage={{
          ...BASE,
          budget: {
            compressibleTokens: 145_000,
            budgetTokens: 214_000,
            triggerTokens: 167_000,
            exhausted: false,
          },
        }}
        contextWindow={256_000}
      />,
    )

    expect(screen.getByText(/对话历史 145K \/ 触发线 167K/)).toBeInTheDocument()
  })

  it('固定开销挤满窗口时改说「压缩无法释放」并指出可行动作', () => {
    render(
      <ContextUsageCard
        contextUsage={{
          ...BASE,
          budget: {
            compressibleTokens: 3_000,
            budgetTokens: 0,
            triggerTokens: 0,
            exhausted: true,
          },
        }}
        contextWindow={256_000}
      />,
    )

    expect(screen.getByText(/固定开销已占满窗口，压缩无法释放/)).toBeInTheDocument()
    expect(screen.getByText(/关闭部分 MCP 服务/)).toBeInTheDocument()
  })
})
