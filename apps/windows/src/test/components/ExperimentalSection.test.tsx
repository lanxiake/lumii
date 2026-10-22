/**
 * ExperimentalSection：列表入口 + 提示词风格详情栈导航测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ExperimentalSection } from '../../renderer/pages/SettingsPage/components/ExperimentalSection'
import { __resetPluginStateForTests } from '../../plugins/renderer/state'

vi.mock('../../renderer/pages/AutonomousPage/AutonomousPage', () => ({
  AutonomousPage: () => <div data-testid="autonomous-page" />,
}))

const updatePromptStyle = vi.fn(async () => {})
const getStatus = vi.fn(async () => ({
  enabled: false,
  pendingGoalsCount: 0,
  satisfaction: {
    overall: 0.76,
    trend: 'stable' as const,
    breakdown: { taskCompletion: 0, userFeedback: 0, efficiency: 0, knowledgeGrowth: 0 },
  },
}))
/**
 * 渠道功能开关（跨渠道会话接续）：主进程 JSON，渲染层经 channelService 读写。
 * 必须是有状态的假后端：列表摘要是一个独立组件，返回列表时会**重新读一次**，
 * 用固定返回值的 mock 会把「已开启」变回「已关闭」。
 */
let channelFeatures: Record<string, unknown> = { crossChannelContinuityEnabled: false }
const getFeatures = vi.fn(async () => ({ ...channelFeatures }))
const setFeatures = vi.fn(async (patch: Record<string, unknown>) => {
  channelFeatures = { ...channelFeatures, ...patch }
  return { ...channelFeatures }
})

beforeEach(() => {
  localStorage.clear()
  channelFeatures = { crossChannelContinuityEnabled: false }
  __resetPluginStateForTests()
  updatePromptStyle.mockClear()
  getStatus.mockClear()
  getFeatures.mockClear()
  setFeatures.mockClear()
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    settings: { updatePromptStyle },
    autonomous: { getStatus },
    // 提示词风格已插件化：条目是否显示取决于扩展列表（见 plugins/renderer/state.ts）
    extensions: {
      list: async () => [
        { id: 'com.lumii.prompt-style', enabled: true, state: 'active' },
        { id: 'com.lumii.channel-continuity', enabled: true, state: 'active' },
      ],
      onStateChanged: () => () => {},
    },
  }
  ;(window as unknown as { channelService?: unknown }).channelService = { getFeatures, setFeatures }
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  delete (window as unknown as { channelService?: unknown }).channelService
})

