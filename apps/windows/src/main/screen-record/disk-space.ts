/**
 * Windows 卷可用磁盘空间查询（录屏 start 预检）
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { platform } from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

/** 解析盘符字母（Windows）；非 Windows 返回 null */
export function extractDriveLetter(dirPath: string): string | null {
  const resolved = path.resolve(dirPath)
  const m = /^([A-Za-z]):/.exec(resolved)
  return m ? m[1]!.toUpperCase() : null
}

/**
 * 查询目录所在卷的剩余字节数。
 * Windows 优先 PowerShell Get-PSDrive；失败时宽松放行 10GB（不阻塞 MVP）。
 */
export async function getFreeDiskBytes(dirPath: string): Promise<number> {
  const FALLBACK_BYTES = 10 * 1024 * 1024 * 1024

  if (platform() === 'win32') {
    const letter = extractDriveLetter(dirPath)
    if (!letter) return FALLBACK_BYTES
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-PSDrive -Name '${letter}').Free`,
        ],
        { timeout: 8000, windowsHide: true },
      )
      const n = Number(String(stdout).trim())
      if (Number.isFinite(n) && n >= 0) return n
    } catch {
      // fall through
    }
    return FALLBACK_BYTES
  }

  // 非 Windows：尝试 Node fs.statfs（Node 19+）
  try {
    const fs = await import('node:fs/promises')
    const statfs = (fs as { statfs?: (p: string) => Promise<{ bavail: number; bsize: number }> })
      .statfs
    if (typeof statfs === 'function') {
      const st = await statfs(dirPath)
      return st.bavail * st.bsize
    }
  } catch {
    // ignore
  }
  return FALLBACK_BYTES
}
