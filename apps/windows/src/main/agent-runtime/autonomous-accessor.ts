import { defineServiceAccessor } from '../../plugins/api'
import type { AutonomousService } from '../../plugins/builtin/autonomous/service'

/**
 * 自主进化的**核心侧入口**。
 *
 * 功能本体在 `plugins/builtin/autonomous/`：插件启用时把服务放进容器，停用时消失。
 * bridge / IPC / 命令都只认这里的 getter——拿不到就是「自主进化没开」，
 * 不需要在十几个调用点各写一遍 `isExtensionActive`。
 *
 * type-only import 不产生运行期依赖（编译期擦除）。
 */
const accessor = defineServiceAccessor<AutonomousService>('autonomous')

export function setAutonomousAccessor(fn: (() => AutonomousService | null) | null): void {
  accessor.setResolver(fn)
}

export function getAutonomousService(): AutonomousService | null {
  return accessor.get()
}
