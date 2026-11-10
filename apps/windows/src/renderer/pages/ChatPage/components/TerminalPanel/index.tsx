/**
 * 终端页（工作台单栏 tab）
 *
 * 一条 xterm + 主进程一条 PTY。
 *
 * 生命周期：页面挂载时新建；**切走 tab 不杀进程**（用户可能只是去看一眼
 * 别的东西，回来还在原地），页面真正卸载才结束。
 *
 * 挂载取消用**每次挂载自己的令牌**，不用共享 ref —— StrictMode 会「挂载① →
 * 卸载 → 挂载②」，共享标志会被②重置，于是①的 create 回来时被当成有效进程收下，
 * 泄漏一条 PTY（三次就撞上限）。令牌由闭包持有，卸载即作废，谁也改不了它。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { RotateCw, SquareTerminal } from 'lucide-react'
import styles from './TerminalPanel.module.css'

export interface TerminalPanelProps {
  /** 终端起始目录（工作区根）；没有就由 shell 自己定 */
  cwd?: string
}

/** 从主题的 CSS 变量取色，终端配色跟随四套主题而不是写死一套 */
function readTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const read = (name: string, fallback: string): string => {
    if (typeof window === 'undefined') return fallback
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  }
  return {
    background: read('--mt-surface-1', '#1b1b1f'),
    foreground: read('--mt-fg-1', '#e6e6ea'),
    cursor: read('--mt-accent-500', '#5aa9ff'),
    selectionBackground: read('--mt-surface-3', '#33333a'),
  }
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({ cwd }) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exited, setExited] = useState<number | null>(null)

  /**
   * 起一条终端并绑到当前挂载上。
   * @returns 取消函数：调用后这次挂载不再持有任何进程（已建好的会被杀掉）
   */
  const start = useCallback((): (() => void) => {
    const host = hostRef.current
    if (!host) return () => {}

    // 闭包内的一次性令牌：只有这次挂载能读到，卸载后立刻作废
    let cancelled = false
    let ownId: string | null = null

    const theme = readTheme()
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace',
      theme: { ...theme },
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    void window.electronAPI.terminal
      .create(cwd ?? '', { cols: term.cols, rows: term.rows })
      .then((session) => {
        // 创建期间被卸载（StrictMode 的第一次挂载就是这条路）：这条进程没人要了
        if (cancelled) {
          void window.electronAPI.terminal.kill(session.id)
          return
        }
        ownId = session.id
        idRef.current = session.id
        if (session.tail) term.write(session.tail)

        term.onData((data) => {
          if (ownId) void window.electronAPI.terminal.write(ownId, data)
        })
        term.onResize(({ cols, rows }) => {
          if (ownId) void window.electronAPI.terminal.resize(ownId, cols, rows)
        })
        term.focus()
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
      if (ownId) {
        if (idRef.current === ownId) idRef.current = null
        void window.electronAPI.terminal.kill(ownId)
        ownId = null
      }
    }
  }, [cwd])

  useEffect(() => {
    const cancel = start()
    return () => {
      cancel()
      termRef.current?.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [start])

  // 主进程推来的数据 / 退出事件
  useEffect(() => {
    const offData = window.electronAPI.terminal.onData(({ id, data }) => {
      if (id === idRef.current) termRef.current?.write(data)
    })
    const offExit = window.electronAPI.terminal.onExit(({ id, exitCode }) => {
      if (id === idRef.current) setExited(exitCode)
    })
    return () => {
      offData()
      offExit()
    }
  }, [])

  // 容器尺寸变化：xterm 的 fit 是手动的，不做 ResizeObserver 就永远是初始 80×24
  useEffect(() => {
    const host = hostRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // 容器尺寸为 0 时 fit 会抛；下一帧再试
      }
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  // 主题切换：只换配色，不动进程与输出
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => {
      const term = termRef.current
      if (!term) return
      const theme = readTheme()
      term.options.theme = { ...theme }
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    return () => observer.disconnect()
  }, [])

  const restart = useCallback(() => {
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
    idRef.current = null
    if (hostRef.current) hostRef.current.innerHTML = ''
    setError(null)
    setExited(null)
    const cancel = start()
    cancelRef.current = cancel
  }, [start])

  /** restart 建出来的那条由这里持有，卸载时统一取消 */
  const cancelRef = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      cancelRef.current?.()
      cancelRef.current = null
    },
    [],
  )

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <SquareTerminal size={13} strokeWidth={1.8} />
        <span className={styles.title}>{cwd || '默认目录'}</span>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={restart}
          title={exited === null ? '重启终端' : '新建一个终端'}
          aria-label={exited === null ? '重启终端' : '新建一个终端'}
        >
          <RotateCw size={13} strokeWidth={1.8} />
        </button>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {exited !== null && (
        <div className={styles.exited}>
          进程已退出（{exited}）。
          <button type="button" className={styles.exitedBtn} onClick={restart}>
            新建终端
          </button>
        </div>
      )}
      <div ref={hostRef} className={styles.screen} data-terminal-screen />
    </div>
  )
}
