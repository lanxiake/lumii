/**
 * Breeze 服务端口的探测与清理。
 *
 * 只清理 Python 进程：端口上如果是别的程序（用户自己的服务），杀掉它比报错更糟。
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'

export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE'))
    srv.once('listening', () => srv.close(() => resolve(false)))
    srv.listen(port, '127.0.0.1')
  })
}

/** 解析 `netstat -ano` 输出里监听指定端口的 PID */
export function parseNetstatListeners(out: string, port: number): number[] {
  const re = new RegExp(`[:.]${port}\\s`)
  return [
    ...new Set(
      out
        .split(/\r?\n/)
        .filter((l) => /LISTENING/i.test(l))
        .filter((l) => {
          const local = l.trim().split(/\s+/)[1] ?? ''
          return re.test(local + ' ')
        })
        .map((l) => Number(l.trim().split(/\s+/).pop()))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ]
}

function pidsOnPort(port: number): number[] {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
      return parseNetstatListeners(out, port)
    }
    return execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch {
    return []
  }
}

function processName(pid: number): string {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      return /^"([^"]+)"/.exec(out.trim())?.[1] ?? ''
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

export function killPid(pid: number): void {
  try {
    if (process.platform === 'win32') {
      // /T 连子进程一起结束；uvicorn 的 worker 线程挂在同一进程里，但保险起见带上
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    /* 已经退出 */
  }
}

/**
 * 释放被无响应进程占着的端口。只动 Python 进程，其余情况抛出可读的错误。
 * @returns 被清理掉的 PID
 */
export async function freePort(port: number): Promise<number[]> {
  if (!(await isPortInUse(port))) return []
  const pids = pidsOnPort(port)
  if (pids.length === 0) {
    throw new Error(`端口 ${port} 已被占用，但查不到占用它的进程。请在设置里给 Breeze 换一个端口`)
  }
  const foreign = pids
    .map((pid) => ({ pid, name: processName(pid) }))
    .filter((p) => !/python/i.test(p.name))
  if (foreign.length > 0) {
    const who = foreign.map((p) => `${p.name || '未知程序'}(PID ${p.pid})`).join('、')
    throw new Error(`端口 ${port} 被 ${who} 占用。请关闭该程序，或在设置里给 Breeze 换一个端口`)
  }
  pids.forEach(killPid)
  for (let i = 0; i < 20 && (await isPortInUse(port)); i++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  if (await isPortInUse(port)) {
    throw new Error(`端口 ${port} 仍被占用（PID ${pids.join(',')}），请手动结束该进程后重试`)
  }
  return pids
}
