/**
 * ScreenRecordRoot — 全局挂载面板/确认弹窗/顶栏按钮状态
 */
import React, { useCallback, useEffect, useRef } from 'react'
import {
  SETTINGS_STORAGE_KEY,
  SETTINGS_UPDATE_EVENT,
  useSettings,
} from '../../hooks/business/useSettings'
import type { AppSettings } from '../../hooks/business/useSettings/useSettings.types'
import type { ScreenRecordEvent } from '../../../shared/screen-record'
import { useScreenRecordContext } from './ScreenRecordContext'
import { ScreenRecordPanel, formatDuration } from './ScreenRecordPanel'
import { ScreenRecordConfirmDialog } from './ScreenRecordConfirmDialog'
import * as screenRecordApi from '../../services/screen-record-api'
import styles from './ScreenRecord.module.css'

export interface ScreenRecordTitleControlProps {
  className?: string
}

/** 录屏设置缺省值，settings 尚未写入时兜底 */
const DEFAULT_SCREEN_RECORD = {
  enabled: true,
  alwaysAllow: false,
  includeMicDefault: true,
  includeSystemAudioDefault: true,
  exportMp4Default: false,
  narrateOriginalAudioGain: 0.35,
  confirmTimeoutSec: 120,
}

/**
 * 顶栏录屏按钮（未录制显示摄像图标，录制中显示红点 + 计时）。
 * 点击始终开合面板，停止录制在面板内完成，避免原生 confirm 打断。
 */
export const ScreenRecordTitleControl: React.FC<ScreenRecordTitleControlProps> = ({
  className = '',
}) => {
  const { status, elapsedMs, panelOpen, setPanelOpen } = useScreenRecordContext()
  const { settings } = useSettings()
  const enabled = settings.screenRecord?.enabled !== false
  const recording = status === 'recording'
  const paused = status === 'paused'
  const active = recording || paused

  const classNames = [
    styles.titleBtn,
    recording ? styles.titleBtnRec : '',
    paused ? styles.titleBtnActive : '',
    panelOpen && !active ? styles.titleBtnActive : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={classNames}
      title={
        !enabled
          ? '录屏功能已关闭，请到「设置 → 隐私与数据 → 录屏」启用'
          : recording
            ? `录制中 ${formatDuration(elapsedMs)}，点击打开面板`
            : paused
              ? `已暂停 ${formatDuration(elapsedMs)}，点击打开面板`
              : '录屏'
      }
      aria-label={active ? '打开录屏面板' : '打开录屏面板'}
      disabled={!enabled && !active}
      onClick={() => setPanelOpen(!panelOpen)}
    >
      {recording ? (
        <>
          <span className={styles.recDot} />
          <span className={styles.recTimer}>REC {formatDuration(elapsedMs)}</span>
        </>
      ) : paused ? (
        <span className={styles.recTimer}>暂停 {formatDuration(elapsedMs)}</span>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
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
    targetHidden,
    focusRecordingPath,
    clearFocusRecording,
    refreshSources,
    start,
    stop,
    pause,
    resume,
    respondConfirm,
  } = useScreenRecordContext()
  const { settings, updateSettings } = useSettings()

  const screenRecord = settings.screenRecord ?? DEFAULT_SCREEN_RECORD

  // 事件回调里要读最新 settings，用 ref 避免重复订阅 IPC
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  /**
   * 落盘录屏设置：useSettings.saveSettings 走的是闭包内的旧 settings，
   * 这里直接写 localStorage 并广播，保证「始终允许」立即生效且不丢其它设置。
   */
  const persistAlwaysAllow = useCallback(
    (v: boolean) => {
      const base = settingsRef.current
      const next: AppSettings = {
        ...base,
        screenRecord: { ...(base.screenRecord ?? DEFAULT_SCREEN_RECORD), alwaysAllow: v },
      }
      updateSettings({ screenRecord: next.screenRecord })
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next))
        window.dispatchEvent(new CustomEvent(SETTINGS_UPDATE_EVENT, { detail: next }))
      } catch {
        // localStorage 不可用时仅内存生效
      }
    },
    [updateSettings],
  )

  useEffect(() => {
    // 直接订阅 preload 事件而不复用 screen-record-api.onEvent：
    // 后者会驱动采集单例，重复订阅将导致 start-capture 被执行两次
    const unsub = window.electronAPI?.screenRecord?.onEvent((raw) => {
      const e = raw as ScreenRecordEvent
      if (e.type === 'screen-record:persist-always-allow') {
        persistAlwaysAllow(Boolean(e.value))
      }
    })
    return () => {
      unsub?.()
    }
  }, [persistAlwaysAllow])

  return (
    <>
      <ScreenRecordPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        sources={sources}
        status={status}
        elapsedMs={elapsedMs}
        includeMicDefault={screenRecord.includeMicDefault}
        includeSystemAudioDefault={screenRecord.includeSystemAudioDefault !== false}
        exportMp4Default={screenRecord.exportMp4Default === true}
        alwaysAllow={screenRecord.alwaysAllow}
        enabled={screenRecord.enabled}
        lastRecording={lastRecording}
        targetHidden={targetHidden}
        focusRecordingPath={focusRecordingPath}
        onFocusConsumed={clearFocusRecording}
        onRefreshSources={refreshSources}
        onStart={async (p) => {
          await start(p)
        }}
        onStop={async (p) => {
          await stop(p)
        }}
        onPause={async () => {
          await pause()
        }}
        onResume={async () => {
          await resume()
        }}
        onAlwaysAllowChange={persistAlwaysAllow}
        onNarrate={async (p) => {
          return screenRecordApi.narrate({
            path: p.path,
            cues: p.cues,
            writeSrt: true,
            dub: true,
            subtitleMode: 'burn',
          })
        }}
      />
      <ScreenRecordConfirmDialog payload={pendingConfirm} onRespond={respondConfirm} />
    </>
  )
}
