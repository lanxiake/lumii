/**
 * SkillRow：环境屏蔽（如 Linux 缺 Python 3）时启用开关禁用并显示原因。
 *
 * 对应设计 D4「屏蔽入口 + 文案说明，禁止静默失败」在技能页的落点。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { SkillRow } from '../../renderer/pages/SkillsPage/components/SkillRow'

const skillInfo = {
  skillItemId: 'local-pdf-skill',
  isEnabled: true,
  executionCount: 3,
  skill: { name: 'PDF 处理', description: '示例技能', version: '1.0.0', tags: ['本地'] },
}

function renderRow(blockedReason?: string | null) {
  const onToggle = vi.fn()
  render(
    <SkillRow
      skillInfo={skillInfo}
      isOperating={false}
      blockedReason={blockedReason}
      onDetail={vi.fn()}
      onToggle={onToggle}
      onUninstall={vi.fn()}
    />,
  )
  return { onToggle }
}

describe('SkillRow 屏蔽态', () => {
  it('blockedReason 存在时：开关禁用、title 显示原因、点击不触发 onToggle', () => {
    const reason = '需要 Python 3。请先安装：sudo apt install python3'
    const { onToggle } = renderRow(reason)

    const btn = screen.getByTitle(reason)
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('无 blockedReason 时：开关可用，title 为「禁用」（当前已启用），点击触发 onToggle', () => {
    const { onToggle } = renderRow(null)

    const btn = screen.getByTitle('禁用')
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('技能行本身仍可点开详情（屏蔽只约束启用开关）', () => {
    const reason = '需要 Python 3'
    renderRow(reason)
    // 名称与调用次数照常渲染
    expect(screen.getByText('PDF 处理')).toBeInTheDocument()
    expect(screen.getByText('3 次')).toBeInTheDocument()
  })
})
