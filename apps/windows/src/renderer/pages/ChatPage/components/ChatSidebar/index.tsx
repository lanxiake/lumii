import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { SessionItem } from '../SessionItem'
import { ChannelBindModal } from '../ChannelBindModal'
import { useAgents } from '../../../../hooks/business/useAgents/useAgents'
import type { ChatSession } from '../../../../hooks/business/useChat'
import styles from './ChatSidebar.module.css'

/** 会话渠道：系统默认 / 个人微信 / 企业微信 / 飞书 */
type SessionChannel = 'default' | 'wechat' | 'wecom' | 'feishu'

interface ChannelMeta {
  id: SessionChannel
  label: string
  icon: string
}

/** 固定渠道顺序（始终展示系统默认；其余有会话时展示） */
const CHANNEL_META: readonly ChannelMeta[] = [
  { id: 'default', label: '系统默认', icon: '🌐' },
  { id: 'wechat', label: '个人微信', icon: '💬' },
  { id: 'wecom', label: '企业微信', icon: '🏢' },
  { id: 'feishu', label: '飞书', icon: '🐦' },
]

interface ChatSidebarProps {
  sessions: ChatSession[]
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onCreateSession: () => void
  onPinSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  onRenameSession: (sessionId: string, newTitle: string) => void
}

/**
 * 归一化会话渠道（兼容旧数据 / 空值）。
 */
function normalizeChannel(channel?: string): SessionChannel {
  if (channel === 'wechat' || channel === 'wecom' || channel === 'feishu') return channel
  return 'default'
}

/**
 * 判断两天是否同一天。
 */
const isSameDay = (date1: Date, date2: Date): boolean => {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  )
}

/**
 * 聊天侧边栏：按渠道分组展示历史会话。
 */
