/**
 * RichComposer.tsx - 富文本输入框（contenteditable）
 *
 * 为什么不用 `<textarea>`：引用与文件引用要在**输入框内**以特殊样式呈现，
 * 并能点击删除，而 textarea 只能显示纯文本。代价是输入框要自己管：
 * 光标、IME、粘贴、换行、占位符，以及「DOM ↔ 文本」的翻译（见 composer-content.ts）。
 *
 * 三条不可动摇的约束：
 *
 * 1. **文本是唯一的对外契约。** 组件对外只吐 `onChange(text)`，与 textarea 时代一模一样，
 *    所以草稿、发送、渠道出站、Agent 解析全都不用知道这里换了实现。
 * 2. **不受控。** React 只在「外部值确实变了」时才重写 DOM。若每次渲染都重写，
 *    光标会当场跳回开头 —— 这是 contenteditable + React 最经典的坑。
 *    判据是拿 `value` 与当前 DOM 的序列化结果比，不等才写。
 * 3. **chip 是命令式建出来的**（React 不接管这棵子树），所以删除用**事件委托**：
 *    在根节点上听 click，认 `data-chip-remove`。重建 DOM 不会漏挂监听。
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react'
import styles from './RichComposer.module.css'
import {
  CHIP_ATTR,
  buildComposerNodes,
  createFileChipNode,
  createQuoteChipNode,
  parseComposerText,
  serializeComposer,
} from './composer-content'
import type { FileReference } from './index'
import type { QuoteInput } from '../../../../selection/quote-bridge'

export interface RichComposerHandle {
  focus(): void
  /** 在光标处插入一个引用 chip（前后补换行，让它独占一块） */
  insertQuote(input: QuoteInput): void
  /** 在光标处插入一个文件/目录引用 chip（补空格分隔，便于 Agent 解析路径） */
  insertFileReference(ref: FileReference): void
  getText(): string
}

export interface RichComposerProps {
  value: string
  onChange: (text: string) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void
  onPaste?: (e: React.ClipboardEvent<HTMLDivElement>) => void
  onCompositionStart?: () => void
  onCompositionEnd?: (text: string) => void
  onBlur?: () => void
  disabled?: boolean
  placeholder?: string
  /** 盒模型度量由调用方给（沿用 textarea 时代那套 `.chat-textarea`） */
  className?: string
  fileReferences?: readonly FileReference[]
  /** 点了内联 chip 的 × 时通知外部（把引用从会话状态里也摘掉） */
  onFileChipRemove?: (ref: FileReference) => void
}

/** 光标处的 Range；光标不在本编辑器内时落到末尾 */
function caretRange(root: HTMLElement): Range {
  const selection = window.getSelection()
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0)
    if (root.contains(range.startContainer)) return range
  }
  const range = document.createRange()
  range.selectNodeContents(root)
  range.collapse(false)
  return range
}

