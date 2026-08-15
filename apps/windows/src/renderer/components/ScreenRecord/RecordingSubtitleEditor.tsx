/**
 * RecordingSubtitleEditor — 左视频 + 右字幕时间轴编辑
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Input } from '../ui'
import type { ScreenRecordSubtitleCue } from '../../../shared/screen-record'
import * as screenRecordApi from '../../services/screen-record-api'
import styles from './ScreenRecord.module.css'

export interface RecordingSubtitleEditorProps {
  videoPath: string
  onClose: () => void
  /** 可选：打开时预填导入文本（旁白初稿） */
  initialImportText?: string
}

type EditorCue = {
  id: string
  startMs: number
  endMs: number
  text: string
  audioFile?: string
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
}) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [cues, setCues] = useState<EditorCue[]>([])
  const [baseline, setBaseline] = useState('')
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [currentMs, setCurrentMs] = useState(0)
  const [includeDub, setIncludeDub] = useState(true)
  const [importOpen, setImportOpen] = useState(Boolean(initialImportText))
  const [importDraft, setImportDraft] = useState(initialImportText ?? '0|开场介绍')

  const mediaUrl = useMemo(() => screenRecordApi.buildRecordingMediaUrl(videoPath), [videoPath])
  const dirty = useMemo(() => JSON.stringify(cues) !== baseline, [cues, baseline])

  /** 从 sidecar / srt 加载 */
  const reload = useCallback(async () => {
    setLoading(true)
    setMsg('')
    try {
      const r = await screenRecordApi.loadSubtitleProject(videoPath)
      if (!r.ok) {
        setMsg(`加载失败：${r.error}`)
        setCues([])
        setBaseline('[]')
        return
      }
      const next = r.cues.map((c) => ({
        id: c.id,
        startMs: c.startMs,
        endMs: c.endMs,
        text: c.text,
        audioFile: c.audioFile,
      }))
      setCues(next)
      setBaseline(JSON.stringify(next))
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [videoPath])

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
      const r = await screenRecordApi.saveSubtitleProject(videoPath, toPayload())
      if (r.ok) {
        setBaseline(JSON.stringify(cues))
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
        path: videoPath,
        cues: toPayload(),
        dub: includeDub,
        subtitleMode: 'burn',
      })
      if (r.ok) {
        setBaseline(JSON.stringify(cues))
        const bits = [`完成：${r.path}`]
        if (typeof r.ttsRegenerated === 'number') {
          bits.push(`TTS 重配 ${r.ttsRegenerated} / 复用 ${r.ttsReused ?? 0}`)
        }
        if (r.warning) bits.push(`警告：${r.warning}`)
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

  const activeCueId = useMemo(() => {
    const hit = cues.find((c) => currentMs >= c.startMs && currentMs < c.endMs)
    return hit?.id
  }, [cues, currentMs])

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
            <video
              ref={videoRef}
              className={styles.editorVideo}
              src={mediaUrl}
              controls
              onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
            />
            <p className={styles.switchHint} title={videoPath}>
              {videoPath}
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
                    className={`${styles.cueItem} ${activeCueId === c.id ? styles.cueItemActive : ''}`}
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
