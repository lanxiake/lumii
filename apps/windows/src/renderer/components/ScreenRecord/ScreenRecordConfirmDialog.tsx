/**
 * ScreenRecordConfirmDialog — AI 触发录屏确认弹窗
 */
import React, { useEffect, useState } from 'react'
import { Button, Checkbox, Modal } from '../ui'
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
    <Modal
      open
      layer="elevated"
      width={400}
      maskClosable={false}
      showClose={false}
      title={`AI 请求录制「${payload.sourceName}」`}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={() => onRespond(false)}>
            拒绝
          </Button>
          <Button variant="primary" size="sm" onClick={() => onRespond(true, remember)}>
            允许录制
          </Button>
        </>
      }
    >
      <div className={styles.confirmBody}>
        <div className={styles.confirmMeta}>
          <span>{payload.sourceType === 'screen' ? '整屏' : '窗口'}</span>
          <span>·</span>
          <span className={styles.confirmCountdown}>{remain}s 后自动拒绝</span>
        </div>

        {payload.thumbnailDataUrl ? (
          <img className={styles.thumb} src={payload.thumbnailDataUrl} alt="源预览" />
        ) : (
          <div className={styles.thumbPlaceholder}>无预览图</div>
        )}

        <div className={styles.switchRow}>
          <Checkbox checked={remember} onChange={setRemember}>
            始终允许 Lumii Agent 录屏
          </Checkbox>
        </div>
      </div>
    </Modal>
  )
}