function placeCaretAfter(node: Node): void {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.setStartAfter(node)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

export const RichComposer = forwardRef<RichComposerHandle, RichComposerProps>(function RichComposer(
  {
    value,
    onChange,
    onKeyDown,
    onPaste,
    onCompositionStart,
    onCompositionEnd,
    onBlur,
    disabled = false,
    placeholder,
    className,
    fileReferences = [],
    onFileChipRemove,
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)
  // 命令式插入要用到最新的 props，又不能因此重建回调
  const onChangeRef = useRef(onChange)
  const onFileChipRemoveRef = useRef(onFileChipRemove)
  const fileRefsRef = useRef(fileReferences)
  onChangeRef.current = onChange
  onFileChipRemoveRef.current = onFileChipRemove
  fileRefsRef.current = fileReferences

  /** 把当前 DOM 的文本吐给外部，并同步空态（占位符靠它显示） */
  const emitChange = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    const text = serializeComposer(root)
    root.setAttribute('data-empty', text.length === 0 ? 'true' : 'false')
    onChangeRef.current(text)
  }, [])

  /** 用给定文本重建整棵子树（chip 由 fileReferences 还原） */
  const rebuild = useCallback((text: string) => {
    const root = rootRef.current
    if (!root) return
    const segments = parseComposerText(text, fileRefsRef.current)
    root.replaceChildren(...buildComposerNodes(segments, document))
    root.setAttribute('data-empty', text.length === 0 ? 'true' : 'false')
  }, [])

  // 首次挂载：把初始草稿铺开（chip 在这里还原）。
  // 依赖故意留空 —— 只在挂载时跑一次，后续变化由下面那个 effect 按需处理。
  useLayoutEffect(() => {
    rebuild(value)
  }, [])

  /**
   * 外部值变化（切会话、点建议、发送后清空）才重写 DOM。
   * IME 组合期间一律不写：那会把正在组合的串直接抹掉。
   */
  useEffect(() => {
    const root = rootRef.current
    if (!root || composingRef.current) return
    if (serializeComposer(root) === value) return
    rebuild(value)
  }, [value, rebuild])

  /**
   * 上方 chip 行删掉某个引用时，把正文里对应的内联 chip 一并摘掉。
   *
   * 不会与「点内联 × → 通知外部删引用」形成回环：内联删除是**先摘 DOM 再通知**，
   * 等外部把清单更新回来时，chip 早已不在 DOM 里，这里找不到东西可删。
   */
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const known = new Set(fileReferences.map((ref) => ref.relativePath))
    let removed = false
    root.querySelectorAll<HTMLElement>(`[${CHIP_ATTR}="file"]`).forEach((chip) => {
      const path = chip.getAttribute('data-file-path')
      if (path && !known.has(path)) {
        chip.remove()
        removed = true
      }
    })
    if (removed) emitChange()
  }, [fileReferences, emitChange])

  /** 在光标处插一串节点，插完把光标放到最后一个节点之后 */
  const insertNodesAtCaret = useCallback((nodes: Node[]) => {
    const root = rootRef.current
    if (!root || nodes.length === 0) return
    const range = caretRange(root)
    range.deleteContents()
    const last = nodes[nodes.length - 1]
    const fragment = document.createDocumentFragment()
    nodes.forEach((node) => fragment.appendChild(node))
    range.insertNode(fragment)
    placeCaretAfter(last)
    root.focus()
    emitChange()
  }, [emitChange])

  /** 光标前一个字符（用于决定要不要补分隔） */
  const textBeforeCaret = useCallback((): string => {
    const root = rootRef.current
    if (!root) return ''
    const range = caretRange(root)
    const before = document.createRange()
    before.selectNodeContents(root)
    before.setEnd(range.startContainer, range.startOffset)
    return serializeComposer(before.cloneContents(), { trimTrailingBreak: false })
  }, [])

  const removeChip = useCallback((chip: HTMLElement) => {
    const kind = chip.getAttribute(CHIP_ATTR)
    const path = chip.getAttribute('data-file-path')
    const nextSibling = chip.nextSibling
    chip.remove()
    // 光标落到 chip 原来的位置（没有后继就落到末尾）
    if (rootRef.current) {
      if (nextSibling && rootRef.current.contains(nextSibling)) {
        const range = document.createRange()
        range.setStartBefore(nextSibling)
        range.collapse(true)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
      rootRef.current.focus()
    }
    emitChange()
    if (kind === 'file' && path) {
      // 文本已经改过了才通知外部：外部更新清单会再触发一次收敛 effect，那时已无 chip 可删
      const ref = fileRefsRef.current.find((item) => item.relativePath === path)
      if (ref) onFileChipRemoveRef.current?.(ref)
    }
  }, [emitChange])

  useImperativeHandle(ref, () => ({
    focus: () => rootRef.current?.focus(),
    getText: () => (rootRef.current ? serializeComposer(rootRef.current) : ''),
    insertQuote: (input) => {
      const before = textBeforeCaret()
      const nodes: Node[] = []
      if (before.length > 0 && !before.endsWith('\n')) nodes.push(document.createTextNode('\n'))
      nodes.push(createQuoteChipNode(input, document))
      // 收尾换行让用户接着在新的一行写，而不是贴着引用块
      nodes.push(document.createTextNode('\n'))
      insertNodesAtCaret(nodes)
    },
    insertFileReference: (ref) => {
      const before = textBeforeCaret()
      const nodes: Node[] = []
      if (before.length > 0 && !/\s$/.test(before)) nodes.push(document.createTextNode(' '))
      nodes.push(createFileChipNode(ref, document))
      nodes.push(document.createTextNode(' '))
      insertNodesAtCaret(nodes)
    },
  }), [emitChange, insertNodesAtCaret, textBeforeCaret])

  /** chip 上的 × 是命令式建的，用事件委托收点击 */
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null
    const removeButton = target?.closest('[data-chip-remove]')
    if (!removeButton) return
    const chip = removeButton.closest(`[${CHIP_ATTR}]`)
    if (!(chip instanceof HTMLElement)) return
    e.preventDefault()
    e.stopPropagation()
    removeChip(chip)
  }, [removeChip])

  /** 点 × 不该把焦点从编辑器挪走，否则删完就没法接着打字 */
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null
    if (target?.closest('[data-chip-remove]')) e.preventDefault()
  }, [])

  /**
   * 换行一律自己插 `<br>`：
   * 交给浏览器的话，Shift+Enter 在不同情况下会产出 `<div>` / `<br>` 两种结构，
   * 序列化就得多认一种，不如从一开始只留一种表示。
   */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && e.shiftKey && !composingRef.current) {
      e.preventDefault()
      insertNodesAtCaret([document.createElement('br')])
      return
    }
    onKeyDown?.(e)
  }, [insertNodesAtCaret, onKeyDown])

  /**
   * 粘贴只取纯文本：带格式的 HTML 粘进来会引入 `<font>`/`<div>` 之类我们序列化不认识的结构。
   */
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    onPaste?.(e)
    if (e.defaultPrevented) return
    const text = e.clipboardData?.getData('text/plain') ?? ''
    e.preventDefault()
    if (text.length === 0) return
    insertNodesAtCaret(buildComposerNodes([{ kind: 'text', text }], document))
  }, [onPaste, insertNodesAtCaret])

  return (
    <div
      ref={rootRef}
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      tabIndex={0}
      contentEditable={!disabled}
      suppressContentEditableWarning
      // 中英混输时浏览器的拼写检查会拖慢输入（与 textarea 时代同一条理由）
      spellCheck={false}
      data-empty="true"
      data-disabled={disabled ? 'true' : 'false'}
      className={className ? `${styles['rich-composer']} ${className}` : styles['rich-composer']}
      data-placeholder={placeholder ?? ''}
      onInput={emitChange}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onBlur={onBlur}
      onCompositionStart={() => {
        composingRef.current = true
        onCompositionStart?.()
      }}
      onCompositionEnd={() => {
        composingRef.current = false
        // 组合期间 DOM 变了但没往外吐（见上面那个 effect），这里补一次最终文本
        const root = rootRef.current
        const text = root ? serializeComposer(root) : ''
        if (root) root.setAttribute('data-empty', text.length === 0 ? 'true' : 'false')
        onCompositionEnd?.(text)
      }}
    />
  )
})
