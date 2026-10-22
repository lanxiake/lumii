import { startBrowserService } from '../../../plugins/builtin/browser/service'
import { createLogger } from '../../logger'

/**
 * 首屏就绪之后的后台装配（从 `index.ts` 的 `startPostReadyServices` 搬出来）。
 *
 * 为什么先搬它：`initChannelServices` 一上来就给十个模块级单例赋值，
 * 搬它等于连状态一起搬；而这个阶段**一个赋值都不做**，只读两个单例。
 * 阶段函数搬家的模板先在这里压稳（显式 deps + 可测的回调逻辑）。
 */

const log = createLogger('Main')

/** 只用到 `setOnConflictPending`，用结构类型而不是 import 整个调度器 */
export interface ConflictScheduler {
  setOnConflictPending(handler: () => Promise<void>): void
}

/** 同理：只用到「就绪没」和「驱动一轮」，不 import 4500 行的 bridge */
export interface ConflictDrivenBridge {
  isInitialized: boolean
  executeSyncConflictGoal(): Promise<string | null>
}

export interface PostReadyDeps {
  syncScheduler: ConflictScheduler | null
  /** getter 而不是实例：本阶段跑在 bridge 建好之后，但类型上允许还没起来 */
  getBridge: () => ConflictDrivenBridge | null
  /** 可注入：单测里不真的去拉 Chromium */
  startBrowserService?: () => Promise<boolean>
  /**
   * 浏览器插件这两次启动是否启用（`isExtensionActive('com.lumii.browser')`）。
   * 关掉时整段跳过——否则会走「启动失败」那条 WARN，看着像服务坏了。
   */
  browserPluginEnabled?: boolean
  logger?: { info(message: string): void; warn(message: string): void }
}

export async function startPostReadyServices(deps: PostReadyDeps): Promise<void> {
  const logger = deps.logger ?? log

  // 注入云同步冲突 Agent 重试回调：SyncScheduler 每次 tick 若仍处于 conflict 且冷却已过，
  // 自动驱动 Agent 重新处理（与心跳 evolution-tick 同路径）
  deps.syncScheduler?.setOnConflictPending(async () => {
    const bridge = deps.getBridge()
    // 未初始化就静默跳过：初始化失败会在启动日志里单独报，这里再报一次只会刷屏
    if (!bridge?.isInitialized) return
    await bridge.executeSyncConflictGoal()
  })

  // 启动浏览器控制服务（控制用户本机浏览器）
  if (deps.browserPluginEnabled === false) {
    logger.info('浏览器插件已禁用：跳过控制服务启动')
    return
  }
  const started = await (deps.startBrowserService ?? startBrowserService)()
  if (started) {
    logger.info('浏览器控制服务已就绪')
  } else {
    logger.warn('浏览器控制服务启动失败，browser.* 命令将不可用')
  }
}
