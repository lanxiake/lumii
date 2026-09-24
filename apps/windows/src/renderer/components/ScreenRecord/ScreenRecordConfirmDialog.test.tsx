/**
 * ScreenRecordConfirmDialog：标题按**发起方**措辞
 *
 * 用户自己点面板也会走到这个弹窗（源不是 Lumii 本窗时），原实现只有一种文案
 * 「AI 请求录制」——用户会以为自己被偷录。判据是 `payload.initiator`：
 * 缺省按用户（IPC 路径即用户操作），AI 工具显式传 'agent'。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ScreenRecordConfirmDialog } from './ScreenRecordConfirmDialog'
import type { ScreenRecordConfirmPayload } from '../../hooks/useScreenRecord'

function makePayload(
  overrides: Partial<ScreenRecordConfirmPayload> = {},
): ScreenRecordConfirmPayload {
  return {
    sessionId: 's1',
    sourceName: '整个屏幕',
    sourceType: 'screen',
    sourceId: 'screen-1',
    timeoutSec: 120,
    startedAt: Date.now(),
    purpose: 'record',
    ...overrides,
  }
}

describe('ScreenRecordConfirmDialog 的标题', () => {
  it('用户自己发起的录制：写「请求录制」，不写成 AI 请求', () => {
    render(<ScreenRecordConfirmDialog payload={makePayload({ initiator: 'user' })} onRespond={vi.fn()} />)

    expect(screen.getByText('请求录制「整个屏幕」')).toBeInTheDocument()
    expect(screen.queryByText(/AI 请求录制/)).not.toBeInTheDocument()
  })

  it('AI 发起的录制：保留「AI 请求录制」', () => {
    render(<ScreenRecordConfirmDialog payload={makePayload({ initiator: 'agent' })} onRespond={vi.fn()} />)

    expect(screen.getByText('AI 请求录制「整个屏幕」')).toBeInTheDocument()
  })

  it('发起方缺失时按用户处理（老数据/未升级的主进程也不会误报 AI）', () => {
    render(<ScreenRecordConfirmDialog payload={makePayload()} onRespond={vi.fn()} />)

    expect(screen.getByText('请求录制「整个屏幕」')).toBeInTheDocument()
  })

  it('截图路径恒为 AI（只有 agent 入口）', () => {
    render(<ScreenRecordConfirmDialog payload={makePayload({ purpose: 'screenshot' })} onRespond={vi.fn()} />)

    expect(screen.getByText('AI 请求截取「整个屏幕」')).toBeInTheDocument()
  })
})
