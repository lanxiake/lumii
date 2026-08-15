/**
 * RecordingSubtitleEditor — 左视频 + 右字幕时间轴编辑
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Input } from '../ui'
import {
  SCREEN_RECORD_SUBTITLE_STYLE_DEFAULTS,
  SUBTITLE_ASS_PLAY_RES_Y,
  type ScreenRecordSubtitleCue,
  type ScreenRecordSubtitleStyle,
} from '../../../shared/screen-record'
import * as screenRecordApi from '../../services/screen-record-api'
import styles from './ScreenRecord.module.css'

export interface RecordingSubtitleEditorProps {
  videoPath: string
  onClose: () => void
  /** 可选：打开时预填导入文本（旁白初稿） */
  initialImportText?: string
  /** 成片路径因导出 MP4 等原因发生变化时通知外层刷新列表 */
  onPathChanged?: (nextPath: string) => void
}

type EditorCue = {
  id: string
  startMs: number
  endMs: number
  text: string
  audioFile?: string
}

/**
 * 计算 <video> 内实际画面区域（默认 object-fit: contain，会留黑边）。
 * 字幕叠加层必须贴着画面而不是元素边缘，否则黑边上会出现字幕。
 */
export function computeContainedVideoBox(
  elementWidth: number,
  elementHeight: number,
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number; offsetX: number; offsetY: number } {
  if (naturalWidth < 1 || naturalHeight < 1 || elementWidth < 1 || elementHeight < 1) {
    return { width: elementWidth, height: elementHeight, offsetX: 0, offsetY: 0 }
  }
  const scale = Math.min(elementWidth / naturalWidth, elementHeight / naturalHeight)
  const width = naturalWidth * scale
  const height = naturalHeight * scale
  return {
    width,
    height,
    offsetX: (elementWidth - width) / 2,
    offsetY: (elementHeight - height) / 2,
  }
}

/**
 * 把 ASS 字号换算为预览像素值。
 *
 * libass 渲染 SRT 时以 PlayResY=288 为基准并按视频高度等比放大，
 * 预览必须用同一比例，所见才等于烧录结果。
 */
export function computePreviewFontPx(fontSize: number, videoHeightPx: number): number {
  if (!Number.isFinite(videoHeightPx) || videoHeightPx <= 0) return fontSize
  return (fontSize * videoHeightPx) / SUBTITLE_ASS_PLAY_RES_Y
}

/**
 * 返回当前播放时间命中的字幕，用于编辑阶段的实时叠加预览。
 */
export function findActiveCue<T extends Pick<EditorCue, 'startMs' | 'endMs'>>(
  cues: T[],
  currentMs: number,
): T | undefined {
  return cues.find((cue) => currentMs >= cue.startMs && currentMs < cue.endMs)
}

/** 毫秒 → 秒字符串（输入框） */
function msToSecInput(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(ms % 1000 === 0 ? 0 : 2)
}

