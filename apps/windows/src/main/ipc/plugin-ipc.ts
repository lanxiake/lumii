import { ipcMain } from 'electron'
import { join, dirname } from 'path'
import { promises as fs, existsSync, readdirSync } from 'fs'
import os from 'os'
import { resolveClientStateDir } from '../paths'

interface PluginIpcLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

const logger: PluginIpcLogger = {
  info: (...args) => console.log('[Main]', ...args),
  warn: (...args) => console.warn('[Main]', ...args),
  error: (...args) => console.error('[Main]', ...args),
}

export function getSoulFilePath(): string {
  return join(resolveClientStateDir(), 'data', 'soul.md')
}

/**
 * 读取本地 SOUL 文件；不存在时返回 undefined。
 */
export async function readSoulFile(): Promise<{ content: string; updatedAt: string } | undefined> {
  try {
    const p = getSoulFilePath()
    if (!existsSync(p)) return undefined
    const content = await fs.readFile(p, 'utf-8')
    const stat = await fs.stat(p)
    return { content, updatedAt: stat.mtime.toISOString() }
  } catch {
    return undefined
  }
}

/**
 * 写入本地 SOUL 文件，并在覆盖前备份旧内容。
 */
export async function writeSoulFile(content: string): Promise<{ updatedAt: string } | undefined> {
  try {
    const p = getSoulFilePath()
    await fs.mkdir(dirname(p), { recursive: true })
    if (existsSync(p)) {
      await fs.copyFile(p, `${p}.bak`)
    }
    await fs.writeFile(p, content, 'utf-8')
    const stat = await fs.stat(p)
    return { updatedAt: stat.mtime.toISOString() }
  } catch {
    return undefined
  }
}

function getUserMemoryFilePath(): string {
  return join(resolveClientStateDir(), 'data', 'user-memory.md')
}

export async function readUserMemoryFile(): Promise<{ content: string; updatedAt: string } | undefined> {
  try {
    const p = getUserMemoryFilePath()
    if (!existsSync(p)) return undefined
    const content = await fs.readFile(p, 'utf-8')
    const stat = await fs.stat(p)
    return { content, updatedAt: stat.mtime.toISOString() }
  } catch {
    return undefined
  }
}

export async function writeUserMemoryFile(content: string): Promise<{ updatedAt: string } | undefined> {
  try {
    const p = getUserMemoryFilePath()
    await fs.mkdir(dirname(p), { recursive: true })
    // 备份旧内容（Task 5 P0：整理失败时可回滚）。
    // P1-2 升级：从单层 `.bak` 改为**带时间戳的快照序列**——个人记忆每次整理都是
    // 一次全量重写，只留一层意味着连错两次就把原文彻底丢掉，而「整理吞内容」
    // 恰恰是这条路径最需要复盘的事故。
    if (existsSync(p)) {
      await fs.copyFile(p, `${p}.bak`)
      const snapshotDir = join(dirname(p), 'backups', 'user-memory')
      await fs.mkdir(snapshotDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await fs.copyFile(p, join(snapshotDir, `${stamp}.md`))
      await pruneUserMemorySnapshots(snapshotDir)
    }
    await fs.writeFile(p, content, 'utf-8')
    return { updatedAt: new Date().toISOString() }
  } catch {
    return undefined
  }
}

/** 快照保留期（份数）：够复盘最近几次整理，又不至于无限堆积 */
const USER_MEMORY_SNAPSHOT_KEEP = 30

/** 按文件名（时间戳）倒序保留最近 N 份，其余删除。失败不影响写入主流程。 */
async function pruneUserMemorySnapshots(dir: string): Promise<void> {
  try {
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md')).sort()
    for (const name of names.slice(0, Math.max(0, names.length - USER_MEMORY_SNAPSHOT_KEEP))) {
      await fs.rm(join(dir, name), { force: true })
    }
  } catch {
    // 清理失败不影响本次写入
  }
}

export function setupCloakBrowserIpcHandlers(): void {
  logger.info('设置 CloakBrowser IPC 处理器')

  // 持有当前安装任务的 AbortController，用于取消下载
  let installAbortController: AbortController | null = null

  ipcMain.handle('plugin:cloak-browser:status', async () => {
    try {
      const { exeFilename } = await import('../cloak-browser-downloader.js')
      const cloakDir = join(os.homedir(), '.cloakbrowser')
      if (!existsSync(cloakDir)) return { installed: false }
      const entries = readdirSync(cloakDir).filter((d) => d.startsWith('chromium-'))
      if (entries.length === 0) return { installed: false }
      entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      const latest = entries[0]
      const exePath = join(cloakDir, latest, exeFilename())
      if (!existsSync(exePath)) return { installed: false }
      const version = latest.replace('chromium-', '')
      return { installed: true, version, exePath }
    } catch {
      return { installed: false }
    }
  })

  ipcMain.handle('plugin:cloak-browser:install', async (_event) => {
    try {
      // 若已有安装任务在进行，先取消
      installAbortController?.abort()
      installAbortController = new AbortController()
      const { signal } = installAbortController

      const { ensureCloakBrowser } = await import('../cloak-browser-downloader.js')
      const result = await ensureCloakBrowser(
        (progress) => { _event.sender.send('cloak-browser-progress', progress) },
        signal,
      )
      installAbortController = null
      return { success: result !== null && result !== undefined && (result as string).length > 0 }
    } catch (err) {
      installAbortController = null
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[CloakBrowser] 安装失败:', message)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('plugin:cloak-browser:cancel', () => {
    if (installAbortController) {
      logger.info('[CloakBrowser] 收到取消指令')
      installAbortController.abort()
      installAbortController = null
    }
    return { success: true }
  })

  ipcMain.handle('plugin:cloak-browser:uninstall', async () => {
    try {
      const cloakDir = join(os.homedir(), '.cloakbrowser')
      if (existsSync(cloakDir)) {
        await fs.rm(cloakDir, { recursive: true, force: true })
        logger.info('[CloakBrowser] 已删除目录:', cloakDir)
      }
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[CloakBrowser] 卸载失败:', message)
      return { success: false, error: message }
    }
  })
}
