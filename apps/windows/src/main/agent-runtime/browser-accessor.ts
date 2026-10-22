import { defineServiceAccessor } from '../../plugins/api'
import type { BrowserService } from '../../plugins/builtin/browser/service-api'

/**
 * 浏览器控制的核心侧入口。
 *
 * 插件停用 → 服务消失 → 启动/停止/取上下文全部变成 no-op，
 * 浏览器工具也不会被注册（工具注册本身也在插件里）。
 */
const accessor = defineServiceAccessor<BrowserService>('browser')

export function setBrowserAccessor(fn: (() => BrowserService | null) | null): void {
  accessor.setResolver(fn)
}

export function getBrowserService(): BrowserService | null {
  return accessor.get()
}
