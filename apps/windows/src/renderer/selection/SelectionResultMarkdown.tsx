/**
 * SelectionResultMarkdown.tsx - L2 结果的 Markdown 渲染
 *
 * 为什么气泡里要过一遍 Markdown：翻译/解释/总结/润色出来的东西**长度差别极大** ——
 * 短则一个词，长则一屏。全是纯文本时，长结果就是一堵字墙：没有标题、没有分段、
 * 重点与正文一样重。所以提示词里要结构（见 selection-prompts.ts），这里负责把
 * 结构读出来。
 *
 * 与 ChatMessage 那套 Markdown 管线**故意分开**：那边挂了 KaTeX / 代码高亮 / 图片灯箱，
 * 为一个 420px 宽的气泡全量加载不划算，而且那套的排版尺度（标题 20px+）在这里太大。
 * 这里只要「标题 / 分段 / 列表 / 引用 / 强调」这几样，样式是**手绘笔记**的语汇：
 * 荧光笔标重点、手画方框包引用、不规则圆角、轻微的笔触倾斜。
 *
 * 颜色一律用令牌 + color-mix 调出来，不写字面量 —— 三个主题（深/浅/护眼）都要跟着换，
 * 这也是 styles/design-system.themes.test.ts 守着的。
 */

import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import clsx from 'clsx'
import styles from './SelectionResultMarkdown.module.css'

/**
 * 必须是模块级稳定引用：每次渲染给新数组会让 react-markdown 重新解析整段正文
 * （ChatMessage 里踩过同一条，见那边的注释）。
 */
const REMARK_PLUGINS = [remarkGfm]

/** react-markdown 会往组件里塞一个 `node`，不能透到 DOM 上 */
type MarkdownProps = React.HTMLAttributes<HTMLElement> & { node?: unknown }

function heading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as 'h1'
  return function Heading({ node: _node, className, ...rest }: MarkdownProps) {
    return (
      <Tag
        {...rest}
        className={clsx(styles['sr-heading'], styles[`sr-heading--${level}`], className)}
      />
    )
  }
}

const COMPONENTS: Components = {
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),

  p: ({ node: _node, className, ...rest }: MarkdownProps) => (
    <p {...rest} className={clsx(styles['sr-p'], className)} />
  ),

  /** `**重点**` → 荧光笔划过去的样子 */
  strong: ({ node: _node, className, ...rest }: MarkdownProps) => (
    <strong {...rest} className={clsx(styles['sr-mark'], className)} />
  ),

  /** `*补充*` → 波浪线，与荧光笔区分开 */
  em: ({ node: _node, className, ...rest }: MarkdownProps) => (
    <em {...rest} className={clsx(styles['sr-em'], className)} />
  ),

  ul: ({ node: _node, className, ...rest }: MarkdownProps) => (
    <ul {...rest} className={clsx(styles['sr-list'], styles['sr-list--ul'], className)} />
  ),
  ol: ({ node: _node, className, ...rest }: MarkdownProps) => (
    <ol {...rest} className={clsx(styles['sr-list'], styles['sr-list--ol'], className)} />
  ),
  li: ({ node: _node, className, ...rest }: MarkdownProps) => (
    <li {...rest} className={clsx(styles['sr-li'], className)} />
  ),

  /** 引用块当「便签」用：手画方框 + 暖色底 */
  blockquote: ({ node: _node, className, ...rest }: MarkdownProps) => (
    <blockquote {...rest} className={clsx(styles['sr-quote'], className)} />
  ),

  hr: ({ node: _node, className, ...rest }: MarkdownProps) => (
    <hr {...rest} className={clsx(styles['sr-hr'], className)} />
  ),

  a: ({ node: _node, className, ...rest }: MarkdownProps) => (
    <a {...rest} className={clsx(styles['sr-link'], className)} target="_blank" rel="noreferrer" />
  ),

  pre: ({ node: _node, className, ...rest }: MarkdownProps) => (
    <pre {...rest} className={clsx(styles['sr-pre'], className)} />
  ),
  code: ({ node: _node, className, ...rest }: MarkdownProps) => (
    <code {...rest} className={clsx(styles['sr-code'], className)} />
  ),

  table: ({ node: _node, className, ...rest }: MarkdownProps) => (
    <div className={styles['sr-table-wrap']}>
      <table {...rest} className={clsx(styles['sr-table'], className)} />
    </div>
  ),
}

export const SelectionResultMarkdown: React.FC<{ text: string }> = ({ text }) => (
  <div className={styles['sr-root']}>
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
      {text}
    </ReactMarkdown>
  </div>
)

export default SelectionResultMarkdown