const ChatSidebar: React.FC<ChatSidebarProps> = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onPinSession,
  onDeleteSession,
  onRenameSession,
}) => {
  const [searchQuery, setSearchQuery] = useState('')
  /** 已折叠的渠道 key */
  const [collapsedChannels, setCollapsedChannels] = useState<Set<string>>(() => new Set())
  /** 绑定渠道弹窗 */
  const [bindModalOpen, setBindModalOpen] = useState(false)

  const { agents } = useAgents()
  const agentsMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  /**
   * 搜索过滤后的会话。
   */
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions
    const q = searchQuery.toLowerCase()
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.messages.some((m) => m.content.toLowerCase().includes(q)),
    )
  }, [sessions, searchQuery])

  /**
   * 按渠道分组：渠道 → { pinned, sessions(按时间) }；搜索时额外按今天/昨天/更早切分。
   */
  const channelGroups = useMemo(() => {
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const isSearch = Boolean(searchQuery.trim())

    const buckets = new Map<
      SessionChannel,
      {
        pinned: ChatSession[]
        sessions: ChatSession[]
        today: ChatSession[]
        yesterday: ChatSession[]
        earlier: ChatSession[]
      }
    >()

    for (const meta of CHANNEL_META) {
      buckets.set(meta.id, {
        pinned: [],
        sessions: [],
        today: [],
        yesterday: [],
        earlier: [],
      })
    }

    for (const session of filteredSessions) {
      const ch = normalizeChannel(session.channel)
      const bucket = buckets.get(ch)!
      if (session.isPinned) {
        bucket.pinned.push(session)
        continue
      }
      if (isSearch) {
        if (isSameDay(session.updatedAt, today)) bucket.today.push(session)
        else if (isSameDay(session.updatedAt, yesterday)) bucket.yesterday.push(session)
        else bucket.earlier.push(session)
      } else {
        bucket.sessions.push(session)
      }
    }

    // 非置顶按更新时间倒序
    const sortByUpdated = (a: ChatSession, b: ChatSession) =>
      b.updatedAt.getTime() - a.updatedAt.getTime()

    const visible: Array<{
      meta: ChannelMeta
      pinned: ChatSession[]
      sessions: ChatSession[]
      today: ChatSession[]
      yesterday: ChatSession[]
      earlier: ChatSession[]
      total: number
    }> = []

    for (const meta of CHANNEL_META) {
      const bucket = buckets.get(meta.id)!
      bucket.pinned.sort(sortByUpdated)
      bucket.sessions.sort(sortByUpdated)
      bucket.today.sort(sortByUpdated)
      bucket.yesterday.sort(sortByUpdated)
      bucket.earlier.sort(sortByUpdated)
      const total =
        bucket.pinned.length +
        bucket.sessions.length +
        bucket.today.length +
        bucket.yesterday.length +
        bucket.earlier.length
      // 系统默认始终展示；其它渠道仅有会话时展示
      if (meta.id !== 'default' && total === 0) continue
      visible.push({ meta, ...bucket, total })
    }

    return { isSearch, visible }
  }, [filteredSessions, searchQuery])

  // 新出现的非默认渠道默认折叠，避免列表过长抢焦点
  const prevChannelKeysRef = useRef<string[]>([])
  useEffect(() => {
    const currentKeys = channelGroups.visible.map((g) => g.meta.id)
    const prevKeys = prevChannelKeysRef.current
    if (prevKeys.length > 0) {
      const newKeys = currentKeys.filter((k) => !prevKeys.includes(k) && k !== 'default')
      if (newKeys.length > 0) {
        setCollapsedChannels((prev) => {
          const next = new Set(prev)
          newKeys.forEach((k) => next.add(k))
          return next
        })
      }
    }
    prevChannelKeysRef.current = currentKeys
  }, [channelGroups.visible])

  /**
   * 切换渠道折叠。
   */
  const toggleChannel = useCallback((key: string) => {
    setCollapsedChannels((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  /**
   * 渲染某一组会话条目。
   */
  const renderSessionItems = (groupSessions: ChatSession[]) =>
    groupSessions.map((session) => (
      <SessionItem
        key={session.id}
        session={session}
        isActive={activeSessionId === session.id}
        onSelect={() => onSelectSession(session.id)}
        onPin={() => onPinSession(session.id)}
        onDelete={() => onDeleteSession(session.id)}
        onRename={(newTitle) => onRenameSession(session.id, newTitle)}
        agent={searchQuery && session.agentId ? agentsMap.get(session.agentId) : undefined}
      />
    ))

  /**
   * 渲染渠道内的时间小分组（仅搜索模式）。
   */
  const renderTimeSubGroup = (title: string, groupSessions: ChatSession[]) => {
    if (groupSessions.length === 0) return null
    return (
      <div className={styles['channel-subgroup']}>
        <div className={styles['channel-subgroup-label']}>{title}</div>
        {renderSessionItems(groupSessions)}
      </div>
    )
  }

  return (
    <div className={styles['chat-sidebar']}>
      <div className={styles['sidebar-header']}>
        <Button
          variant="secondary"
          onClick={() => setBindModalOpen(true)}
          className={styles['bind-channel-btn']}
        >
          🔗 绑定渠道
        </Button>
        <Button onClick={onCreateSession} className={styles['new-chat-btn']}>
          + 新建对话
        </Button>
      </div>

      <ChannelBindModal open={bindModalOpen} onClose={() => setBindModalOpen(false)} />

      <div className={styles['session-search']}>
        <div className={styles['search-input-wrapper']}>
          <svg
            className={styles['search-icon']}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.35-4.35"></path>
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索会话..."
            className={styles['search-input']}
          />
          {searchQuery && (
            <button
              className={styles['search-clear']}
              onClick={() => setSearchQuery('')}
              title="清除搜索"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className={styles['conversations-list']}>
        {sessions.length === 0 ? (
          <div className={styles['no-conversations']}>暂无会话，点击上方按钮创建</div>
        ) : filteredSessions.length === 0 ? (
          <div className={styles['no-search-results']}>未找到匹配的会话</div>
        ) : (
          channelGroups.visible.map((group) => {
            const key = group.meta.id
            const isCollapsed = collapsedChannels.has(key)
            return (
              <div key={key} className={styles['channel-group']}>
                <div
                  className={`${styles['channel-group-label']} ${styles['channel-group-label--collapsible']}`}
                  onClick={() => toggleChannel(key)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggleChannel(key)
                    }
                  }}
                >
                  <span className={styles['group-icon']}>{group.meta.icon}</span>
                  <span>{group.meta.label}</span>
                  <span className={styles['group-count']}>({group.total})</span>
                  <span
                    className={`${styles['group-chevron']}${isCollapsed ? ` ${styles['group-chevron--collapsed']}` : ''}`}
                  >
                    ▾
                  </span>
                </div>

                <div
                  className={`${styles['channel-group-body']}${isCollapsed ? ` ${styles['channel-group-body--collapsed']}` : ''}`}
                >
                  {group.total === 0 ? (
                    <div className={styles['channel-empty']}>暂无会话</div>
                  ) : (
                    <>
                      {group.pinned.length > 0 && (
                        <div className={styles['channel-subgroup']}>
                          <div className={styles['channel-subgroup-label']}>📌 置顶</div>
                          {renderSessionItems(group.pinned)}
                        </div>
                      )}
                      {channelGroups.isSearch ? (
                        <>
                          {renderTimeSubGroup('今天', group.today)}
                          {renderTimeSubGroup('昨天', group.yesterday)}
                          {renderTimeSubGroup('更早', group.earlier)}
                        </>
                      ) : (
                        renderSessionItems(group.sessions)
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export default ChatSidebar
export { ChatSidebar }
