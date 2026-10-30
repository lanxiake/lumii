/**
 * WorkspaceArtifactsPanel 组件测试
 * 验证：空态、任务分组、成品卡选中、筛选/搜索、中间产物折叠、进行中进度条。
 */

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { FileChangeEntry } from '@mtbot/agent-runtime/browser'
import { WorkspaceArtifactsPanel } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel'
import { mergeLocalEdits } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/local-edits'
import {
  buildArtifactLedger,
  type LedgerMessageLike,
} from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/ledger'

const toAbsolutePath = (relativePath: string): string => `/ws/${relativePath}`

function assistant(
  id: string,
  timestamp: number,
  fileChanges: FileChangeEntry[],
): LedgerMessageLike {
  return { id, role: 'assistant', timestamp, fileChanges }
}

const MESSAGES: LedgerMessageLike[] = [
  { id: 'u1', role: 'user', timestamp: new Date(2026, 9, 19, 10, 0).getTime(), text: '做一组封面' },
  assistant('t1', new Date(2026, 9, 19, 10, 30).getTime(), [
    { path: 'uploads/short/a.png', status: 'added', confidence: 'exact' },
    { path: 'outputs/pet-demo/sprite.png', status: 'added', confidence: 'exact' },
    { path: 'outputs/script.txt', status: 'added', confidence: 'exact' },
  ]),
  assistant('t2', new Date(2026, 9, 19, 11, 5).getTime(), [
    { path: 'uploads/short/b.jpg', status: 'modified', confidence: 'unattributed' },
    { path: 'src/old.ts', status: 'deleted', confidence: 'exact' },
  ]),
]

function renderPanel(props: Partial<React.ComponentProps<typeof WorkspaceArtifactsPanel>> = {}) {
  return render(
    <WorkspaceArtifactsPanel
      ledger={buildArtifactLedger(MESSAGES)}
      toAbsolutePath={toAbsolutePath}
      onSelect={vi.fn()}
      {...props}
    />,
  )
}

