import { defineServiceAccessor } from '../../plugins/api'
import type { VcsService } from '../../plugins/builtin/vcs/service-api'

/**
 * 工作空间版本管理的核心侧入口（回合开始/结束快照、Agent 主动打快照）。
 *
 * 插件停用 → 服务消失 → 快照跳过；回合照常跑，只是这段时间没有版本可回滚。
 */
const accessor = defineServiceAccessor<VcsService>('vcs')

export function setVcsAccessor(fn: (() => VcsService | null) | null): void {
  accessor.setResolver(fn)
}

export function getVcsService(): VcsService | null {
  return accessor.get()
}
