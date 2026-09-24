/**
 * Agent Runtime ask_user_question Modal
 *
 * 多问题使用 Tab 页切换，每次只展示一个问题，减少竖向滚动。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '../ui/Modal/Modal'
import { Button } from '../ui/Button/Button'
import styles from './AskUserModal.module.css'

export interface AskUserModalQuestion {
  readonly question: string
  readonly header: string
  readonly multiSelect?: boolean
  readonly options: readonly {
    readonly label: string
    readonly description: string
    readonly preview?: string
    /** AI 推荐项标记（UI 高亮；每问至多一个） */
    readonly recommended?: boolean
    /** 推荐理由（一句话，配合 recommended 使用） */
    readonly recommendReason?: string
  }[]
}

interface AskUserModalPayload {
  readonly answers: Record<string, string>
  readonly annotations?: Record<string, { preview?: string; notes?: string }>
  readonly declined?: boolean
}

export interface AskUserModalProps {
  readonly open: boolean
  /** 提问的前因后果（为什么问、查到什么、答了影响什么）；空则不展示 */
  readonly context?: string
  readonly questions: readonly AskUserModalQuestion[]
  readonly timeoutMs: number
  readonly onSubmit: (payload: AskUserModalPayload) => void | Promise<void>
  readonly onDecline?: () => void | Promise<void>
}

interface PerQuestionState {
  selected: string[]
  otherText: string
  notes: string
}

const OTHER_LABEL = 'Other'
/** 单选点选后的自动前进延迟；多选、Other 与带 preview 的选项不参与自动前进 */
const AUTO_ADVANCE_DELAY_MS = 300

