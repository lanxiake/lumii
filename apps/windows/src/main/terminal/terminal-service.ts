/**
 * 本地终端（PTY）会话管理
 *
 * 一个会话一条 PTY，不做多标签：工作台是一列 480px 的窄栏，切标签的收益
 * 远小于多标签带来的生命周期问题（配额、重连、孤儿进程）。
 *
 * 进程归属渲染层的「终端页」：关掉工作台不杀（用户可能只是切去看对话），
 * 页面卸载 / 切换会话 / 应用退出时才结束。所以这里只负责 spawn/写/缩放/杀，
 * 不猜测谁在用它。
 */

import type { IPty } from '@lydell/node-pty'

/**
 * 原生模块按需加载：启动路径不该因为一个没开的终端去碰 .node。
 * 加载失败要说清楚（打包漏了二进制 / ABI 不符），而不是抛一个 require 栈。
 */
function loadNodePty(): typeof import('@lydell/node-pty') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@lydell/node-pty')
  } catch (error) {
    throw new Error(
      `本地终端不可用：加载 @lydell/node-pty 失败（${error instanceof Error ? error.message : String(error)}）`,
    )
  }
}

export interface TerminalSession {
  id: string
  pty: IPty
  /** 最近一次输出的尾部（重连时先回放，避免新面板一片空白） */
  tail: string
  exited: boolean
  exitCode?: number
}

/** 输出回放上限：超过就丢最旧的（终端本来也是可见区，不需要全量） */
const TAIL_LIMIT = 64 * 1024
/** 同时活着的终端上限：单栏工作台，超过基本就是泄漏 */
const MAX_SESSIONS = 3

const sessions = new Map<string, TerminalSession>()
let seq = 0

/** 平台默认 shell：Windows 先 pwsh 再 powershell 再 cmd，其余用 $SHELL 兜到 sh */
export function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/sh'
}

/**
 * 创建一条 PTY。
 * @param cwd - 工作目录；不存在时由调用方兜底（这里不猜）
 */
export function createTerminal(
  cwd: string,
  onData: (id: string, data: string) => void,
  onExit: (id: string, exitCode: number) => void,
): TerminalSession {
  // 已退出的终端不占名额：用户看到的是「进程已退出」，再开一个不该被拒
  for (const [id, session] of sessions) {
    if (session.exited) sessions.delete(id)
  }
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`终端数量已达上限（${MAX_SESSIONS}），请先关闭不用的终端`)
  }
  const pty = loadNodePty()

  const id = `term-${++seq}`
  const child = pty.spawn(defaultShell(), [], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd,
    env: process.env as Record<string, string>,
  })

  const session: TerminalSession = { id, pty: child, tail: '', exited: false }
  sessions.set(id, session)

  child.onData((data) => {
    session.tail = (session.tail + data).slice(-TAIL_LIMIT)
    onData(id, data)
  })
  child.onExit(({ exitCode }) => {
    session.exited = true
    session.exitCode = exitCode
    onExit(id, exitCode)
  })

  return session
}

export function writeTerminal(id: string, data: string): boolean {
  const session = sessions.get(id)
  if (!session || session.exited) return false
  session.pty.write(data)
  return true
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const session = sessions.get(id)
  if (!session || session.exited) return false
  // PTY 拒绝非法维度会抛；夹到至少 1 列 1 行
  session.pty.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)))
  return true
}

export function killTerminal(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  if (session.exited) return
  try {
    session.pty.kill()
  } catch {
    // 已经退出的进程 kill 会抛，忽略
  }
}

/** 重连时先回放尾部（新面板挂载时用） */
export function readTerminalTail(id: string): string {
  return sessions.get(id)?.tail ?? ''
}

/** 应用退出：把所有 PTY 收干净，避免留下孤儿 shell */
export function killAllTerminals(): void {
  for (const id of [...sessions.keys()]) killTerminal(id)
}