/** 新 cue id */
function newCueId(): string {
  return `cue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 解析「秒|文本」多行导入。
 */
export function parseImportLines(raw: string): Array<{ startMs: number; text: string }> {
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
 * 成片字幕编辑器（全屏 overlay）。
 */
export const RecordingSubtitleEditor: React.FC<RecordingSubtitleEditorProps> = ({
  videoPath,
  onClose,
  initialImportText,
  onPathChanged,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  // 烧录可能把 webm 换成 mp4，成片路径会变，后续操作都以它为准
  const [currentPath, setCurrentPath] = useState(videoPath)
  const [cues, setCues] = useState<EditorCue[]>([])
  const [baseline, setBaseline] = useState('')
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [currentMs, setCurrentMs] = useState(0)
  const [includeDub, setIncludeDub] = useState(true)
  const [importOpen, setImportOpen] = useState(Boolean(initialImportText))
  const [importDraft, setImportDraft] = useState(initialImportText ?? '0|开场介绍')
  // 预览始终用无字幕原片：成片已被就地烧录，直接播会与叠加层重影
  const [previewPath, setPreviewPath] = useState(videoPath)
  const [mediaVersion, setMediaVersion] = useState(0)
  const [hasOriginal, setHasOriginal] = useState(false)
  const [style, setStyle] = useState<ScreenRecordSubtitleStyle>(
    SCREEN_RECORD_SUBTITLE_STYLE_DEFAULTS,
  )
  const [videoBox, setVideoBox] = useState({ width: 0, height: 0, offsetX: 0, offsetY: 0 })

  /** 跟踪播放器内实际画面区域，供字幕叠加层等比换算 */
  const measureVideoBox = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    setVideoBox(
      computeContainedVideoBox(v.clientWidth, v.clientHeight, v.videoWidth, v.videoHeight),
    )
  }, [])

  const mediaUrl = useMemo(
    () => screenRecordApi.buildRecordingMediaUrl(previewPath, mediaVersion),
    [previewPath, mediaVersion],
  )

  useEffect(() => {
    const v = videoRef.current
    if (!v || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measureVideoBox)
    ro.observe(v)
    return () => ro.disconnect()
  }, [measureVideoBox, mediaUrl])

  const dirty = useMemo(
    () => JSON.stringify({ cues, style }) !== baseline,
    [cues, style, baseline],
  )

  /** 从 sidecar / srt 加载 */
  const reload = useCallback(async () => {
    setLoading(true)
    setMsg('')
    try {
      const r = await screenRecordApi.loadSubtitleProject(currentPath)
      if (!r.ok) {
        setMsg(`加载失败：${r.error}`)
        setCues([])
        setBaseline('')
        return
      }
      const next = r.cues.map((c) => ({
        id: c.id,
        startMs: c.startMs,
        endMs: c.endMs,
        text: c.text,
        audioFile: c.audioFile,
      }))
      const nextStyle = r.style ?? SCREEN_RECORD_SUBTITLE_STYLE_DEFAULTS
      setCues(next)
      setStyle(nextStyle)
      setBaseline(JSON.stringify({ cues: next, style: nextStyle }))
      setHasOriginal(Boolean(r.originalPath))
      setPreviewPath(r.originalPath ?? currentPath)
      setMediaVersion(Date.now())
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [currentPath])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** 转为 IPC cue */
  const toPayload = (): ScreenRecordSubtitleCue[] =>
    cues.map((c) => ({
      id: c.id,
      startMs: c.startMs,
      endMs: c.endMs,
      text: c.text,
      audioFile: c.audioFile,
    }))

  /** 保存字幕（不烧录） */
  const onSave = async () => {
    setBusy(true)
    setMsg('保存中…')
    try {
      const r = await screenRecordApi.saveSubtitleProject(currentPath, toPayload(), style)
      if (r.ok) {
        setBaseline(JSON.stringify({ cues, style }))
        setMsg(`已保存：${r.srtPath}`)
      } else {
        setMsg(`保存失败：${r.error}`)
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 烧录成片 */
  const onBurn = async () => {
    setBusy(true)
    setMsg('烧录中…')
    try {
      const r = await screenRecordApi.burnSubtitles({
        path: currentPath,
        cues: toPayload(),
        dub: includeDub,
        subtitleMode: 'burn',
        style,
      })
      if (r.ok) {
        setBaseline(JSON.stringify({ cues, style }))
        if (r.path !== currentPath) {
          setCurrentPath(r.path)
          onPathChanged?.(r.path)
        }
        const bits = [`已烧录并覆盖：${r.path}`]
        if (typeof r.ttsRegenerated === 'number') {
          bits.push(`TTS 重配 ${r.ttsRegenerated} / 复用 ${r.ttsReused ?? 0}`)
        }
        if (r.warning === 'subtitle_burn_failed') {
          bits.push('警告：字幕未写入画面（配音可能已生成），请检查样式后重试烧录')
        } else if (r.warning === 'mp4_failed') {
          bits.push('警告：MP4 导出失败，已保留 WebM')
        } else if (r.warning) {
          bits.push(`警告：${r.warning}`)
        }
        setMsg(bits.join(' · '))
        await reload()
      } else {
        setMsg(`烧录失败：${r.error}${r.message ? ` (${r.message})` : ''}`)
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 用备份原片覆盖成片，撤销此前的烧录 */
  const onRestore = async () => {
    setBusy(true)
    setMsg('还原中…')
    try {
      const r = await screenRecordApi.restoreOriginal(currentPath)
      if (r.ok) {
        if (r.path !== currentPath) {
          setCurrentPath(r.path)
          onPathChanged?.(r.path)
        }
        setMediaVersion(Date.now())
        setMsg(`已还原为无字幕原片：${r.path}`)
      } else {
        setMsg(`还原失败：${r.error}${r.message ? ` (${r.message})` : ''}`)
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 应用文本导入 */
  const applyImport = () => {
    const parsed = parseImportLines(importDraft)
    if (parsed.length === 0) {
      setMsg('请按「秒|文本」填写至少一行')
      return
    }
    const next = parsed.map((p, i) => {
      const startMs = p.startMs
      const endMs = i + 1 < parsed.length ? Math.max(startMs + 1, parsed[i + 1]!.startMs) : startMs + 2000
      return {
        id: newCueId(),
        startMs,
        endMs,
        text: p.text,
      }
    })
    setCues(next)
    setImportOpen(false)
    setMsg(`已导入 ${next.length} 条（未保存）`)
  }

  const activeCue = useMemo(() => findActiveCue(cues, currentMs), [cues, currentMs])

  return (
    <div
      className={styles.editorOverlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section className={styles.editor} role="dialog" aria-label="字幕编辑">
        <header className={styles.editorHeader}>
          <div className={styles.panelTitleWrap}>
            <h3 className={styles.panelTitle}>字幕编辑</h3>
            {dirty && <span className={styles.dirtyBadge}>未保存</span>}
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className={styles.editorBody}>
          <div className={styles.editorVideoCol}>
            <div className={styles.editorVideoStage}>
              <video
                key={mediaUrl}
                ref={videoRef}
                className={styles.editorVideo}
                src={mediaUrl}
                controls
                onLoadedMetadata={measureVideoBox}
                onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
              />
              {activeCue?.text && (
                <div
                  className={styles.editorSubtitlePreview}
                  aria-live="off"
                  style={{
                    left: videoBox.offsetX,
                    right: videoBox.offsetX,
                    bottom: videoBox.offsetY + videoBox.height * 0.04,
                    color: style.primaryColor,
                    fontSize: `${computePreviewFontPx(style.fontSize, videoBox.height)}px`,
                    WebkitTextStroke: style.outline > 0 ? `${style.outline}px #000` : undefined,
                  }}
                >
                  {activeCue.text}
                </div>
              )}
            </div>

            <div className={styles.styleBar}>
              <label className={styles.styleField}>
                <span>字号</span>
                <input
                  type="range"
                  min={10}
                  max={120}
                  step={1}
                  value={style.fontSize}
                  aria-label="字幕字号"
                  onChange={(e) =>
                    setStyle((prev) => ({ ...prev, fontSize: Number(e.target.value) }))
                  }
                />
                <span className={styles.styleValue}>{style.fontSize}</span>
              </label>
              <label className={styles.styleField}>
                <span>颜色</span>
                <input
                  type="color"
                  className={styles.styleColor}
                  value={style.primaryColor}
                  aria-label="字幕颜色"
                  onChange={(e) =>
                    setStyle((prev) => ({ ...prev, primaryColor: e.target.value.toUpperCase() }))
                  }
                />
              </label>
              <label className={styles.styleField}>
                <span>描边</span>
                <input
                  type="range"
                  min={0}
                  max={8}
                  step={1}
                  value={style.outline}
                  aria-label="字幕描边宽度"
                  onChange={(e) =>
                    setStyle((prev) => ({ ...prev, outline: Number(e.target.value) }))
                  }
                />
                <span className={styles.styleValue}>{style.outline}</span>
              </label>
            </div>

            {hasOriginal && (
              <div className={styles.editorPreviewActions}>
                <span className={styles.switchHint}>预览用无字幕原片叠加，效果与烧录一致</span>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onRestore()}>
                  还原成无字幕
                </Button>
              </div>
            )}
            <p className={styles.switchHint} title={currentPath}>
              {currentPath}
            </p>
          </div>

          <div className={styles.editorCueCol}>
            {loading ? (
              <p className={styles.empty}>加载字幕…</p>
            ) : (
              <ul className={styles.cueList}>
                {cues.map((c, idx) => (
                  <li
                    key={c.id}
                    className={`${styles.cueItem} ${activeCue?.id === c.id ? styles.cueItemActive : ''}`}
                  >
                    <div className={styles.cueMeta}>
                      <button
                        type="button"
                        className={styles.cueJump}
                        onClick={() => {
                          const v = videoRef.current
                          if (v) {
                            v.currentTime = c.startMs / 1000
                            void v.play()
                          }
                        }}
                      >
                        #{idx + 1}
                      </button>
                      <Input
                        className={styles.cueTime}
                        value={msToSecInput(c.startMs)}
                        aria-label="开始秒"
                        onChange={(e) => {
                          const sec = Number(e.target.value)
                          if (!Number.isFinite(sec) || sec < 0) return
                          setCues((prev) =>
                            prev.map((x) =>
                              x.id === c.id ? { ...x, startMs: Math.round(sec * 1000) } : x,
                            ),
                          )
                        }}
                      />
                      <span className={styles.cueDash}>–</span>
                      <Input
                        className={styles.cueTime}
                        value={msToSecInput(c.endMs)}
                        aria-label="结束秒"
                        onChange={(e) => {
                          const sec = Number(e.target.value)
                          if (!Number.isFinite(sec) || sec < 0) return
                          setCues((prev) =>
                            prev.map((x) =>
                              x.id === c.id ? { ...x, endMs: Math.round(sec * 1000) } : x,
                            ),
                          )
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setCues((prev) => prev.filter((x) => x.id !== c.id))}
                      >
                        删除
                      </Button>
                    </div>
                    <textarea
                      className={styles.cueText}
                      rows={2}
                      value={c.text}
                      onChange={(e) => {
                        const text = e.target.value
                        setCues((prev) =>
                          prev.map((x) => (x.id === c.id ? { ...x, text } : x)),
                        )
                      }}
                    />
                  </li>
                ))}
                {cues.length === 0 && (
                  <li className={styles.empty}>暂无字幕，可导入「秒|文本」或点下方添加</li>
                )}
              </ul>
            )}

            {importOpen && (
              <div className={styles.narrateBox}>
                <p className={styles.switchHint}>每行：`开始秒|旁白文本`</p>
                <textarea
                  className={styles.narrateTextarea}
                  rows={4}
                  value={importDraft}
                  onChange={(e) => setImportDraft(e.target.value)}
                />
                <Button variant="secondary" size="sm" onClick={applyImport}>
                  应用到列表
                </Button>
              </div>
            )}
          </div>
        </div>

        <footer className={styles.editorFooter}>
          <div className={styles.editorFooterLeft}>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                setCues((prev) => [
                  ...prev,
                  {
                    id: newCueId(),
                    startMs: Math.round(currentMs),
                    endMs: Math.round(currentMs) + 2000,
                    text: '',
                  },
                ])
              }
            >
              添加字幕
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setImportOpen((v) => !v)}>
              从文本导入
            </Button>
            <Checkbox checked={includeDub} onChange={setIncludeDub}>
              烧录时含配音
            </Checkbox>
          </div>
          <div className={styles.editorFooterRight}>
            {msg && <span className={styles.switchHint}>{msg}</span>}
            <Button variant="secondary" size="sm" disabled={busy || loading} onClick={() => void onSave()}>
              保存字幕
            </Button>
            <Button variant="primary" size="sm" disabled={busy || loading || cues.length === 0} onClick={() => void onBurn()}>
              {busy ? '处理中…' : '烧录成片'}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  )
}
