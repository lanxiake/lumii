/**
 * 验证本机微信策略弹窗：切换账号页签时，列表正确刷新（不再显示相同内容）
 *
 * 前置：策略文件已是「顶层11人 + 两账号各2人」的状态
 * 验证：打开弹窗后，TOOLAN账号显示2行，Loop账号也显示2行（而不是两边都11行）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { PolicyModal } from '../../plugins/builtin/pcwechat/ui/Settings/PolicyModal'

// Mock window.channelService
const mockGetPolicy = vi.fn()
const mockSetPolicy = vi.fn()
const mockListWechatContacts = vi.fn()
const mockListWechatAccounts = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'channelService', {
    value: {
      getPolicy: mockGetPolicy,
      setPolicy: mockSetPolicy,
      listWechatContacts: mockListWechatContacts,
      listWechatAccounts: mockListWechatAccounts,
    },
    configurable: true,
  })
})

describe('PolicyModal 账号切换验证', () => {
  it('切换账号页签时，列表内容应跟随变化（不再显示相同的11行）', async () => {
    // 模拟真实策略：顶层11人，TOOLAN/Loop各2人
    const policy = {
      defaultMode: 'notify' as const,
      peers: [
        { id: 'peer1', label: '顶层1', mode: 'auto' as const },
        { id: 'peer2', label: '顶层2', mode: 'auto' as const },
        { id: 'peer3', label: '顶层3', mode: 'auto' as const },
        { id: 'peer4', label: '顶层4', mode: 'auto' as const },
        { id: 'peer5', label: '顶层5', mode: 'auto' as const },
        { id: 'peer6', label: '顶层6', mode: 'auto' as const },
        { id: 'peer7', label: '顶层7', mode: 'auto' as const },
        { id: 'peer8', label: '顶层8', mode: 'auto' as const },
        { id: 'peer9', label: '顶层9', mode: 'auto' as const },
        { id: 'peer10', label: '顶层10', mode: 'auto' as const },
        { id: 'peer11', label: '顶层11', mode: 'auto' as const },
      ],
      accounts: {
        wxid_sngf3b86qbz021: {
          label: 'TOOLAN',
          defaultMode: 'ignore' as const,
          peers: [
            { id: 'filehelper', label: '文件传输助手', mode: 'auto' as const },
            { id: 'wxid_sngf3b86qbz021', label: '自己', mode: 'auto' as const },
          ],
        },
        wxid_s6piyhfvptv522: {
          label: 'Loop',
          defaultMode: 'ignore' as const,
          peers: [
            { id: 'filehelper', label: '文件传输助手', mode: 'auto' as const },
            { id: 'wxid_s6piyhfvptv522', label: '自己', mode: 'auto' as const },
          ],
        },
      },
    }

    const accounts = [
      { wxid: 'wxid_sngf3b86qbz021', running: true },
      { wxid: 'wxid_s6piyhfvptv522', running: true },
    ]

    mockGetPolicy.mockResolvedValue(policy)
    mockListWechatAccounts.mockResolvedValue({ accounts })
    mockListWechatContacts.mockResolvedValue({
      contacts: [],
      total: 0,
      offset: 0,
      error: null,
    })

    const onClose = vi.fn()
    const onSaved = vi.fn()

    render(<PolicyModal open={true} onClose={onClose} onSaved={onSaved} />)

    // 等弹窗加载完成
    await waitFor(() => {
      expect(screen.getByText(/回复策略/)).toBeInTheDocument()
    })

    // 初始应在 TOOLAN 页签，显示2行
    await waitFor(() => {
      const btn1 = screen.getByRole('button', { name: /TOOLAN/ })
      expect(btn1).toBeInTheDocument()
      // 检查列表标题
      expect(screen.getByText(/谁可以被代回.*2/)).toBeInTheDocument()
    })

    // 验证 TOOLAN 账号只显示 2 条
    expect(screen.getByText('文件传输助手')).toBeInTheDocument()
    expect(screen.queryByText('顶层1')).not.toBeInTheDocument() // 不应显示顶层的11人

    // 点击切换到 Loop 页签
    const loopTab = screen.getByRole('button', { name: /Loop/ })
    await loopTab.click()

    // Loop 账号也应只显示 2 条
    await waitFor(() => {
      expect(screen.getByText(/谁可以被代回.*2/)).toBeInTheDocument()
      expect(screen.getByText('文件传输助手')).toBeInTheDocument()
      expect(screen.queryByText('顶层1')).not.toBeInTheDocument()
    })

    // 再切回 TOOLAN，列表应该仍然是2条（不是11条）
    const toolanTab = screen.getByRole('button', { name: /TOOLAN/ })
    await toolanTab.click()

    await waitFor(() => {
      expect(screen.getByText(/谁可以被代回.*2/)).toBeInTheDocument()
      expect(screen.getByText('文件传输助手')).toBeInTheDocument()
      expect(screen.queryByText('顶层1')).not.toBeInTheDocument()
    })
  })
})