describe('WorkspaceArtifactsPanel', () => {
  it('空会话显示空态与零统计', () => {
    renderPanel({ ledger: buildArtifactLedger([]) })
    expect(screen.getByText('0', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/这个会话还没有产出/)).toBeInTheDocument()
  })

  it('默认只展开最新组；展开后显示成品卡，未归属与删除不出现', () => {
    const { container } = renderPanel()
    expect(screen.getByText('3', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getAllByText('做一组封面').length).toBeGreaterThan(0)
    // 同回合拆成多个目录组：只展开最新一组，其余折叠
    expect(screen.getByText('a.png')).toBeInTheDocument()
    expect(screen.queryByText('sprite.png')).toBeNull()

    for (const header of container.querySelectorAll('button[aria-expanded="false"]')) {
      fireEvent.click(header)
    }
    expect(screen.getByText('sprite.png')).toBeInTheDocument()
    expect(screen.getByText('script.txt')).toBeInTheDocument()
    expect(screen.queryByText('b.jpg')).not.toBeInTheDocument()
    expect(screen.queryByText('old.ts')).not.toBeInTheDocument()
  })

  it('点卡片选中（不改弹 Modal）；选中态可读', () => {
    const onSelect = vi.fn()
    renderPanel({ onSelect, selectedPath: 'uploads/short/a.png' })
    const card = screen.getByRole('button', { name: /a\.png/ })
    expect(card).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(card)
    expect(onSelect).toHaveBeenCalledWith('uploads/short/a.png')
  })

  it('筛选与搜索只保留命中项', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /图片/ }))
    expect(screen.queryByText('script.txt')).not.toBeInTheDocument()
    expect(screen.getByText('a.png')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /全部/ }))
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索产物路径' }), {
      target: { value: 'sprite' },
    })
    expect(screen.getByText('sprite.png')).toBeInTheDocument()
    expect(screen.queryByText('script.txt')).not.toBeInTheDocument()
  })

  it('中间产物折叠成一行，展开后出网格并提示用途', () => {
    const intermediates: FileChangeEntry[] = Array.from({ length: 25 }, (_, index) => ({
      path: `outputs/x/cut-${index}.png`,
      status: 'added',
      confidence: 'exact',
    }))
    const ledger = buildArtifactLedger([
      { id: 'u', role: 'user', timestamp: 50, text: '切图' },
      assistant('t', 100, [
        { path: 'outputs/x/final.png', status: 'added', confidence: 'exact' },
        ...intermediates,
      ]),
    ])
    const onCleanup = vi.fn()
    renderPanel({ ledger, onCleanup })

    expect(screen.getByText(/中间产物 25 个/)).toBeInTheDocument()
    expect(screen.getByText('final.png')).toBeInTheDocument()
    expect(screen.queryByText('cut-0.png')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /中间产物 25 个/ }))
    expect(screen.getByText('cut-0.png')).toBeInTheDocument()
    expect(screen.getByText(/这些是过程文件/)).toBeInTheDocument()

    // 概要行与折叠行各有一个入口，点哪个都该打开对话框
    fireEvent.click(screen.getAllByRole('button', { name: /清理…/ })[0]!)
    expect(onCleanup).toHaveBeenCalled()
  })

  it('AG-UI 卡片状态：running 占位可中断，failed 可重试（只回填 prompt）', () => {
    const onAbort = vi.fn()
    const onRetryPrompt = vi.fn()
    const { rerender } = render(
      <WorkspaceArtifactsPanel
        ledger={buildArtifactLedger(MESSAGES)}
        toAbsolutePath={toAbsolutePath}
        onSelect={vi.fn()}
        onAbort={onAbort}
        onRetryPrompt={onRetryPrompt}
        cards={[
          {
            id: 'tool:t1',
            toolCallId: 't1',
            turnId: 'turn',
            timestamp: Date.now(),
            kind: 'image',
            lifecycle: 'running',
            title: '生成图片',
            placeholder: { prompt: '一只兔子' },
          },
        ]}
      />,
    )
    expect(screen.getByText('进行中')).toBeInTheDocument()
    expect(screen.getByText('一只兔子')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '中断' }))
    expect(onAbort).toHaveBeenCalled()

    rerender(
      <WorkspaceArtifactsPanel
        ledger={buildArtifactLedger(MESSAGES)}
        toAbsolutePath={toAbsolutePath}
        onSelect={vi.fn()}
        onAbort={onAbort}
        onRetryPrompt={onRetryPrompt}
        cards={[
          {
            id: 'tool:t2',
            toolCallId: 't2',
            turnId: 'turn',
            timestamp: Date.now(),
            kind: 'image',
            lifecycle: 'failed',
            title: '生成图片',
            error: '模型超时',
            retry: { toolName: 'image_generate', prompt: '一只猫' },
          },
        ]}
      />,
    )
    expect(screen.getByText('失败')).toBeInTheDocument()
    expect(screen.getByText('模型超时')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetryPrompt).toHaveBeenCalledWith('一只猫')
    expect(onAbort).toHaveBeenCalledTimes(1)
  })

  it('有 running 卡时进度并入卡内，不再叠一条进度条', () => {
    renderPanel({
      ledger: buildArtifactLedger([]),
      progress: { toolName: 'image_generate', done: 0, total: 1, startedAt: Date.now() - 4000 },
      onAbort: vi.fn(),
      cards: [
        {
          id: 'tool:t1',
          toolCallId: 't1',
          turnId: 'turn',
          timestamp: Date.now(),
          kind: 'image',
          lifecycle: 'running',
          title: 'p1-red.png',
          placeholder: { prompt: '纯红' },
        },
      ],
    })
    // 卡内给了计时与中断；页面上只有这一个「中断」
    expect(screen.getAllByRole('button', { name: '中断' })).toHaveLength(1)
    expect(screen.getByText(/0\/1/)).toBeInTheDocument()
    expect(screen.getByText('正在生成…')).toBeInTheDocument()
  })

  it('没有中间折叠行时，概要行仍给清理入口（temp/ 也要能清）', () => {
    const onCleanup = vi.fn()
    renderPanel({ onCleanup })
    fireEvent.click(screen.getByRole('button', { name: /清理…/ }))
    expect(onCleanup).toHaveBeenCalled()
  })

  it('interrupt：等拍板的卡片式动作', () => {
    const onAllowOnce = vi.fn()
    const onDeny = vi.fn()
    renderPanel({
      interrupt: {
        title: 'bash 需要授权',
        detail: 'bash',
        onAllowOnce,
        onAllowAlways: vi.fn(),
        onDeny,
      },
    })
    expect(screen.getByText('等你拍板')).toBeInTheDocument()
    expect(screen.getByText('bash 需要授权')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }))
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(onAllowOnce).toHaveBeenCalled()
    expect(onDeny).toHaveBeenCalled()
  })

  it('进行中：阶段 + 已完成/总数 + 中断', () => {
    const onAbort = vi.fn()
    renderPanel({
      progress: { toolName: 'image_generate', done: 1, total: 4, startedAt: Date.now() - 3000 },
      onAbort,
    })
    expect(screen.getByText('生成图片')).toBeInTheDocument()
    expect(screen.getByText(/1\/4/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '中断' }))
    expect(onAbort).toHaveBeenCalled()
  })
})

