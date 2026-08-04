/**
 * BrowserService — Windows 客户端浏览器控制适配层
 *
 * 将 src/browser/ 的浏览器自动化能力嵌入到 Electron 主进程中，
 * 控制用户本机的 Chrome/Edge/Brave，而非网关服务器上的浏览器。
 *
 * 设计原则：
 * - 不依赖 loadConfig()（网关配置），直接构造 ResolvedBrowserConfig
 * - 使用 control-service.ts 的无 HTTP 服务器模式
 * - 通过 node.invoke.request 将浏览器操作暴露给网关 Agent
 */

// 浏览器控制服务默认端口（与网关浏览器控制端口区分）
const DEFAULT_BROWSER_CONTROL_PORT = 18790
// 默认 CDP 端口（Chrome 以 --remote-debugging-port 启动时使用）
const DEFAULT_CDP_PORT = 18791
// Chrome 扩展中继服务器端口（与 CDP 端口区分，避免冲突）
const DEFAULT_EXTENSION_RELAY_PORT = 18793
// 端口递增步长
const PORT_INCREMENT = 10
// 端口探测最大重试次数（超出后使用 startPort + maxRetries * PORT_INCREMENT）
const PORT_MAX_RETRIES = 3

const log = {
  info: (...args: unknown[]) => console.log('[BrowserService]', ...args),
  error: (...args: unknown[]) => console.error('[BrowserService]', ...args),
  warn: (...args: unknown[]) => console.warn('[BrowserService]', ...args),
}

// ============================================================================
// 类型定义（从 @mtbot/browser-control 包导入）
// ============================================================================

import type { BrowserServerState, BrowserRouteContext, ResolvedBrowserConfig } from '@mtbot/browser-control'

export type { BrowserRouteContext }

// ============================================================================
// 模块状态
// ============================================================================

let browserState: BrowserServerState | null = null
let browserContext: BrowserRouteContext | null = null

// ============================================================================
// 配置构造（绕过 loadConfig() 依赖）
// ============================================================================

/**
 * 构造 Windows 客户端专用的浏览器配置
 * 不读取网关配置文件，使用合理默认值
 */
function buildWindowsBrowserConfig(
  cdpPort = DEFAULT_CDP_PORT,
  extensionRelayPort = DEFAULT_EXTENSION_RELAY_PORT,
): ResolvedBrowserConfig {
  return {
    enabled: true,
    evaluateEnabled: false,
    controlPort: DEFAULT_BROWSER_CONTROL_PORT,
    cdpProtocol: 'http',
    cdpHost: '127.0.0.1',
    cdpIsLoopback: true,
    remoteCdpTimeoutMs: 1500,
    remoteCdpHandshakeTimeoutMs: 3000,
    color: '#4285F4',
    executablePath: undefined,
    headless: false,
    noSandbox: false,
    attachOnly: false,
    defaultProfile: 'mtbot',
    profiles: {
      mtbot: {
        cdpPort,
        color: '#4285F4',
      },
      chrome: {
        driver: 'extension',
        cdpUrl: `http://127.0.0.1:${extensionRelayPort}`,
        color: '#00AA00',
      },
    },
  }
}

// ============================================================================
// 服务生命周期
// ============================================================================

/**
 * 判断某个监听进程是否是可以安全 kill 的 Chrome 实例
 * 只要 commandLine 包含 --remote-debugging-port= 就认为是 Chrome 调试实例
 * （普通用户启动的 Chrome 不会带这个参数，除非他们自己加了）
 */
function isMtbotChrome(commandLine: string | undefined): boolean {
  if (!commandLine) return false
  return commandLine.toLowerCase().includes('--remote-debugging-port=')
}

/**
 * 启动前清理：仅 kill 确认是 mtbot 启动的 Chrome 残留进程
 * 不 kill 用户自己的 Chrome 或其他非 mtbot 进程
 */
async function killMtbotStaleBrowserProcess(port: number): Promise<boolean> {
  const { spawn } = await import('node:child_process')
  const { inspectPortUsage } = await import('./vendor/ports-inspect.js')

  try {
    const usage = await inspectPortUsage(port)
    if (usage.status !== 'busy') return false

    let killed = false
    for (const listener of usage.listeners ?? []) {
      if (!listener.pid || listener.pid <= 0) continue

      if (!isMtbotChrome(listener.commandLine)) {
        log.warn(`[killMtbotStaleBrowserProcess] 端口 ${port} 被非 mtbot 进程占用 pid=${listener.pid} cmd="${listener.commandLine ?? '?'}"，跳过 kill`)
        continue
      }

      log.warn(`[killMtbotStaleBrowserProcess] 发现 mtbot Chrome 残留 pid=${listener.pid} 占用端口 ${port}，正在 kill...`)
      spawn('taskkill', ['/F', '/T', '/PID', String(listener.pid)], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      })
      killed = true
    }

    if (killed) {
      await new Promise((r) => setTimeout(r, 600))
    }
    return killed
  } catch (err) {
    log.warn(`[killMtbotStaleBrowserProcess] 检查端口 ${port} 失败: ${String(err)}`)
    return false
  }
}

/**
 * 通用端口探测：从 startPort 开始，每次 +PORT_INCREMENT，最多 PORT_MAX_RETRIES 次
 * 找不到空闲端口时返回 startPort + PORT_MAX_RETRIES * PORT_INCREMENT
 */
