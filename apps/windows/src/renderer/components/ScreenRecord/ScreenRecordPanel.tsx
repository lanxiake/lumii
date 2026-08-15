/**
 * ScreenRecordPanel — 录制 / 成片双 Tab 面板
 *
 * 录制页只保留「选源 + 开录」主链路，细项收进可折叠的录制选项；
 * 成片页承载浏览、预览、字幕编辑、旁白、文件操作等后处理功能。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Input } from '../ui'
import { ConfirmModal } from '../ui/Modal/ConfirmModal'
import type { ScreenRecordSource, ScreenRecordRecordingItem } from '../../../shared/screen-record'
import * as screenRecordApi from '../../services/screen-record-api'
import { RecordingSubtitleEditor } from './RecordingSubtitleEditor'
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
  /** 目标窗口最小化/遮挡，画面已冻结 */
  targetHidden?: boolean
  /** 录制完成后需要在成片库定位的路径 */
  focusRecordingPath?: string | null
  /** 定位完成回调（清除一次性焦点） */
  onFocusConsumed?: () => void
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
  /** 对指定成片做旁白（可选；未传则隐藏入口） */
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

/** 格式化字节 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** 相对时间：刚刚 / N 分钟前 / 具体时间 */
function formatMtime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}

/** 解析「秒|文本」多行旁白草稿 */
function parseNarrateDraft(raw: string): Array<{ startMs: number; text: string }> {
  return raw
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
}

