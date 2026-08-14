/**
 * 渠道出站 Hub 的 IPC 处理逻辑（与 Agent channel_list/channel_send 同源）。
 *
 * 从 index.ts 抽出以便单测覆盖 list/send 转发与参数校验，不依赖 Electron ipcMain。
 */
import type { ChannelOutboundRouter } from './channel-outbound-router'
import type { ChannelSendResult, OutboundChannelId } from './outbound-types'

/** channelService IPC 所需的最小 Hub 形状 */
export interface ChannelServiceHub {
  router: ChannelOutboundRouter
}

/**
 * 处理 channel:list —— Hub 未就绪时返回空列表（不 throw）。
 */
export async function handleChannelList(
  hub: ChannelServiceHub | null | undefined,
): Promise<{ channels: Awaited<ReturnType<ChannelOutboundRouter['list']>> }> {
  if (!hub) return { channels: [] }
  return { channels: await hub.router.list() }
}

/**
 * 处理 channel:send —— 校验 channel 后转发 Router；Hub 未就绪返回 HUB_NOT_READY。
 */
export async function handleChannelSend(
  hub: ChannelServiceHub | null | undefined,
  params: unknown,
): Promise<ChannelSendResult> {
  if (!hub) {
    return { ok: false, errorCode: 'HUB_NOT_READY', message: '渠道出站 Hub 尚未就绪，请稍后再试' }
  }
  const p = (params ?? {}) as Record<string, unknown>
  const channel = String(p.channel ?? '').trim()
  if (channel !== 'feishu' && channel !== 'weixin' && channel !== 'wecom') {
    return {
      ok: false,
      errorCode: 'PEER_NOT_FOUND',
      message: "channel 必须是 'feishu' | 'weixin' | 'wecom'",
    }
  }
  return hub.router.send({
    channel: channel as OutboundChannelId,
    to: String(p.to ?? ''),
    text: String(p.text ?? ''),
    ...(typeof p.mediaPath === 'string' && p.mediaPath ? { mediaPath: p.mediaPath } : {}),
    ...(typeof p.fileName === 'string' && p.fileName ? { fileName: p.fileName } : {}),
  })
}
