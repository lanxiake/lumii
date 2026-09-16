import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { SessionItem } from '../SessionItem'
import { ChannelBindModal } from '../ChannelBindModal'
import { ContextMenu } from '../ContextMenu'
import type { ContextMenuItem } from '../ContextMenu'
import { MoreHorizontal, Plus, Trash2 } from '../../../../components/ui/Icon'
import { useAgents } from '../../../../hooks/business/useAgents/useAgents'
import { useSettingsHub } from '../../../../components/SettingsHub'
import { isMainAgentSession } from '../../utils/main-agent-session'
import type { ClearGroupHistoryRequest } from '../../clearGroupPlan'
import type { ChatSession } from '../../../../hooks/business/useChat'
import styles from './ChatSidebar.module.css'

/** 会话来源：系统默认 / 个人微信 / 企业微信 / 飞书 / QQ / 定时任务 / 自主进化 */
type SessionChannel = 'default' | 'wechat' | 'wecom' | 'feishu' | 'qbot' | 'cron' | 'evolution'

/** 侧栏顶层 tab */
type SidebarTab = 'default' | 'channel' | 'system'

interface ChannelMeta {
  id: SessionChannel
  label: string
  icon: string
  tab: SidebarTab
}

/** 固定来源顺序（默认 tab 放系统默认；渠道 tab 放外部渠道；系统 tab 放定时任务/自主进化） */
const CHANNEL_META: readonly ChannelMeta[] = [
  { id: 'default', label: '系统默认', icon: '本机', tab: 'default' },
  { id: 'wechat', label: '个人微信', icon: '微信', tab: 'channel' },
  { id: 'wecom', label: '企业微信', icon: '企微', tab: 'channel' },
  { id: 'feishu', label: '飞书', icon: '飞书', tab: 'channel' },
  { id: 'qbot', label: 'QQ', icon: 'QQ', tab: 'channel' },
  { id: 'cron', label: '定时任务', icon: '定时', tab: 'system' },
  { id: 'evolution', label: '自主进化', icon: '进化', tab: 'system' },
]

/** 分组清空历史的请求类型见 ../../clearGroupPlan（ChatPage 与侧栏共用） */

interface ChatSidebarProps {
  sessions: ChatSession[]
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onCreateSession: () => void
  /** 在指定 Agent 分组下新建会话（null = 系统默认） */
  onCreateSessionInGroup: (agentId: string | null) => void
  /** 清空某分组的历史（置顶与运行中会话由处理方跳过） */
  onClearGroupHistory: (request: ClearGroupHistoryRequest) => void
  onPinSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  onRenameSession: (sessionId: string, newTitle: string) => void
}

/**
 * 归一化会话渠道（兼容旧数据 / 空值）。
 */
