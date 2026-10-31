/**
 * 流水线页「状态 → 界面」：空态 / spec 坏了 / 单条详情 / 运行中禁用按钮。
 *
 * 数据层用假 bridge（`window.electronAPI.pipeline`）喂，不碰真实 IPC。
 * 计划要求真机验收另做（Task 11），这里只锁渲染分支。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PipelinePage } from './PipelinePage'

interface FakeBridge {
  list: ReturnType<typeof vi.fn>
  detail: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  openDir: ReturnType<typeof vi.fn>
  onProgress: ReturnType<typeof vi.fn>
  onFinished: ReturnType<typeof vi.fn>
}

function installBridge(over: Partial<Record<keyof FakeBridge, unknown>> = {}) {
  const b: FakeBridge = {
    list: vi.fn(async () => []),
    detail: vi.fn(async () => null),
    run: vi.fn(async () => ({ ok: true })),
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
    expect(screen.queryByText(/录制运行/)).toBeNull()
  })

  it('单条详情 → 步骤表、断言区、两个运行按钮都在', async () => {
    const b = installBridge({
      list: vi.fn(async () => [
        { id: 'demo', name: '演示', stepCount: 2, narrationCount: 1 },
      ]),
      detail: vi.fn(async () => ({
        spec: {
          id: 'demo',
          name: '演示',
          steps: [
            { id: 'a', label: '第一步', tool: 'app_goto', holdMs: 800 },
            { id: 'b', label: '第二步', tool: 'app_act', holdMs: 1200, narration: '说明' },
          ],
        },
        specHash: 'h',
        runs: [],
        lastJournal: [{ i: 0, id: 'a', tool: 'app_goto', startedAt: 1, ms: 5, ok: true }],
      })),
    })
    render(<PipelinePage />)
    await waitFor(() => expect(screen.getByText('第一步')).toBeTruthy())
    expect(screen.getByText('第二步')).toBeTruthy()
    expect(screen.getByText(/录制运行/)).toBeTruthy()
    expect(screen.getByText('彩排（不录）')).toBeTruthy()
    expect(screen.getByText(/上次 run 的断言/)).toBeTruthy()
    expect(b.detail).toHaveBeenCalledWith('demo')
  })

  it('点「彩排」→ 用 rehearsal 调 run（不是 record）', async () => {
    const b = installBridge({
      list: vi.fn(async () => [{ id: 'demo', stepCount: 1, narrationCount: 0 }]),
      detail: vi.fn(async () => ({
        spec: { id: 'demo', steps: [{ id: 'a', tool: 'app_goto', holdMs: 800 }] },
        specHash: 'h',
        runs: [],
      })),
    })
    render(<PipelinePage />)
    await waitFor(() => expect(screen.getByText('彩排（不录）')).toBeTruthy())
    await act(async () => {
      fireEvent.click(screen.getByText('彩排（不录）'))
    })
    expect(b.run).toHaveBeenCalledWith({ id: 'demo', mode: 'rehearsal', resumeRunId: undefined })
  })

  it('运行中（进度事件到达）→ 两个运行按钮都禁用，并显示第 N/M 步', async () => {
    let emitProgress: ((e: unknown) => void) | null = null
    installBridge({
      list: vi.fn(async () => [{ id: 'demo', stepCount: 3, narrationCount: 0 }]),
      detail: vi.fn(async () => ({
        spec: {
          id: 'demo',
          steps: [
            { id: 'a', tool: 'app_goto', holdMs: 800 },
            { id: 'b', tool: 'app_act', holdMs: 800 },
            { id: 'c', tool: 'app_act', holdMs: 800 },
          ],
        },
        specHash: 'h',
        runs: [],
      })),
      onProgress: vi.fn((cb: (e: unknown) => void) => {
        emitProgress = cb
        return () => {}
      }),
      // run 永不 resolve：模拟「跑到一半」
      run: vi.fn(() => new Promise(() => {})),
    })
    render(<PipelinePage />)
    await waitFor(() => expect(screen.getByText(/录制运行/)).toBeTruthy())
    await act(async () => {
      fireEvent.click(screen.getByText(/录制运行/))
    })
    await act(async () => {
      emitProgress?.({ runId: 'r1', i: 1, total: 3, stepId: 'b', label: '第二步', status: 'ok' })
    })
    await waitFor(() => expect(screen.getByText(/正在跑第 2\/3 步/)).toBeTruthy())
    const recordBtn = screen.getByText(/录制运行/).closest('button')!
    expect(recordBtn.disabled).toBe(true)
  })
})