export const AskUserModal: React.FC<AskUserModalProps> = ({
  open,
  context,
  questions,
  timeoutMs,
  onSubmit,
  onDecline,
}) => {
  const [busy, setBusy] = useState(false)
  const [leftSec, setLeftSec] = useState(() => Math.max(1, Math.ceil(timeoutMs / 1000)))
  const [activeTab, setActiveTab] = useState(0)
  const autoAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const defaultState: Record<number, PerQuestionState> = useMemo(
    () =>
      questions.reduce<Record<number, PerQuestionState>>((acc, _, idx) => {
        acc[idx] = { selected: [], otherText: '', notes: '' }
        return acc
      }, {}),
    [questions],
  )

  const [perQ, setPerQ] = useState<Record<number, PerQuestionState>>(defaultState)

  const clearAutoAdvance = useCallback((): void => {
    if (autoAdvanceTimer.current !== null) {
      clearTimeout(autoAdvanceTimer.current)
      autoAdvanceTimer.current = null
    }
  }, [])

  useEffect(() => {
    clearAutoAdvance()
    setPerQ(defaultState)
    setActiveTab(0)
  }, [defaultState, clearAutoAdvance])

  useEffect(() => {
    if (!open) {
      clearAutoAdvance()
      setBusy(false)
      return
    }
    setLeftSec(Math.max(1, Math.ceil(timeoutMs / 1000)))
    const t = setInterval(() => setLeftSec((s) => (s <= 1 ? 1 : s - 1)), 1000)
    return () => clearInterval(t)
  }, [open, timeoutMs, clearAutoAdvance])

  useEffect(() => () => clearAutoAdvance(), [clearAutoAdvance])

  function toggleOption(qIdx: number, label: string, multiSelect: boolean): void {
    clearAutoAdvance()
    const cur = perQ[qIdx] ?? { selected: [], otherText: '', notes: '' }
    const nextSelected = multiSelect
      ? cur.selected.includes(label)
        ? cur.selected.filter((l) => l !== label)
        : [...cur.selected, label]
      : [label]
    const nextState: Record<number, PerQuestionState> = {
      ...perQ,
      [qIdx]: { ...cur, selected: nextSelected },
    }
    setPerQ(nextState)

    if (multiSelect || label === OTHER_LABEL) return
    const opt = questions[qIdx]?.options.find((o) => o.label === label)
    // 带 preview 的选项需要停留阅读，不自动前进
    if (opt?.preview) return
    scheduleAutoAdvance(qIdx, nextState)
  }

  /** 单选点选后自动前进：非末题切下一题；末题全部答完自动提交，否则跳到第一个未答完的题 */
  function scheduleAutoAdvance(fromIdx: number, state: Record<number, PerQuestionState>): void {
    autoAdvanceTimer.current = setTimeout(() => {
      autoAdvanceTimer.current = null
      if (fromIdx < questions.length - 1) {
        setActiveTab(fromIdx + 1)
        return
      }
      const firstInvalid = questions.findIndex((_, idx) => !isQuestionValidIn(state, idx))
      if (firstInvalid === -1) {
        void submitWith(state)
      } else if (firstInvalid !== fromIdx) {
        setActiveTab(firstInvalid)
      }
    }, AUTO_ADVANCE_DELAY_MS)
  }

  function updateOtherText(qIdx: number, text: string): void {
    setPerQ((prev) => {
      const cur = prev[qIdx] ?? { selected: [], otherText: '', notes: '' }
      return { ...prev, [qIdx]: { ...cur, otherText: text } }
    })
  }

  function updateNotes(qIdx: number, text: string): void {
    setPerQ((prev) => {
      const cur = prev[qIdx] ?? { selected: [], otherText: '', notes: '' }
      return { ...prev, [qIdx]: { ...cur, notes: text } }
    })
  }

  function isQuestionValidIn(state: Record<number, PerQuestionState>, idx: number): boolean {
    const s = state[idx]
    if (!s) return false
    const hasSelection = s.selected.length > 0
    const hasOther = s.selected.includes(OTHER_LABEL) ? s.otherText.trim().length > 0 : true
    return hasSelection && hasOther
  }

  function isQuestionValid(idx: number): boolean {
    return isQuestionValidIn(perQ, idx)
  }

  function isValid(): boolean {
    return questions.every((_, idx) => isQuestionValidIn(perQ, idx))
  }

  async function submitWith(state: Record<number, PerQuestionState>): Promise<void> {
    if (busy) return
    if (!questions.every((_, idx) => isQuestionValidIn(state, idx))) return
    setBusy(true)
    try {
      const answers: Record<string, string> = {}
      const annotations: Record<string, { preview?: string; notes?: string }> = {}
      questions.forEach((q, idx) => {
        const s = state[idx]
        if (!s) return
        const labels = s.selected.map((l) => (l === OTHER_LABEL ? s.otherText.trim() : l))
        answers[q.question] = labels.join(', ')
        if (!q.multiSelect && s.selected.length === 1) {
          const sel = s.selected[0]
          const opt = q.options.find((o) => o.label === sel)
          if (opt?.preview) {
            annotations[q.question] = { ...annotations[q.question], preview: opt.preview }
          }
        }
        if (s.notes.trim()) {
          annotations[q.question] = { ...annotations[q.question], notes: s.notes.trim() }
        }
      })
      await onSubmit({
        answers,
        annotations: Object.keys(annotations).length ? annotations : undefined,
      })
    } finally {
      setBusy(false)
    }
  }

  async function handleSubmit(): Promise<void> {
    await submitWith(perQ)
  }

  async function handleDecline(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      if (onDecline) {
        await onDecline()
      } else {
        await onSubmit({ answers: {}, declined: true })
      }
    } finally {
      setBusy(false)
    }
  }

  const q = questions[activeTab]
  const state = perQ[activeTab] ?? { selected: [], otherText: '', notes: '' }
  const isMulti = Boolean(q?.multiSelect)
  const selectedOther = state.selected.includes(OTHER_LABEL)
  const singleSelectedOpt =
    !isMulti && state.selected.length === 1
      ? q?.options.find((o) => o.label === state.selected[0])
      : undefined

  const allHaveRecommendation =
    questions.length > 0 && questions.every((q) => q.options.some((o) => o.recommended))

  /** 一键采用所有推荐项并提交（仅当每问都有推荐项时可用） */
  function applyAllRecommendations(): void {
    clearAutoAdvance()
    const next: Record<number, PerQuestionState> = {}
    questions.forEach((q, idx) => {
      const cur = perQ[idx] ?? { selected: [], otherText: '', notes: '' }
      const rec = q.options.find((o) => o.recommended)
      next[idx] = rec ? { ...cur, selected: [rec.label], otherText: '' } : cur
    })
    setPerQ(next)
    void submitWith(next)
  }

  const footer = (
    <div className={styles.footer}>
      <p className={styles.countdown}>{leftSec}s</p>
      <div className={styles.footerActions}>
        {allHaveRecommendation && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => applyAllRecommendations()}
          >
            全部采用推荐
          </Button>
        )}
        <Button variant="secondary" disabled={busy} onClick={() => void handleDecline()}>
          拒绝回答
        </Button>
        <Button
          variant="primary"
          disabled={busy || !isValid()}
          onClick={() => void handleSubmit()}
        >
          提交回答
        </Button>
      </div>
    </div>
  )

  return (
    <Modal
      open={open}
      title=" AI 请您回答以下问题"
      footer={footer}
      maskClosable={false}
      // 右上角 × 与 Esc 都走「拒绝回答」：用户明确要的语义是「关掉 = 不答，
      // 模型按推荐/默认方案继续」，而不是关不掉或静默等待。
      onClose={() => void handleDecline()}
      width={560}
    >
      <div className={styles.body}>
        {/* 前因后果：弹窗是突然出现的，不给背景用户无从判断选项 */}
        {context?.trim() ? <p className={styles.context}>{context.trim()}</p> : null}

        {/* Tab 导航：多问题时显示 */}
        {questions.length > 1 && (
          <div className={styles.tabs}>
            {questions.map((tq, idx) => (
              <button
                key={idx}
                className={`${styles.tab} ${activeTab === idx ? styles.tabActive : ''} ${isQuestionValid(idx) ? styles.tabDone : ''}`}
                onClick={() => {
                  clearAutoAdvance()
                  setActiveTab(idx)
                }}
              >
                <span className={styles.tabChip}>{tq.header}</span>
                {isQuestionValid(idx) && <span className={styles.tabCheck}>✓</span>}
              </button>
            ))}
          </div>
        )}

        {/* 当前问题 */}
        {q && (
          <div className={styles.question}>
            <div className={styles.qHeader}>
              <span className={styles.chip}>{q.header}</span>
              <span className={styles.hint}>{isMulti ? '可多选' : '单选 · 选后自动进入下一题'}</span>
            </div>
            <p className={styles.qText}>{q.question}</p>
            <div className={styles.options}>
              {q.options.map((opt) => {
                const checked = state.selected.includes(opt.label)
                return (
                  <label
                    key={opt.label}
                    className={`${styles.option} ${checked ? styles.checked : ''}`}
                  >
                    <input
                      type={isMulti ? 'checkbox' : 'radio'}
                      name={`q-${activeTab}`}
                      checked={checked}
                      onChange={() => toggleOption(activeTab, opt.label, isMulti)}
                    />
                    <div className={styles.optBody}>
                      <div className={styles.optLabel}>
                        {opt.label}
                        {opt.recommended && <span className={styles.recBadge}>AI 推荐</span>}
                      </div>
                      <div className={styles.optDesc}>{opt.description}</div>
                      {opt.recommended && opt.recommendReason && (
                        <div className={styles.recReason}>理由：{opt.recommendReason}</div>
                      )}
                    </div>
                  </label>
                )
              })}
              <label className={`${styles.option} ${selectedOther ? styles.checked : ''}`}>
                <input
                  type={isMulti ? 'checkbox' : 'radio'}
                  name={`q-${activeTab}`}
                  checked={selectedOther}
                  onChange={() => toggleOption(activeTab, OTHER_LABEL, isMulti)}
                />
                <div className={styles.optBody}>
                  <div className={styles.optLabel}>{OTHER_LABEL}</div>
                  <div className={styles.optDesc}>自定义回答</div>
                </div>
              </label>
            </div>
            {selectedOther && (
              <textarea
                className={styles.otherInput}
                placeholder="请输入您的回答"
                value={state.otherText}
                onChange={(e) => updateOtherText(activeTab, e.target.value)}
                rows={2}
              />
            )}
            {singleSelectedOpt?.preview && (
              <pre className={styles.preview}>{singleSelectedOpt.preview}</pre>
            )}
            <input
              className={styles.notesInput}
              placeholder="（可选）补充说明"
              value={state.notes}
              onChange={(e) => updateNotes(activeTab, e.target.value)}
            />
          </div>
        )}

        {/* 多问题时的翻页按钮 */}
        {questions.length > 1 && (
          <div className={styles.tabNav}>
            <button
              className={styles.tabNavBtn}
              disabled={activeTab === 0}
              onClick={() => {
                clearAutoAdvance()
                setActiveTab((p) => p - 1)
              }}
            >
              ← 上一题
            </button>
            <span className={styles.tabNavCount}>{activeTab + 1} / {questions.length}</span>
            <button
              className={styles.tabNavBtn}
              disabled={activeTab === questions.length - 1}
              onClick={() => {
                clearAutoAdvance()
                setActiveTab((p) => p + 1)
              }}
            >
              下一题 →
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}

