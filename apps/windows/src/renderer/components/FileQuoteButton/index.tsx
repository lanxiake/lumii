/**
 * FileQuoteButton — 「引用到输入框」按钮（产出卡 / 文件变更行 / 文件树共用）
 *
 * 引用是**投递**语义，不是同步状态：这里只调 quote-bridge，
 * 输入框在对话页时才会接住。不在对话页就置灰并说明原因。
 *
 * 用 `span[role=button]` 而不是 `<button>`：调用方常常是整张产物卡 / 整行文件，
 * 它们本身就是 `<button>`，嵌套 button 是非法 HTML（浏览器会拆节点）。
 * 无障碍语义靠 role + 键盘响应补回来。
 */

import React from 'react'
import { Quote } from 'lucide-react'
import {
  hasFileRefSink,
  insertFileReference,
  type QuoteFileRef,
} from '../../services/quote-bridge'
import styles from './FileQuoteButton.module.css'

export interface FileQuoteButtonProps {
  /** 相对工作区根的路径（POSIX）；产出与文件变更都按它引用 */
  relativePath: string
  /** 展示名；缺省取路径末段 */
  name?: string
  /** 绝对路径；缺省由输入框按工作区根补全 */
  absolutePath?: string
  isDirectory?: boolean
  /** 是否显示文字，默认只显示图标（卡片内空间紧张） */
  withLabel?: boolean
  className?: string
  /** 阻止冒泡：外层有点击行为时必传，否则会连带触发「选中/查看」 */
  stopPropagation?: boolean
}

export const FileQuoteButton: React.FC<FileQuoteButtonProps> = ({
  relativePath,
  name,
  absolutePath,
  isDirectory = false,
  withLabel = false,
  className,
  stopPropagation = false,
}) => {
  const enabled = hasFileRefSink()

  const quote = () => {
    if (!enabled) return
    const ref: QuoteFileRef = {
      relativePath,
      name: name ?? relativePath.split('/').pop() ?? relativePath,
      isDirectory,
      ...(absolutePath ? { absolutePath } : {}),
    }
    insertFileReference(ref)
  }

  const handleClick = (event: React.MouseEvent) => {
    if (stopPropagation) {
      event.preventDefault()
      event.stopPropagation()
    }
    quote()
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (stopPropagation) event.stopPropagation()
    quote()
  }

  const label = '引用到输入框'

  return (
    <span
      role="button"
      tabIndex={enabled ? 0 : -1}
      aria-disabled={!enabled}
      aria-label={label}
      className={className ? `${styles.button} ${className}` : styles.button}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      // 路径只放 title：无障碍名恒定，才不会被外层「按文件名找按钮」的选择器误命中
      title={enabled ? `${label}：${relativePath}` : '打开对话页后可引用'}
    >
      <Quote size={12} strokeWidth={2} aria-hidden />
      {withLabel && <span>引用</span>}
    </span>
  )
}

export default FileQuoteButton
