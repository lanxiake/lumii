import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AskUserModal } from './AskUserModal'
import type { AskUserModalQuestion } from './AskUserModal'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const q1: AskUserModalQuestion = {
  question: '你想先了解哪类功能？',
  header: '方向',
  options: [
    {
      label: '知识资产',
      description: '资料库与记忆',
      recommended: true,
      recommendReason: '你刚导入过文档',
    },
    { label: '自动化', description: '定时任务与提醒' },
  ],
}

const q2: AskUserModalQuestion = {
  question: '用哪种方式带你了解？',
  header: '演示',
  options: [
    { label: '带路式', description: '打开界面指给你看' },
    { label: '图文讲解', description: '只看说明' },
  ],
}

function renderModal(questions: readonly AskUserModalQuestion[], onSubmit = vi.fn()) {
  render(<AskUserModal open questions={questions} timeoutMs={60000} onSubmit={onSubmit} />)
  return onSubmit
}

describe('AskUserModal 单选自动前进', () => {
  it('单选点选后自动进入下一题', async () => {
    renderModal([q1, q2])
    fireEvent.click(screen.getByRole('radio', { name: /知识资产/ }))
    await waitFor(() => expect(screen.getByText('用哪种方式带你了解？')).toBeInTheDocument())
  })

  it('最后一题选择后自动提交全部答案', async () => {
    const onSubmit = renderModal([q1, q2])
    fireEvent.click(screen.getByRole('radio', { name: /知识资产/ }))
    await waitFor(() => expect(screen.getByText('用哪种方式带你了解？')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('radio', { name: /带路式/ }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].answers).toEqual({
      '你想先了解哪类功能？': '知识资产',
      '用哪种方式带你了解？': '带路式',
    })
  })

  it('只有一个问题时点选即自动提交', async () => {
    const onSubmit = renderModal([q1])
    fireEvent.click(screen.getByRole('radio', { name: /自动化/ }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].answers).toEqual({ '你想先了解哪类功能？': '自动化' })
  })

  it('跳到末题作答后，自动跳回第一个未答的题', async () => {
    const q3: AskUserModalQuestion = {
      question: '第三个问题？',
      header: '三',
      options: [
        { label: '丙一', description: '说明丙一' },
        { label: '丙二', description: '说明丙二' },
      ],
    }
    renderModal([q1, q2, q3])
    fireEvent.click(screen.getByRole('button', { name: /三/ }))
    fireEvent.click(screen.getByRole('radio', { name: /丙一/ }))
    await waitFor(() => expect(screen.getByText('你想先了解哪类功能？')).toBeInTheDocument())
  })

  it('多选不自动前进（需手动确认）', async () => {
    const multiQ: AskUserModalQuestion = {
      question: '想开启哪些能力？',
      header: '能力',
      multiSelect: true,
      options: [
        { label: '定时任务', description: '自动化' },
        { label: '知识库', description: '资料沉淀' },
      ],
    }
    renderModal([multiQ, q2])
    fireEvent.click(screen.getByRole('checkbox', { name: /定时任务/ }))
    await sleep(450)
    expect(screen.getByText('想开启哪些能力？')).toBeInTheDocument()
    expect(screen.queryByText('用哪种方式带你了解？')).not.toBeInTheDocument()
  })

  it('选择 Other 不自动前进（等待自由输入）', async () => {
    renderModal([q1, q2])
    fireEvent.click(screen.getByRole('radio', { name: /Other/ }))
    await sleep(450)
    expect(screen.queryByText('用哪种方式带你了解？')).not.toBeInTheDocument()
  })

  it('带 preview 的选项停留展示，不自动前进', async () => {
    const withPreview: AskUserModalQuestion = {
      question: '选哪个方案？',
      header: '方案',
      options: [
        { label: '方案甲', description: '说明甲', preview: '预览正文-甲' },
        { label: '方案乙', description: '说明乙' },
      ],
    }
    renderModal([withPreview, q2])
    fireEvent.click(screen.getByRole('radio', { name: /方案甲/ }))
    await sleep(450)
    expect(screen.getByText('预览正文-甲')).toBeInTheDocument()
    expect(screen.queryByText('用哪种方式带你了解？')).not.toBeInTheDocument()
  })
})

describe('AskUserModal AI 推荐', () => {
  it('渲染推荐徽章与理由', () => {
    renderModal([q1])
    expect(screen.getByText('AI 推荐')).toBeInTheDocument()
    expect(screen.getByText('理由：你刚导入过文档')).toBeInTheDocument()
  })

  it('全部采用推荐：一键用推荐答案提交', async () => {
    const recQ2: AskUserModalQuestion = {
      ...q2,
      options: [
        {
          label: '带路式',
          description: '打开界面指给你看',
          recommended: true,
          recommendReason: '你更想动手试',
        },
        { label: '图文讲解', description: '只看说明' },
      ],
    }
    const onSubmit = renderModal([q1, recQ2])
    fireEvent.click(screen.getByRole('button', { name: '全部采用推荐' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].answers).toEqual({
      '你想先了解哪类功能？': '知识资产',
      '用哪种方式带你了解？': '带路式',
    })
  })

  it('无推荐字段时无徽章、无一键采用按钮（回归）', () => {
    const plain: AskUserModalQuestion = {
      question: '随便选一个？',
      header: '选择',
      options: [
        { label: '甲', description: '甲说明' },
        { label: '乙', description: '乙说明' },
      ],
    }
    renderModal([plain])
    expect(screen.queryByText('AI 推荐')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全部采用推荐' })).not.toBeInTheDocument()
  })

  it('保留手动提交路径（多选 + 手动翻页 + 提交回答）', async () => {
    const multiA: AskUserModalQuestion = {
      question: '题目甲',
      header: '甲',
      multiSelect: true,
      options: [
        { label: '选项一', description: 'd1' },
        { label: '选项二', description: 'd2' },
      ],
    }
    const multiB: AskUserModalQuestion = {
      question: '题目乙',
      header: '乙',
      multiSelect: true,
      options: [
        { label: '选项三', description: 'd3' },
        { label: '选项四', description: 'd4' },
      ],
    }
    const onSubmit = renderModal([multiA, multiB])
    fireEvent.click(screen.getByRole('checkbox', { name: /选项一/ }))
    fireEvent.click(screen.getByRole('button', { name: /下一题/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /选项四/ }))
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].answers).toEqual({
      题目甲: '选项一',
      题目乙: '选项四',
    })
  })
})

describe('AskUserModal 关闭（= 拒绝回答，模型按默认方案继续）', () => {
  it('点右上角 × 等同拒绝回答', async () => {
    const onSubmit = renderModal([q1])
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toEqual({ answers: {}, declined: true })
  })

  it('Esc 与 × 同源：也走拒绝回答', async () => {
    const onSubmit = renderModal([q1])
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toEqual({ answers: {}, declined: true })
  })

  it('宿主给了 onDecline 时，关闭只走 onDecline（不落 answers）', async () => {
    const onSubmit = vi.fn()
    const onDecline = vi.fn()
    render(
      <AskUserModal
        open
        questions={[q1]}
        timeoutMs={60000}
        onSubmit={onSubmit}
        onDecline={onDecline}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(onDecline).toHaveBeenCalledTimes(1))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('AskUserModal 前因后果（context）', () => {
  it('渲染模型给的背景说明，避免用户面对弹窗无从选择', () => {
    render(
      <AskUserModal
        open
        context="已扫过本地技能库，没有代码审查类；下面决定要不要去远程市场找。"
        questions={[q1]}
        timeoutMs={60000}
        onSubmit={vi.fn()}
      />,
    )
    expect(
      screen.getByText('已扫过本地技能库，没有代码审查类；下面决定要不要去远程市场找。'),
    ).toBeInTheDocument()
  })

  it('context 缺失或空白时不渲染背景块（回归）', () => {
    const { rerender } = render(
      <AskUserModal open context="有背景的唯一标记文本" questions={[q1]} timeoutMs={60000} onSubmit={vi.fn()} />,
    )
    expect(document.body.textContent).toContain('有背景的唯一标记文本')
    rerender(
      <AskUserModal open context="   " questions={[q1]} timeoutMs={60000} onSubmit={vi.fn()} />,
    )
    expect(document.body.textContent).not.toContain('有背景的唯一标记文本')
  })
})
