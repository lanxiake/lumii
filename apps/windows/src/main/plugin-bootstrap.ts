/**
 * 启动时后台预安装插件依赖：反检测浏览器（国内 GitHub 镜像）、MemPalace（清华 PyPI 镜像）。
 */

import { createLogger } from './logger'
import {
  isCloakBrowserBootstrapEnabled,
  isMemPalaceBootstrapEnabled,
} from './plugin-bootstrap-config'
import {
  checkMemPalaceInstalled,
  ensureMemPalacePalaceDir,
  ensureMemPalaceRuntime,
} from './ipc/plugin-ipc'

const log = createLogger('PluginBootstrap')

/**
 * 后台预下载 CloakBrowser（已安装则跳过；失败仅打日志不阻塞启动）。
 */
export async function prefetchCloakBrowserOnInit(): Promise<void> {
  if (!isCloakBrowserBootstrapEnabled()) return
  try {
    const { ensureCloakBrowser } = await import('./cloak-browser-downloader.js')
    const exePath = await ensureCloakBrowser()
    if (exePath) {
      log.info('[init] CloakBrowser 预下载/安装完成')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`[init] CloakBrowser 预下载失败（可在插件中心手动安装）：${message}`)
  }
}

/**
 * 后台预安装 MemPalace Python 包与运行时（已安装则跳过；失败仅打日志不阻塞启动）。
 */
export async function prefetchMemPalaceOnInit(): Promise<void> {
  if (!isMemPalaceBootstrapEnabled()) return
  try {
    if (await checkMemPalaceInstalled()) return
    await ensureMemPalaceRuntime((msg) => log.info(msg))
    await ensureMemPalacePalaceDir()
    log.info('[init] MemPalace 预安装完成')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`[init] MemPalace 预安装失败（可在记忆页手动安装）：${message}`)
  }
}

/**
 * 应用启动时触发插件依赖后台预安装（不 await，避免阻塞主流程）。
 */
export function initPluginDependenciesOnStartup(): void {
  void prefetchMemPalaceOnInit()
  void prefetchCloakBrowserOnInit()
}
