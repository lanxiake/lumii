import React, { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import styles from './Modal.module.css'

export interface PromptInputModalProps {
  open: boolean
  title: string
  /** 输入框上方的说明文字 */
  description?: string
  /** 输入框占位符 */
  placeholder?: string
  /** 打开时的默认值 */
  defaultValue?: string
  confirmText?: string
  cancelText?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}

/**
 * 文本输入弹窗：替代 Electron 中不可用的 window.prompt()。
 */
export const PromptInputModal: React.FC<PromptInputModalProps> = ({
  open,
  title,
  description,
  placeholder,
  defaultValue = '',
  confirmText = '确定',
  cancelText = '取消',
  onConfirm,
  onCancel,
}) => {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue(defaultValue)
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
    }
  }, [open, defaultValue])

  if (!open) return null

  const trimmed = value.trim()
  const canSubmit = Boolean(trimmed)

  /**
   * 确认提交输入值。
   */
  const submit = () => {
    if (!canSubmit) return
    onConfirm(trimmed)
  }

  const footer = (
    <>
      <button type="button" className={styles['modal-btn-secondary']} onClick={onCancel}>
        {cancelText}
      </button>
      <button
        type="button"
        className={styles['modal-btn-primary']}
        onClick={submit}
        disabled={!canSubmit}
        style={{ opacity: canSubmit ? 1 : 0.5 }}
      >
        {confirmText}
      </button>
    </>
  )

  return (
    <Modal open={open} title={title} footer={footer} onClose={onCancel} maskClosable={false} width={360}>
      {description && (
        <div className={styles['modal-confirm-content']} style={{ marginBottom: 12 }}>
          {description}
        </div>
      )}
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onCancel()
        }}
        style={{
          width: '100%',
          padding: '8px 12px',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-bg-tertiary)',
          color: 'var(--color-text-primary)',
          fontSize: 'var(--font-size-sm)',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
    </Modal>
  )
}

export default PromptInputModal
