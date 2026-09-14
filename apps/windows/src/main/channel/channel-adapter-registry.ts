/**
 * 渠道适配器注册表
 *
 * 四个 adapter 各自在构造末尾注册自己，让渠道层之外（agent-runtime 的工具实现、
 * IPC 层）能按渠道类型拿到 adapter。
 *
 * 为什么需要它：adapter 实例原本只活在 `index.ts` 装配处的局部作用域里
 * （企微/飞书/QQ 是各 try 块内的 const），外部拿不到；而 Agent 要在渠道上
 * 「帮用户切会话」时必须调到对应 adapter 的 `setActiveSessionKey`。
 *
 * 与 `getChannelInteractionHub` 同理：进程内单例，进程存活期内不重建。
 */

import type { IChannelAdapter } from './types'

const adapters = new Map<string, IChannelAdapter>()

/** 由各 adapter 在构造末尾调用 */
export function registerChannelAdapter(adapter: IChannelAdapter): void {
  adapters.set(adapter.channelType, adapter)
}

/** 按渠道类型取 adapter；未接入该渠道时返回 undefined */
export function getChannelAdapter(channelType: string): IChannelAdapter | undefined {
  return adapters.get(channelType)
}

/** 测试用：清空注册表 */
export function __resetChannelAdapterRegistry(): void {
  adapters.clear()
}
