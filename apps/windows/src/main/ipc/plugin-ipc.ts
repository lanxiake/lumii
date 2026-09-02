import { execFile as _execFile } from 'child_process'
import { promisify as _promisify } from 'util'
import { ipcMain } from 'electron'
import { join, dirname } from 'path'
import { promises as fs, existsSync, readdirSync } from 'fs'
import os from 'os'
import { MemPalaceMcpBridge } from '../mempalace-mcp-client'
import {
  ensureBundledPython,
  getBundledPythonExe,
  getPythonRuntimeDir,
  hasPackage as hasPythonPackage,
  BUNDLED_ONNXRUNTIME_SPEC,
  buildBundledPipInstallArgs,
  repairGoogleRpcNamespaceIfNeeded,
  repairOnnxRuntimeIfNeeded,
} from '../python-env'
import { resolveClientStateDir } from '../paths'

export interface PluginIpcLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

const logger: PluginIpcLogger = {
  info: (...args) => console.log('[Main]', ...args),
  warn: (...args) => console.warn('[Main]', ...args),
  error: (...args) => console.error('[Main]', ...args),
}

const _execFileAsync = _promisify(_execFile)

/**
 * MemPalace 复用公共内置 Python 运行时（见 python-env.ts）。
 * 运行时目录与旧版一致（~/.lumii/runtimes/python-embed），已装用户不必重下。
 */
export function getMemPalaceRuntimeDir(): string {
  return getPythonRuntimeDir()
}

export function getMemPalacePythonExe(): string {
  return getBundledPythonExe()
}

export function getMemPalacePalaceDir(): string {
  return join(resolveClientStateDir(), 'memory', 'palace')
}

/** 检测 site-packages 中是否已有 mempalace 包（快速路径） */
function hasMemPalacePackage(): boolean {
  return hasPythonPackage('mempalace')
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

export function getUserMemoryFilePath(): string {
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
    // 备份旧内容到 .bak（Task 5 P0：整理失败时可回滚）
    if (existsSync(p)) {
      await fs.copyFile(p, `${p}.bak`)
    }
    await fs.writeFile(p, content, 'utf-8')
    return { updatedAt: new Date().toISOString() }
  } catch {
    return undefined
  }
}

let _mempalaceBridge: MemPalaceMcpBridge | null = null
export function getMemPalaceBridge(): MemPalaceMcpBridge {
  if (!_mempalaceBridge) {
    _mempalaceBridge = new MemPalaceMcpBridge(getMemPalacePythonExe(), getMemPalacePalaceDir())
  }
  return _mempalaceBridge
}

