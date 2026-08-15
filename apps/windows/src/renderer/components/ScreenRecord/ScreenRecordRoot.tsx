/**
 * ScreenRecordRoot — 全局挂载面板/确认弹窗/顶栏按钮状态
 */
import React, { useCallback, useEffect } from 'react'
import { useSettings } from '../../hooks/business/useSettings/useSettings'
import { useScreenRecordContext } from './ScreenRecordContext'
import { ScreenRecordPanel, formatDuration } from './ScreenRecordPanel'
import { ScreenRecordConfirmDialog } from './ScreenRecordConfirmDialog'
import styles from './ScreenRecord.module.css'

export interface ScreenRecordTitleControlProps {
  className?: string
}

/**
 * 顶栏录屏按钮（REC 红点 + 计时）。
 */
export const ScreenRecordTitleControl: React.FC<ScreenRecordTitleControlProps> = () => {
  const { status, elapsedMs, panelOpen, setPanelOpen, stop } = useScreenRecordContext()
  const { settings } = useSettings()
  const enabled = settings.screenRecord?.enabled !== false
  const recording = status === 'recording'

  return (
    <button
      type="button"
      className={`${styles.titleBtn} ${recording ? styles.titleBtnRec : ''}`}
      title={
        !enabled
          ? '录屏功能已关闭，请到设置启用'
          : recording
            ? '停止录制'
            : '开始录屏'
      }
      disabled={!enabled && !recording}
      onClick={() => {
        if (recording) {
          if (window.confirm('停止当前录制？')) void stop()
          return
        }
        setPanelOpen(!panelOpen)
      }}
    >
      {recording ? (
        <>
          <span className={styles.recDot} />
          <span className={styles.recTimer}>REC {formatDuration(elapsedMs)}</span>
        </>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M23 7l-7 5 7 5V7z" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      )}
    </button>
  )
}

/**
 * 全局录屏 UI：面板 + 确认弹窗 + alwaysAllow 持久化监听。
 */
export const ScreenRecordRoot: React.FC = () => {
  const {
    status,
    elapsedMs,
    sources,
    lastRecording,
    panelOpen,
    setPanelOpen,
    pendingConfirm,
    refreshSources,
    start,
    stop,
    respondConfirm,
  } = useScreenRecordContext()
  const { settings, updateSettings } = useSettings()

  const screenRecord = settings.screenRecord ?? {
    enabled: true,
    alwaysAllow: false,
    includeMicDefault: true,
    confirmTimeoutSec: 120,
  }

  useEffect(() => {
    const unsub = window.electronAPI?.screenRecord?.onEvent((raw) => {
      const e = raw as { type?: string; value?: boolean }
      if (e.type === 'screen-record:persist-always-allow') {
        updateSettings({
          screenRecord: { ...screenRecord, alwaysAllow: Boolean(e.value) },
        })
        void saveSettings()
      }
    })
    return () => {
      unsub?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onAlwaysAllowChange = useCallback(
    (v: boolean) => {
      const next = {
        ...settings,
        screenRecord: { ...screenRecord, alwaysAllow: v },
      }
      updateSettings({ screenRecord: next.screenRecord })
      try {
        localStorage.setItem('mtbot-assistant-settings', JSON.stringify(next))
        window.dispatchEvent(new CustomEvent('mtbot-settings-update', { detail: next }))
      } catch {
        // ignore
      }
    },
    [settings, screenRecord, updateSettings],
  )

  return (
    <>
      <ScreenRecordPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        sources={sources}
        status={status}
        elapsedMs={elapsedMs}
        includeMicDefault={screenRecord.includeMicDefault}
        alwaysAllow={screenRecord.alwaysAllow}
        enabled={screenRecord.enabled}
        lastRecording={lastRecording}
        onRefreshSources={refreshSources}
        onStart={async (p) => {
          await start(p)
        }}
        onStop={async () => {
          await stop()
        }}
        onAlwaysAllowChange={onAlwaysAllowChange}
      />
      <ScreenRecordConfirmDialog payload={pendingConfirm} onRespond={respondConfirm} />
    </>
  )
}