describe('WorkspaceArtifactsPanel 状态点 / 上次查看 / 跟随', () => {
  it('最新组显示状态点（等你拍板优先），历史组显示已完成', () => {
    const ledger = buildArtifactLedger([
      { id: 'u1', role: 'user', timestamp: 10, text: '写报告' },
      assistant('t1', 20, [{ path: 'outputs/a/old.md', status: 'added', confidence: 'exact' }]),
      { id: 'u2', role: 'user', timestamp: 30, text: '再写一份' },
      assistant('t2', 40, [{ path: 'outputs/b/new.md', status: 'added', confidence: 'exact' }]),
    ])
    renderPanel({
      ledger,
      cards: [
        {
          id: 'c1',
          turnId: 't2',
          timestamp: 40,
          kind: 'doc',
          lifecycle: 'waiting_input',
        },
      ],
    })
    const dots = screen.getAllByLabelText(/等你拍板|已完成/)
    expect(dots.some((dot) => dot.getAttribute('aria-label') === '等你拍板')).toBe(true)
    expect(dots.some((dot) => dot.getAttribute('aria-label') === '已完成')).toBe(true)
  })

  it('有比 lastSeenAt 更新的组时插一条「上次查看之后」分隔行', () => {
    const ledger = buildArtifactLedger([
      { id: 'u1', role: 'user', timestamp: 10, text: '旧任务' },
      assistant('t1', 100, [{ path: 'outputs/a/old.md', status: 'added', confidence: 'exact' }]),
      { id: 'u2', role: 'user', timestamp: 200, text: '新任务' },
      assistant('t2', 300, [{ path: 'outputs/b/new.md', status: 'added', confidence: 'exact' }]),
    ])
    const { rerender } = renderPanel({ ledger, lastSeenAt: 150 })
    expect(screen.getByText('上次查看之后')).toBeInTheDocument()

    // 全部都在上次查看之前 → 不渲染分隔行
    rerender(
      <WorkspaceArtifactsPanel
        ledger={ledger}
        toAbsolutePath={toAbsolutePath}
        onSelect={vi.fn()}
        lastSeenAt={999}
      />,
    )
    expect(screen.queryByText('上次查看之后')).toBeNull()
  })

  it('跟随开关可切；点卡片会自动退出跟随', () => {
    const ledger = buildArtifactLedger([
      { id: 'u1', role: 'user', timestamp: 10, text: '做封面' },
      assistant('t1', 20, [{ path: 'outputs/covers/a.png', status: 'added', confidence: 'exact' }]),
    ])
    const onFollowChange = vi.fn()
    const { rerender } = renderPanel({ ledger, follow: false, onFollowChange })
    fireEvent.click(screen.getByRole('button', { name: '跟随' }))
    expect(onFollowChange).toHaveBeenCalledWith(true)

    rerender(
      <WorkspaceArtifactsPanel
        ledger={ledger}
        toAbsolutePath={toAbsolutePath}
        onSelect={vi.fn()}
        follow
        onFollowChange={onFollowChange}
      />,
    )
    expect(screen.getByRole('button', { name: '跟随' })).toHaveAttribute('aria-pressed', 'true')
    onFollowChange.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /a\.png/ }))
    expect(onFollowChange).toHaveBeenCalledWith(false)
  })
})

