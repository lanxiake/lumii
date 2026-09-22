/**
 * SelectionBubble.tsx - 划词结果气泡
 *
 * 只服务 L2（翻译/解释/总结/润色）。三态：pending / done / error。
 *
 * 生命周期与浮条解耦（见 bubble-store 的说明）：浮条随任意 mousedown 收起，
 * 气泡不收，否则用户点别处想看结果时它正好没了。
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Quote, Volume2, VolumeX, X } from 'lucide-react'
import { placeFloating, type FloatingPosition } from './floating-position'
import { hasQuoteSink, insertQuote } from './quote-bridge'
import { SINGLE_ACTION_LABELS } from './single-action-labels'
import { useSelectionBubble, closeBubble } from './bubble-store'
import { useTtsPreview } from '../hooks/business/useTtsPreview'
import { writeClipboardText } from '../services/clipboard-service'
import styles from './SelectionBubble.module.css'

/** 朗读上限与消息朗读一致（设置页试听的 100 字上限会把长结果静默截断） */
const SPEAK_MAX_CHARS = 8000

interface SelectionBubbleProps {
  rootRef: React.RefObject<HTMLDivElement>
}

/** 来源摘要：单行、过长截断 */
function shorten(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

export const SelectionBubble: React.FC<SelectionBubbleProps> = ({ rootRef }) => {
  const state = useSelectionBubble()
  const [position, setPosition] = useState<FloatingPosition | null>(null)
  /** 用户拖过之后的位移。每次开新气泡都归零（重置在下面的 layout effect 里） */
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)
  const showQuote = hasQuoteSink()
  const { isSpeaking, busy: ttsBusy, speak, stop: stopSpeaking } = useTtsPreview()

  // 先量后定位（与浮条同一套）。依赖 state?.anchorRect：换选区时重算
  useLayoutEffect(() => {
    if (!state) return
    setDragOffset({ x: 0, y: 0 })
    const el = rootRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPosition(
      placeFloating(state.anchorRect, { width, height }, 'bottom', {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    )
  }, [state, rootRef])

  /**
   * 拖动气泡：按住头部拖，别挡住下面的正文。
   *
   * 用 pointer capture 而不是往 document 上挂 mousemove —— 指针移到窗口外再松开时，
   * 捕获能保证 pointerup 仍然回到这里，不会留下「粘在指针上」的浮层。
   */
  const handleDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !position) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: dragOffset.x,
      baseY: dragOffset.y,
    }
  }

  const handleDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setDragOffset({
      x: drag.baseX + (e.clientX - drag.startX),
      y: drag.baseY + (e.clientY - drag.startY),
    })
  }

  const handleDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  // 只挂 Esc。滚动/缩放/点别处不在这里管 —— 那是划词层的既有行为
  // （useSelectionWatcher 的 handleViewportChange），气泡跟着一起收就够了
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeBubble()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!state) return null

  const label = SINGLE_ACTION_LABELS[state.action]

  return createPortal(
    <div
      ref={rootRef}
      className={styles['selection-bubble']}
      role="dialog"
      aria-label={`${label}结果`}
      data-selection-bubble=""
      style={{
        top: (position?.top ?? 0) + dragOffset.y,
        left: (position?.left ?? 0) + dragOffset.x,
        visibility: position ? 'visible' : 'hidden',
      }}
      // 保住选区：气泡里的复制/引用不该把用户刚选的那段弄没
      onMouseDown={(e) => e.preventDefault()}
    >
      <div
        className={styles['selection-bubble__head']}
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
        title="按住可拖动"
      >
        <span className={styles['selection-bubble__title']}>{label}</span>
        <span className={styles['selection-bubble__source']}>{shorten(state.text)}</span>
        <button
          type="button"
          className={styles['selection-bubble__icon-button']}
          aria-label="关闭"
          title="关闭（Esc）"
          onClick={closeBubble}
        >
          <X size={14} />
        </button>
      </div>

      <div className={styles['selection-bubble__body']} data-selection-bubble-status={state.status}>
        {state.status === 'pending' && (
          <div className={styles['selection-bubble__pending']}>
            <span className={styles['selection-bubble__dot']} />
            <span className={styles['selection-bubble__dot']} />
            <span className={styles['selection-bubble__dot']} />
            <span>处理中…</span>
          </div>
        )}
        {state.status === 'done' && (
          <p className={styles['selection-bubble__result']}>{state.result}</p>
        )}
        {state.status === 'error' && (
          <p className={styles['selection-bubble__error']}>{state.error ?? '处理失败'}</p>
        )}
      </div>

      {state.status === 'done' && state.result && (
        <div className={styles['selection-bubble__foot']}>
          <button
            type="button"
            className={styles['selection-bubble__action']}
            disabled={ttsBusy}
            onClick={() => {
              if (isSpeaking) void stopSpeaking()
              else void speak(state.result ?? '', { maxChars: SPEAK_MAX_CHARS })
            }}
            title={ttsBusy ? '正在准备朗读…' : isSpeaking ? '停止朗读' : '朗读'}
          >
            {isSpeaking ? <VolumeX size={13} /> : <Volume2 size={13} />}
            <span>{ttsBusy ? '准备中' : isSpeaking ? '停止' : '朗读'}</span>
          </button>
          <button
            type="button"
            className={styles['selection-bubble__action']}
            onClick={() => void writeClipboardText(state.result ?? '')}
          >
            <Copy size={13} />
            <span>复制</span>
          </button>
          {showQuote && (
            <button
              type="button"
              className={styles['selection-bubble__action']}
              onClick={() => {
                insertQuote({ text: state.result ?? '' })
                closeBubble()
              }}
            >
              <Quote size={13} />
              <span>引用</span>
            </button>
          )}
        </div>
      )}
    </div>,
    document.body,
  )
}

export default SelectionBubble
