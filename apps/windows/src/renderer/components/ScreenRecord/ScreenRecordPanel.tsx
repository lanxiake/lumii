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
  exportMp4Default: boolean
  alwaysAllow: boolean
  enabled: boolean
  lastRecording: { path: string; durationMs: number; bytes: number } | null
  onRefreshSources: () => Promise<unknown>
  onStart: (p: {
    sourceId: string
    includeMic: boolean
    includeSystemAudio: boolean
  }) => Promise<unknown>
  onStop: (p?: { exportMp4?: boolean }) => Promise<unknown>
  onPause: () => Promise<unknown>
  onResume: () => Promise<unknown>
  onAlwaysAllowChange: (v: boolean) => void
  onIncludeMicDefaultChange?: (v: boolean) => void
  /** 对最近成片做旁白（可选；未传则仅提示走 AI） */
  onNarrate?: (params: {
    path: string
    cues: Array<{ startMs: number; text: string }>
  }) => Promise<unknown>
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
  exportMp4Default,
  alwaysAllow,
  enabled,
  lastRecording,
  onRefreshSources,
  onStart,
  onStop,
  onPause,
  onResume,
  onAlwaysAllowChange,
  onNarrate,
}) => {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string>('')
  const [includeMic, setIncludeMic] = useState(includeMicDefault)
  const [includeSystemAudio, setIncludeSystemAudio] = useState(includeSystemAudioDefault)
  const [exportMp4, setExportMp4] = useState(exportMp4Default)
  const [narrateOpen, setNarrateOpen] = useState(false)
  const [narrateDraft, setNarrateDraft] = useState('0|开场介绍')
  const [narrateBusy, setNarrateBusy] = useState(false)
  const [narrateMsg, setNarrateMsg] = useState('')
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
    setExportMp4(exportMp4Default)
  }, [exportMp4Default])

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
            <div className={styles.switchRow}>
              <Checkbox checked={exportMp4} onChange={setExportMp4}>
                停止时导出 MP4
              </Checkbox>
            </div>
            <p className={styles.switchHint}>失败时保留 WebM；转码可能需要数秒</p>
            <div>
              <div className={styles.switchRow}>
                <Checkbox checked={alwaysAllow} onChange={onAlwaysAllowChange}>
                  始终允许录屏
                </Checkbox>
              </div>
              <p className={styles.switchHint}>开启后 AI 录制非本软件窗口时不再逐次确认</p>
            </div>
          </div>

          <p className={`${styles.hint} ${styles.hintWarn}`}>
            录制单窗口时请保持目标窗口可见且不要最小化；最小化或关闭目标窗口可能导致黑屏或中断（已录片段仍会保存）。
          </p>

          {narrateOpen && lastRecording && onNarrate && (
            <div className={styles.narrateBox}>
              <p className={styles.switchHint}>
                每行：`开始秒|旁白文本`（音色用语音设置；默认烧字幕）。复杂旁白请用 AI 工具
                screen_record_narrate。
              </p>
              <textarea
                className={styles.narrateTextarea}
                rows={4}
                value={narrateDraft}
                onChange={(e) => setNarrateDraft(e.target.value)}
                disabled={narrateBusy}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={narrateBusy}
                  onClick={() => {
                    const cues = narrateDraft
                      .split('\n')
                      .map((line) => line.trim())
                      .filter(Boolean)
                      .map((line) => {
                        const pipe = line.indexOf('|')
                        if (pipe < 0) return null
                        const sec = Number(line.slice(0, pipe).trim())
                        const text = line.slice(pipe + 1).trim()
                        if (!Number.isFinite(sec) || sec < 0 || !text) return null
                        return { startMs: Math.round(sec * 1000), text }
                      })
                      .filter((c): c is { startMs: number; text: string } => !!c)
                    if (cues.length === 0) {
                      setNarrateMsg('请按「秒|文本」填写至少一行')
                      return
                    }
                    setNarrateBusy(true)
                    setNarrateMsg('处理中…')
                    void onNarrate({ path: lastRecording.path, cues })
                      .then((raw) => {
                        const r = raw as { ok?: boolean; path?: string; error?: string; message?: string }
                        if (r?.ok && r.path) {
                          setNarrateMsg(`完成：${r.path}`)
                        } else {
                          setNarrateMsg(`失败：${r?.error ?? r?.message ?? 'unknown'}`)
                        }
                      })
                      .catch((e: unknown) => {
                        setNarrateMsg(e instanceof Error ? e.message : String(e))
                      })
                      .finally(() => setNarrateBusy(false))
                  }}
                >
                  {narrateBusy ? '处理中…' : '生成旁白成片'}
                </Button>
                {narrateMsg && <span className={styles.switchHint}>{narrateMsg}</span>}
              </div>
            </div>
          )}
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
              {onNarrate && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={active || narrateBusy}
                  onClick={() => setNarrateOpen((v) => !v)}
                >
                  旁白/字幕
                </Button>
              )}
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
              <Button
                variant="danger"
                size="sm"
                onClick={() => void onStop({ exportMp4 })}
              >
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
