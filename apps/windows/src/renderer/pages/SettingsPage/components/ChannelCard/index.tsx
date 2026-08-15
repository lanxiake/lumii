/**
 * 渠道卡片：整宽行式布局。
 *
 * 一张卡片自上而下分四段：标题行（图标 / 名称 / 状态 / 操作）、错误横幅、
 * 结构化 meta 条、可发送对象（peer）区。原先底部独立的 peer 表格已并入此处，
 * 页面因此从「卡片网格 + 表格面板」收敛成一条列表。
 */
import React from 'react'
import { ChannelStatusPill, type ChannelConnectionState } from '../ChannelStatusPill'
import styles from './ChannelCard.module.css'

export type { ChannelConnectionState }

/** meta 条中的一项，如「连接时长 / 3 天 5 小时」 */
export interface ChannelMetaItem {
  label: string
  value: string
  /** 值为 ID 一类的标识时用等宽字体 */
  mono?: boolean
}

/** 可发送对象（对齐 Agent channel_list 返回的 peer） */
export interface ChannelPeerItem {
  id: string
  label?: string
  canSend: boolean
  blockedReason?: 'NO_REPLY_CONTEXT' | 'TOKEN_STALE' | 'UNSUPPORTED'
}

const BLOCKED_REASON_LABELS: Record<NonNullable<ChannelPeerItem['blockedReason']>, string> = {
  NO_REPLY_CONTEXT: '无回复上下文',
  TOKEN_STALE: '凭证已过期',
  UNSUPPORTED: '不支持发送',
}

interface ChannelCardProps {
  /** 渠道图标（品牌字标） */
  icon?: React.ReactNode
  name: string
  description?: string
  /** 能力标签，如「仅会话内被动回复」 */
  capability?: string
  /** 归一后的连接状态 */
  state: ChannelConnectionState
  /** 状态文案 */
  statusLabel: string
  /** 操作按钮区 */
  actions?: React.ReactNode
  /** 已连接时展示的结构化信息 */
  meta?: ChannelMetaItem[]
  /** 可发送对象；传 undefined 表示不展示该区块（未连接） */
  peers?: ChannelPeerItem[]
  /** peer 列表是否仍在读取 */
  peersLoading?: boolean
  /** 错误提示（非空时展示横幅） */
  errorMessage?: string | null
  /** 额外内容（如配置表单） */
  children?: React.ReactNode
}

/**
 * 渲染单个渠道的设置卡片。
 */
export const ChannelCard: React.FC<ChannelCardProps> = ({
  icon,
  name,
  description,
  capability,
  state,
  statusLabel,
  actions,
  meta,
  peers,
  peersLoading = false,
  errorMessage,
  children,
}) => {
  const sendablePeerCount = peers?.filter((p) => p.canSend).length ?? 0

  return (
    <section className={styles.card}>
      <div className={styles.row}>
        {icon && <span className={styles.icon}>{icon}</span>}
        <div className={styles.text}>
          <div className={styles.name}>{name}</div>
          {(description || capability) && (
            <div className={styles.descRow}>
              {description && <span className={styles.description}>{description}</span>}
              {capability && <span className={styles.capability}>{capability}</span>}
            </div>
          )}
        </div>
        <ChannelStatusPill state={state} label={statusLabel} />
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>

      {errorMessage && <div className={styles.error}>{errorMessage}</div>}

      {meta && meta.length > 0 && (
        <dl className={styles.meta}>
          {meta.map((item) => (
            <div key={item.label} className={styles.metaItem}>
              <dt className={styles.metaLabel}>{item.label}</dt>
              <dd className={`${styles.metaValue} ${item.mono ? styles.mono : ''}`}>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {peers && (
        <div className={styles.peers}>
          <div className={styles.peersLabel}>
            {peersLoading ? '可发送对象 · 读取中' : `可发送对象 · ${sendablePeerCount}`}
          </div>
          {peers.length === 0 ? (
            <div className={styles.peersEmpty}>
              暂无记录，等对方给 Bot 发一条消息后出现在这里
            </div>
          ) : (
            <div className={styles.chips}>
              {peers.map((peer) => (
                <span
                  key={peer.id}
                  className={`${styles.chip} ${peer.canSend ? '' : styles.chipBlocked}`}
                  title={peer.id}
                >
                  <span className={styles.chipDot} />
                  <span className={styles.chipName}>{peer.label || peer.id}</span>
                  {peer.label && <span className={styles.chipId}>{peer.id}</span>}
                  {!peer.canSend && peer.blockedReason && (
                    <span className={styles.chipReason}>
                      {BLOCKED_REASON_LABELS[peer.blockedReason]}
                    </span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {children}
    </section>
  )
}

export default ChannelCard
