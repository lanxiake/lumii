/**
 * 流水线页「状态 → 界面」：空态 / spec 坏了 / 单条详情 / 进度显示。
 *
 * 数据层用假 bridge（`window.electronAPI.pipeline`）喂，不碰真实 IPC。
 *
 * **本页没有执行入口**（设计 §4.0）：流水线由 Agent 跑。这里锁两件事——
 * 没有运行按钮，以及「在对话里运行」确实把话术预填进对话并把视图切过去。
 * 计划要求真机验收另做，这里只锁渲染分支。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PipelinePage } from './PipelinePage'

interface FakeBridge {
  list: ReturnType<typeof vi.fn>
  detail: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  openDir: ReturnType<typeof vi.fn>
  onProgress: ReturnType<typeof vi.fn>
  onFinished: ReturnType<typeof vi.fn>
}

function installBridge(over: Partial<Record<keyof FakeBridge, unknown>> = {}) {
  const b: FakeBridge = {
    list: vi.fn(async () => []),
    detail: vi.fn(async () => null),
    cancel: vi.fn(async () => ({ ok: true })),
    openDir: vi.fn(async () => ({ ok: true })),
    onProgress: vi.fn(() => () => {}),
    onFinished: vi.fn(() => () => {}),
    ...(over as object),
  }
  ;(window as unknown as { electronAPI: { pipeline: FakeBridge } }).electronAPI = { pipeline: b }
  return b
}

afterEach(() => cleanup())
beforeEach(() => {
  vi.clearAllMocks()
})

const demoDetail = () => ({
  spec: {
    id: 'demo',
    name: '演示',
    steps: [
      { id: 'a', label: '第一步', tool: 'app_goto', holdMs: 800 },
      { id: 'brief', label: '整理简报', kind: 'agent', agentType: 'builtin:explore', prompt: 'x', holdMs: 800 },
    ],
  },
  specHash: 'h',
  runs: [],
  lastJournal: [{ i: 0, id: 'a', tool: 'app_goto', startedAt: 1, ms: 5, ok: true }],
})

describe('PipelinePage', () => {
  it('空清单 → 空态提示（不是白屏）', async () => {
    installBridge()
    render(<PipelinePage />)
    await waitFor(() => expect(screen.getByText(/还没有流水线/)).toBeTruthy())
  })

  it('spec 坏掉 → 左栏标「spec 坏了」，右栏显示错误，且无运行按钮', async () => {
    installBridge({
      list: vi.fn(async () => [
        { id: 'bad', stepCount: 0, narrationCount: 0, error: 'steps[0] unknown tool: nope' },
      ]),
    })
    render(<PipelinePage />)
    await waitFor(() => expect(screen.getByText('spec 坏了')).toBeTruthy())
    expect(screen.getByText(/unknown tool: nope/)).toBeTruthy()
    expect(screen.queryByText(/在对话里运行/)).toBeNull()
  })

  it('单条详情 → 步骤表与断言区都在，且没有任何执行按钮', async () => {
    const b = installBridge({
      list: vi.fn(async () => [{ id: 'demo', name: '演示', stepCount: 2, narrationCount: 1 }]),
      detail: vi.fn(async () => demoDetail()),
    })
    render(<PipelinePage />)
    await waitFor(() => expect(screen.getByText('第一步')).toBeTruthy())
    expect(screen.getByText('整理简报')).toBeTruthy()
    // agent 步骤显示为 Agent · <id>，而不是空白工具名
    expect(screen.getByText(/Agent · builtin:explore/)).toBeTruthy()
    expect(screen.getByText(/上次 run 的断言/)).toBeTruthy()
    // 执行入口已移除
    expect(screen.queryByText(/录制运行/)).toBeNull()
    expect(screen.queryByText(/彩排（不录）/)).toBeNull()
    expect(b.detail).toHaveBeenCalledWith('demo')
  })

  it('点「在对话里运行」→ 派发草稿事件并切到对话', async () => {
    installBridge({
      list: vi.fn(async () => [{ id: 'demo', name: '演示', stepCount: 2, narrationCount: 0 }]),
      detail: vi.fn(async () => demoDetail()),
    })
    const seen: { text?: string }[] = []
    const onViewChange = vi.fn()
    const listener = (e: Event) => seen.push((e as CustomEvent<{ text?: string }>).detail ?? {})
    window.addEventListener('mtbot:chat-draft-request', listener)

    render(<PipelinePage onViewChange={onViewChange} />)
    await waitFor(() => expect(screen.getByText(/在对话里运行/)).toBeTruthy())
    await act(async () => {
      fireEvent.click(screen.getByText(/在对话里运行/))
    })

    expect(seen[0]?.text).toBe('跑流水线 demo')
    expect(onViewChange).toHaveBeenCalledWith('chat')
    window.removeEventListener('mtbot:chat-draft-request', listener)
  })

  it('进度事件到达 → 显示第 N/M 步', async () => {
    let emitProgress: ((e: unknown) => void) | null = null
    installBridge({
      list: vi.fn(async () => [{ id: 'demo', stepCount: 2, narrationCount: 0 }]),
      detail: vi.fn(async () => demoDetail()),
      onProgress: vi.fn((cb: (e: unknown) => void) => {
        emitProgress = cb
        return () => {}
      }),
    })
    render(<PipelinePage />)
    await waitFor(() => expect(screen.getByText('第一步')).toBeTruthy())
    await act(async () => {
      emitProgress?.({ runId: 'r1', i: 1, total: 2, stepId: 'brief', label: '整理简报', status: 'ok' })
    })
    await waitFor(() => expect(screen.getByText(/正在跑第 2\/2 步/)).toBeTruthy())
  })
})
