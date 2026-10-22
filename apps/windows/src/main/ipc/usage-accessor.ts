import { defineServiceAccessor } from '../../plugins/api'
import type { UsageService } from '../../plugins/builtin/usage/service-api'

/**
 * 用量查询的核心侧入口（`usage:query`）。
 *
 * 插件停用 → 服务消失 → handler 如实返回错误，而不是给一份空数据
 * （空数据会被误读成「这个月一次都没调用」）。
 */
const accessor = defineServiceAccessor<UsageService>('usage')

export function setUsageAccessor(fn: (() => UsageService | null) | null): void {
  accessor.setResolver(fn)
}

export function getUsageService(): UsageService | null {
  return accessor.get()
}