describe('ExperimentalSection — 列表与栈导航', () => {
  /** 插件条目在扩展状态加载完才出现，点它之前先等 */
  const openPromptStyle = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /提示词风格（实验）/ }))
  }

  it('默认渲染实验功能列表，不展开详情', async () => {
    render(<ExperimentalSection />)
    expect(screen.getByRole('heading', { name: '实验功能' })).toBeInTheDocument()
    // 插件条目要等扩展状态加载完才出现（未加载完按「禁用」处理，不闪一个空壳行）
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /提示词风格（实验）/ })).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /自主进化/ })).toBeInTheDocument()
    expect(screen.queryByTestId('autonomous-page')).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: '系统提示词风格' })).not.toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('状态：已禁用')).toBeInTheDocument()
    })
  })

  it('进入提示词风格详情：默认简要档，可切极简并回列表同步', async () => {
    render(<ExperimentalSection />)
    await openPromptStyle()

    expect(screen.getByRole('heading', { name: '提示词风格（实验）' })).toBeInTheDocument()
    const detailedBtn = screen.getByRole('radio', { name: '详细' })
    const terseBtn = screen.getByRole('radio', { name: '简要' })
    const minimalBtn = screen.getByRole('radio', { name: '极简' })
    // 系统初始化默认 = 简要档（2026-09-15 起）
    expect(terseBtn).toHaveAttribute('aria-checked', 'true')
    expect(detailedBtn).toHaveAttribute('aria-checked', 'false')
    expect(minimalBtn).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(minimalBtn)
    expect(updatePromptStyle).toHaveBeenCalledWith({ style: 'minimal' })
    const stored = JSON.parse(localStorage.getItem('mtbot-assistant-settings') ?? '{}')
    expect(stored.promptStyle).toEqual({ style: 'minimal' })

    fireEvent.click(screen.getByRole('button', { name: '返回实验功能列表' }))
    expect(screen.getByRole('heading', { name: '实验功能' })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('当前：极简')).toBeInTheDocument()
    })
  })

  it('重复点击当前档位不触发写入', async () => {
    render(<ExperimentalSection />)
    await openPromptStyle()
    // 先切到极简，确保当前档位与再点击目标一致（默认简要 → 直接点简要本就是 no-op）
    fireEvent.click(screen.getByRole('radio', { name: '极简' }))
    await waitFor(() => expect(updatePromptStyle).toHaveBeenCalledWith({ style: 'minimal' }))
    // 冲掉事件广播引发的同步尾巴，再取基线
    await new Promise((resolve) => setTimeout(resolve, 0))
    const callsAfterSwitch = updatePromptStyle.mock.calls.length

    fireEvent.click(screen.getByRole('radio', { name: '极简' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updatePromptStyle.mock.calls.length).toBe(callsAfterSwitch)
  })

  it('进入自主进化详情并返回', () => {
    render(<ExperimentalSection />)
    fireEvent.click(screen.getByRole('button', { name: /自主进化/ }))
    expect(screen.getByRole('heading', { name: '自主进化' })).toBeInTheDocument()
    expect(screen.getByTestId('autonomous-page')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回实验功能列表' }))
    expect(screen.getByRole('heading', { name: '实验功能' })).toBeInTheDocument()
    expect(screen.queryByTestId('autonomous-page')).not.toBeInTheDocument()
  })

  it('插件被禁用时，它的实验项整条消失（不是灰掉）', async () => {
    let push: ((payload: { id: string; enabled: boolean }) => void) | null = null
    ;(window as unknown as { electronAPI: { extensions: unknown } }).electronAPI.extensions = {
      list: async () => [
        { id: 'com.lumii.prompt-style', enabled: true, state: 'active' },
        { id: 'com.lumii.other', enabled: true, state: 'active' },
      ],
      onStateChanged: (cb: (payload: { id: string; enabled: boolean }) => void) => {
        push = cb
        return () => {}
      },
    }

    render(<ExperimentalSection />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /提示词风格（实验）/ })).toBeInTheDocument(),
    )

    push!({ id: 'com.lumii.prompt-style', enabled: false })

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /提示词风格（实验）/ })).not.toBeInTheDocument(),
    )
    // 其它条目不受影响
    expect(screen.getByRole('button', { name: /自主进化/ })).toBeInTheDocument()
  })

  it('不渲染提示词段清单表格', async () => {
    render(<ExperimentalSection />)
    await openPromptStyle()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText('段 ID')).not.toBeInTheDocument()
  })
})

describe('ExperimentalSection — 跨渠道会话接续开关（2026-09-15 从渠道设置搬入）', () => {
  it('列表展示该项与当前状态', async () => {
    render(<ExperimentalSection />)
    expect(await screen.findByRole('button', { name: /跨渠道会话接续/ })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('状态：已关闭')).toBeInTheDocument())
    expect(getFeatures).toHaveBeenCalled()
  })

  it('进入详情可开启：写主进程开关，返回列表状态同步', async () => {
    render(<ExperimentalSection />)
    fireEvent.click(await screen.findByRole('button', { name: /跨渠道会话接续/ }))

    expect(screen.getByRole('heading', { name: '跨渠道会话接续' })).toBeInTheDocument()
    const sw = screen.getByRole('switch')
    expect(sw).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(sw)
    await waitFor(() =>
      expect(setFeatures).toHaveBeenCalledWith({ crossChannelContinuityEnabled: true }),
    )

    fireEvent.click(screen.getByRole('button', { name: '返回实验功能列表' }))
    await waitFor(() => expect(screen.getByText('状态：已启用')).toBeInTheDocument())
  })

  it('读取失败时回落「已关闭」，不阻塞其余实验项', async () => {
    getFeatures.mockRejectedValueOnce(new Error('ipc down'))
    render(<ExperimentalSection />)
    await waitFor(() => expect(screen.getByText('状态：已关闭')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /提示词风格（实验）/ })).toBeInTheDocument()
  })
})
