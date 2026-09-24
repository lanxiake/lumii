/**
 * Markdown 预览中 Mermaid 代码块识别与文本提取工具。
 */

import type { ReactNode, ReactElement } from 'react'
import { isValidElement } from 'react'

/** 从 code 的 className 判断是否为 mermaid 围栏块（language-mermaid） */
export function isMermaidCodeClass(className?: string | null): boolean {
  if (!className) return false
  return /(?:^|\s)language-mermaid(?:\s|$)/i.test(className)
}

/** 递归提取 React children 中的纯文本（用于 code 节点内容） */
export function extractCodeText(children: ReactNode): string {
  if (children == null || typeof children === 'boolean') return ''
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(extractCodeText).join('')
  if (isValidElement(children)) {
    const el = children as ReactElement<{ children?: ReactNode }>
    return extractCodeText(el.props.children)
  }
  return ''
}
