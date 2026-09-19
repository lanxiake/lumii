/**
 * ModelConfigSection 测试 — 模型级思考配置（modelReasoning / thinkingFormat）
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ToastProvider } from '../../renderer/components/ui/Toast/ToastContainer'
import { ModelConfigSection } from '../../renderer/pages/SettingsPage/components/ModelConfigSection'
import { createDefaultSlotsConfig } from '../../renderer/services/model-config-service'
import type { ProviderSlotsConfigView } from '../../renderer/services/model-config-service'

function buildConfig(overrides: Partial<ProviderSlotsConfigView['chat']> = {}): ProviderSlotsConfigView {
  const base = createDefaultSlotsConfig()
  return {
    ...base,
    chat: {
      ...base.chat,
      enabled: true,
      modelId: 'Qwen3.8-Flash-Next',
      allowedModelIds: ['Qwen3.8-Flash-Next'],
      apiKey: 'sk-test',
      ...overrides,
    },
  }
}

function renderSection() {
  return render(
    <ToastProvider>
      <ModelConfigSection />
    </ToastProvider>,
  )
}

describe('ModelConfigSection 思考配置', () => {
  let setConfig: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setConfig = vi.fn(async (cfg: unknown) => cfg)
    window.electronAPI = {
      ...window.electronAPI,
      provider: {
        getConfig: vi.fn(async () => buildConfig()),
        setConfig,
        listModels: vi.fn(async () => []),
        testConnection: vi.fn(async () => ({ ok: true, message: '' })),
      },
    } as unknown as typeof window.electronAPI
  })

  it('渲染思考参数格式下拉与模型行的思考勾选（默认按内置表勾选）', async () => {
    renderSection()

    await waitFor(() => {
      expect(screen.getByText('思考参数格式')).toBeInTheDocument()
    })
    // qwen 系模型内置判定为支持思考
    const box = screen.getByLabelText('Qwen3.8-Flash-Next 支持思考') as HTMLInputElement
    expect(box.checked).toBe(true)
  })

  it('取消勾选后保存：modelReasoning 落到配置里', async () => {
    renderSection()

    const box = (await screen.findByLabelText('Qwen3.8-Flash-Next 支持思考')) as HTMLInputElement
    fireEvent.click(box)
    fireEvent.click(screen.getByText('保存全部'))

    await waitFor(() => expect(setConfig).toHaveBeenCalled())
    const saved = setConfig.mock.calls[0]![0] as ProviderSlotsConfigView
    expect(saved.chat.modelReasoning).toEqual({ 'Qwen3.8-Flash-Next': false })
  })

  it('切换思考参数格式后保存：thinkingFormat 落到配置里', async () => {
    renderSection()

    const select = (await screen.findByLabelText('思考参数格式')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'qwen' } })
    fireEvent.click(screen.getByText('保存全部'))

    await waitFor(() => expect(setConfig).toHaveBeenCalled())
    const saved = setConfig.mock.calls[0]![0] as ProviderSlotsConfigView
    expect(saved.chat.thinkingFormat).toBe('qwen')
  })
})
