/**
 * 渠道设置分区。
 *
 * 负责页头（标题 / 说明 / 连接汇总）与三张整宽渠道卡片的排布，
 * 并统一拉取 channel:list 快照后按渠道分发给各卡片。
 */
import React from 'react'
import { WeixinChannelSettings } from '../WeixinChannelSettings'
import { WecomChannelSettings } from '../WecomChannelSettings'
import { FeishuChannelSettings } from '../FeishuChannelSettings'
import { useChannelSnapshots } from './useChannelSnapshots'
import styles from './ChannelsSection.module.css'

export type { ChannelSnapshot, ChannelPeerSnapshot, OutboundChannelId } from './useChannelSnapshots'

const TOTAL_CHANNELS = 3

/**
 * 渲染渠道设置分区。
 */
export const ChannelsSection: React.FC = () => {
  const { snapshots, loading } = useChannelSnapshots()

  const connectedCount = Object.values(snapshots).filter((s) => s?.connected).length

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <div className={styles.titleBlock}>
          <h3 className={styles.title}>渠道设置</h3>
          <p className={styles.subtitle}>
            接入即时通讯渠道后，Agent 可在会话内回复，也能主动向已连接的联系人发消息。
          </p>
        </div>
        <span className={styles.summary}>
          <span
            className={`${styles.summaryDot} ${connectedCount === 0 ? styles.summaryDotIdle : ''}`}
          />
          {loading ? '读取连接状态…' : `${connectedCount} / ${TOTAL_CHANNELS} 渠道已连接`}
        </span>
      </div>

      <div className={styles.list}>
        <WeixinChannelSettings snapshot={snapshots.weixin} snapshotLoading={loading} />
        <WecomChannelSettings snapshot={snapshots.wecom} snapshotLoading={loading} />
        <FeishuChannelSettings snapshot={snapshots.feishu} snapshotLoading={loading} />
      </div>

      <p className={styles.footnote}>
        「可发送对象」与 Agent 的 channel_list 工具同源，仅作展示；发送消息请交给 Agent 完成。
      </p>
    </div>
  )
}

export default ChannelsSection
