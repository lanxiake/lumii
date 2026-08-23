import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ToastProvider } from '../../../../components/ui/Toast/ToastContainer'
import { PerformanceDiagnostics } from './PerformanceDiagnostics'

function buildReport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    generatedAt: Date.now(),
    startupStats: { totalDuration: 1000, phases: { preload: 100, window: 500 }, completed: true },
    ipcStats: {
      totalCalls: 42,
      slowCalls: 3,
      errors: 1,
      channelBreakdown: {
        'agent-runtime:command': {
          channel: 'agent-runtime:command',
          totalCalls: 20,
          successCalls: 19,
          errorCalls: 1,
          totalDuration: 1000,
          minDuration: 50,
          maxDuration: 250,
          averageDuration: 50,
        },
      },
      averageLatency: 85,
    },
    memoryStats: {
      current: { mainProcess: { heapUsed: 100 * 1024 * 1024, external: 10, rss: 300 * 1024 * 1024 }, childProcesses: [] },
      peak: { mainProcess: { heapUsed: 150 * 1024 * 1024, external: 20, rss: 400 * 1024 * 1024 }, childProcesses: [] },
    },
    health: 'good',
    ...overrides,
  }
}

function renderWithToast() {
  return render(
    <ToastProvider>
      <PerformanceDiagnostics />
    </ToastProvider>,
  )
}

describe('PerformanceDiagnostics', () => {
  beforeEach(() => {
    window.electronAPI = {
      ...window.electronAPI,
      performance: {
        getReport: vi.fn(async () => buildReport()),
        capture: vi.fn(async () => ({ success: true })),
        openLogFolder: vi.fn(async () => ({ success: true })),
      },
    } as typeof window.electronAPI
  })

  it('should render performance diagnostics panel with the health status', async () => {
    renderWithToast()

    await waitFor(() => {
      expect(screen.getByText('良好')).toBeInTheDocument()
    })
  })

  it('should load and display performance report metrics', async () => {
    renderWithToast()

    await waitFor(() => {
      expect(screen.getByText('42')).toBeInTheDocument() // 总调用数
      expect(screen.getByText('85ms')).toBeInTheDocument() // 平均延迟
      expect(screen.getByText('1000ms')).toBeInTheDocument() // 启动耗时
    })
  })

  it('should show an error state when getReport rejects', async () => {
    window.electronAPI = {
      ...window.electronAPI,
      performance: {
        getReport: vi.fn(async () => {
          throw new Error('IPC unavailable')
        }),
        capture: vi.fn(),
        openLogFolder: vi.fn(),
      },
    } as typeof window.electronAPI

    renderWithToast()

    await waitFor(() => {
      expect(screen.getByText('IPC unavailable')).toBeInTheDocument()
    })
  })

  it('should allow manual capture and reload the report afterwards', async () => {
    renderWithToast()

    const captureBtn = await screen.findByText('手动捕获')
    fireEvent.click(captureBtn)

    await waitFor(() => {
      expect(window.electronAPI.performance.capture).toHaveBeenCalledTimes(1)
      expect(window.electronAPI.performance.getReport).toHaveBeenCalledTimes(2) // 初次加载 + 捕获后刷新
    })
  })

  it('should open the log folder', async () => {
    renderWithToast()

    const openBtn = await screen.findByText('打开日志')
    fireEvent.click(openBtn)

    await waitFor(() => {
      expect(window.electronAPI.performance.openLogFolder).toHaveBeenCalledTimes(1)
    })
  })
})
