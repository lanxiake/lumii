/**
 * ApprovalCard 组件测试
 * 测试 Phase 5: 审批卡片视觉升级 - 倒计时/紧急状态/结果显示
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import ApprovalCard from '../../renderer/pages/ChatPage/components/ApprovalCard'
import type { ExecApprovalRequest } from '../../renderer/types/exec-approvals'

describe('Phase 5: 审批卡片 - ApprovalCard组件', () => {
  const createMockApproval = (expiresInSeconds = 30): ExecApprovalRequest => ({
    id: 'approval-1',
    request: {
      command: 'rm -rf /tmp/test',
      host: 'localhost',
      cwd: '/home/user',
      security: 'high' as any,
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + expiresInSeconds * 1000,
  })

  const mockProps = {
    approval: createMockApproval(),
    isResolving: false,
    onDecision: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // Mock clipboard
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(),
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('TC-5.1 ApprovalCard 基本功能', () => {
    it('TC-5.1.1: 组件正常渲染', () => {
      const { container } = render(<ApprovalCard {...mockProps} />)
      expect(container.querySelector('.approval-card')).toBeInTheDocument()
    })

    it('TC-5.1.2: 显示命令内容', () => {
      render(<ApprovalCard {...mockProps} />)
      expect(screen.getByText('rm -rf /tmp/test')).toBeInTheDocument()
    })

    it('TC-5.1.3: 显示主机信息', () => {
      render(<ApprovalCard {...mockProps} />)
      expect(screen.getByText('localhost')).toBeInTheDocument()
    })

    it('TC-5.1.4: 显示工作目录', () => {
      render(<ApprovalCard {...mockProps} />)
      expect(screen.getByText('/home/user')).toBeInTheDocument()
    })

    it('TC-5.1.5: 显示安全级别', () => {
      render(<ApprovalCard {...mockProps} />)
      expect(screen.getByText('high')).toBeInTheDocument()
    })

    it('TC-5.1.6: 点击"允许一次"触发回调', () => {
      render(<ApprovalCard {...mockProps} />)

      const allowBtn = screen.getByText(/允许一次/)
      fireEvent.click(allowBtn)

      expect(mockProps.onDecision).toHaveBeenCalledWith('allow-once')
    })

    it('TC-5.1.7: 点击"拒绝"触发回调', () => {
      render(<ApprovalCard {...mockProps} />)

      const denyBtn = screen.getByText(/拒绝/)
      fireEvent.click(denyBtn)

      expect(mockProps.onDecision).toHaveBeenCalledWith('deny')
    })

    it('TC-5.1.8: 点击"白名单"触发回调', () => {
      render(<ApprovalCard {...mockProps} />)

      const alwaysBtn = screen.getByText('白名单')
      fireEvent.click(alwaysBtn)

      expect(mockProps.onDecision).toHaveBeenCalledWith('allow-always')
    })

    it('TC-5.1.9: 处理中禁用所有按钮', () => {
      render(<ApprovalCard {...mockProps} isResolving={true} />)

      const buttons = screen.getAllByRole('button').filter((btn) =>
        btn.textContent?.match(/允许一次|拒绝|白名单/)
      )

      buttons.forEach((btn) => {
        expect(btn).toBeDisabled()
      })
    })

    it('TC-5.1.10: 复制命令按钮功能', () => {
      render(<ApprovalCard {...mockProps} />)

      const copyBtn = screen.getByText(/复制/)
      fireEvent.click(copyBtn)

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('rm -rf /tmp/test')
    })
  })

  describe('TC-5.1 倒计时功能', () => {
    it('TC-5.1.4: 显示初始倒计时', () => {
      render(<ApprovalCard {...mockProps} approval={createMockApproval(30)} />)
      expect(screen.getByText(/30秒后过期/)).toBeInTheDocument()
    })

    // 假定时器下不能用 waitFor：它按真实时钟轮询，会一直等到超时
    it('TC-5.1.5: 倒计时每秒更新', () => {
      render(<ApprovalCard {...mockProps} approval={createMockApproval(30)} />)

      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(screen.getByText(/29秒后过期/)).toBeInTheDocument()
    })

    it('TC-5.1.6: 倒计时<=10秒显示紧急状态', async () => {
      const { container } = render(
        <ApprovalCard {...mockProps} approval={createMockApproval(10)} />
      )

      const countdown = container.querySelector('.approval-countdown')
      expect(countdown).toHaveClass('urgent')
    })

    it('TC-5.1.7: 倒计时归零显示已过期', () => {
      render(<ApprovalCard {...mockProps} approval={createMockApproval(1)} />)

      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(screen.getByText(/已过期/)).toBeInTheDocument()
    })
  })

  describe('TC-5.2 审批结果显示', () => {
    it('TC-5.2.1: 允许一次结果显示', () => {
      render(
        <ApprovalCard
          {...mockProps}
          decision="allow-once"
        />
      )

      expect(screen.getByText(/已允许（一次）/)).toBeInTheDocument()
    })

    it('TC-5.2.2: 加入白名单结果显示', () => {
      render(
        <ApprovalCard
          {...mockProps}
          decision="allow-always"
        />
      )

      expect(screen.getByText(/已加入白名单/)).toBeInTheDocument()
    })

    it('TC-5.2.3: 拒绝结果显示', () => {
      render(
        <ApprovalCard
          {...mockProps}
          decision="deny"
        />
      )

      expect(screen.getByText(/已拒绝/)).toBeInTheDocument()
    })

    it('TC-5.2.4: 结果显示处理者信息', () => {
      render(
        <ApprovalCard
          {...mockProps}
          decision="allow-once"
          resolvedBy="用户A"
        />
      )

      expect(screen.getByText(/用户A/)).toBeInTheDocument()
    })

    it('TC-5.2.5: 结果状态不显示操作按钮', () => {
      render(
        <ApprovalCard
          {...mockProps}
          decision="allow-once"
        />
      )

      expect(screen.queryByText(/允许一次/)).not.toBeInTheDocument()
      expect(screen.queryByText(/拒绝/)).not.toBeInTheDocument()
    })
  })
})
