/**
 * Agent Runtime ask_user_question Modal
 *
 * 多问题使用 Tab 页切换，每次只展示一个问题，减少竖向滚动。
 */

import React, { useEffect, useMemo, useState } from 'react'
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
  }[]
}

export interface AskUserModalPayload {
  readonly answers: Record<string, string>
  readonly annotations?: Record<string, { preview?: string; notes?: string }>
  readonly declined?: boolean
}

export interface AskUserModalProps {
  readonly open: boolean
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

export const AskUserModal: React.FC<AskUserModalProps> = ({
  open,
  questions,
  timeoutMs,
  onSubmit,
  onDecline,
}) => {
  const [busy, setBusy] = useState(false)
  const [leftSec, setLeftSec] = useState(() => Math.max(1, Math.ceil(timeoutMs / 1000)))
  const [activeTab, setActiveTab] = useState(0)

  const defaultState: Record<number, PerQuestionState> = useMemo(
    () =>
      questions.reduce<Record<number, PerQuestionState>>((acc, _, idx) => {
        acc[idx] = { selected: [], otherText: '', notes: '' }
        return acc
      }, {}),
    [questions],
  )

  const [perQ, setPerQ] = useState<Record<number, PerQuestionState>>(defaultState)

  useEffect(() => {
    setPerQ(defaultState)
    setActiveTab(0)
  }, [defaultState])

  useEffect(() => {
    if (!open) {
      setBusy(false)
      return
    }
    setLeftSec(Math.max(1, Math.ceil(timeoutMs / 1000)))
    const t = setInterval(() => setLeftSec((s) => (s <= 1 ? 1 : s - 1)), 1000)
    return () => clearInterval(t)
  }, [open, timeoutMs])

  function toggleOption(qIdx: number, label: string, multiSelect: boolean): void {
    setPerQ((prev) => {
      const cur = prev[qIdx] ?? { selected: [], otherText: '', notes: '' }
      let nextSelected: string[]
      if (multiSelect) {
        nextSelected = cur.selected.includes(label)
          ? cur.selected.filter((l) => l !== label)
          : [...cur.selected, label]
      } else {
        nextSelected = [label]
      }
      return { ...prev, [qIdx]: { ...cur, selected: nextSelected } }
    })
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

  function isQuestionValid(idx: number): boolean {
    const s = perQ[idx]
    if (!s) return false
    const hasSelection = s.selected.length > 0
    const hasOther = s.selected.includes(OTHER_LABEL) ? s.otherText.trim().length > 0 : true
    return hasSelection && hasOther
  }

  function isValid(): boolean {
    return questions.every((_, idx) => isQuestionValid(idx))
  }

  async function handleSubmit(): Promise<void> {
    if (busy) return
    if (!isValid()) return
    setBusy(true)
    try {
      const answers: Record<string, string> = {}
      const annotations: Record<string, { preview?: string; notes?: string }> = {}
      questions.forEach((q, idx) => {
        const s = perQ[idx]!
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

  const footer = (
    <div className={styles.footer}>
      <p className={styles.countdown}>{leftSec}s</p>
      <div className={styles.footerActions}>
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
      title="🤖 AI 请您回答以下问题"
      footer={footer}
      maskClosable={false}
      width={560}
    >
      <div className={styles.body}>
        {/* Tab 导航：多问题时显示 */}
        {questions.length > 1 && (
          <div className={styles.tabs}>
            {questions.map((tq, idx) => (
              <button
                key={idx}
                className={`${styles.tab} ${activeTab === idx ? styles.tabActive : ''} ${isQuestionValid(idx) ? styles.tabDone : ''}`}
                onClick={() => setActiveTab(idx)}
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
              <span className={styles.hint}>{isMulti ? '可多选' : '单选'}</span>
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
                      <div className={styles.optLabel}>{opt.label}</div>
                      <div className={styles.optDesc}>{opt.description}</div>
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
              onClick={() => setActiveTab((p) => p - 1)}
            >
              ← 上一题
            </button>
            <span className={styles.tabNavCount}>{activeTab + 1} / {questions.length}</span>
            <button
              className={styles.tabNavBtn}
              disabled={activeTab === questions.length - 1}
              onClick={() => setActiveTab((p) => p + 1)}
            >
              下一题 →
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}

