/**
 * ChatInput 组件测试
 * 测试 Phase 3: 消息功能增强 - 自动高度输入框
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import ChatInput from '../../renderer/pages/ChatPage/components/ChatInput'

vi.mock('../../renderer/pages/ChatPage/components/ChatInput/ComposerPlusMenu', () => ({
  ComposerPlusMenu: () => null,
}))

vi.mock('../../renderer/pages/ChatPage/commands/slash-command-executor', () => ({
  getSelectedAcpBackendId: () => 'lumii',
  BACKEND_INFO: {},
  MAIN_BACKEND_ID: 'lumii',
}))

vi.mock('../../renderer/hooks/business/useSkills', () => ({
  useSkills: () => ({
    installedSkills: [],
    isLoading: false,
    enableSkill: vi.fn(async () => true),
    disableSkill: vi.fn(async () => true),
  }),
}))

vi.mock('../../renderer/hooks/business/useToolSearch', () => ({
  useToolSearch: () => ({
    tools: [],
    mcpStatus: [],
    isLoading: false,
    togglingTool: null,
    toggleTool: vi.fn(),
    refresh: vi.fn(),
  }),
}))

describe('Phase 3: 消息功能 - ChatInput组件', () => {
  const mockProps = {
    value: '',
    onChange: vi.fn(),
    onSend: vi.fn(),
    disabled: false,
    isStreaming: false,
    isConnected: true,
    placeholder: '输入消息...',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  /**
   * 输入框是 contenteditable（RichComposer），没有 `.value`，也没有 placeholder 属性 ——
   * 占位符落在 `data-placeholder` 上。所以这里不再用 getByPlaceholderText。
   */
  function getComposer(container: HTMLElement): HTMLElement {
    return container.querySelector('.chat-textarea') as HTMLElement
  }

  /** 「打字」在 contenteditable 上等价于：把文本写进 DOM + 派发一次 input */
  function typeInto(composer: HTMLElement, text: string): void {
    const nodes: Node[] = []
    text.split('\n').forEach((line, index) => {
      if (index > 0) nodes.push(document.createElement('br'))
      if (line.length > 0) nodes.push(document.createTextNode(line))
    })
    composer.replaceChildren(...nodes)
    fireEvent.input(composer)
  }

  describe('TC-3.2 自动高度输入框功能', () => {
    it('TC-3.2.1: 组件正常渲染', () => {
      const { container } = render(<ChatInput {...mockProps} />)
      expect(container.querySelector('.chat-input-wrapper')).toBeInTheDocument()
      expect(container.querySelector('.chat-textarea')).toBeInTheDocument()
    })

    it('TC-3.2.2: 输入文本立即显示在输入框，失焦后才通知父组件', () => {
      const { container } = render(<ChatInput {...mockProps} />)

      const composer = getComposer(container)
      typeInto(composer, 'Test message')

      expect(composer.textContent).toBe('Test message')
      expect(mockProps.onChange).not.toHaveBeenCalled()

      fireEvent.blur(composer)
      expect(mockProps.onChange).toHaveBeenCalledWith('Test message')
    })

    it('TC-3.2.3: 按Enter键发送消息（非Shift+Enter）', () => {
      const { container } = render(<ChatInput {...mockProps} value="Test message" />)

      fireEvent.keyDown(getComposer(container), { key: 'Enter', shiftKey: false })

      expect(mockProps.onSend).toHaveBeenCalled()
    })

    it('TC-3.2.4: 按Shift+Enter不发送消息（插入换行）', () => {
      const { container } = render(<ChatInput {...mockProps} value="Test message" />)

      fireEvent.keyDown(getComposer(container), { key: 'Enter', shiftKey: true })

      expect(mockProps.onSend).not.toHaveBeenCalled()
    })

    it('TC-3.2.5: 空白内容按Enter不发送', () => {
      const { container } = render(<ChatInput {...mockProps} value="   " />)

      fireEvent.keyDown(getComposer(container), { key: 'Enter', shiftKey: false })

      expect(mockProps.onSend).not.toHaveBeenCalled()
    })

    it('TC-3.2.6: 点击发送按钮触发发送', () => {
      render(<ChatInput {...mockProps} value="Test message" />)

      // 输入区有模型/推理/帮助等多个按钮，按 title 精确定位发送键
      const sendBtn = screen.getByTitle('发送消息')
      fireEvent.click(sendBtn)

      expect(mockProps.onSend).toHaveBeenCalled()
    })

    it('TC-3.2.7: 连接断开时输入框禁用', () => {
      const { container } = render(<ChatInput {...mockProps} isConnected={false} />)

      // contenteditable 没有 disabled 属性，禁用靠 contenteditable=false 表达
      expect(getComposer(container)).toHaveAttribute('contenteditable', 'false')
    })

    // 图标从 emoji 换成了内联 SVG，textContent 已取不到字形，改判按钮语义
    it('TC-3.2.8: 流式生成时发送按钮切换为停止', () => {
      render(<ChatInput {...mockProps} isStreaming={true} />)

      expect(screen.getByTitle('停止生成')).toBeInTheDocument()
      expect(screen.queryByTitle('发送消息')).not.toBeInTheDocument()
    })

    it('TC-3.2.9: 非流式时发送按钮显示发送', () => {
      render(<ChatInput {...mockProps} isStreaming={false} />)

      expect(screen.getByTitle('发送消息')).toBeInTheDocument()
      expect(screen.queryByTitle('停止生成')).not.toBeInTheDocument()
    })

    it('TC-3.2.10: 禁用时发送按钮不可点击', () => {
      render(<ChatInput {...mockProps} disabled={true} />)

      expect(screen.getByTitle('发送消息')).toBeDisabled()
    })

    it('TC-3.2.11: 未连接时显示警告提示', () => {
      render(<ChatInput {...mockProps} isConnected={false} />)

      expect(screen.getByText(/未连接到服务器/)).toBeInTheDocument()
    })

    // 生成中提示改由 placeholder 承载（见 index.tsx 的 effectivePlaceholder）
    it('TC-3.2.12: 流式生成时显示生成中提示', () => {
      const { container } = render(<ChatInput {...mockProps} isStreaming={true} />)

      expect(getComposer(container)).toHaveAttribute(
        'data-placeholder',
        expect.stringMatching(/AI 回复中/),
      )
    })

    // 快捷键提示挪到输入卡下方 composer-hint，只在有输入时出现，按键各自是 <kbd>
    it('TC-3.2.13: 有输入时显示快捷键提示', () => {
      render(<ChatInput {...mockProps} value="hi" />)

      expect(screen.getByText('Enter')).toBeInTheDocument()
      expect(screen.getByText('Shift+Enter')).toBeInTheDocument()
    })

    it('TC-3.2.14: 空白内容发送按钮禁用', () => {
      render(<ChatInput {...mockProps} value="" />)

      expect(screen.getByTitle('发送消息')).toBeDisabled()
    })
  })

  describe('输入性能：本地草稿与 IME', () => {
    it('IME 组合期间不把中间拼音同步给父组件', () => {
      const { container } = render(<ChatInput {...mockProps} />)

      const composer = getComposer(container)
      fireEvent.compositionStart(composer)
      typeInto(composer, 'ni')
      typeInto(composer, 'nihao')

      expect(composer.textContent).toBe('nihao')
      expect(mockProps.onChange).not.toHaveBeenCalled()
    })

    it('IME 组合结束后把最终文案一次性同步给父组件', () => {
      const { container } = render(<ChatInput {...mockProps} />)

      const composer = getComposer(container)
      fireEvent.compositionStart(composer)
      typeInto(composer, 'nihao')
      typeInto(composer, '你好')
      fireEvent.compositionEnd(composer)

      expect(composer.textContent).toBe('你好')
      expect(mockProps.onChange).toHaveBeenCalledTimes(1)
      expect(mockProps.onChange).toHaveBeenCalledWith('你好')
    })

    it('未失焦直接回车时用本地草稿发送', () => {
      const onSendWithValue = vi.fn()
      const { container } = render(<ChatInput {...mockProps} onSendWithValue={onSendWithValue} />)

      const composer = getComposer(container)
      typeInto(composer, 'hello')
      fireEvent.keyDown(composer, { key: 'Enter', shiftKey: false })

      expect(onSendWithValue).toHaveBeenCalledWith('hello')
      expect(mockProps.onSend).not.toHaveBeenCalled()
    })

    it('切换会话时把未同步的旧草稿写回对应 session', () => {
      const onPersistDraft = vi.fn()
      const { container, rerender } = render(
        <ChatInput
          {...mockProps}
          sessionKey="session-a"
          value=""
          onPersistDraft={onPersistDraft}
        />,
      )

      typeInto(getComposer(container), 'draft-a')

      rerender(
        <ChatInput
          {...mockProps}
          sessionKey="session-b"
          value=""
          onPersistDraft={onPersistDraft}
        />,
      )

      expect(onPersistDraft).toHaveBeenCalledWith('session-a', 'draft-a')
    })

    it('关闭浏览器拼写检查以免中英混输卡顿', () => {
      const { container } = render(<ChatInput {...mockProps} />)

      expect(getComposer(container)).toHaveAttribute('spellcheck', 'false')
    })
  })
})

