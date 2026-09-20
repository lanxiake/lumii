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

/**
 * 「已保存的凭据解不开」在设置页的提示。
 *
 * 为什么要有这一组：main 侧把解密失败与「没填」分开了（视图上的
 * `apiKeyDecryptFailed`），但如果渲染层不读它，用户第一眼看到的仍是
 * **一个空的 API Key 输入框**——他会以为自己没填过，重填、保存、重启，问题照旧。
 * 这一组锁的就是「这个标记真的被界面用上了」。
 */
describe('ModelConfigSection 凭据解密失败提示', () => {
  function setGetConfig(cfg: ProviderSlotsConfigView) {
    window.electronAPI = {
      ...window.electronAPI,
      provider: {
        getConfig: vi.fn(async () => cfg),
        setConfig: vi.fn(async (c: unknown) => c),
        listModels: vi.fn(async () => []),
        testConnection: vi.fn(async () => ({ ok: true, message: '' })),
      },
    } as unknown as typeof window.electronAPI
  }

  const ALERT = /已保存的凭据无法解密/

  it('标记为真时明确说明「读不出来」而不是显示一个空框', async () => {
    setGetConfig(buildConfig({ apiKey: '', apiKeyDecryptFailed: true }))
    renderSection()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(ALERT)
    // 得告诉用户重填就行，且旧密文不会被保存覆盖
    expect(alert).toHaveTextContent('重新填写')
    expect(alert).toHaveTextContent('原密文会保留')
  })

  it('没有该标记时不出现（正常用户不该看到这句）', async () => {
    setGetConfig(buildConfig({ apiKey: 'sk-test' }))
    renderSection()

    await waitFor(() => expect(screen.getByText('API Key')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('用户一开始重填就撤掉提示（别挂在已填好的框下面）', async () => {
    setGetConfig(buildConfig({ apiKey: '', apiKeyDecryptFailed: true }))
    renderSection()

    expect(await screen.findByRole('alert')).toHaveTextContent(ALERT)

    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'sk-new' } })

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})
