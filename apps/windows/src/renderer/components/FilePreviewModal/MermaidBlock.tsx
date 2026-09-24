/**
 * MermaidBlock — 将 Mermaid 源码渲染为 SVG（文件预览 Markdown 用）
 *
 * 动态 import mermaid，避免拖慢首屏；失败时回退源码与错误信息。
 */

import React, { useEffect, useId, useState } from 'react'
import styles from './MermaidBlock.module.css'

export interface MermaidBlockProps {
  /** Mermaid 源码（不含围栏） */
  source: string
  /** 跟随文件预览的明暗色 */
  colorMode: 'light' | 'dark'
}

/** 渲染单个 Mermaid 图；源码或主题变化时重新渲染 */
export const MermaidBlock: React.FC<MermaidBlockProps> = ({ source, colorMode }) => {
  const reactId = useId().replace(/:/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const renderId = `mermaid-${reactId}-${Math.random().toString(36).slice(2, 9)}`

    /** 按需加载 mermaid 并渲染当前源码 */
    async function renderDiagram(): Promise<void> {
      setLoading(true)
      setError(null)
      setSvg(null)
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: colorMode === 'dark' ? 'dark' : 'default',
          fontFamily: 'inherit',
        })
        const { svg: nextSvg } = await mermaid.render(renderId, source)
        if (!cancelled) {
          setSvg(nextSvg)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Mermaid 渲染失败'
          setError(message)
          setSvg(null)
          setLoading(false)
        }
      }
    }

    void renderDiagram()
    return () => {
      cancelled = true
    }
  }, [source, colorMode, reactId])

  if (loading) {
    return (
      <div className={styles.wrap} data-testid="mermaid-diagram" aria-busy="true">
        <span className={styles.loading}>正在渲染流程图…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className={styles.wrap} data-testid="mermaid-diagram">
        <div className={styles.error} role="alert">
          Mermaid 渲染失败：{error}
        </div>
        <pre className={styles.fallback}>
          <code>{source}</code>
        </pre>
      </div>
    )
  }

  return (
    <div
      className={styles.wrap}
      data-testid="mermaid-diagram"
      // mermaid 输出为受信 SVG（securityLevel=strict）
      dangerouslySetInnerHTML={{ __html: svg ?? '' }}
    />
  )
}

MermaidBlock.displayName = 'MermaidBlock'
