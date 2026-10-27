/**
 * 设置页「存储」：四类占用、策略读取/保存、立即清理、回收站恢复。
 * 主进程全部走 mock——这里验的是界面接线与参数，真实 IO 由主进程单测覆盖。
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ToastProvider } from '../../renderer/components/ui/Toast/ToastContainer'
import { StorageSection } from '../../renderer/pages/SettingsPage/components/StorageSection'

const PREFS = {
  enabled: true,
  intermediateDays: 7,
  ephemeralHours: 24,
  quotaGb: 10,
  targetPercent: 80,
  trashDays: 7,
}

const SCAN = {
  workspaceDir: 'E:/ws',
  classes: {
    deliverable: { count: 12, bytes: 2048 },
    intermediate: { count: 30, bytes: 1024 * 1024 },
    ephemeral: { count: 4, bytes: 4096 },
    internal: { count: 2, bytes: 100 },
  },
  candidates: [],
  skipped: [],
  truncated: false,
  scannedAt: Date.now(),
}

interface MockApi {
  cleanupGetPrefs: ReturnType<typeof vi.fn>
  cleanupSetPrefs: ReturnType<typeof vi.fn>
  cleanupScan: ReturnType<typeof vi.fn>
  cleanupListTrash: ReturnType<typeof vi.fn>
  cleanupRestore: ReturnType<typeof vi.fn>
  cleanupHistory: ReturnType<typeof vi.fn>
  cleanupRunNow: ReturnType<typeof vi.fn>
}

function installApi(overrides: Partial<MockApi> = {}): MockApi {
  const api: MockApi = {
    cleanupGetPrefs: vi.fn(async () => PREFS),
    cleanupSetPrefs: vi.fn(async (prefs: unknown) => ({ ok: true, prefs: prefs as typeof PREFS })),
    cleanupScan: vi.fn(async () => ({ ok: true, scan: SCAN })),
    cleanupListTrash: vi.fn(async () => [
      { id: 'batch-1', createdAt: Date.now(), bytes: 512, files: 2 },
    ]),
    cleanupRestore: vi.fn(async () => ({ ok: true, restored: 2, conflicts: 0 })),
    cleanupHistory: vi.fn(async () => [
      {
        at: new Date().toISOString(),
        action: 'trash',
        path: 'outputs/x/cut-1.png',
        trigger: 'ttl',
      },
    ]),
    cleanupRunNow: vi.fn(async () => ({
      ran: true,
      ttlRemoved: 3,
      ttlBytes: 10,
      quotaRemoved: 0,
      quotaBytes: 0,
      trashRemoved: 1,
      errors: [],
    })),
    ...overrides,
  }
  ;(window.electronAPI as unknown as { workspace: unknown }).workspace = api
  return api
}

function renderSection() {
  return render(
    <ToastProvider>
      <StorageSection />
    </ToastProvider>,
  )
}

describe('StorageSection', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('展示四类占用（产出标注永不自动删）与回收站/记录', async () => {
    installApi()
    renderSection()

    await waitFor(() => expect(screen.getByTestId('storage-usage')).toBeInTheDocument())
    expect(screen.getByText('产出（永不自动删）')).toBeInTheDocument()
    expect(screen.getByText(/12 个/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '恢复' })).toBeInTheDocument()
    expect(await screen.findByText(/outputs\/x\/cut-1\.png/)).toBeInTheDocument()
  })

  it('保存策略把表单值交给主进程', async () => {
    const api = installApi()
    renderSection()
    await waitFor(() => expect(screen.getByText('中间产物保留（天）')).toBeInTheDocument())

    const input = screen.getByLabelText('中间产物保留（天）')
    fireEvent.change(input, { target: { value: '14' } })
    fireEvent.click(screen.getByRole('button', { name: '保存策略' }))

    await waitFor(() => expect(api.cleanupSetPrefs).toHaveBeenCalled())
    expect(api.cleanupSetPrefs.mock.calls[0]![0]).toMatchObject({ intermediateDays: 14 })
  })

  it('立即清理走 runNow 并刷新占用', async () => {
    const api = installApi()
    renderSection()
    await waitFor(() => expect(screen.getByRole('button', { name: '立即清理' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '立即清理' }))
    await waitFor(() => expect(api.cleanupRunNow).toHaveBeenCalled())
    // 刷新会再读一次策略与占用
    await waitFor(() => expect(api.cleanupScan).toHaveBeenCalledTimes(2))
  })

  it('回收站恢复调用 cleanupRestore 并刷新', async () => {
    const api = installApi()
    renderSection()
    const restoreBtn = await screen.findByRole('button', { name: '恢复' })
    fireEvent.click(restoreBtn)
    await waitFor(() => expect(api.cleanupRestore).toHaveBeenCalledWith('batch-1'))
  })
})
