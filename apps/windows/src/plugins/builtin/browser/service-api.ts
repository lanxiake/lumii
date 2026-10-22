import type { BrowserRouteContext } from './service'

/**
 * 浏览器插件对核心暴露的能力（type-only 契约，核心不 import 实现）。
 *
 * 核心只在三处用到它：启动阶段调 `start`、退出时 `stop`、工具/协议取 `getContext`。
 * 插件停用后 `S.browser` 消失，这三处自动变成 no-op。
 */
export interface BrowserService {
  /** 启动 CDP 与扩展中继；返回是否成功（失败不阻塞启动流程） */
  start(): Promise<boolean>
  stop(): Promise<void>
  getContext(): BrowserRouteContext | null
}
