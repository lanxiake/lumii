/**
 * Mermaid 工具与预览块的行为契约。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { extractCodeText, isMermaidCodeClass } from './mermaid-utils'

describe('isMermaidCodeClass', () => {
  it('识别 language-mermaid', () => {
    expect(isMermaidCodeClass('language-mermaid')).toBe(true)
    expect(isMermaidCodeClass('hljs language-mermaid')).toBe(true)
    expect(isMermaidCodeClass('LANGUAGE-MERMAID')).toBe(true)
  })

  it('拒绝非 mermaid 语言', () => {
    expect(isMermaidCodeClass('language-js')).toBe(false)
    expect(isMermaidCodeClass('mermaid')).toBe(false)
    expect(isMermaidCodeClass('')).toBe(false)
    expect(isMermaidCodeClass(null)).toBe(false)
  })
})

describe('extractCodeText', () => {
  it('拼接字符串与嵌套节点文本', () => {
    expect(extractCodeText('graph BT\n  A-->B')).toBe('graph BT\n  A-->B')
    expect(extractCodeText(['a', 'b'])).toBe('ab')
    expect(extractCodeText(createElement('span', null, 'graph TD'))).toBe('graph TD')
  })
})

describe('MermaidBlock', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('mermaid')
    vi.restoreAllMocks()
  })

  it('渲染成功时注入 SVG', async () => {
    vi.doMock('mermaid', () => ({
      default: {
        initialize: vi.fn(),
        render: vi.fn(async () => ({ svg: '<svg data-testid="mermaid-svg"><text>ok</text></svg>' })),
      },
    }))
    const { MermaidBlock: Fresh } = await import('./MermaidBlock')
    render(<Fresh source={'graph BT\n  A-->B'} colorMode="light" />)
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument()
    })
    expect(screen.getByTestId('mermaid-diagram').innerHTML).toContain('data-testid="mermaid-svg"')
  })

  it('渲染失败时回退源码与错误提示', async () => {
    vi.doMock('mermaid', () => ({
      default: {
        initialize: vi.fn(),
        render: vi.fn(async () => {
          throw new Error('Parse error on line 1')
        }),
      },
    }))
    const { MermaidBlock: Fresh } = await import('./MermaidBlock')
    render(<Fresh source={'not valid'} colorMode="dark" />)
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
    expect(screen.getByRole('alert').textContent).toMatch(/Parse error|渲染失败/)
    expect(screen.getByText('not valid')).toBeInTheDocument()
  })
})

describe('createMermaidMarkdownComponents + MDEditor', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('mermaid')
    vi.restoreAllMocks()
  })

  it('mermaid 围栏走 MermaidBlock，普通代码仍是 pre/code', async () => {
    vi.doMock('mermaid', () => ({
      default: {
        initialize: vi.fn(),
        render: vi.fn(async () => ({ svg: '<svg data-testid="md-svg"></svg>' })),
      },
    }))
    const MDEditor = (await import('@uiw/react-md-editor')).default
    const { createMermaidMarkdownComponents } = await import('./mermaid-markdown-components')
    const source = [
      '```mermaid',
      'graph BT',
      '  A-->B',
      '```',
      '',
      '```js',
      'const x = 1',
      '```',
    ].join('\n')
    const { container } = render(
      createElement(MDEditor.Markdown, {
        source,
        components: createMermaidMarkdownComponents('light'),
      }),
    )
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument()
    })
    expect(container.querySelector('pre code.language-js') || container.querySelector('code.language-js')).toBeTruthy()
  })
})
