import React, { useState, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import hljs from 'highlight.js'
import { ArtifactToolbar } from './ArtifactToolbar'
import { IframeArtifact } from './IframeArtifact'
import styles from './ArtifactBlock.module.css'

export interface ArtifactBlockProps {
  content: string
  language?: string
  title?: string
  /** 消息是否正在流式输出 — 流式时默认显示源码，结束后自动切到预览 */
  messageStreaming?: boolean
}

const PREVIEWABLE_LANGS = new Set(['html', 'javascript', 'js', 'svg'])

export function ArtifactBlock({ content, language = 'text', title, messageStreaming = false }: ArtifactBlockProps) {
  const isPreviewable = PREVIEWABLE_LANGS.has(language.toLowerCase())

  // 流式时默认显示源码，非流式且可预览时默认展示预览
  const [previewActive, setPreviewActive] = useState(isPreviewable && !messageStreaming)
  // 用户是否手动切换过预览状态（手动切换后不再自动切换）
  const [userToggled, setUserToggled] = useState(false)

  // 流式结束后自动切换到预览模式（仅当用户没手动切换过时）
  useEffect(() => {
    if (!messageStreaming && isPreviewable && !userToggled) {
      setPreviewActive(true)
    }
  }, [messageStreaming, isPreviewable, userToggled])
  const [fullscreen, setFullscreen] = useState(false)
  const [runKey, setRunKey] = useState(0)
  const [copied, setCopied] = useState(false)

  // 按 Escape 退出全屏弹窗
  useEffect(() => {
    if (!fullscreen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullscreen])

  // 源码高亮：使用 highlight.js 手动高亮
  const highlightedHtml = useMemo(() => {
    try {
      const lang = language.toLowerCase()
      if (hljs.getLanguage(lang)) {
        return hljs.highlight(content, { language: lang }).value
      }
      return hljs.highlightAuto(content).value
    } catch {
      return content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
  }, [content, language])

  function handleCopy() {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  function handleTogglePreview() {
    setUserToggled(true)
    setPreviewActive(prev => !prev)
  }

  function handleToggleFullscreen() {
    setFullscreen(prev => !prev)
  }

  function handleRerun() {
    setRunKey(prev => prev + 1)
  }

  const codeView = (
    <pre className={styles['code-block']}>
      {/* dangerouslySetInnerHTML: hljs 输出已对内容 HTML 转义，安全 */}
      <code
        className={`hljs language-${language.toLowerCase()}`}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
    </pre>
  )

  const previewView = isPreviewable ? (
    <IframeArtifact
      key={runKey}
      content={content}
      language={language}
      title={title}
      fullscreen={false}
    />
  ) : null

  // 全屏弹窗（Portal 到 document.body）
  const fullscreenModal = fullscreen
    ? createPortal(
        <div className={styles['fullscreen-overlay']} onClick={(e) => { if (e.target === e.currentTarget) setFullscreen(false) }}>
          <div className={styles['fullscreen-dialog']}>
            <div className={styles['floating-controls']}>
              <button
                className={styles['floating-btn']}
                onClick={() => setFullscreen(false)}
                title="缩小预览"
                aria-label="缩小预览"
              >
                缩小
              </button>
              <button
                className={`${styles['floating-btn']} ${styles['floating-btn-danger']}`}
                onClick={() => {
                  setFullscreen(false)
                  setPreviewActive(false)
                  setUserToggled(true)
                }}
                title="关闭预览"
                aria-label="关闭预览"
              >
                关闭
              </button>
            </div>
            <ArtifactToolbar
              language={language}
              onCopy={handleCopy}
              onTogglePreview={handleTogglePreview}
              onToggleFullscreen={handleToggleFullscreen}
              onRerun={handleRerun}
              previewActive={previewActive}
              fullscreen={true}
            />
            <div className={styles['fullscreen-content']}>
              {previewActive && isPreviewable ? (
                <IframeArtifact
                  key={`fullscreen-${runKey}`}
                  content={content}
                  language={language}
                  title={title}
                  fullscreen={true}
                />
              ) : (
                codeView
              )}
            </div>
          </div>
        </div>,
        document.body,
      )
    : null

  return (
    <>
      <div className={styles['artifact-block']}>
        <ArtifactToolbar
          language={language}
          onCopy={handleCopy}
          onTogglePreview={handleTogglePreview}
          onToggleFullscreen={handleToggleFullscreen}
          onRerun={handleRerun}
          previewActive={previewActive}
          fullscreen={false}
        />
        {copied && <div className={styles['copy-toast']}>已复制</div>}
        {previewActive && isPreviewable ? previewView : codeView}
      </div>
      {fullscreenModal}
    </>
  )
}