function normalizeChannel(channel?: string): SessionChannel {
  if (
    channel === 'wechat' ||
    channel === 'wecom' ||
    channel === 'feishu' ||
    channel === 'qbot' ||
    channel === 'cron' ||
    channel === 'evolution'
  ) {
    return channel
  }
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
 * 默认 Tab 系统分组的侧栏短名与空态中文说明（仅 UI，不改 Agent 定义）。
 * key：`__main__` = 系统默认；其余为内置 selectable Agent id。
 */
const SIDEBAR_SYSTEM_GROUP_UI: Record<string, { label: string; emptyDesc: string }> = {
  __main__: {
    label: '默认',
    emptyDesc: '通用助手，处理日常问答与多步任务',
  },
  'code-dev': {
    label: '开发',
    emptyDesc: '绑定项目，完成可验证的代码改动',
  },
  'system-keeper': {
    label: '维护',
    emptyDesc: '维护 Wiki、记忆与用户指南，并可代操客户端设置',
  },
  chronicler: {
    label: '记事',
    emptyDesc: '日报、周复盘、早间简报与专注提醒',
  },
  'info-curator': {
    label: '情报',
    emptyDesc: '按偏好策展资讯，筛选噪声并整理推送',
  },
}

/**
 * 解析侧栏分组显示名：系统五组用两字短名，其余回退 Agent 全名。
 */
function resolveSidebarGroupLabel(agentId: string | null, fallbackName: string): string {
  const key = agentId ?? '__main__'
  return SIDEBAR_SYSTEM_GROUP_UI[key]?.label ?? fallbackName
}

/**
 * 解析空组中文功能描述：系统五组用侧栏文案，其余回退 Agent description。
 */
function resolveSidebarEmptyDesc(agentId: string | null, fallback?: string): string {
  const key = agentId ?? '__main__'
  return SIDEBAR_SYSTEM_GROUP_UI[key]?.emptyDesc ?? (fallback?.trim() || '暂无会话')
}

/**
 * 聊天侧边栏：按渠道分组展示历史会话。
 */
const ChatSidebar: React.FC<ChatSidebarProps> = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onCreateSessionInGroup,
  onClearGroupHistory,
  onPinSession,
  onDeleteSession,
  onRenameSession,
}) => {
  const [searchQuery, setSearchQuery] = useState('')
  /** 已折叠的渠道 key */
  const [collapsedChannels, setCollapsedChannels] = useState<Set<string>>(() => new Set())
  /** 绑定渠道弹窗 */
  const [bindModalOpen, setBindModalOpen] = useState(false)
  /** 默认会话 / 渠道会话 / 系统会话 三态切换 */
  const [tab, setTab] = useState<SidebarTab>('default')
  /** 分组「⋯」菜单（新建 / 清空历史） */
  const [groupMenu, setGroupMenu] = useState<{
    x: number
    y: number
    items: ContextMenuItem[]
  } | null>(null)

  const { agents } = useAgents()
  const agentsMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  const { openHub } = useSettingsHub()

  /** QQ 渠道无扫码流程，引导到设置页填写凭证 */
  const handleGoToQbotSettings = useCallback(() => {
    openHub('settings', 'channels')
  }, [openHub])

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
   * 汇总运行中会话：按渠道、按顶层 Tab，供折叠分组与 Tab 脉冲点使用。
   * Tab 指示用全量 sessions（不受搜索过滤），避免搜索时误藏跨 Tab 运行态。
   */
  const runningIndicators = useMemo(() => {
    const byChannel = new Set<SessionChannel>()
    const byTab = new Set<SidebarTab>()
    for (const session of sessions) {
      if (!session.isStreaming) continue
      const ch = normalizeChannel(session.channel)
      byChannel.add(ch)
      const meta = CHANNEL_META.find((m) => m.id === ch)
      if (meta) byTab.add(meta.tab)
    }
    return { byChannel, byTab }
  }, [sessions])

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
      // 各 tab 只展示归属自己的来源分组；渠道/系统 tab 隐藏空分组，
      // 但系统 tab 的「自主进化」始终保留（提供固定聊天框入口）。
      if (meta.tab !== tab) continue
      const isEvolutionSystem = tab === 'system' && meta.id === 'evolution'
      if (tab !== 'default' && total === 0 && !isEvolutionSystem) continue
      visible.push({ meta, ...bucket, total })
    }

    return { isSearch, visible }
  }, [filteredSessions, searchQuery, tab])

  /** 可选 Agent 列表（用户 Agent + selectable 系统 Agent），用于默认 tab 的空组占位 */
  const selectableAgentList = useMemo(
    () =>
      agents
        .filter((a) => a.userId || a.selectable)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    [agents],
  )

  /**
   * 默认 tab 视图：把「系统默认」渠道的会话按 Agent 分组。
   * 系统默认（agentId 为空/default/assistant）恒为第一组且无标题；其余每个有会话的 Agent 一组，按最近活跃排序。
   * 非搜索态下没有会话的 Agent 也占位展示（含职责说明与「⋯」），便于发现和发起。
   *
   * 归属到具体 Agent 的定时任务记录（channel='cron'，如 chronicler 的「早间简报」）一并归入
   * 该 Agent 分组，便于用户查看与 Agent 回顾；系统默认 Agent 跑的后台任务（自主进化等）不进组，
   * 否则会把分组灌满后台记录。这些记录同时仍保留在「系统」tab 的「定时任务」分组下。
   */
  const agentGroups = useMemo(() => {
    if (tab !== 'default') return []
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const isSearch = Boolean(searchQuery.trim())

    const groups = new Map<
      string,
      {
        key: string
        agentId: string | null
        pinned: ChatSession[]
        sessions: ChatSession[]
        today: ChatSession[]
        yesterday: ChatSession[]
        earlier: ChatSession[]
        total: number
        latest: number
      }
    >()

    for (const session of filteredSessions) {
      const ch = normalizeChannel(session.channel)
      const isMain = isMainAgentSession(session.agentId)
      const belongsToAgentGroup = ch === 'default' || (ch === 'cron' && !isMain)
      if (!belongsToAgentGroup) continue
      const key = isMain ? '__main__' : session.agentId!
      let g = groups.get(key)
      if (!g) {
        g = { key, agentId: isMain ? null : session.agentId!, pinned: [], sessions: [], today: [], yesterday: [], earlier: [], total: 0, latest: 0 }
        groups.set(key, g)
      }
      g.total++
      g.latest = Math.max(g.latest, session.updatedAt.getTime())
      if (session.isPinned) {
        g.pinned.push(session)
        continue
      }
      if (isSearch) {
        if (isSameDay(session.updatedAt, today)) g.today.push(session)
        else if (isSameDay(session.updatedAt, yesterday)) g.yesterday.push(session)
        else g.earlier.push(session)
      } else {
        g.sessions.push(session)
      }
    }

    // 非搜索态：系统默认组恒存在，没有会话的成员 Agent 也占位（空组展示说明与「⋯」）
    if (!isSearch) {
      if (!groups.has('__main__')) {
        groups.set('__main__', {
          key: '__main__',
          agentId: null,
          pinned: [],
          sessions: [],
          today: [],
          yesterday: [],
          earlier: [],
          total: 0,
          latest: 0,
        })
      }
      for (const agent of selectableAgentList) {
        if (!groups.has(agent.id)) {
          groups.set(agent.id, {
            key: agent.id,
            agentId: agent.id,
            pinned: [],
            sessions: [],
            today: [],
            yesterday: [],
            earlier: [],
            total: 0,
            latest: 0,
          })
        }
      }
    }

    const sortByUpdated = (a: ChatSession, b: ChatSession) =>
      b.updatedAt.getTime() - a.updatedAt.getTime()
    const list = [...groups.values()]
    for (const g of list) {
      g.pinned.sort(sortByUpdated)
      g.sessions.sort(sortByUpdated)
      g.today.sort(sortByUpdated)
      g.yesterday.sort(sortByUpdated)
      g.earlier.sort(sortByUpdated)
    }
    // 系统默认组置顶；其余按最近活跃倒序；同为空的组按侧栏显示名排
    const labelOf = (g: (typeof list)[number]) =>
      resolveSidebarGroupLabel(
        g.agentId,
        g.agentId ? (agentsMap.get(g.agentId)?.name ?? g.agentId) : '默认',
      )
    list.sort((a, b) => {
      if (a.key === '__main__') return -1
      if (b.key === '__main__') return 1
      if (a.latest !== b.latest) return b.latest - a.latest
      return labelOf(a).localeCompare(labelOf(b), 'zh')
    })
    return list
  }, [filteredSessions, searchQuery, tab, selectableAgentList, agentsMap])

  /** 非搜索态会话列表：固定高度容器，约 5 条可见，滚轮在组内滑动分页（布局不动） */
  const renderSessionsScrollable = (groupKey: string, list: ChatSession[]) => (
    <div className={styles['group-scroll']} data-group={groupKey}>
      {renderSessionItems(list)}
    </div>
  )

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
   * 取某 Agent 分组的全量会话（不受搜索过滤影响，清空历史用）。
   *
   * 只含默认渠道：分组里同时展示的定时任务记录（channel='cron'）是任务产出，
   * 不参与「清空历史」，否则一条「清空全部历史」会把早间简报之类的记录连带删掉。
   */
  const sessionsOfAgentGroup = useCallback(
    (agentId: string | null) =>
      sessions.filter((s) => {
        if (normalizeChannel(s.channel) !== 'default') return false
        const isMain = isMainAgentSession(s.agentId)
        return agentId ? !isMain && s.agentId === agentId : isMain
      }),
    [sessions],
  )

  /** 取某渠道分组的全量会话（不受搜索过滤影响，清空历史用） */
  const sessionsOfChannelGroup = useCallback(
    (channel: SessionChannel) => sessions.filter((s) => normalizeChannel(s.channel) === channel),
    [sessions],
  )

  /**
   * 打开分组「⋯」菜单。
   * 默认 Tab 可附带「在此新建对话」；渠道/系统仅清空项。
   * 清空执行时跳过置顶与运行中会话（由 ChatPage 侧统一处理并二次确认）。
   */
  const openGroupMenu = useCallback(
    (
      e: React.MouseEvent,
      label: string,
      groupSessions: ChatSession[],
      options?: { createAgentId?: string | null },
    ) => {
      e.stopPropagation()
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const items: ContextMenuItem[] = []

      if (options && 'createAgentId' in options) {
        const agentId = options.createAgentId ?? null
        items.push({
          id: 'create-in-group',
          label: '在此新建对话',
          icon: <Plus size={14} strokeWidth={1.8} />,
          onClick: () => onCreateSessionInGroup(agentId),
        })
      }

      items.push(
        {
          id: 'clear-keep-recent',
          label: '清空历史（保留最近 5 条）',
          icon: <Trash2 size={14} strokeWidth={1.8} />,
          separatorBefore: items.length > 0,
          onClick: () => onClearGroupHistory({ label, sessions: groupSessions, keepRecent: 5 }),
        },
        {
          id: 'clear-all',
          label: '清空全部历史',
          icon: <Trash2 size={14} strokeWidth={1.8} />,
          danger: true,
          onClick: () => onClearGroupHistory({ label, sessions: groupSessions, keepRecent: null }),
        },
      )

      setGroupMenu({
        x: Math.max(8, rect.right - 168),
        y: rect.bottom + 4,
        items,
      })
    },
    [onClearGroupHistory, onCreateSessionInGroup],
  )

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
      <ChannelBindModal open={bindModalOpen} onClose={() => setBindModalOpen(false)} onGoToQbotSettings={handleGoToQbotSettings} />

      {groupMenu && (
        <ContextMenu
          items={groupMenu.items}
          position={{ x: groupMenu.x, y: groupMenu.y }}
          onClose={() => setGroupMenu(null)}
        />
      )}

      {/* 默认 / 渠道 / 系统 三态切换；有运行中 Agent 时显示脉冲点 */}
      <div className={styles['session-seg']} role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'default'}
          className={`${styles['seg-btn']}${tab === 'default' ? ` ${styles['seg-btn--active']}` : ''}`}
          onClick={() => setTab('default')}
        >
          默认
          {runningIndicators.byTab.has('default') && (
            <span className={styles['running-dot']} aria-label="有运行中的对话" />
          )}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'channel'}
          className={`${styles['seg-btn']}${tab === 'channel' ? ` ${styles['seg-btn--active']}` : ''}`}
          onClick={() => setTab('channel')}
        >
          渠道
          {runningIndicators.byTab.has('channel') && (
            <span className={styles['running-dot']} aria-label="有运行中的对话" />
          )}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'system'}
          className={`${styles['seg-btn']}${tab === 'system' ? ` ${styles['seg-btn--active']}` : ''}`}
          onClick={() => setTab('system')}
        >
          系统
          {runningIndicators.byTab.has('system') && (
            <span className={styles['running-dot']} aria-label="有运行中的对话" />
          )}
        </button>
      </div>

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
        {searchQuery.trim() && filteredSessions.length === 0 ? (
          <div className={styles['no-search-results']}>未找到匹配的会话</div>
        ) : tab === 'default' ? (
          agentGroups.length === 0 ? (
            <div className={styles['no-conversations']}>暂无会话，点击上方按钮创建</div>
          ) : (
            agentGroups.map((g) => {
              const collapseKey = `agent:${g.key}`
              const isCollapsed = collapsedChannels.has(collapseKey)
              const groupHasRunning = [...g.pinned, ...g.sessions].some((s) => s.isStreaming)
              const agentInfo = g.agentId ? agentsMap.get(g.agentId) : null
              const groupLabel = resolveSidebarGroupLabel(
                g.agentId,
                g.agentId ? (agentInfo?.name ?? g.agentId) : '默认',
              )
              const emptyDesc = resolveSidebarEmptyDesc(g.agentId, agentInfo?.description)
              return (
                <div key={g.key} className={styles['channel-group']}>
                  <div
                    className={`${styles['channel-group-label']} ${styles['channel-group-label--collapsible']}`}
                    onClick={() => toggleChannel(collapseKey)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      // 只在组头自身聚焦时响应；避免吞掉「⋯」按钮上的 Enter/空格
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleChannel(collapseKey)
                      }
                    }}
                  >
                    <span>{groupLabel}</span>
                    {g.total > 0 && <span className={styles['group-count']}>({g.total})</span>}
                    {isCollapsed && groupHasRunning && (
                      <span className={styles['running-dot']} aria-label="有运行中的对话" />
                    )}
                    <span className={styles['group-actions']}>
                      <button
                        type="button"
                        className={styles['group-action-btn']}
                        title={`「${groupLabel}」更多操作`}
                        aria-label={`「${groupLabel}」更多操作`}
                        onClick={(e) =>
                          openGroupMenu(e, groupLabel, sessionsOfAgentGroup(g.agentId), {
                            createAgentId: g.agentId,
                          })
                        }
                      >
                        <MoreHorizontal size={14} strokeWidth={1.8} />
                      </button>
                    </span>
                  </div>

                  <div
                    className={`${styles['channel-group-body']}${isCollapsed ? ` ${styles['channel-group-body--collapsed']}` : ''}`}
                  >
                    {g.total === 0 ? (
                      <div className={styles['group-empty-desc']}>{emptyDesc}</div>
                    ) : (
                      <>
                        {g.pinned.length > 0 && (
                          <div className={styles['channel-subgroup']}>
                            <div className={styles['channel-subgroup-label']}>置顶</div>
                            {renderSessionItems(g.pinned)}
                          </div>
                        )}
                        {channelGroups.isSearch ? (
                          <>
                            {renderTimeSubGroup('今天', g.today)}
                            {renderTimeSubGroup('昨天', g.yesterday)}
                            {renderTimeSubGroup('更早', g.earlier)}
                          </>
                        ) : (
                          renderSessionsScrollable(g.key, g.sessions)
                        )}
                      </>
                    )}
                  </div>
                </div>
              )
            })
          )
        ) : channelGroups.visible.length === 0 ? (
          <div className={styles['no-conversations']}>
            {tab === 'channel' ? '暂无渠道会话，先绑定渠道' : '暂无系统会话'}
          </div>
        ) : (
          channelGroups.visible.map((group) => {
            const key = group.meta.id
            const isCollapsed = collapsedChannels.has(key)
            const groupHasRunning = runningIndicators.byChannel.has(key)
            return (
              <div key={key} className={styles['channel-group']}>
                <div
                  className={`${styles['channel-group-label']} ${styles['channel-group-label--collapsible']}`}
                  onClick={() => toggleChannel(key)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    // 只在组头自身聚焦时响应；避免吞掉「⋯」按钮上的 Enter/空格
                    if (e.target !== e.currentTarget) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggleChannel(key)
                    }
                  }}
                >
                  <span className={styles['group-icon']}>{group.meta.icon}</span>
                  <span>{group.meta.label}</span>
                  <span className={styles['group-count']}>({group.total})</span>
                  {isCollapsed && groupHasRunning && (
                    <span className={styles['running-dot']} aria-label="有运行中的对话" />
                  )}
                  <span className={styles['group-actions']}>
                    {/* 自主进化会话不可删除（主进程守卫），不提供清空菜单 */}
                    {key !== 'evolution' && (
                      <button
                        type="button"
                        className={styles['group-action-btn']}
                        title={`「${group.meta.label}」更多操作`}
                        aria-label={`「${group.meta.label}」更多操作`}
                        onClick={(e) => openGroupMenu(e, group.meta.label, sessionsOfChannelGroup(key))}
                      >
                        <MoreHorizontal size={14} strokeWidth={1.8} />
                      </button>
                    )}
                  </span>
                </div>

                <div
                  className={`${styles['channel-group-body']}${isCollapsed ? ` ${styles['channel-group-body--collapsed']}` : ''}`}
                >
                  {group.total === 0 ? (
                    group.meta.id === 'evolution' && tab === 'system' ? (
                      <button
                        type="button"
                        className={styles['evolution-entry']}
                        onClick={() => onSelectSession('evolution:main')}
                      >
                        <span className={styles['evolution-entry-glyph']}>进化</span>
                        <span className={styles['evolution-entry-label']}>进入自主进化</span>
                      </button>
                    ) : (
                      <div className={styles['channel-empty']}>暂无会话</div>
                    )
                  ) : (
                    <>
                      {group.pinned.length > 0 && (
                        <div className={styles['channel-subgroup']}>
                          <div className={styles['channel-subgroup-label']}>置顶</div>
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
                        renderSessionsScrollable(`ch:${key}`, group.sessions)
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* 列表底部主操作：默认 tab 新建对话，渠道 tab 绑定渠道，系统 tab 无操作 */}
      {tab !== 'system' && (
        <div className={styles['sidebar-footer']}>
          {tab === 'default' ? (
            <button className={styles['footer-btn']} onClick={onCreateSession} aria-label="新建对话">
              <span className={styles['footer-btn-glyph']}>+</span>
              新建对话
            </button>
          ) : (
            <button className={styles['footer-btn']} onClick={() => setBindModalOpen(true)}>
              绑定渠道
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const ChatSidebarMemo = React.memo(ChatSidebar)
ChatSidebarMemo.displayName = 'ChatSidebar'

export default ChatSidebarMemo
export { ChatSidebarMemo as ChatSidebar }
