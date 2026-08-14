/**
 * 已连接渠道 peer 列表（只读）。
 *
 * 汇总 channel_list 语义（feishu/weixin/wecom），展示各渠道连接态、推送模式与可发送 peer。
 * 纯展示，不提供发送表单；发送仍走 Agent 的 channel_send，避免面板变成第二套发消息入口。
 */
import React, { useEffect, useState } from 'react'
import { Card } from '../../../../components/ui/Card/Card'
import { Tag } from '../../../../components/ui/Tag/Tag'
import styles from './ChannelPeerPanel.module.css'

type OutboundChannelId = 'feishu' | 'weixin' | 'wecom'
type ChannelPushMode = 'native_push' | 'cached_reply' | 'reply_only'

interface ChannelPeer {
  id: string
  label?: string
  canSend: boolean
  blockedReason?: 'NO_REPLY_CONTEXT' | 'TOKEN_STALE' | 'UNSUPPORTED'
  lastInboundAt?: number
}

interface ChannelSnapshot {
  channel: OutboundChannelId
  connected: boolean
  pushMode: ChannelPushMode
  peers: ChannelPeer[]
}

const CHANNEL_LABELS: Record<OutboundChannelId, string> = {
  feishu: '飞书',
  weixin: '微信',
  wecom: '企业微信',
}

const PUSH_MODE_LABELS: Record<ChannelPushMode, string> = {
  native_push: '真推送',
  cached_reply: '缓存 token 伪推送',
  reply_only: '仅被动回复',
}

const BLOCKED_REASON_LABELS: Record<NonNullable<ChannelPeer['blockedReason']>, string> = {
  NO_REPLY_CONTEXT: '未建立回复上下文',
  TOKEN_STALE: 'token 已过期',
  UNSUPPORTED: '不支持',
}

/**
 * 已连接渠道 peer 列表面板。
 */
export const ChannelPeerPanel: React.FC = () => {
  const [snapshots, setSnapshots] = useState<ChannelSnapshot[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    const load = async () => {
      try {
        const res = await window.channelService?.list?.()
        if (mounted) {
          setSnapshots(((res?.channels ?? []) as ChannelSnapshot[]))
        }
      } catch {
        if (mounted) setSnapshots([])
      } finally {
        if (mounted) setLoading(false)
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [])

  return (
    <Card className={styles.panel}>
      <div className={styles.title}>已连接渠道 · Peer 列表</div>
      <p className={styles.hint}>
        与 Agent channel_list 工具同源的只读展示，仅供调试；发送消息请通过 Agent 完成。
      </p>
      {loading ? (
        <div className={styles.loading}>加载中...</div>
      ) : (
        (snapshots ?? []).map((snap) => (
          <div key={snap.channel} className={styles.channelBlock}>
            <div className={styles.channelHeader}>
              <span className={styles.channelName}>{CHANNEL_LABELS[snap.channel] ?? snap.channel}</span>
              <Tag color={snap.connected ? 'success' : 'default'}>
                {snap.connected ? '已连接' : '未连接'}
              </Tag>
              <span className={styles.pushMode}>{PUSH_MODE_LABELS[snap.pushMode] ?? snap.pushMode}</span>
            </div>
            {!snap.connected || snap.peers.length === 0 ? (
              <div className={styles.empty}>
                {snap.connected ? '暂无已记录的 peer（尚未收到过对方消息）' : '未连接，无 peer 数据'}
              </div>
            ) : (
              <table className={styles.peerTable}>
                <thead>
                  <tr>
                    <th>Peer</th>
                    <th>可发送</th>
                    <th>最近入站</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.peers.map((peer) => (
                    <tr key={peer.id}>
                      <td className={styles.peerId}>{peer.label ?? peer.id}</td>
                      <td>
                        {peer.canSend ? (
                          <Tag color="success">可发送</Tag>
                        ) : (
                          <Tag color="warning">
                            {peer.blockedReason ? BLOCKED_REASON_LABELS[peer.blockedReason] : '不可发送'}
                          </Tag>
                        )}
                      </td>
                      <td>{peer.lastInboundAt ? new Date(peer.lastInboundAt).toLocaleString() : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))
      )}
    </Card>
  )
}

export default ChannelPeerPanel
