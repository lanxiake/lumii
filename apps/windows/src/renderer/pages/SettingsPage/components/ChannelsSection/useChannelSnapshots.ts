/**
 * 统一拉取渠道出站快照（channel:list），供渠道设置区各卡片共用。
 *
 * 只在分区层拉一次，避免三张卡片各发一次 IPC；三个渠道的登录状态变化时自动刷新，
 * 使 peer 列表与连接态保持同步。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** 出站渠道标识，与主进程 outbound-types 对齐 */
export type OutboundChannelId = 'feishu' | 'weixin' | 'wecom'

/** 渠道推送能力 */
export type ChannelPushMode = 'native_push' | 'cached_reply' | 'reply_only'

/** 单个可发送对象 */
export interface ChannelPeerSnapshot {
  id: string
  label?: string
  canSend: boolean
  blockedReason?: 'NO_REPLY_CONTEXT' | 'TOKEN_STALE' | 'UNSUPPORTED'
  lastInboundAt?: number
}

/** 单个渠道的出站快照 */
export interface ChannelSnapshot {
  channel: OutboundChannelId
  connected: boolean
  pushMode: ChannelPushMode
  peers: ChannelPeerSnapshot[]
}

export interface UseChannelSnapshotsResult {
  /** 按渠道索引的快照；Hub 未就绪或渠道未注册时为 undefined */
  snapshots: Partial<Record<OutboundChannelId, ChannelSnapshot>>
  loading: boolean
  refresh: () => Promise<void>
}

/**
 * 读取并订阅渠道出站快照。
 */
export function useChannelSnapshots(): UseChannelSnapshotsResult {
  const [snapshots, setSnapshots] = useState<Partial<Record<OutboundChannelId, ChannelSnapshot>>>({})
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const res = await window.channelService?.list?.()
      if (!mountedRef.current) return
      const next: Partial<Record<OutboundChannelId, ChannelSnapshot>> = {}
      for (const item of (res?.channels ?? []) as ChannelSnapshot[]) {
        if (item?.channel) next[item.channel] = item
      }
      setSnapshots(next)
    } catch {
      if (mountedRef.current) setSnapshots({})
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refresh()

    // 登录态变化会改变 connected 与 peer 可用性，跟随刷新
    const unsubscribers = [
      window.weixinService?.onStatusChange?.(() => void refresh()),
      window.wecomService?.onStatusChange?.(() => void refresh()),
      window.feishuService?.onStatusChange?.(() => void refresh()),
    ]

    return () => {
      mountedRef.current = false
      for (const off of unsubscribers) off?.()
    }
  }, [refresh])

  return { snapshots, loading, refresh }
}