/**
 * 上下文指示器的触发线口径。
 *
 * 这里的 contextUsage 会在组件内被重建成只含必要字段的新对象——漏传 budget 会让
 * 口径**静默**退回整窗百分比（store 里明明有快照，label 却还说「压缩阈值 78%」，
 * 且 TS 不会报错）。所以要断言最终落到 aria-label 上的文案。
 */
describe('上下文指示器的触发线口径', () => {
  // 上一个 describe 的 mockProps 在其作用域内，这里自备一份
  const compactProps = {
    value: '',
    onChange: vi.fn(),
    onSend: vi.fn(),
    disabled: false,
    isStreaming: false,
    isConnected: true,
    placeholder: '输入消息...',
    // 没有它整个上下文按钮不渲染
    onCompactContext: vi.fn(),
  }

  const labelOf = (): string => {
    const btn = document.querySelector('[aria-label^="上下文使用"]')
    return btn?.getAttribute('aria-label') ?? ''
  }

  it('有触发线快照时报对话历史与触发线，而不是整窗百分比', () => {
    render(
      <ChatInput
        {...compactProps}
        contextUsage={{
          usedTokens: 190_000,
          contextWindow: 256_000,
          triggerThreshold: 0.78,
          isNearThreshold: true,
          budget: {
            compressibleTokens: 145_000,
            budgetTokens: 214_000,
            triggerTokens: 167_000,
            exhausted: false,
          },
        }}
      />,
    )

    const label = labelOf()
    expect(label).toContain('对话历史 145K')
    expect(label).toContain('触发线 167K')
    // 有快照就不该再拿整窗百分比跟阈值比例作比较
    expect(label).not.toContain('压缩阈值')
  })

  it('快照缺失时退回整窗百分比，且不出现「状态 状态健康」叠字', () => {
    render(
      <ChatInput
        {...compactProps}
        contextUsage={{
          usedTokens: 26_000,
          contextWindow: 200_000,
          triggerThreshold: 0.78,
          isNearThreshold: false,
        }}
      />,
    )

    const label = labelOf()
    expect(label).toContain('压缩阈值 78%')
    expect(label).toContain('状态 健康')
    expect(label).not.toContain('状态 状态')
  })

  it('固定开销挤满窗口时给出可行动作', () => {
    render(
      <ChatInput
        {...compactProps}
        contextUsage={{
          usedTokens: 198_000,
          contextWindow: 200_000,
          triggerThreshold: 0.78,
          isNearThreshold: true,
          budget: {
            compressibleTokens: 3_000,
            budgetTokens: 0,
            triggerTokens: 0,
            exhausted: true,
          },
        }}
      />,
    )

    expect(labelOf()).toContain('固定开销已占满窗口，压缩无法释放空间')
  })
})