async function findAvailablePort(startPort: number, label: string): Promise<number> {
  const { inspectPortUsage } = await import('./vendor/ports-inspect.js')

  for (let i = 0; i < PORT_MAX_RETRIES; i++) {
    const port = startPort + i * PORT_INCREMENT
    try {
      const usage = await inspectPortUsage(port)
      if (usage.status === 'free') {
        if (i > 0) log.info(`[findAvailablePort:${label}] 端口 ${port} 可用（跳过 ${i} 个被占用的端口）`)
        return port
      }
      log.warn(`[findAvailablePort:${label}] 端口 ${port} 被占用，尝试 ${port + PORT_INCREMENT}...`)
    } catch (err) {
      log.warn(`[findAvailablePort:${label}] 检查端口 ${port} 出错: ${String(err)}，尝试下一个...`)
    }
  }

  const fallback = startPort + PORT_MAX_RETRIES * PORT_INCREMENT
  log.warn(`[findAvailablePort:${label}] 所有端口均被占用，使用端口 ${fallback}`)
  return fallback
}

/**
 * CDP 端口探测：在通用探测基础上，额外处理 mtbot Chrome 残留（kill 后复用该端口）
 */
async function findAvailableCdpPort(startPort = DEFAULT_CDP_PORT): Promise<number> {
  const { inspectPortUsage } = await import('./vendor/ports-inspect.js')

  for (let i = 0; i < PORT_MAX_RETRIES; i++) {
    const port = startPort + i * PORT_INCREMENT
    try {
      const usage = await inspectPortUsage(port)

      if (usage.status === 'free') {
        if (i > 0) log.info(`[findAvailableCdpPort] 端口 ${port} 可用（跳过 ${i} 个被占用的端口）`)
        return port
      }

      const hasMtbotProcess = (usage.listeners ?? []).some((l) => isMtbotChrome(l.commandLine))
      if (hasMtbotProcess) {
        log.info(`[findAvailableCdpPort] 端口 ${port} 被 mtbot Chrome 残留占用，kill 后复用`)
        await killMtbotStaleBrowserProcess(port)
        return port
      }

      log.warn(`[findAvailableCdpPort] 端口 ${port} 被非 mtbot 进程占用，尝试 ${port + PORT_INCREMENT}...`)
    } catch (err) {
      log.warn(`[findAvailableCdpPort] 检查端口 ${port} 出错: ${String(err)}，尝试下一个...`)
    }
  }

  const fallback = startPort + PORT_MAX_RETRIES * PORT_INCREMENT
  log.warn(`[findAvailableCdpPort] 所有端口均被占用，使用端口 ${fallback}`)
  return fallback
}

/**
 * 启动浏览器控制服务（嵌入 Electron 主进程，无 HTTP 服务器）
 */
export async function startBrowserService(): Promise<boolean> {
  if (browserState) {
    return true
  }

  try {
    const { createBrowserRouteContext, ensureChromeExtensionRelayServer, resolveProfile } = await import('@mtbot/browser-control')

    // 并行探测两个端口（CDP + 扩展中继），每次 +10，最多 3 次
    const [cdpPort, extensionRelayPort] = await Promise.all([
      findAvailableCdpPort(),
      findAvailablePort(DEFAULT_EXTENSION_RELAY_PORT, 'extensionRelay'),
    ])

    const resolved = buildWindowsBrowserConfig(cdpPort, extensionRelayPort)

    browserState = {
      server: null,
      port: resolved.controlPort,
      resolved,
      profiles: new Map(),
    }

    browserContext = createBrowserRouteContext({
      getState: () => browserState,
    })

    // 启动 Chrome 扩展中继服务器（extension 驱动的 profile 需要）
    for (const name of Object.keys(resolved.profiles)) {
      const profile = resolveProfile(resolved, name)
      if (!profile || profile.driver !== 'extension') continue
      await ensureChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl }).catch((err) => {
        log.warn(`[startBrowserService] 扩展中继启动失败 profile="${name}": ${String(err)}`)
      })
    }

    log.info(`[startBrowserService] 浏览器控制服务已启动（CDP: ${cdpPort}，扩展中继: ${extensionRelayPort}）`)
    // Chrome 按需启动，首次调用 browser.* 命令时再打开

    return true
  } catch (err) {
    log.error('浏览器控制服务启动失败:', err)
    browserState = null
    browserContext = null
    return false
  }
}

/**
 * 停止浏览器控制服务
 */
export async function stopBrowserService(): Promise<void> {
  if (!browserContext || !browserState) {
    return
  }

  try {
    for (const name of Object.keys(browserState.resolved.profiles)) {
      try {
        await browserContext.forProfile(name).stopRunningBrowser()
      } catch {
        // ignore
      }
    }
  } catch (err) {
    log.warn('浏览器服务停止时出错:', err)
  }

  browserState = null
  browserContext = null

  try {
    const { closePlaywrightBrowserConnection } = await import('@mtbot/browser-control')
    await closePlaywrightBrowserConnection()
  } catch {
    // ignore
  }

  log.info('浏览器控制服务已停止')
}

/**
 * 获取浏览器路由上下文（供 NodeCommandHandler 使用）
 */
export function getBrowserContext(): BrowserRouteContext | null {
  return browserContext
}

/**
 * 获取浏览器服务状态
 */
export function getBrowserServiceState(): { running: boolean; port: number | null } {
  return {
    running: browserState !== null,
    port: browserState?.port ?? null,
  }
}
