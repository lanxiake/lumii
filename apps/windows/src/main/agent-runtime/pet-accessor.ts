import { defineServiceAccessor } from '../../plugins/api'
import type { PetService } from '../../plugins/builtin/pet/service-api'

/**
 * 桌宠的核心侧入口。
 *
 * 插件停用 → 服务消失 → 没有窗口可推、提示词不注入宠物模式段、托盘项不出现、
 * 资产协议不再响应。核心各处的调用都写成 `getPetService()?.…`，不再各自判门。
 */
const accessor = defineServiceAccessor<PetService>('pet')

export function setPetAccessor(fn: (() => PetService | null) | null): void {
  accessor.setResolver(fn)
}

export function getPetService(): PetService | null {
  return accessor.get()
}
