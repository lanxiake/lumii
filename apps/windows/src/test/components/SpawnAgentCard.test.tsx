/**
 * SpawnAgentCard 委托卡片状态测试
 *
 * 覆盖 2026-09-20 冒烟修复：被中止的 sync 委托此前照常返回 status:'ok'，
 * 卡片显示「已完成」（实时与重启回放都错）；orchestrator 现在返回 status:'aborted'，
 * 卡片须落在「已中断」——中断不是失败，也不该伪装成完成。
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { SpawnAgentCard } from '../../renderer/pages/ChatPage/components/SpawnAgentCard'

/** 对齐主进程 jsonToolResult：载荷序列化在 content[0].text */
function toolResult(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

function renderCard(result: unknown) {
  return render(
    <SpawnAgentCard
      part={{
        id: 'tool-1',
        args: { name: '灵栖维护', prompt: '整理资料' },
        status: 'done',
        result,
      }}
      messageStreaming={false}
    />,
  )
}

describe('SpawnAgentCard 的中止态', () => {
  it("result.status='aborted' → 显示「已中断」而不是「已完成」", () => {
    const { getByRole, container } = renderCard(
      toolResult({
        status: 'aborted',
        instanceId: 'inst-1',
        mode: 'sync',
        agentDefinitionId: 'builtin:maintenance',
        agentName: '灵栖维护',
        message: 'Sub-agent run was aborted before completion; no usable output.',
      }),
    )

    const header = getByRole('button')
    expect(header.textContent).toContain('已中断')
    expect(header.textContent).not.toContain('已完成')
    expect(container.textContent).toContain('本次委托已中断')
  })

  it('status=ok 的正常终态不受影响（照旧「已完成」）', () => {
    const { getByRole } = renderCard(
      toolResult({
        status: 'ok',
        instanceId: 'inst-1',
        mode: 'sync',
        agentName: '灵栖维护',
        output: '资料已整理完毕。',
      }),
    )

    const header = getByRole('button')
    expect(header.textContent).toContain('已完成')
    expect(header.textContent).not.toContain('已中断')
  })
})
