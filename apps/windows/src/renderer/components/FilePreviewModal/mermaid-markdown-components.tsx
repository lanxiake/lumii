/**
 * 为 MDEditor.Markdown 注入 Mermaid 代码块渲染（仅预览态使用）。
 */

import React, { Children, isValidElement, type ReactNode } from 'react'
import { MermaidBlock } from './MermaidBlock'
import { extractCodeText, isMermaidCodeClass } from './mermaid-utils'

type ColorMode = 'light' | 'dark'

/** react-markdown / md-editor 会塞 node，不能透到 DOM */
type MdCodeProps = React.HTMLAttributes<HTMLElement> & {
  children?: ReactNode
  node?: unknown
}

type MdPreProps = React.HTMLAttributes<HTMLPreElement> & {
  children?: ReactNode
  node?: unknown
}

/** 判断子节点是否为 MermaidBlock，避免再包一层 <pre> */
function isMermaidBlockChild(node: ReactNode): boolean {
  return isValidElement(node) && node.type === MermaidBlock
}

/**
 * 生成文件预览 Markdown 的 components 覆盖：mermaid 围栏渲染为图，其余保持默认。
 */
export function createMermaidMarkdownComponents(colorMode: ColorMode) {
  return {
    code({ className, children, node: _node, ...props }: MdCodeProps) {
      if (isMermaidCodeClass(className)) {
        const source = extractCodeText(children).replace(/\n$/, '')
        return <MermaidBlock source={source} colorMode={colorMode} />
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    },
    pre({ children, node: _node, ...props }: MdPreProps) {
      const list = Children.toArray(children)
      if (list.length === 1 && isMermaidBlockChild(list[0])) {
        return <>{children}</>
      }
      return <pre {...props}>{children}</pre>
    },
  }
}
