import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ToastProvider } from '../../../../../renderer/components/ui/Toast/ToastContainer'
import { PerformanceDiagnostics } from './PerformanceDiagnostics'
import type { PerfEvent, PerfSummary } from '../../../../../shared/performance'

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub

const writeText = vi.fn(async (_text: string) => undefined)

const summary: PerfSummary = {
  generatedAt: 1,
  today: { total: 3, byKind: { 'ipc.slow': 2, 'db.slow': 1 }, slowestMs: 800 },
  ipc: {
    totalCalls: 100,
    slowCalls: 2,
    errors: 0,
    byChannel: {},
  },
  startupStats: { totalDuration: 1000, phases: { 'S1-extensions': 16 } },
  memory: { rss: 300, heapUsed: 100, peakRss: 400 },
  logDir: '/tmp/perf',
  health: 'warning',
}

const events: PerfEvent[] = [
  { timestamp: 1, kind: 'ipc.slow', name: 'agent-runtime:command', duration: 300 },
  { timestamp: 2, kind: 'ipc.slow', name: 'agent-runtime:command', duration: 500 },
  { timestamp: 3, kind: 'db.slow', name: 'SELECT * FROM messages WHERE id = ?', duration: 800, detail: { op: 'all' } },
]

function mockApi(eventList: PerfEvent[] = events) {
  const api = {
    getSummary: vi.fn(async () => summary),
    listEvents: vi.fn(async () => eventList),
    capture: vi.fn(async () => ({ success: true })),
    openLogFolder: vi.fn(async () => ({ success: true })),
    recordEvent: vi.fn(async () => ({ success: true })),
    readRendererNativeMemory: vi.fn(),
  }
  // 只挂 electronAPI，不要替换 window —— React DOM 依赖 jsdom 的 window/document
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { performance: api }
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
  return api
}

function renderPanel() {
  return render(
    <ToastProvider>
      <PerformanceDiagnostics />
    </ToastProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PerformanceDiagnostics', () => {
  it('展示今日摘要与明细行', async () => {
    mockApi()
    renderPanel()
    await waitFor(() => expect(screen.getByText('警告')).toBeTruthy())
    expect(screen.getByText('今日慢事件')).toBeTruthy()
    expect(screen.getByText('明细（3）')).toBeTruthy()
    expect(screen.getAllByText('agent-runtime:command')).toHaveLength(2)
    expect(screen.getByText('SELECT * FROM messages WHERE id = ?')).toBeTruthy()
  })

  it('按类型筛选后明细只剩该类型，计数同步', async () => {
    mockApi()
    renderPanel()
    await waitFor(() => expect(screen.getByText('明细（3）')).toBeTruthy())

    const select = screen.getByLabelText('事件类型') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'db.slow' } })

    expect(screen.getByText('明细（1）')).toBeTruthy()
    expect(screen.queryByText('agent-runtime:command')).toBeNull()
  })

  it('最小耗时筛掉快事件', async () => {
    mockApi()
    renderPanel()
    await waitFor(() => expect(screen.getByText('明细（3）')).toBeTruthy())

    const input = screen.getByLabelText('最小耗时（毫秒）') as HTMLInputElement
    fireEvent.change(input, { target: { value: '600' } })

    expect(screen.getByText('明细（1）')).toBeTruthy()
    expect(screen.getByText('SELECT * FROM messages WHERE id = ?')).toBeTruthy()
  })

  it('复制筛选结果输出 JSONL（一行一条）', async () => {
    mockApi()
    renderPanel()
    await waitFor(() => expect(screen.getByText('明细（3）')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('事件类型'), { target: { value: 'ipc.slow' } })
    fireEvent.click(screen.getByText('复制筛选结果'))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const text = writeText.mock.calls[0]![0] as string
    const lines = text.split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'ipc.slow', name: 'agent-runtime:command' })
  })

  it('展开某条后可单独复制它的完整 JSON', async () => {
    mockApi()
    renderPanel()
    await waitFor(() => expect(screen.getByText('明细（3）')).toBeTruthy())

    // 点第一条明细行（按时间倒序，最上面是 db.slow）
    const row = screen.getByText('SELECT * FROM messages WHERE id = ?').closest('button')!
    fireEvent.click(row)

    expect(screen.getByText(/"kind": "db\.slow"/)).toBeTruthy()
    fireEvent.click(screen.getByText('复制这条'))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(JSON.parse(writeText.mock.calls[0]![0] as string)).toMatchObject({ kind: 'db.slow' })
  })

  it('排行视图展示次数与百分位', async () => {
    mockApi()
    renderPanel()
    await waitFor(() => expect(screen.getByText('明细（3）')).toBeTruthy())

    fireEvent.click(screen.getByText('排行（2）'))

    // agent-runtime:command 两条：300 / 500 → p50 400, p95 490, max 500, 合计 800
    const row = screen.getByText('agent-runtime:command').closest('div')!
    expect(row.textContent).toContain('2')
    expect(row.textContent).toContain('400ms')
    expect(row.textContent).toContain('500ms')
    expect(row.textContent).toContain('800ms')
  })

  it('筛选后无事件时显示空态', async () => {
    mockApi()
    renderPanel()
    await waitFor(() => expect(screen.getByText('明细（3）')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('最小耗时（毫秒）'), { target: { value: '99999' } })
    expect(screen.getByText('当前筛选下没有事件')).toBeTruthy()
  })

  it('加载失败时显示错误', async () => {
    const api = mockApi()
    api.getSummary.mockRejectedValueOnce(new Error('boom'))
    renderPanel()
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy())
  })
})