/**
 * 录屏面板 Popover（录制 / 成片）。
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
  targetHidden = false,
  focusRecordingPath = null,
  onFocusConsumed,
  onRefreshSources,
  onStart,
  onStop,
  onPause,
  onResume,
  onAlwaysAllowChange,
  onNarrate,
}) => {
  const [tab, setTab] = useState<'record' | 'library'>('record')
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | 'screen' | 'window'>('all')
  const [selectedId, setSelectedId] = useState<string>('')
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [includeMic, setIncludeMic] = useState(includeMicDefault)
  const [includeSystemAudio, setIncludeSystemAudio] = useState(includeSystemAudioDefault)
  const [exportMp4, setExportMp4] = useState(exportMp4Default)

  const [recordings, setRecordings] = useState<ScreenRecordRecordingItem[]>([])
  const [libraryMsg, setLibraryMsg] = useState('')
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [narrateOpen, setNarrateOpen] = useState(false)
  const [narrateDraft, setNarrateDraft] = useState('0|开场介绍')
  const [narrateBusy, setNarrateBusy] = useState(false)
  const [narrateMsg, setNarrateMsg] = useState('')
  const [editorPath, setEditorPath] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ScreenRecordRecordingItem | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const selectedRef = useRef<HTMLLIElement>(null)

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
    if (open && tab === 'record') void onRefreshSources()
  }, [open, tab, onRefreshSources])

  /** 刷新成片库 */
  const refreshLibrary = useCallback(async () => {
    setLibraryLoading(true)
    setLibraryMsg('')
    try {
      const r = await screenRecordApi.listRecordings()
      if (r.ok) setRecordings(r.items)
      else setLibraryMsg(`列表加载失败：${r.error}`)
    } catch (e) {
      setLibraryMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLibraryLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open && tab === 'library') void refreshLibrary()
  }, [open, tab, refreshLibrary])

  // 录制完成：自动切到成片页并选中最新文件
  useEffect(() => {
    if (!open || !focusRecordingPath) return
    setTab('library')
    setSelectedPath(focusRecordingPath)
    setNarrateOpen(false)
    setNarrateMsg('')
    void refreshLibrary()
    onFocusConsumed?.()
  }, [open, focusRecordingPath, refreshLibrary, onFocusConsumed])

  useEffect(() => {
    if (tab === 'library' && selectedPath) {
      selectedRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [tab, selectedPath, recordings])

  // Esc 关闭：编辑器打开时交由编辑器处理
  useEffect(() => {
    if (!open || editorPath) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose, editorPath])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = sources.slice()
    if (typeFilter !== 'all') list = list.filter((s) => s.type === typeFilter)
    list.sort((a, b) => Number(b.isLumii) - Number(a.isLumii))
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q))
    return list
  }, [sources, query, typeFilter])

  const selectedRecording = useMemo(
    () => recordings.find((r) => r.path === selectedPath) ?? null,
    [recordings, selectedPath],
  )

  if (!open) return null

  /** 成片操作：打开所在目录 */
  const revealPath = (p: string) => {
    void window.electronAPI?.app?.showItemInFolder(p)
  }

  /** 删除成片及其字幕工程附属文件，并刷新成片库。 */
  const confirmDeleteRecording = async () => {
    const target = deleteTarget
    if (!target || deleteBusy) return
    setDeleteBusy(true)
    setLibraryMsg('')
    try {
      const result = await screenRecordApi.deleteRecording(target.path)
      if (!result.ok) {
        setLibraryMsg(`删除失败：${result.error}${result.message ? ` (${result.message})` : ''}`)
        return
      }
      if (selectedPath === target.path) setSelectedPath(null)
      if (editorPath === target.path) setEditorPath(null)
      setNarrateOpen(false)
      setLibraryMsg(`已删除：${target.name}`)
      await refreshLibrary()
    } catch (e) {
      setLibraryMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleteBusy(false)
      setDeleteTarget(null)
    }
  }

  return (
    <>
      <div
        className={styles.panelOverlay}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && !editorPath) onClose()
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

          <div className={styles.tabs} role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'record'}
              className={`${styles.tab} ${tab === 'record' ? styles.tabActive : ''}`}
              onClick={() => setTab('record')}
            >
              录制
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'library'}
              className={`${styles.tab} ${tab === 'library' ? styles.tabActive : ''}`}
              onClick={() => setTab('library')}
            >
              成片{recordings.length > 0 ? ` · ${recordings.length}` : ''}
            </button>
          </div>

          {tab === 'record' ? (
            <>
              <div className={styles.panelBody}>
                {!enabled && (
                  <p className={styles.hintWarn}>
                    录屏功能已关闭，请到「设置 → 隐私与数据 → 录屏」启用。
                  </p>
                )}

                {active && targetHidden && (
                  <p className={styles.hintWarn}>
                    目标窗口已最小化或被隐藏，画面已冻结为最后一帧；恢复窗口后会自动继续录制。
                  </p>
                )}

                <div className={styles.sourceHead}>
                  <span className={styles.sectionLabel}>录制目标</span>
                  <div className={styles.filterChips}>
                    {(
                      [
                        ['all', '全部'],
                        ['screen', '屏幕'],
                        ['window', '窗口'],
                      ] as const
                    ).map(([v, label]) => (
                      <button
                        key={v}
                        type="button"
                        className={`${styles.chip} ${typeFilter === v ? styles.chipActive : ''}`}
                        disabled={active}
                        onClick={() => setTypeFilter(v)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索显示器或窗口名称"
                  disabled={active}
                  aria-label="搜索录制源"
                />

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

                <button
                  type="button"
                  className={styles.optionsToggle}
                  onClick={() => setOptionsOpen((v) => !v)}
                  aria-expanded={optionsOpen}
                >
                  <span>录制选项</span>
                  <span className={styles.optionsSummary}>
                    {[
                      includeMic ? '麦克风' : null,
                      includeSystemAudio ? '系统声' : null,
                      exportMp4 ? 'MP4' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '静音 · WebM'}
                    <span className={styles.optionsCaret}>{optionsOpen ? '▴' : '▾'}</span>
                  </span>
                </button>

                {optionsOpen && (
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
                        停止时导出 MP4（成功后删除 WebM）
                      </Checkbox>
                    </div>
                    <div className={styles.switchRow}>
                      <Checkbox checked={alwaysAllow} onChange={onAlwaysAllowChange}>
                        始终允许 AI 录屏
                      </Checkbox>
                    </div>
                    <p className={styles.switchHint}>开启后 AI 录制非本软件窗口时不再逐次确认</p>
                  </div>
                )}
              </div>

              <footer className={styles.panelFooter}>
                <span className={styles.footerHint}>
                  {active ? '录制中可暂停；成片会自动出现在「成片」页' : '窗口录制时请保持目标窗口不被关闭'}
                </span>
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
                    <Button variant="danger" size="sm" onClick={() => void onStop({ exportMp4 })}>
                      停止 · {formatDuration(elapsedMs)}
                    </Button>
                  </div>
                )}
              </footer>
            </>
          ) : (
            <>
              <div className={styles.panelBody}>
                <div className={styles.libraryToolbar}>
                  <span className={styles.sectionLabel}>成片库</span>
                  <div className={styles.libraryToolbarRight}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={libraryLoading}
                      onClick={() => void refreshLibrary()}
                    >
                      {libraryLoading ? '刷新中…' : '刷新'}
                    </Button>
                    {recordings[0] && (
                      <Button variant="ghost" size="sm" onClick={() => revealPath(recordings[0]!.path)}>
                        打开目录
                      </Button>
                    )}
                  </div>
                </div>
                {libraryMsg && <p className={styles.hintWarn}>{libraryMsg}</p>}

                <ul className={styles.libraryList}>
                  {recordings.map((item) => {
                    const isSelected = item.path === selectedPath
                    return (
                      <li key={item.path} ref={isSelected ? selectedRef : undefined}>
                        <button
                          type="button"
                          className={`${styles.libraryItem} ${isSelected ? styles.libraryItemActive : ''}`}
                          onClick={() => setSelectedPath(isSelected ? null : item.path)}
                        >
                          <span className={styles.libraryName} title={item.path}>
                            {item.name}
                          </span>
                          <span className={styles.libraryMeta}>
                            {formatMtime(item.mtimeMs)} · {formatBytes(item.bytes)}
                            {item.hasSrt ? ' · 含字幕' : ''}
                          </span>
                        </button>

                        {isSelected && (
                          <div className={styles.libraryActions}>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setEditorPath(item.path)}
                            >
                              预览 / 编辑字幕
                            </Button>
                            {onNarrate && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={narrateBusy}
                                onClick={() => setNarrateOpen((v) => !v)}
                              >
                                AI 旁白
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" onClick={() => revealPath(item.path)}>
                              打开文件夹
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={deleteBusy}
                              onClick={() => setDeleteTarget(item)}
                            >
                              删除
                            </Button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                  {!libraryLoading && recordings.length === 0 && (
                    <li className={styles.empty}>暂无成片，先去「录制」页录一段</li>
                  )}
                </ul>

                {narrateOpen && selectedRecording && onNarrate && (
                  <div className={styles.narrateBox}>
                    <p className={styles.switchHint}>
                      每行：`开始秒|旁白文本`。生成后可在编辑器中逐条修改，改动只会重配改过的那句。
                    </p>
                    <textarea
                      className={styles.narrateTextarea}
                      rows={4}
                      value={narrateDraft}
                      onChange={(e) => setNarrateDraft(e.target.value)}
                      disabled={narrateBusy}
                    />
                    <div className={styles.narrateActions}>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={narrateBusy}
                        onClick={() => {
                          const cues = parseNarrateDraft(narrateDraft)
                          if (cues.length === 0) {
                            setNarrateMsg('请按「秒|文本」填写至少一行')
                            return
                          }
                          setNarrateBusy(true)
                          setNarrateMsg('处理中…')
                          void onNarrate({ path: selectedRecording.path, cues })
                            .then((raw) => {
                              const r = raw as {
                                ok?: boolean
                                path?: string
                                error?: string
                                message?: string
                              }
                              if (r?.ok && r.path) {
                                setNarrateMsg('已生成旁白成片')
                                setEditorPath(selectedRecording.path)
                                void refreshLibrary()
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
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={narrateBusy}
                        onClick={() => setEditorPath(selectedRecording.path)}
                      >
                        直接编辑字幕
                      </Button>
                      {narrateMsg && <span className={styles.switchHint}>{narrateMsg}</span>}
                    </div>
                  </div>
                )}
              </div>

              <footer className={styles.panelFooter}>
                <span className={styles.footerHint}>
                  {lastRecording ? `最近成片 ${formatDuration(lastRecording.durationMs)}` : '成片保存在工作区 temp/recordings'}
                </span>
                <Button variant="secondary" size="sm" onClick={() => setTab('record')}>
                  去录制
                </Button>
              </footer>
            </>
          )}
        </section>
      </div>

      {editorPath && (
        <RecordingSubtitleEditor
          videoPath={editorPath}
          onPathChanged={(next) => {
            setEditorPath(next)
            void refreshLibrary()
          }}
          onClose={() => {
            setEditorPath(null)
            void refreshLibrary()
          }}
        />
      )}
      <ConfirmModal
        open={deleteTarget != null}
        title="删除成片"
        content={`确定删除「${deleteTarget?.name ?? ''}」吗？将同时删除同名附属目录（字幕工程、SRT、配音缓存与无字幕原片），此操作不可恢复。`}
        confirmText={deleteBusy ? '删除中…' : '删除'}
        cancelText="取消"
        confirmVariant="danger"
        layer="elevated"
        onConfirm={() => void confirmDeleteRecording()}
        onCancel={() => {
          if (!deleteBusy) setDeleteTarget(null)
        }}
      />
    </>
  )
}

export { formatDuration }
