/**
 * Channel Hub 装配：Registry + 四 Provider + Router + 微信 token store + peer 持久化。
 *
 * 独立于 index.ts，避免入口继续膨胀。
 */

import path from 'node:path'
import type { FeishuLoginService } from '../feishu-login-service'
import type { WeixinLoginService } from '../weixin-login-service'
import type { WecomLoginService } from '../wecom-login-service'
import type { QbotLoginService } from '../qbot-login-service'
import { ChannelRegistry } from './channel-registry'
import { ChannelOutboundRouter } from './channel-outbound-router'
import { WeixinReplyContextStore } from './weixin-reply-context-store'
import { ChannelPeerStore } from './channel-peer-store'
import { FeishuChannelProvider } from './providers/feishu-outbound-provider'
import { WeixinChannelProvider } from './providers/weixin-outbound-provider'
import { WecomChannelProvider } from './providers/wecom-outbound-provider'
import { QbotChannelProvider } from './providers/qbot-outbound-provider'

export { ChannelPeerStore }

export interface ChannelHubDeps {
  feishu: FeishuLoginService
  weixin?: WeixinLoginService
  wecom: WecomLoginService
  qbot?: QbotLoginService
  /** 客户端数据根（默认 ~/.lumii） */
  dataRoot: string
  /** 可注入已有 store（微信 adapter 需更早持有同一实例） */
  weixinStore?: WeixinReplyContextStore
  /** 可注入已有 peer store（渠道 adapter 需早于 Hub 记录入站 peer） */
  peerStore?: ChannelPeerStore
}

export interface ChannelHub {
  router: ChannelOutboundRouter
  registry: ChannelRegistry
  weixinStore: WeixinReplyContextStore
  /** 入站 peer 持久化：adapter 与 Provider 共用同一实例 */
  peerStore: ChannelPeerStore
  wecomProvider: WecomChannelProvider
  /** QQ Provider（qbot 登录服务缺席时为 null，供 adapter 注入） */
  qbotProvider: QbotChannelProvider | null
  /** 把持久化的最近入站 peer 恢复到 Provider 快照（仅启动时调用） */
  restorePeerSnapshots(): void
}

/**
 * 创建微信 reply context 持久化路径。
 */
function resolveWeixinReplyContextPath(dataRoot: string): string {
  return path.join(dataRoot, 'channel', 'weixin-reply-contexts.json')
}

/**
 * 创建渠道 peer 持久化路径。
 */
function resolveChannelPeerStorePath(dataRoot: string): string {
  return path.join(dataRoot, 'channel', 'channel-peers.json')
}

/**
 * 仅创建 WeixinReplyContextStore（供 adapter 早于 Hub 使用）。
 */
export function createWeixinReplyContextStore(dataRoot: string): WeixinReplyContextStore {
  return new WeixinReplyContextStore(resolveWeixinReplyContextPath(dataRoot))
}

/**
 * 仅创建 ChannelPeerStore（供 adapter 早于 Hub 使用）。
 */
export function createChannelPeerStore(dataRoot: string): ChannelPeerStore {
  return new ChannelPeerStore(resolveChannelPeerStorePath(dataRoot))
}

/**
 * 装配完整 Channel Hub。
 */
export function createChannelHub(deps: ChannelHubDeps): ChannelHub {
  const weixinStore =
    deps.weixinStore ?? createWeixinReplyContextStore(deps.dataRoot)
  const peerStore = deps.peerStore ?? createChannelPeerStore(deps.dataRoot)
  const registry = new ChannelRegistry()
  const wecomProvider = new WecomChannelProvider(deps.wecom)
  const qbotProvider = deps.qbot ? new QbotChannelProvider(deps.qbot) : null
  registry.register(new FeishuChannelProvider(deps.feishu))
  if (deps.weixin) registry.register(new WeixinChannelProvider(deps.weixin, weixinStore))
  registry.register(wecomProvider)
  if (qbotProvider) registry.register(qbotProvider)
  const router = new ChannelOutboundRouter(registry)
  return {
    router,
    registry,
    weixinStore,
    peerStore,
    wecomProvider,
    qbotProvider,
    restorePeerSnapshots() {
      // 记录里是真实入站时刻，这里只做启动恢复；跨进程后被动回复窗口已无从校验，
      // 与 Provider 内存态统一取当前时刻，不对陈旧记录做假过滤
      const now = Date.now()
      qbotProvider?.setSnapshotRestore(
        ChannelPeerStore.toPeers(peerStore.listByChannel('qbot'), now),
      )
      wecomProvider.setSnapshotRestore(
        ChannelPeerStore.toPeers(peerStore.listByChannel('wecom'), now),
      )
    },
  }
}
