import { useEffect, useRef, useState } from 'react'
import styles from './IframeArtifact.module.css'

// iframe 内联 CSP：内容来自模型，允许加载外部资源（YouTube、GSAP 等）是为了可用性；
// 真正的隔离靠 `<iframe sandbox="allow-scripts">` 的不透明源，见下方 sandbox 属性。
const IFRAME_CSP =
  "default-src *; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'; img-src * data: blob: lumii-local:; font-src * data:; media-src * data: blob: lumii-local:; frame-src *; connect-src * ws: wss:;"

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
          // 只给 allow-scripts，**不给 allow-same-origin**：`srcDoc` 本会继承父文档
          // origin，两者同开等于没有沙箱——模型生成的 HTML 能读 `parent.localStorage`
          // 并调用 `parent.electronAPI`。去掉后文档变成不透明源，跨帧访问被拒。
          // 代价：产物里不能用 localStorage/cookie，也不能直接读父页（本来也不该）。
          sandbox="allow-scripts"
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
