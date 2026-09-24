/**
 * PetModeTitleControl：标题栏宠物开关的状态来源与置灰理由
 *
 * 这个按钮只干三件事，用例也就锁这三件：
 *   1. 状态从主进程读（挂载时 getMode），不是本地瞎猜
 *   2. 广播 `pet-mode-changed` 能改它——**这条最要紧**：托盘、Ctrl+Shift+P、
 *      控制坞都能开关宠物模式，不订阅的话按钮会一直显示"打开"，成了骗人的指示器
 *   3. 屏蔽平台上置灰并给出原因（D4：不能只是把按钮变灰）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ToastProvider } from '../ui/Toast/ToastContainer'

const getMode = vi.fn()
const switchMode = vi.fn()
const getFeatureAvailability = vi.fn()
const on = vi.fn()
const off = vi.fn()

/** 上一次注册的 pet-mode-changed 回调，用来模拟主进程广播 */
let modeChangedHandler: ((mode: unknown) => void) | undefined

// eslint-disable-next-line import/first
import { PetModeTitleControl } from './PetModeTitleControl'

const AVAILABLE = { features: { petMode: { available: true } }, messages: {} }
const BLOCKED = {
  features: { petMode: { available: false, reason: 'platform-unsupported' } },
  messages: { petMode: { 'platform-unsupported': '宠物模式不支持当前平台。' } },
}

function renderControl(): void {
  render(
    <ToastProvider>
      <PetModeTitleControl />
    </ToastProvider>,
  )
}

/** 按钮的可访问名就是 title，用正则匹配免得把 Ctrl+Shift+P 也写进断言 */
function petButton(): HTMLElement {
  return screen.getByRole('button', { name: /宠物模式/ })
}

beforeEach(() => {
  vi.clearAllMocks()
  modeChangedHandler = undefined
  getMode.mockResolvedValue('desktop')
  switchMode.mockResolvedValue({ success: true })
  getFeatureAvailability.mockResolvedValue(AVAILABLE)
  on.mockImplementation((channel: string, handler: (mode: unknown) => void) => {
    if (channel === 'pet-mode-changed') modeChangedHandler = handler
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    app: { getFeatureAvailability },
    pet: { getMode, switchMode },
    on,
    off,
  }
})

describe('PetModeTitleControl', () => {
  it('挂载时按主进程的当前模式点亮，点击切到相反的一档', async () => {
    getMode.mockResolvedValue('pet')
    renderControl()

    await waitFor(() => expect(petButton()).toHaveAttribute('data-pet-mode', 'on'))

    fireEvent.click(petButton())
    // 第二个实参是 modelId：pet-service 原样转发，没传也是 undefined，
    // 而 toHaveBeenCalledWith 会把尾部 undefined 也算进实参列表
    await waitFor(() => expect(switchMode).toHaveBeenCalledWith('desktop', undefined))
  })

  it('桌面模式下点击 → 打开宠物模式', async () => {
    renderControl()

    await waitFor(() => expect(petButton()).toHaveAttribute('data-pet-mode', 'off'))

    fireEvent.click(petButton())
    await waitFor(() => expect(switchMode).toHaveBeenCalledWith('pet', undefined))
  })

  it('别的入口改了模式（托盘/快捷键）：广播能让按钮跟上', async () => {
    renderControl()
    await waitFor(() => expect(petButton()).toHaveAttribute('data-pet-mode', 'off'))

    // 模拟 Ctrl+Shift+P 由主进程广播过来
    modeChangedHandler?.('pet')

    await waitFor(() => expect(petButton()).toHaveAttribute('data-pet-mode', 'on'))
  })

  it('屏蔽平台：置灰并把原因写进提示', async () => {
    getFeatureAvailability.mockResolvedValue(BLOCKED)
    renderControl()

    await waitFor(() => expect(petButton()).toBeDisabled())
    expect(petButton()).toHaveAttribute('title', '宠物模式不支持当前平台。')
  })
})
