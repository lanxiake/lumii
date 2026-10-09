/**
 * 本机微信回复策略弹窗：挑人（勾选）→ 批量设档 → 保存。
 *
 * 盯的是「用户看得懂」这条：候选列表显示人名、名单里也是人名在前；
 * 以及批量这一条真的落到每一行上，而不是只改了显示。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { PolicyModal } from '../../renderer/pages/SettingsPage/components/PcwechatChannelSettings/PolicyModal'

function mockChannelService(overrides: {
  policy?: unknown
  contacts?: Array<{ id: string; label: string; isGroup: boolean }>
  contactsError?: string
}) {
  const setPolicy = vi.fn(async (_c: string, p: unknown) => p)
  ;(window as any).channelService = {
    getPolicy: vi.fn(async () => overrides.policy ?? { defaultMode: 'notify', peers: [] }),
    setPolicy,
    listWechatContacts: vi.fn(async () => ({
      contacts: overrides.contacts ?? [],
      ...(overrides.contactsError ? { error: overrides.contactsError } : {}),
    })),
  }
  return { setPolicy }
}

/** 策略读回来之前「从微信里挑人」是禁用的（读的时候不让点），测试得等它可用 */
async function clickPickPeople() {
  const btn = screen.getByRole('button', { name: '从微信里挑人' })
  await waitFor(() => expect(btn).toBeEnabled())
  fireEvent.click(btn)
}

describe('PcwechatPolicyModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('打开即读到策略：名单显示人名，wxid 只作副标题', async () => {
    mockChannelService({
      policy: {
        defaultMode: 'ignore',
        peers: [{ id: 'wxid_mama', label: '妈妈', mode: 'auto' }],
      },
    })
    render(<PolicyModal open onClose={() => undefined} />)

    expect(await screen.findByText('妈妈')).toBeInTheDocument()
    expect(screen.getByText('wxid_mama')).toBeInTheDocument()
    expect(screen.getByText('谁可以被代回（1）')).toBeInTheDocument()
  })

  it('从微信里挑人：勾选两个 → 加入名单 → 默认「起草给我确认」', async () => {
    mockChannelService({
      contacts: [
        { id: 'wxid_mama', label: '妈妈', isGroup: false },
        { id: '123@chatroom', label: '家人群', isGroup: true },
        { id: 'filehelper', label: '文件传输助手', isGroup: false },
      ],
    })
    render(<PolicyModal open onClose={() => undefined} />)

    await clickPickPeople()
    expect(await screen.findByText('家人群')).toBeInTheDocument()

    // 候选面板里的复选框按顺序对应候选列表（妈妈、家人群、文件传输助手）
    const boxes = screen.getAllByRole('checkbox')
    fireEvent.click(boxes[0])
    fireEvent.click(boxes[1])
    fireEvent.click(screen.getByRole('button', { name: /加入名单（2）/ }))

    expect(await screen.findByText('谁可以被代回（2）')).toBeInTheDocument()
    // 新加的人默认草稿档（先看得见草稿再决定放开直接回）
    expect(screen.getAllByDisplayValue('起草给我确认')).toHaveLength(2)
  })

  it('跨搜索累积勾选：勾一个 → 搜别的再勾一个 → 加入名单时两个都要进去', async () => {
    mockChannelService({
      contacts: [
        { id: 'wxid_mama', label: '妈妈', isGroup: false },
        { id: 'wxid_ayi', label: '阿姨', isGroup: false },
        { id: 'wxid_baba', label: '爸爸', isGroup: false },
      ],
    })
    render(<PolicyModal open onClose={() => undefined} />)

    await clickPickPeople()
    expect(await screen.findByText('妈妈')).toBeInTheDocument()

    // 第一轮：不搜索，勾「妈妈」
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 妈妈' }))
    expect(screen.getByRole('button', { name: /加入名单（1）/ })).toBeInTheDocument()

    // 第二轮：搜索后候选只剩「爸爸」，再勾它——「妈妈」此时已不在可见列表里
    fireEvent.change(screen.getByPlaceholderText('搜名字或 wxid'), { target: { value: '爸爸' } })
    await waitFor(() => expect(screen.queryByText('妈妈')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 爸爸' }))
    // 计数本来就承认勾了 2 个（是「加入」那一步把它们丢了一个）
    expect(screen.getByRole('button', { name: /加入名单（2）/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /加入名单（2）/ }))

    expect(await screen.findByText('谁可以被代回（2）')).toBeInTheDocument()
    expect(screen.getByText('妈妈')).toBeInTheDocument()
    expect(screen.getByText('爸爸')).toBeInTheDocument()
  })

  it('「全选」只把当前可见的人并进勾选，不吞掉先前勾的', async () => {
    mockChannelService({
      contacts: [
        { id: 'wxid_mama', label: '妈妈', isGroup: false },
        { id: 'wxid_baba', label: '爸爸', isGroup: false },
      ],
    })
    render(<PolicyModal open onClose={() => undefined} />)

    await clickPickPeople()
    fireEvent.click(await screen.findByRole('checkbox', { name: '选择 妈妈' }))

    // 搜到只剩「爸爸」，点全选——应把「爸爸」并进勾选，而不是把「妈妈」挤掉
    fireEvent.change(screen.getByPlaceholderText('搜名字或 wxid'), { target: { value: '爸爸' } })
    await waitFor(() => expect(screen.queryByText('妈妈')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '全选' }))

    fireEvent.click(screen.getByRole('button', { name: /加入名单（2）/ }))
    expect(await screen.findByText('谁可以被代回（2）')).toBeInTheDocument()
  })

  it('批量设档：勾选名单里的人 → 选「直接代回」→ 应用 + 保存', async () => {
    const { setPolicy } = mockChannelService({
      policy: {
        defaultMode: 'notify',
        peers: [
          { id: 'wxid_a', label: '阿呆', mode: 'draft' },
          { id: 'wxid_b', label: '阿宝', mode: 'draft' },
        ],
      },
    })
    render(<PolicyModal open onClose={() => undefined} />)

    expect(await screen.findByText('谁可以被代回（2）')).toBeInTheDocument()
    const boxes = screen.getAllByRole('checkbox')
    fireEvent.click(boxes[0])
    fireEvent.click(boxes[1])

    fireEvent.change(screen.getByLabelText('批量档位'), { target: { value: 'auto' } })
    fireEvent.click(screen.getByRole('button', { name: '应用' }))

    // 批量下拉 + 两行都变成「直接代回」
    expect(screen.getAllByDisplayValue('直接代回')).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(setPolicy).toHaveBeenCalledTimes(1))
    expect(setPolicy.mock.calls[0]?.[0]).toBe('pcwechat')
    expect(setPolicy.mock.calls[0]?.[1]).toMatchObject({
      defaultMode: 'notify',
      peers: [
        { id: 'wxid_a', label: '阿呆', mode: 'auto' },
        { id: 'wxid_b', label: '阿宝', mode: 'auto' },
      ],
    })
  })

  it('读不到微信会话时如实说明，但仍能改已有名单', async () => {
    mockChannelService({
      policy: { defaultMode: 'notify', peers: [{ id: 'wxid_a', label: '阿呆', mode: 'auto' }] },
      contacts: [],
      contactsError: '本机微信的 MCP 没连上，现在只能编辑已有名单',
    })
    render(<PolicyModal open onClose={() => undefined} />)

    await clickPickPeople()
    expect(
      await screen.findByText('本机微信的 MCP 没连上，现在只能编辑已有名单'),
    ).toBeInTheDocument()
    expect(screen.getByText('阿呆')).toBeInTheDocument()
  })
})