export async function checkMemPalaceInstalled(): Promise<boolean> {
  const runtimeDir = getMemPalaceRuntimeDir()
  const pythonExe = getMemPalacePythonExe()
  if (!existsSync(pythonExe)) return false
  if (!hasMemPalacePackage()) return false
  try {
    await repairGoogleRpcNamespaceIfNeeded()
    await _execFileAsync(pythonExe, ['-c', 'import mempalace, chromadb'], {
      timeout: 30000,
      cwd: runtimeDir,
      env: { ...process.env, PYTHONHOME: runtimeDir },
    })
    return true
  } catch (err) {
    logger.warn('[MemPalace] import 验证失败:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * 确保宫殿数据目录存在。
 * 注意：仅建目录不够——空 chroma.sqlite3 缺 collection 时读路径会报 NotFound；
 * 集合引导由 MemPalaceMcpBridge 握手后的 mempalace_status 完成。
 */
export async function ensureMemPalacePalaceDir(): Promise<void> {
  const palaceDir = getMemPalacePalaceDir()
  if (!existsSync(palaceDir)) {
    await fs.mkdir(palaceDir, { recursive: true })
    logger.info('[MemPalace] 已创建 palace 目录:', palaceDir)
  }
}

/** MemPalace pip 安装后的 import 校验命令（与 IPC 安装、启动预安装共用） */
const MEMPALACE_VERIFY_SCRIPT =
  'from google.rpc.error_details_pb2 import RetryInfo; import mempalace, chromadb; print("ok")'

/**
 * 确保 MemPalace 运行时与 Python 包已就绪（内置 Python + 清华 PyPI 镜像装 mempalace）。
 * 已安装则快速返回；失败抛出异常供 IPC / 启动预安装捕获。
 */
export async function ensureMemPalaceRuntime(onProgress?: (msg: string) => void): Promise<void> {
  const report = onProgress ?? ((msg: string) => logger.info('[MemPalace]', msg))

  const pythonExe = await ensureBundledPython(report)
  if (await checkMemPalaceInstalled()) {
    await repairOnnxRuntimeIfNeeded()
    report('MemPalace 已安装')
    return
  }

  report('正在安装 mempalace...')
  await _execFileAsync(pythonExe, buildBundledPipInstallArgs(['mempalace', BUNDLED_ONNXRUNTIME_SPEC]), {
    timeout: 300000,
    windowsHide: true,
    cwd: getPythonRuntimeDir(),
    env: {
      ...process.env,
      PYTHONHOME: getPythonRuntimeDir(),
      PYTHONNOUSERSITE: '1',
    },
  })
  await repairGoogleRpcNamespaceIfNeeded()
  await repairOnnxRuntimeIfNeeded()

  report('正在验证安装...')
  await _execFileAsync(pythonExe, ['-c', MEMPALACE_VERIFY_SCRIPT], {
    timeout: 30000,
    cwd: getPythonRuntimeDir(),
    env: { ...process.env, PYTHONHOME: getPythonRuntimeDir(), PYTHONNOUSERSITE: '1' },
  })

  logger.info('[MemPalace] 安装完成')
}

export function setupMemPalaceIpcHandlers(): void {
  logger.info('设置 MemPalace IPC 处理器')

  ipcMain.handle('plugin:mempalace:status', async () => {
    const installed = await checkMemPalaceInstalled()
    return { installed, runtimeDir: getMemPalaceRuntimeDir() }
  })

  ipcMain.handle('plugin:mempalace:install', async (_event) => {
    const sendProgress = (msg: string) => {
      _event.sender.send('plugin:mempalace:install:progress', msg)
    }

    try {
      await ensureMemPalaceRuntime(sendProgress)
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[MemPalace] 安装失败:', message)
      return { success: false, error: message }
    }
  })

  // ---- 记忆可视化 IPC ----

  ipcMain.handle('plugin:mempalace:list', async (_event, params?: {
    wing?: string; room?: string; limit?: number; offset?: number
  }) => {
    if (!await checkMemPalaceInstalled()) return { error: 'not_installed' }
    try {
      await ensureMemPalacePalaceDir()
      const bridge = getMemPalaceBridge()
      return await bridge.listDrawers(params ?? {})
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[MemPalace] list 失败:', message)
      return { error: 'process_failed', message }
    }
  })

  ipcMain.handle('plugin:mempalace:search', async (_event, params: {
    query: string; limit?: number; wing?: string; room?: string
  }) => {
    if (!await checkMemPalaceInstalled()) return { error: 'not_installed' }
    try {
      const bridge = getMemPalaceBridge()
      const results = await bridge.searchDrawers(params)
      return { results }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[MemPalace] search 失败:', message)
      return { error: 'process_failed', message }
    }
  })

  ipcMain.handle('plugin:mempalace:delete', async (_event, drawerId: string) => {
    if (!await checkMemPalaceInstalled()) return { success: false, error: 'not_installed' }
    try {
      const bridge = getMemPalaceBridge()
      await bridge.deleteDrawer(drawerId)
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[MemPalace] delete 失败:', message)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('plugin:mempalace:clear', async (_event) => {
    if (!await checkMemPalaceInstalled()) return { success: false, error: 'not_installed' }
    try {
      const bridge = getMemPalaceBridge()
      let deleted = 0
      while (true) {
        const page = await bridge.listDrawers({ limit: 100, offset: 0 })
        if (!page.drawers || page.drawers.length === 0) break
        for (const drawer of page.drawers) {
          await bridge.deleteDrawer(drawer.drawer_id)
          deleted++
          if (deleted % 10 === 0) {
            _event.sender.send('plugin:mempalace:clear:progress', { deleted })
          }
        }
      }
      return { success: true, deleted }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[MemPalace] clear 失败:', message)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('plugin:mempalace:uninstall', async () => {
    try {
      // 先停止 MCP 进程
      if (_mempalaceBridge) {
        _mempalaceBridge.stop()
        _mempalaceBridge = null
      }
      const runtimeDir = getMemPalaceRuntimeDir()
      if (existsSync(runtimeDir)) {
        await fs.rm(runtimeDir, { recursive: true, force: true })
        logger.info('[MemPalace] 已删除运行时目录:', runtimeDir)
      }
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[MemPalace] 卸载失败:', message)
      return { success: false, error: message }
    }
  })
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
