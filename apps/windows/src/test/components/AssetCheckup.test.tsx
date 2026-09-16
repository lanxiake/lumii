/**
 * AssetCheckup（概览页「资产体检」卡）测试。
 *
 * 守住三件事：
 * - 没有报告时给的是**引导**（怎么让它去体检），而不是一张空白的卡；
 * - 有报告时结论 / 发现 / 已查无问题三段都在——只显示问题不显示「查过什么」，
 *   用户分不清「没查」与「查了没事」；
 * - 跨期差分（新增 / 已解决）会被显示出来，这正是报告要落库的理由。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

const fetchMaintenanceOverview = vi.fn()

vi.mock('../../renderer/services/maintenance-report-service', () => ({
  fetchMaintenanceOverview: (...args: unknown[]) => fetchMaintenanceOverview(...args),
}))

const { AssetCheckup } = await import('../../renderer/pages/DashboardPage/components/AssetCheckup')

const report = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  agentId: 'system-keeper',
  scope: 'memory',
  summary: '工作记忆 228 条，发现 1 处重复',
  findings: [
    {
      key: 'memory:duplicate',
      severity: 'high',
      title: '两条记忆内容重复',
      evidence: 'content 相同：id=a1 / id=b2',
      suggestion: '保留较早的一条',
    },
  ],
  checked: ['工作记忆：228 条，未发现矛盾'],
  trigger: 'manual',
  createdAt: new Date().toISOString(),
  ...over,
})

describe('AssetCheckup 资产体检卡', () => {
  beforeEach(() => {
    fetchMaintenanceOverview.mockReset()
  })

  it('还没有体检记录时给出引导，而不是空白卡', async () => {
    fetchMaintenanceOverview.mockResolvedValue({ reports: [], diff: null })
    render(<AssetCheckup />)
    await waitFor(() =>
      expect(screen.getByText(/还没有体检记录/)).toBeInTheDocument(),
    )
    expect(screen.getByText('尚未体检')).toBeInTheDocument()
  })

  it('显示结论 / 发现 / 已查无问题三段', async () => {
    fetchMaintenanceOverview.mockResolvedValue({ reports: [report()], diff: null })
    render(<AssetCheckup />)

    await waitFor(() => expect(screen.getByText('工作记忆 228 条，发现 1 处重复')).toBeInTheDocument())
    expect(screen.getByText('两条记忆内容重复')).toBeInTheDocument()
    expect(screen.getByText('高风险')).toBeInTheDocument()
    expect(screen.getByText('content 相同：id=a1 / id=b2')).toBeInTheDocument()
    expect(screen.getByText(/保留较早的一条/)).toBeInTheDocument()
    // 查过且没问题的项必须露出来
    expect(screen.getByText(/工作记忆：228 条，未发现矛盾/)).toBeInTheDocument()
  })

  it('显示与上一期的差分：新增 / 仍在 / 已解决', async () => {
    fetchMaintenanceOverview.mockResolvedValue({
      reports: [report(), report({ id: 'r0' })],
      diff: {
        added: [{ key: 'wiki:orphan', severity: 'low', title: '孤儿页' }],
        persisting: [{ key: 'memory:duplicate', severity: 'high', title: '两条记忆内容重复' }],
        resolved: [{ key: 'guides:stale', severity: 'low', title: '指南过期' }],
      },
    })
    render(<AssetCheckup />)

    await waitFor(() => expect(screen.getByText('新增 1')).toBeInTheDocument())
    expect(screen.getByText('仍在 1')).toBeInTheDocument()
    expect(screen.getByText('已解决 1')).toBeInTheDocument()
  })

  it('只有一期报告时不显示差分（没有可比对象）', async () => {
    fetchMaintenanceOverview.mockResolvedValue({ reports: [report()], diff: null })
    render(<AssetCheckup />)
    await waitFor(() => expect(screen.getByText('两条记忆内容重复')).toBeInTheDocument())
    expect(screen.queryByText(/新增 \d/)).not.toBeInTheDocument()
  })

  it('点发现条目跳对话页并预填追问（带上依据与建议）', async () => {
    const onViewChange = vi.fn()
    const dispatched: unknown[] = []
    const listener = (e: Event) => dispatched.push((e as CustomEvent).detail)
    window.addEventListener('mtbot:chat-draft-request', listener)

    fetchMaintenanceOverview.mockResolvedValue({ reports: [report()], diff: null })
    render(<AssetCheckup onViewChange={onViewChange} />)
    await waitFor(() => expect(screen.getByText('两条记忆内容重复')).toBeInTheDocument())

    fireEvent.click(screen.getByText('两条记忆内容重复'))

    expect(onViewChange).toHaveBeenCalledWith('chat')
    expect(dispatched).toHaveLength(1)
    const detail = dispatched[0] as { text: string; newSession: boolean }
    expect(detail.text).toContain('两条记忆内容重复')
    expect(detail.text).toContain('content 相同：id=a1 / id=b2')
    expect(detail.newSession).toBe(true)

    window.removeEventListener('mtbot:chat-draft-request', listener)
  })

  it('体检通过（没有发现）时显示绿色结论而不是空白', async () => {
    fetchMaintenanceOverview.mockResolvedValue({
      reports: [report({ findings: [], summary: '四类资产均未发现问题' })],
      diff: null,
    })
    render(<AssetCheckup />)
    await waitFor(() => expect(screen.getByText('四类资产均未发现问题')).toBeInTheDocument())
    expect(screen.getByText('未发现问题')).toBeInTheDocument()
  })

  it('接口失败时给出错误提示，不假装没有报告', async () => {
    fetchMaintenanceOverview.mockRejectedValue(new Error('体检报告接口不可用'))
    render(<AssetCheckup />)
    await waitFor(() => expect(screen.getByText('体检报告接口不可用')).toBeInTheDocument())
  })
})