describe('WorkspaceArtifactsPanel 作用域 / 视图模式', () => {
  const ALL_ITEMS = [
    {
      path: 'outputs/all/a.md',
      kind: 'doc' as const,
      fileName: 'a.md',
      createdAt: Date.now(),
      conversationId: 'conv-x',
    },
    {
      path: 'outputs/all/b.png',
      kind: 'image' as const,
      fileName: 'b.png',
      // 「昨天」要是**日历上的昨天**：写 26 小时前在本地 0–2 点会落到前天的日期，分节变「更早」
      createdAt: (() => { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(12, 0, 0, 0); return d.getTime() })(),
    },
  ]

  it('切到「全部」用 allItems 渲染（按天分节），点一项交给 onOpenAll', () => {
    const onOpenAll = vi.fn()
    const onScopeChange = vi.fn()
    renderPanel({ scope: 'all', allItems: ALL_ITEMS, onOpenAll, onScopeChange })

    expect(screen.getByText('今天')).toBeInTheDocument()
    expect(screen.getByText('昨天')).toBeInTheDocument()
    expect(screen.getByText(/只包含已登记的产物/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /a\.md/ }))
    expect(onOpenAll).toHaveBeenCalledWith(expect.objectContaining({ path: 'outputs/all/a.md' }))
  })

  it('全部为空时给出限制文案，不是空白', () => {
    renderPanel({ scope: 'all', allItems: [] })
    expect(screen.getByText(/还没有登记过产物/)).toBeInTheDocument()
  })

  it('作用域 tab 回调正确；视图模式可切到列表并持久化', () => {
    localStorage.clear()
    const onScopeChange = vi.fn()
    renderPanel({ onScopeChange })
    fireEvent.click(screen.getByRole('tab', { name: '全部' }))
    expect(onScopeChange).toHaveBeenCalledWith('all')

    fireEvent.click(screen.getByRole('button', { name: '列表' }))
    expect(localStorage.getItem('lumii.workbench.viewMode')).toBe('list')
    // 切到列表后按钮变成「网格」（点它可以切回来）
    expect(screen.getByRole('button', { name: '网格' })).toBeInTheDocument()
  })
})

describe('WorkspaceArtifactsPanel · 变体标记（T5）', () => {
  it('列表行与网格卡都标「变体 · 来自 源文件」', () => {
    const base = buildArtifactLedger([
      assistant('t1', new Date(2026, 9, 27, 17, 3).getTime(), [
        { path: 'outputs/demo/cover.png', status: 'added', confidence: 'exact' },
      ]),
      {
        id: 'e1',
        role: 'assistant',
        timestamp: new Date(2026, 9, 27, 17, 9).getTime(),
        fileChanges: [
          {
            path: 'outputs/demo/cover-variant-170917.png',
            status: 'added',
            confidence: 'exact',
          },
        ],
      },
    ])
    const withVariant = mergeLocalEdits(base, [
      {
        editId: 'edit-v',
        sessionKey: 'conv-1',
        path: 'outputs/demo/cover-variant-170917.png',
        action: 'variant',
        scope: { type: 'image-variant' },
        at: new Date(2026, 9, 27, 17, 9).getTime(),
        bytes: 100,
        derivedFrom: 'outputs/demo/cover.png',
      },
    ])

    localStorage.clear()
    const { unmount } = render(
      <WorkspaceArtifactsPanel
        ledger={withVariant}
        toAbsolutePath={toAbsolutePath}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getAllByText(/变体 · 来自 cover\.png/).length).toBeGreaterThan(0)
    unmount()

    localStorage.setItem('lumii.workbench.viewMode', 'grid')
    render(
      <WorkspaceArtifactsPanel
        ledger={withVariant}
        toAbsolutePath={toAbsolutePath}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getAllByText(/变体 · 来自 cover\.png/).length).toBeGreaterThan(0)
    localStorage.clear()
  })
})
