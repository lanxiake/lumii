/**
 * ModelConfigSection 测试 — 多 Provider 配置界面
 *
 * 锁三件事：
 * 1. 每模型的思考配置（modelReasoning）落在**槽**上，保存后能回读；
 * 2. 同一份凭据可被多个能力槽共用（多 Provider 的核心价值）；
 * 3. 「已保存的凭据解不开」必须在界面上被解释，而不是显示一个空框。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ToastProvider } from '../../renderer/components/ui/Toast/ToastContainer'
import { ModelConfigSection } from '../../renderer/pages/SettingsPage/components/ModelConfigSection'
import type { ProviderStoreView } from '../../renderer/services/model-config-service'

function buildStore(overrides: Partial<ProviderStoreView> = {}): ProviderStoreView {
  return {
    providers: [
      {
        id: 'p1',
        name: 'DeepSeek',
        type: 'openai',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        modelIds: ['Qwen3.8-Flash-Next'],
        thinkingFormat: 'auto',
      },
    ],
    slots: {
      chat: { enabled: true, providerId: 'p1', modelId: 'Qwen3.8-Flash-Next' },
      vision: { enabled: false, providerId: '', modelId: '' },
      image: { enabled: false, providerId: '', modelId: '' },
    },
    ...overrides,
  }
}

function renderSection() {
  return render(
    <ToastProvider>
      <ModelConfigSection />
    </ToastProvider>,
  )
}

/** 装载 mock 的 electronAPI（provider 部分） */
function mockApi(store: ProviderStoreView, setConfig = vi.fn(async (c: unknown) => c)) {
  window.electronAPI = {
    ...window.electronAPI,
    provider: {
      getConfig: vi.fn(async () => store),
      setConfig,
      listModels: vi.fn(async () => []),
      testConnection: vi.fn(async () => ({ ok: true, message: '' })),
    },
  } as unknown as typeof window.electronAPI
  return setConfig
}

describe('ModelConfigSection 思考配置', () => {
  it('渲染思考勾选（默认按内置表判定，qwen 系为真）', async () => {
    mockApi(buildStore())
    renderSection()

    const box = (await screen.findByLabelText('Qwen3.8-Flash-Next 支持思考')) as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(screen.getByText('思考参数格式')).toBeInTheDocument()
  })

  it('取消勾选后保存：modelReasoning 落到槽配置里', async () => {
    const setConfig = mockApi(buildStore())
    renderSection()

    const box = (await screen.findByLabelText('Qwen3.8-Flash-Next 支持思考')) as HTMLInputElement
    fireEvent.click(box)
    fireEvent.click(screen.getByText('保存全部'))

    await waitFor(() => expect(setConfig).toHaveBeenCalled())
    const saved = setConfig.mock.calls[0]![0] as ProviderStoreView
    expect(saved.slots.chat.modelReasoning).toEqual({ 'Qwen3.8-Flash-Next': false })
  })

  it('切换思考参数格式后保存：thinkingFormat 落到 provider 上', async () => {
    const setConfig = mockApi(buildStore())
    renderSection()

    const select = (await screen.findByLabelText('思考参数格式')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'qwen' } })
    fireEvent.click(screen.getByText('保存全部'))

    await waitFor(() => expect(setConfig).toHaveBeenCalled())
    const saved = setConfig.mock.calls[0]![0] as ProviderStoreView
    expect(saved.providers[0]!.thinkingFormat).toBe('qwen')
  })
})

describe('多 Provider', () => {
  /** 按 aria-label 找槽位提供商下拉（Select 把 aria-label 透传到 <select>） */
  const findSlotSelect = async (slotLabel: string): Promise<HTMLSelectElement> =>
    (await screen.findByLabelText(`${slotLabel}提供商`)) as HTMLSelectElement

  it('可添加第二个提供商，并让视觉能力指向它', async () => {
    const setConfig = mockApi(buildStore())
    renderSection()

    const visionSelect = await findSlotSelect('视觉理解')
    expect(visionSelect.options).toHaveLength(2) // （未选择）+ p1

    fireEvent.click(screen.getByText('添加提供商'))
    await waitFor(() => expect(visionSelect.options).toHaveLength(3))

    const secondId = Array.from(visionSelect.options)
      .map((o) => o.value)
      .find((v) => v && v !== 'p1')!
    fireEvent.change(visionSelect, { target: { value: secondId } })

    fireEvent.click(screen.getByText('保存全部'))
    await waitFor(() => expect(setConfig).toHaveBeenCalled())

    const saved = setConfig.mock.calls[0]![0] as ProviderStoreView
    expect(saved.providers).toHaveLength(2)
    expect(saved.slots.vision.providerId).toBe(secondId)
  })

  it('同一个提供商可同时供多个能力使用（Key 只填一次）', async () => {
    const setConfig = mockApi(buildStore())
    renderSection()

    fireEvent.change(await findSlotSelect('视觉理解'), { target: { value: 'p1' } })
    fireEvent.click(screen.getByText('保存全部'))

    await waitFor(() => expect(setConfig).toHaveBeenCalled())
    const saved = setConfig.mock.calls[0]![0] as ProviderStoreView
    expect(saved.slots.chat.providerId).toBe('p1')
    expect(saved.slots.vision.providerId).toBe('p1')
    expect(saved.providers).toHaveLength(1)
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
  const ALERT = /已保存的凭据无法解密/

  function storeWithBadKey(): ProviderStoreView {
    const store = buildStore()
    store.providers[0] = {
      ...store.providers[0]!,
      apiKey: '',
      apiKeyDecryptFailed: true,
    }
    return store
  }

  it('标记为真时明确说明「读不出来」而不是显示一个空框', async () => {
    mockApi(storeWithBadKey())
    renderSection()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(ALERT)
    // 得告诉用户重填就行，且旧密文不会被保存覆盖
    expect(alert).toHaveTextContent('重新填写')
    expect(alert).toHaveTextContent('原密文会保留')
  })

  it('没有该标记时不出现（正常用户不该看到这句）', async () => {
    mockApi(buildStore())
    renderSection()

    await waitFor(() => expect(screen.getByText('API Key')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('用户一开始重填就撤掉提示（别挂在已填好的框下面）', async () => {
    mockApi(storeWithBadKey())
    renderSection()

    expect(await screen.findByRole('alert')).toHaveTextContent(ALERT)

    const inputs = screen.getAllByPlaceholderText('sk-...')
    fireEvent.change(inputs[0]!, { target: { value: 'sk-new' } })

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})

beforeEach(() => {
  vi.restoreAllMocks()
})
