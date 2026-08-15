/**
 * ComposerPlusMenu 冒烟测试：主菜单项与附件入口
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ComposerPlusMenu } from '../../renderer/pages/ChatPage/components/ChatInput/ComposerPlusMenu'

vi.mock('../../renderer/hooks/business/useSkills', () => ({
  useSkills: () => ({
    installedSkills: [
      {
        id: 'local-demo',
        userId: 'local',
        skillItemId: 'demo',
        installedVersion: '1.0.0',
        isEnabled: true,
        installedAt: '',
        category: '',
        skill: {
          id: 'demo',
          name: 'demo-skill',
          description: 'A demo skill',
          version: '1.0.0',
          status: 'active',
          downloadCount: 0,
          ratingCount: 0,
          sourceType: 'user',
          isFeatured: false,
          createdAt: '',
          updatedAt: '',
        },
      },
    ],
    isLoading: false,
    enableSkill: vi.fn(async () => true),
    disableSkill: vi.fn(async () => true),
  }),
}))

vi.mock('../../renderer/hooks/business/useToolSearch', () => ({
  useToolSearch: () => ({
    tools: [],
    mcpStatus: [],
    isLoading: false,
    togglingTool: null,
    toggleTool: vi.fn(),
    refresh: vi.fn(),
  }),
}))

describe('ComposerPlusMenu', () => {
  const onAttachFiles = vi.fn()
  const onAgentChange = vi.fn()
  const onManageSkills = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('点击 + 显示主菜单四项', () => {
    render(
      <ComposerPlusMenu
        onAttachFiles={onAttachFiles}
        onAgentChange={onAgentChange}
        onManageSkills={onManageSkills}
        agents={[]}
      />,
    )

    fireEvent.click(screen.getByLabelText('添加附件、技能与 Agent'))

    expect(screen.getByText('添加文件或图片')).toBeInTheDocument()
    expect(screen.getByText('技能')).toBeInTheDocument()
    expect(screen.getByText('MCP 服务')).toBeInTheDocument()
    expect(screen.getByText('切换 Agent')).toBeInTheDocument()
  })

  it('点击添加文件或图片触发 onAttachFiles', () => {
    render(<ComposerPlusMenu onAttachFiles={onAttachFiles} agents={[]} />)

    fireEvent.click(screen.getByLabelText('添加附件、技能与 Agent'))
    fireEvent.click(screen.getByText('添加文件或图片'))

    expect(onAttachFiles).toHaveBeenCalledTimes(1)
  })

  it('进入技能子面板可看到技能并打开管理', () => {
    render(
      <ComposerPlusMenu
        onAttachFiles={onAttachFiles}
        onManageSkills={onManageSkills}
        agents={[]}
      />,
    )

    fireEvent.click(screen.getByLabelText('添加附件、技能与 Agent'))
    fireEvent.click(screen.getByText('技能'))

    expect(screen.getByPlaceholderText('搜索技能…')).toBeInTheDocument()
    expect(screen.getByText('demo-skill')).toBeInTheDocument()

    fireEvent.click(screen.getByText('管理'))
    expect(onManageSkills).toHaveBeenCalledTimes(1)
  })
})
