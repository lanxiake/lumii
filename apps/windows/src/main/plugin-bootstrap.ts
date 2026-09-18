/**
 * 启动时后台预安装插件依赖：反检测浏览器（国内 GitHub 镜像）。
 *
 * MemPalace 曾在此预安装（Python 包 + 嵌入式运行时，~300MB）。2026-09-18 记忆宫殿
 * 换成本地 SQLite 自研实现后，这条预下载不再需要——数据在应用自己的库里，
 * 没有运行时、没有远端下载。
 */

import { createLogger } from './logger'
import { isCloakBrowserBootstrapEnabled } from './plugin-bootstrap-config'

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
 * 应用启动时触发插件依赖后台预安装（不 await，避免阻塞主流程）。
 */
export function initPluginDependenciesOnStartup(): void {
  void prefetchCloakBrowserOnInit()
}
