/**
 * ScreenRecordPanel — 轻量录屏面板（源选择 / 开停 / 成片）
 */
import React, { useEffect, useMemo, useState } from 'react'
import type { ScreenRecordSource } from '../../../shared/screen-record'
import styles from './ScreenRecord.module.css'

export interface ScreenRecordPanelProps {
  open: boolean
  onClose: () => void
  sources: ScreenRecordSource[]
  status: string
  elapsedMs: number
  includeMicDefault: boolean
  alwaysAllow: boolean
  enabled: boolean
  lastRecording: { path: string; durationMs: number; bytes: number } | null
  onRefreshSources: () => Promise<unknown>
  onStart: (p: { sourceId: string; includeMic: boolean }) => Promise<unknown>
  onStop: () => Promise<unknown>
  onAlwaysAllowChange: (v: boolean) => void
  onIncludeMicDefaultChange?: (v: boolean) => void
}

/** 格式化时长 MM:SS 或 H:MM:SS */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  return `${pad(m)}:${pad(s)}`
}

/** 路径中间省略 */
function ellipsizePath(p: string, max = 48): string {
  if (p.length <= max) return p
  const keep = Math.floor((max - 3) / 2)
  return `${p.slice(0, keep)}...${p.slice(-keep)}`
}

/**
 * 简易录屏面板 Popover。
 */
export const ScreenRecordPanel: React.FC<ScreenRecordPanelProps> = ({
  open,
  onClose,
  sources,
  status,
  elapsedMs,
  includeMicDefault,
  alwaysAllow,
  enabled,
  lastRecording,
  onRefreshSources,
  onStart,
  onStop,
  onAlwaysAllowChange,
}) => {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string>('')
  const [includeMic, setIncludeMic] = useState(includeMicDefault)
  const recording = status === 'recording'

  useEffect(() => {
    setIncludeMic(includeMicDefault)
  }, [includeMicDefault])

  useEffect(() => {
    if (open) void onRefreshSources()
  }, [open, onRefreshSources])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = sources.slice()
    list.sort((a, b) => Number(b.isLumii) - Number(a.isLumii))
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q))
    return list
  }, [sources, query])

  if (!open) return null

  return (
    <div className={styles.panelOverlay} role="dialog" aria-label="录屏面板">
      <div className={styles.panel}>
        <header className={styles.panelHeader}>
          <h3>录屏</h3>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        {!enabled && (
          <p className={styles.hintWarn}>录屏功能已关闭，请到设置启用。</p>
        )}

        <p className={styles.hint}>
          提示：录制单窗口时，请保持目标窗口可见，最小化可能导致黑屏
        </p>

        <label className={styles.field}>
          <span>搜索源</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="显示器或窗口名称"
            disabled={recording}
          />
        </label>

        <ul className={styles.sourceList}>
          {filtered.map((s) => (
            <li key={s.sourceId}>
              <button
                type="button"
                className={
                  selectedId === s.sourceId ? styles.sourceItemActive : styles.sourceItem
                }
                disabled={recording}
                onClick={() => setSelectedId(s.sourceId)}
              >
                <span className={styles.sourceType}>{s.type === 'screen' ? '屏' : '窗'}</span>
                <span className={styles.sourceName}>{s.name}</span>
                {s.isLumii && <span className={styles.badge}>本窗（免确认）</span>}
              </button>
            </li>
          ))}
          {filtered.length === 0 && <li className={styles.empty}>无匹配源</li>}
        </ul>

        <label className={styles.switchRow}>
          <input
            type="checkbox"
            checked={includeMic}
            disabled={recording}
            onChange={(e) => setIncludeMic(e.target.checked)}
          />
          <span>包含麦克风</span>
        </label>

        <label className={styles.switchRow}>
          <input
            type="checkbox"
            checked={alwaysAllow}
            onChange={(e) => onAlwaysAllowChange(e.target.checked)}
          />
          <span>始终允许录屏（AI 非自身源免确认）</span>
        </label>

        <div className={styles.actions}>
          {!recording ? (
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={!enabled || !selectedId}
              onClick={() => void onStart({ sourceId: selectedId, includeMic })}
            >
              开始录制
            </button>
          ) : (
            <button
              type="button"
              className={styles.dangerBtn}
              onClick={() => void onStop()}
            >
              停止 · {formatDuration(elapsedMs)}
            </button>
          )}
        </div>

        {lastRecording ? (
          <div className={styles.lastRec}>
            <div className={styles.lastRecPath} title={lastRecording.path}>
              {ellipsizePath(lastRecording.path)}
            </div>
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => {
                void window.electronAPI?.app?.showItemInFolder(lastRecording.path)
              }}
            >
              打开文件夹
            </button>
          </div>
        ) : (
          !recording && <p className={styles.empty}>尚未录制</p>
        )}
      </div>
    </div>
  )
}

export { formatDuration }
