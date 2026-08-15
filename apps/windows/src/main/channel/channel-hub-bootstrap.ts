/**
 * Channel Hub 装配：Registry + 三 Provider + Router + 微信 token store。
 *
 * 独立于 index.ts，避免入口继续膨胀。
 */

import path from 'node:path'
import type { FeishuLoginService } from '../feishu-login-service'
import type { WeixinLoginService } from '../weixin-login-service'
import type { WecomLoginService } from '../wecom-login-service'
import { ChannelRegistry } from './channel-registry'
import { ChannelOutboundRouter } from './channel-outbound-router'
import { WeixinReplyContextStore } from './weixin-reply-context-store'
import { FeishuChannelProvider } from './providers/feishu-outbound-provider'
import { WeixinChannelProvider } from './providers/weixin-outbound-provider'
import { WecomChannelProvider } from './providers/wecom-outbound-provider'

export interface ChannelHubDeps {
  feishu: FeishuLoginService
  weixin: WeixinLoginService
  wecom: WecomLoginService
  /** 客户端数据根（默认 ~/.lumii） */
  dataRoot: string
  /** 可注入已有 store（微信 adapter 需更早持有同一实例） */
  weixinStore?: WeixinReplyContextStore
}

export interface ChannelHub {
  router: ChannelOutboundRouter
  registry: ChannelRegistry
  weixinStore: WeixinReplyContextStore
  wecomProvider: WecomChannelProvider
}

/**
 * 创建微信 reply context 持久化路径。
 */
export function resolveWeixinReplyContextPath(dataRoot: string): string {
  return path.join(dataRoot, 'channel', 'weixin-reply-contexts.json')
}

/**
 * 仅创建 WeixinReplyContextStore（供 adapter 早于 Hub 使用）。
 */
export function createWeixinReplyContextStore(dataRoot: string): WeixinReplyContextStore {
  return new WeixinReplyContextStore(resolveWeixinReplyContextPath(dataRoot))
}

/**
 * 装配完整 Channel Hub。
 */
export function createChannelHub(deps: ChannelHubDeps): ChannelHub {
  const weixinStore =
    deps.weixinStore ?? createWeixinReplyContextStore(deps.dataRoot)
  const registry = new ChannelRegistry()
  const wecomProvider = new WecomChannelProvider(deps.wecom)
  registry.register(new FeishuChannelProvider(deps.feishu))
  registry.register(new WeixinChannelProvider(deps.weixin, weixinStore))
  registry.register(wecomProvider)
  const router = new ChannelOutboundRouter(registry)
  return { router, registry, weixinStore, wecomProvider }
}
