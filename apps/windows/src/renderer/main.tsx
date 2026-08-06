/**
 * Renderer Main Entry - 渲染进程入口
 *
 * React 应用的入口点。
 * 根据 URL 查询参数 ?mode=pet 分流到宠物模式渲染或正常桌面 UI。
 *
 * 关键：宠物模式外壳（PetModeShell）链式依赖 pixi.js / live2d 等重模块，
 * 这些模块在被 import 时即执行顶层副作用。若在桌面模式也静态 import，
 * 任一顶层抛错会导致整个渲染进程挂载失败（全黑屏）。
 * 故按模式分别 lazy import，使桌面 UI 与宠物模式互不拖累。
 */

import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import './styles/global.css'

console.log('[Renderer] 渲染进程启动')

// 全局错误兜底：把渲染进程的未捕获错误写到 console（主进程通过 console-message 转写到文件日志）
window.addEventListener('error', (e) => {
  console.error('[Renderer] window.onerror:', e.message, e.error?.stack ?? '')
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[Renderer] unhandledrejection:', e.reason?.stack ?? e.reason)
})

// file:// URL 下 loadFile({ query }) 会把参数放在 search；hash router 场景也查 hash
const _searchParams = new URLSearchParams(window.location.search)
const _hashParams = new URLSearchParams(window.location.hash.replace(/^#\??/, ''))
const isPetMode = _searchParams.get('mode') === 'pet' || _hashParams.get('mode') === 'pet'
const isFilePreviewMode =
  _searchParams.get('mode') === 'file-preview' || _hashParams.get('mode') === 'file-preview'
console.log(
  '[Renderer] href=' +
    window.location.href +
    ' isPetMode=' +
    String(isPetMode) +
    ' isFilePreviewMode=' +
    String(isFilePreviewMode),
)
const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)

/** 顶层错误边界：渲染崩溃时显示错误信息而非纯黑屏，便于定位 */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Renderer] React 渲染崩溃:', error.message, error.stack, info.componentStack)
  }

  render() {
    if (this.state.error) {
      if (isPetMode) {
        // 宠物模式：透明窗口，用浮动卡片显示错误（叠在桌面上仍可见，便于定位打包问题）
        return (
          <div
            style={{
              position: 'fixed',
              bottom: 80,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(20,10,10,0.92)',
              color: '#ffbbbb',
              borderRadius: 10,
              padding: '12px 18px',
              maxWidth: 500,
              fontFamily: 'monospace',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
              pointerEvents: 'auto',
              zIndex: 9999,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4, color: '#ff6b6b' }}>
              PetMode 渲染崩溃
            </div>
            <div>{this.state.error.message}</div>
            <pre style={{ fontSize: 10, opacity: 0.7, marginTop: 6 }}>
              {this.state.error.stack?.slice(0, 400)}
            </pre>
          </div>
        )
      }
      return (
        <div
          style={{
            padding: 24,
            fontFamily: 'monospace',
            color: '#e0e0e0',
            background: '#1e1e1e',
            height: '100vh',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          <h2 style={{ color: '#ff6b6b' }}>界面加载失败</h2>
          <p>{this.state.error.message}</p>
          <pre style={{ fontSize: 12, opacity: 0.7 }}>{this.state.error.stack}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

if (isPetMode) {
  console.log('[Renderer] 宠物模式窗口启动')
  // 强制透明背景，覆盖 global.css 的 body background-color
  const styleEl = document.createElement('style')
  styleEl.textContent = 'html,body,#root{background:transparent!important;overflow:hidden!important}'
  document.head.appendChild(styleEl)
  const PetModeShell = React.lazy(() =>
    import('./pet/PetModeShell').then((m) => ({ default: m.PetModeShell })),
  )
  root.render(
    <React.StrictMode>
      <RootErrorBoundary>
        <Suspense fallback={null}>
          <PetModeShell />
        </Suspense>
      </RootErrorBoundary>
    </React.StrictMode>,
  )
} else if (isFilePreviewMode) {
  console.log('[Renderer] 文件预览独立窗口启动')
  const FilePreviewWindowApp = React.lazy(() =>
    import('./file-preview/FilePreviewWindowApp').then((m) => ({
      default: m.FilePreviewWindowApp,
    })),
  )
  root.render(
    <React.StrictMode>
      <RootErrorBoundary>
        <Suspense fallback={null}>
          <FilePreviewWindowApp />
        </Suspense>
      </RootErrorBoundary>
    </React.StrictMode>,
  )
} else {
  const App = React.lazy(() => import('./App'))
  root.render(
    <React.StrictMode>
      <RootErrorBoundary>
        <Suspense fallback={null}>
          <App />
        </Suspense>
      </RootErrorBoundary>
    </React.StrictMode>,
  )
}

console.log('[Renderer] React 应用已挂载')
