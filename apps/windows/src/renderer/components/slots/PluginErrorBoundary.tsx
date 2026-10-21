import React from 'react'

/**
 * 插件条目的错误边界。
 *
 * 为什么要它：插件代码与宿主同上下文，**渲染期抛错会顺着 React 树冒到根**——
 * 实测（2026-10-21 探针）一个插件页里 `throw new Error(...)` 会让整个客户端变成
 * 全屏「页面加载失败」，连侧栏都没了，只能重启。
 *
 * 粒度要按**条目**而不是按应用：一个插件的卡片写坏了，其余界面照常，
 * 并且就地显示是谁坏了、坏在哪。事件处理器与异步错误不在边界的管辖范围内
 * （它们本来就不会击穿 React 树）。
 */

interface Props {
  /** 出错时展示的归属（插件 id 或内置条目 id） */
  label: string
  children: React.ReactNode
}

interface State {
  error: Error | null
}

export class PluginErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // console.error 才进主进程日志（console.warn 只进主日志，console.info 不落盘）
    console.error(`[plugin] ${this.props.label} 渲染失败`, error, info.componentStack)
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        role="alert"
        style={{
          padding: '10px 12px',
          margin: 8,
          border: '1px solid var(--color-error)',
          borderRadius: 'var(--radius-md, 8px)',
          color: 'var(--color-text-secondary)',
          fontSize: 'var(--font-size-xs)',
          background: 'var(--color-bg-secondary)',
        }}
      >
        <div style={{ color: 'var(--color-error)', fontWeight: 600 }}>插件 {this.props.label} 渲染失败</div>
        <div style={{ marginTop: 4, wordBreak: 'break-word' }}>{error.message}</div>
        {/* 点了就重试：改好插件文件后不必重启应用（热更新会重新注册） */}
        <button
          onClick={() => this.setState({ error: null })}
          style={{
            marginTop: 8,
            padding: '2px 10px',
            borderRadius: 6,
            border: '1px solid var(--color-border)',
            background: 'transparent',
            color: 'var(--color-text-primary)',
            cursor: 'pointer',
          }}
        >
          重试
        </button>
      </div>
    )
  }
}
