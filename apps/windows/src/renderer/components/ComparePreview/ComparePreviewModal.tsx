/**
 * ComparePreviewModal — 复刻对照：左源站 / 右本地产物。
 *
 * 两侧各自滚动、各自缩放。两棵 DOM 的滚动高度不同，同步滚动只会误导；
 * 「像不像」交给 Agent 判断（设计 §4.5），这里只负责把两边摆在一起。
 */
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react'
import styles from './ComparePreviewModal.module.css'

/** Electron webview 的非标准方法（jsdom 里没有，调用一律可选链） */
type WebviewElement = HTMLElement & {
  reload?: () => void
  setZoomFactor?: (factor: number) => void
}

type WebviewFailLoadEvent = Event & {
  readonly errorCode?: number
  readonly errorDescription?: string
}

const ZOOM_MIN = 0.5
const ZOOM_MAX = 2
const ZOOM_STEP = 0.1

interface ComparePaneProps {
  readonly title: string
  readonly url: string
}

const ComparePane: React.FC<ComparePaneProps> = ({ title, url }) => {
  const hostRef = useRef<HTMLDivElement>(null)
  const webviewRef = useRef<WebviewElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [loadError, setLoadError] = useState<string | null>(null)
  /**
   * `setZoomFactor` 在 `dom-ready` 之前调用会**同步抛错**：
   * "The WebView must be attached to the DOM and the dom-ready event emitted before this method
   * can be called."——挂载时会立刻跑一次 zoom effect，于是整张卡被错误边界打红（真机实测）。
   */
  const [domReady, setDomReady] = useState(false)

  useEffect(() => {
    setLoadError(null)
    setZoom(1)
    setDomReady(false)
  }, [url])

  /** webview 对百分比高度支持不稳定，把宿主像素尺寸写进去 */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const syncSize = (): void => {
      const webview = webviewRef.current ?? host.querySelector('webview')
      if (!webview) return
      const { clientWidth, clientHeight } = host
      if (clientWidth > 0) webview.style.width = `${clientWidth}px`
      if (clientHeight > 0) webview.style.height = `${clientHeight}px`
    }
    syncSize()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(syncSize)
    observer.observe(host)
    return () => observer.disconnect()
  }, [url, loadError])

  useEffect(() => {
    if (!domReady) return
    webviewRef.current?.setZoomFactor?.(zoom)
  }, [zoom, domReady])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return undefined
    const handleFailLoad = (event: Event): void => {
      const detail = event as WebviewFailLoadEvent
      // -3 = ERR_ABORTED：切换地址时取消上一次导航，不是真失败
      if (detail.errorCode === -3) return
      setLoadError(detail.errorDescription?.trim() || '页面无法加载')
    }
    const handleFinishLoad = (): void => setLoadError(null)
    const handleDomReady = (): void => setDomReady(true)
    webview.addEventListener('did-fail-load', handleFailLoad)
    webview.addEventListener('did-finish-load', handleFinishLoad)
    webview.addEventListener('dom-ready', handleDomReady)
    return () => {
      webview.removeEventListener('did-fail-load', handleFailLoad)
      webview.removeEventListener('did-finish-load', handleFinishLoad)
      webview.removeEventListener('dom-ready', handleDomReady)
    }
  }, [url])

  const canZoomOut = zoom > ZOOM_MIN + 0.001
  const canZoomIn = zoom < ZOOM_MAX - 0.001

  return (
    <section className={styles.pane} aria-label={title}>
      <header className={styles.paneHeader}>
        <span className={styles.paneTitle}>{title}</span>
        <span className={styles.paneUrl} title={url}>
          {url}
        </span>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`刷新${title}`}
          title="刷新"
          disabled={!domReady}
          onClick={() => webviewRef.current?.reload?.()}
        >
          <RotateCw size={14} />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`缩小${title}`}
          title="缩小"
          disabled={!canZoomOut}
          onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Number((z - ZOOM_STEP).toFixed(2))))}
        >
          <ZoomOut size={14} />
        </button>
        <button
          type="button"
          className={styles.zoomValue}
          title="重置缩放"
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`放大${title}`}
          title="放大"
          disabled={!canZoomIn}
          onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Number((z + ZOOM_STEP).toFixed(2))))}
        >
          <ZoomIn size={14} />
        </button>
      </header>
      <div ref={hostRef} className={styles.paneBody}>
        {loadError ? (
          <div className={styles.emptyState} role="alert">
            <p className={styles.emptyTitle}>{loadError}</p>
            <p className={styles.emptyHint}>{url}</p>
          </div>
        ) : (
          <webview
            ref={webviewRef as React.RefObject<never>}
            src={url}
            title={title}
            className={styles.webview}
            /**
             * **必须显式收紧**：不写 `webpreferences` 就继承主窗口（`sandbox:false`、
             * `nodeIntegration:false`、`contextIsolation:true`）。对照视图右栏加载的是
             * `file://` 下的复刻产物——那是**外部站点内容重建出来的页面**，跑在
             * 「能读整个磁盘」的 file: 源里。收紧成独立沙箱后，即使产物里有恶意脚本，
             * 也读不到本地文件。
             *
             * 左栏是 https 源站，同样受益（它本来就读不到本地，但统一沙箱更省心）。
             */
            webpreferences="sandbox=yes,nodeIntegration=no,contextIsolation=yes,webSecurity=yes,allowRunningInsecureContent=no"
          />
        )}
      </div>
    </section>
  )
}

export interface ComparePreviewModalProps {
  /** 源站地址（spec 的 provenance.target） */
  readonly sourceUrl: string
  /**
   * 本地静态导出地址（`lumii-local://local/<abs>/out/index.html`）。
   * 没有静态导出产物时传 null：右栏给说明，而不是白屏。
   */
  readonly localUrl: string | null
  readonly onClose: () => void
}

export const ComparePreviewModal: React.FC<ComparePreviewModalProps> = ({
  sourceUrl,
  localUrl,
  onClose,
}) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return createPortal(
    <div className={styles.overlay} role="presentation">
      <button type="button" className={styles.mask} aria-label="关闭复刻对照" onClick={onClose} />
      <div className={styles.dialog} role="dialog" aria-label="复刻对照" aria-modal="true">
        <header className={styles.dialogHeader}>
          <h2 className={styles.dialogTitle}>复刻对照</h2>
          <button type="button" className={styles.closeButton} aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className={styles.body}>
          <ComparePane title="源站" url={sourceUrl} />
          {localUrl ? (
            <ComparePane title="本地" url={localUrl} />
          ) : (
            <section className={styles.pane} aria-label="本地">
              <header className={styles.paneHeader}>
                <span className={styles.paneTitle}>本地</span>
              </header>
              <div className={styles.paneBody}>
                <div className={styles.emptyState}>
                  <p className={styles.emptyTitle}>没有静态导出产物</p>
                  <p className={styles.emptyHint}>
                    该产物未生成 out/index.html。在项目目录运行 npm run dev 后自行在浏览器查看。
                  </p>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
