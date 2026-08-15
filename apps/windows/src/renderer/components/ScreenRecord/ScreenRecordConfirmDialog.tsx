/**
 * ScreenRecordConfirmDialog — AI 触发录屏确认弹窗
 */
import React, { useEffect, useState } from 'react'
import type { ScreenRecordConfirmPayload } from '../../hooks/useScreenRecord'
import styles from './ScreenRecord.module.css'

export interface ScreenRecordConfirmDialogProps {
  payload: ScreenRecordConfirmPayload | null
  onRespond: (allow: boolean, rememberAlwaysAllow?: boolean) => void
}

/**
 * AI 请求录屏确认：缩略图 + 倒计时 + 始终允许勾选。
 * 超时由主进程 Service 触发 confirmation_timeout，Dialog 仅展示倒计时。
 */
export const ScreenRecordConfirmDialog: React.FC<ScreenRecordConfirmDialogProps> = ({
  payload,
  onRespond,
}) => {
  const [remain, setRemain] = useState(0)
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    if (!payload) return
    setRemember(false)
    const tick = () => {
      const elapsed = Math.floor((Date.now() - payload.startedAt) / 1000)
      setRemain(Math.max(0, payload.timeoutSec - elapsed))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [payload])

  if (!payload) return null

  return (
    <div className={styles.confirmOverlay} role="alertdialog" aria-label="录屏确认">
      <div className={styles.confirmCard}>
        <h3>AI 请求录制「{payload.sourceName}」</h3>
        <p className={styles.confirmMeta}>
          {payload.sourceType === 'screen' ? '整屏' : '窗口'} · 剩余 {remain}s
        </p>
        {payload.thumbnailDataUrl ? (
          <img
            className={styles.thumb}
            src={payload.thumbnailDataUrl}
            alt="源预览"
            width={320}
            height={180}
          />
        ) : (
          <div className={styles.thumbPlaceholder} />
        )}
        <label className={styles.switchRow}>
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>始终允许 Lumii Agent 录屏（本次开始生效）</span>
        </label>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.dangerBtn}
            onClick={() => onRespond(false)}
          >
            拒绝
          </button>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => onRespond(true, remember)}
          >
            允许
          </button>
        </div>
      </div>
    </div>
  )
}
