import type { CrossChannelContinuity, RecentConversation } from '../../plugins/builtin/channel-continuity/continuity'
import { DEFAULT_CHANNEL_FEATURES, type ChannelFeatureSettings } from '../../shared/channel-features'

/**
 * 跨渠道会话接续的**核心侧入口**。
 *
 * 功能本体在 `plugins/builtin/channel-continuity/`：插件启用时把服务放进容器，
 * 停用时服务随之消失。adapter / 斜杠命令 / IPC 都只认这里的 getter，
 * 拿不到就按「功能关闭」处理——所以禁用不需要在核心再加一道 `isExtensionActive`。
 *
 * 类型是 type-only import：不产生运行期依赖，守卫也不该把它算成「核心直连插件实现」。
 */
export interface ChannelContinuityService {
  getFeatures(): ChannelFeatureSettings
  setFeatures(patch: Partial<ChannelFeatureSettings>): ChannelFeatureSettings
  /** 功能关时返回 undefined */
  forChannel(bridge: {
    listRecentConversations(limit: number): readonly RecentConversation[]
    getConversationOwnership?(conversationId: string): string | null
  }): CrossChannelContinuity | undefined
}

let accessor: (() => ChannelContinuityService | null) | null = null

/** `index.ts` 在宿主建好后注入：每次现取容器，插件停用后自动变成 null */
export function setChannelContinuityAccessor(fn: (() => ChannelContinuityService | null) | null): void {
  accessor = fn
}

export function getChannelContinuityService(): ChannelContinuityService | null {
  return accessor?.() ?? null
}

/** 功能开关（插件不在时用默认值：接续关闭） */
export function getChannelFeatures(): ChannelFeatureSettings {
  return getChannelContinuityService()?.getFeatures() ?? DEFAULT_CHANNEL_FEATURES
}
