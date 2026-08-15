/**
 * ScreenRecordPanel — 轻量录屏面板（源选择 / 开停 / 成片）
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Input } from '../ui'
import type { ScreenRecordSource } from '../../../shared/screen-record'
import styles from './ScreenRecord.module.css'

export interface ScreenRecordPanelProps {
  open: boolean
  onClose: () => void
  sources: ScreenRecordSource[]
  status: string
  elapsedMs: number
  includeMicDefault: boolean
  includeSystemAudioDefault: boolean
  alwaysAllow: boolean
  enabled: boolean
  lastRecording: { path: string; durationMs: number; bytes: number } | null
  onRefreshSources: () => Promise<unknown>
  onStart: (p: {
    sourceId: string
    includeMic: boolean
    includeSystemAudio: boolean
  }) => Promise<unknown>
  onStop: () => Promise<unknown>
  onPause: () => Promise<unknown>
  onResume: () => Promise<unknown>
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
  includeSystemAudioDefault,
  alwaysAllow,
  enabled,
  lastRecording,
  onRefreshSources,
  onStart,
  onStop,
  onPause,
  onResume,
  onAlwaysAllowChange,
}) => {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string>('')
  const [includeMic, setIncludeMic] = useState(includeMicDefault)
  const [includeSystemAudio, setIncludeSystemAudio] = useState(includeSystemAudioDefault)
  const recording = status === 'recording'
  const paused = status === 'paused'
  const active = recording || paused

  useEffect(() => {
    setIncludeMic(includeMicDefault)
  }, [includeMicDefault])

  useEffect(() => {
    setIncludeSystemAudio(includeSystemAudioDefault)
  }, [includeSystemAudioDefault])

  useEffect(() => {
    if (open) void onRefreshSources()
  }, [open, onRefreshSources])

  // Esc 关闭：与 Modal 行为保持一致
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = sources.slice()
    list.sort((a, b) => Number(b.isLumii) - Number(a.isLumii))
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q))
    return list
  }, [sources, query])

  if (!open) return null

  return (
    <div
      className={styles.panelOverlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section className={styles.panel} role="dialog" aria-label="录屏">
        <header className={styles.panelHeader}>
          <div className={styles.panelTitleWrap}>
            <h3 className={styles.panelTitle}>录屏</h3>
            {recording ? (
              <span className={styles.recBadge}>
                <span className={styles.recDot} />
                {formatDuration(elapsedMs)}
              </span>
            ) : paused ? (
              <span className={styles.recBadge}>暂停 {formatDuration(elapsedMs)}</span>
            ) : null}
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className={styles.panelBody}>
          {!enabled && (
            <p className={styles.hintWarn}>录屏功能已关闭，请到「设置 → 隐私与数据 → 录屏」启用。</p>
          )}

          <div>
            <span className={styles.sectionLabel}>录制源</span>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索显示器或窗口名称"
              disabled={active}
              aria-label="搜索录制源"
            />
          </div>

          <ul className={styles.sourceList}>
            {filtered.map((s) => (
              <li key={s.sourceId}>
                <button
                  type="button"
                  className={`${styles.sourceItem} ${
                    selectedId === s.sourceId ? styles.sourceItemActive : ''
                  }`}
                  disabled={active}
                  onClick={() => setSelectedId(s.sourceId)}
                >
                  <span className={styles.sourceType}>{s.type === 'screen' ? '屏' : '窗'}</span>
                  <span className={styles.sourceName}>{s.name}</span>
                  {s.isLumii && <span className={styles.badge}>本窗 · 免确认</span>}
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className={styles.empty}>{query ? '无匹配的源' : '暂无可录制的源'}</li>
            )}
          </ul>

          <div className={styles.switchRows}>
            <div className={styles.switchRow}>
              <Checkbox checked={includeMic} disabled={active} onChange={setIncludeMic}>
                包含麦克风
              </Checkbox>
            </div>
            <div className={styles.switchRow}>
              <Checkbox
                checked={includeSystemAudio}
                disabled={active}
                onChange={setIncludeSystemAudio}
              >
                包含系统声音
              </Checkbox>
            </div>
            <p className={styles.switchHint}>
              系统声在整屏录制时较可靠；单窗口可能无音轨（会自动降级）
            </p>
            <div>
              <div className={styles.switchRow}>
                <Checkbox checked={alwaysAllow} onChange={onAlwaysAllowChange}>
                  始终允许录屏
                </Checkbox>
              </div>
              <p className={styles.switchHint}>开启后 AI 录制非本软件窗口时不再逐次确认</p>
            </div>
          </div>

          <p className={styles.hint}>录制单窗口时请保持目标窗口可见，最小化可能导致黑屏。</p>
        </div>

        <footer className={styles.panelFooter}>
          {lastRecording ? (
            <div className={styles.lastRec}>
              <span className={styles.lastRecPath} title={lastRecording.path}>
                {ellipsizePath(lastRecording.path, 28)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void window.electronAPI?.app?.showItemInFolder(lastRecording.path)
                }}
              >
                打开文件夹
              </Button>
            </div>
          ) : (
            <span className={styles.footerSpacer} />
          )}

          {!active ? (
            <Button
              variant="primary"
              size="sm"
              disabled={!enabled || !selectedId}
              onClick={() =>
                void onStart({
                  sourceId: selectedId,
                  includeMic,
                  includeSystemAudio,
                })
              }
            >
              开始录制
            </Button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              {recording ? (
                <Button variant="secondary" size="sm" onClick={() => void onPause()}>
                  暂停
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => void onResume()}>
                  继续
                </Button>
              )}
              <Button variant="danger" size="sm" onClick={() => void onStop()}>
                停止 · {formatDuration(elapsedMs)}
              </Button>
            </div>
          )}
        </footer>
      </section>
    </div>
  )
}

export { formatDuration }
