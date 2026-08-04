import React, { useEffect, useRef, useState } from 'react'
import styles from './IframeArtifact.module.css'

// iframe 内容 CSP 已禁用（主进程禁用 CSP，iframe 也无需限制）
// 允许加载外部资源以支持 YouTube 嵌入、GSAP 等功能
const IFRAME_CSP =
  "default-src *; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * data: blob:; frame-src *; connect-src * ws: wss:;"

export interface IframeArtifactProps {
  content: string
  language?: string
  title?: string
  /** 全屏模式：iframe 高度占满父容器 */
  fullscreen?: boolean
}

export function IframeArtifact({ content, language = 'html', title, fullscreen = false }: IframeArtifactProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [error, setError] = useState<string | null>(null)

  const srcDoc = buildSrcDoc(content, language)

  useEffect(() => {
    setError(null)
  }, [content])

  function handleError() {
    setError('Artifact 渲染失败')
  }

  return (
    <div className={`${styles['artifact-wrap']} ${fullscreen ? styles['artifact-wrap-fullscreen'] : ''}`}>
      {title && <div className={styles['artifact-title']}>{title}</div>}
      {error ? (
        <div className={styles['artifact-error']}>{error}</div>
      ) : (
        <iframe
          ref={iframeRef}
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-same-origin"
          className={`${styles['artifact-frame']} ${fullscreen ? styles['artifact-frame-fullscreen'] : ''}`}
          title={title ?? 'artifact'}
          onError={handleError}
        />
      )}
    </div>
  )
}

function injectCsp(html: string): string {
  const cspTag = `<meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}">`
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, `$1\n  ${cspTag}`)
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/(<html[^>]*>)/i, `$1\n<head>${cspTag}</head>`)
  }
  return `<!DOCTYPE html><html><head>${cspTag}</head><body>${html}</body></html>`
}

function buildSrcDoc(content: string, language: string): string {
  if (language === 'html') {
    return injectCsp(content)
  }
  if (language === 'svg') {
    return injectCsp(
      `<!DOCTYPE html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;">${content}</body></html>`
    )
  }
  if (language === 'javascript' || language === 'js') {
    return injectCsp(
      `<!DOCTYPE html><html><body><script>${content}<\/script></body></html>`
    )
  }
  const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return injectCsp(`<!DOCTYPE html><html><body><pre>${escaped}</pre></body></html>`)
}
