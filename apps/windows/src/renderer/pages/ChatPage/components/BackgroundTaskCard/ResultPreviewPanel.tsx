/**
 * 后台任务结果预览。
 *
 * 媒体按产出 kind 就地预览（图片可放大、视频/音频用原生控件）。
 * 结果文本若是 JSON 对象或 Markdown 代码块，则折叠展示，不引入语法高亮依赖。
 */

import React, { useMemo, useState } from 'react'
import type { BackgroundTaskOutput } from '../../../../../shared/agent-runtime-events'
import { ImageLightbox } from '../../../../components/ImageLightbox'
import styles from './ResultPreviewPanel.module.css'

export interface ResultPreviewPanelProps {
  outputs?: readonly BackgroundTaskOutput[]
  result?: string
}

export interface CodeFence {
  readonly language: string
  readonly code: string
}

/** 从整段结果里识别单个 Markdown 代码块 */
export function detectCodeFence(text: string): CodeFence | null {
  const match = /^```([\w+-]*)\n([\s\S]*?)```$/.exec(text.trim())
  if (!match) return null
  return { language: match[1] || 'text', code: match[2] ?? '' }
}

/** 仅当结果是 JSON 对象或数组时返回解析值 */
export function tryParseJsonResult(text: string): unknown | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    const value: unknown = JSON.parse(trimmed)
    if (value !== null && typeof value === 'object') return value
  } catch {
    return null
  }
  return null
}

/** 触发浏览器下载。跨域地址可能忽略 download 文件名，仍会打开链接 */
export function downloadUrl(url: string, filename: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noreferrer'
  link.click()
}

/** 把文本写入剪贴板 */
export function copyText(text: string): void {
  if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text)
}

/** 图片预览：点击或「放大」打开灯箱 */
const ImagePreview: React.FC<{ output: BackgroundTaskOutput }> = ({ output }) => {
  const [open, setOpen] = useState(false)
  if (!output.url) return null
  return (
    <section className={styles.section}>
      <div className={styles.header}>图片预览</div>
      <button type="button" className={styles.imageButton} onClick={() => setOpen(true)}>
        <img src={output.url} alt={output.name} className={styles.image} />
      </button>
      <div className={styles.actions}>
        <button type="button" onClick={() => downloadUrl(output.url!, output.name)}>下载</button>
        <button type="button" onClick={() => setOpen(true)}>放大</button>
      </div>
      {open && <ImageLightbox src={output.url} alt={output.name} onClose={() => setOpen(false)} />}
    </section>
  )
}

/** 视频预览 */
const VideoPreview: React.FC<{ output: BackgroundTaskOutput }> = ({ output }) => {
  if (!output.url) return null
  return (
    <section className={styles.section}>
      <div className={styles.header}>视频预览</div>
      <video className={styles.video} controls width="100%" src={output.url}>
        浏览器不支持视频播放
      </video>
      <div className={styles.actions}>
        <button type="button" onClick={() => downloadUrl(output.url!, output.name)}>下载</button>
        <a href={output.url} target="_blank" rel="noreferrer">在新窗口打开</a>
      </div>
    </section>
  )
}

/** 音频预览 */
const AudioPreview: React.FC<{ output: BackgroundTaskOutput }> = ({ output }) => {
  if (!output.url) return null
  return (
    <section className={styles.section}>
      <div className={styles.header}>音频预览</div>
      <audio controls src={output.url} />
    </section>
  )
}

/** 代码块预览：等宽文本，带语言名和复制 */
const CodePreview: React.FC<{ fence: CodeFence }> = ({ fence }) => (
  <section className={styles.section}>
    <div className={styles.header}>代码 ({fence.language})</div>
    <pre className={styles.code}><code>{fence.code}</code></pre>
    <div className={styles.actions}>
      <button type="button" onClick={() => copyText(fence.code)}>复制代码</button>
    </div>
  </section>
)

/** JSON 预览：默认收起，摘要显示字段数 */
const JsonPreview: React.FC<{ data: object }> = ({ data }) => {
  const [expanded, setExpanded] = useState(false)
  const text = useMemo(() => JSON.stringify(data, null, 2), [data])
  const count = Array.isArray(data) ? data.length : Object.keys(data).length
  const unit = Array.isArray(data) ? '项' : '字段'
  return (
    <section className={styles.section}>
      <div className={styles.header}>JSON 数据</div>
      <button type="button" className={styles.summary} onClick={() => setExpanded((value) => !value)}>
        {expanded ? '收起' : '展开'} ({count} {unit})
      </button>
      {expanded && <pre className={styles.code}><code>{text}</code></pre>}
      <div className={styles.actions}>
        <button type="button" onClick={() => copyText(text)}>复制 JSON</button>
      </div>
    </section>
  )
}

/** 按产出类型和结果文本渲染就地预览。没有可预览内容时不占位 */
export const ResultPreviewPanel: React.FC<ResultPreviewPanelProps> = ({ outputs = [], result }) => {
  const fence = result ? detectCodeFence(result) : null
  const json = !fence && result ? tryParseJsonResult(result) : null
  const media = outputs.filter((output) => output.kind === 'image' || output.kind === 'video' || output.kind === 'audio')
  if (media.length === 0 && !fence && !json) return null

  return (
    <div className={styles.panel}>
      {outputs.map((output) => {
        if (output.kind === 'image') return <ImagePreview key={`${output.kind}:${output.path}`} output={output} />
        if (output.kind === 'video') return <VideoPreview key={`${output.kind}:${output.path}`} output={output} />
        if (output.kind === 'audio') return <AudioPreview key={`${output.kind}:${output.path}`} output={output} />
        return null
      })}
      {fence ? <CodePreview fence={fence} /> : null}
      {json !== null && typeof json === 'object' ? <JsonPreview data={json} /> : null}
    </div>
  )
}
