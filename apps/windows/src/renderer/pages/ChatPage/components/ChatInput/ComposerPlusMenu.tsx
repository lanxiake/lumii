/**
 * ComposerPlusMenu — 输入框左侧「+」统一入口
 *
 * 主菜单：添加附件 / 技能 / MCP / 切换 Agent
 * 子面板：搜索 + 启用禁用或选择 Agent，底部「管理」跳转对应页面。
 * MCP 开关是**会话级**的（设置页里的是全局总开关），同一批 server 可在不同会话按需带。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import styles from './ComposerPlusMenu.module.css'
import type { Agent } from '../../../../services/agent-service'
import { useSkills } from '../../../../hooks/business/useSkills'
import { useToolSearch } from '../../../../hooks/business/useToolSearch'
import { useAgentRuntimeGlobalState } from '../../../../hooks/business/useAgentRuntime'
import { formatTokenCount } from '../../../../utils/format-token-count'
import Switch from '../../../../components/ui/Switch/Switch'
import { isMcpEnabledForSession } from './mcp-session-state'

export type ComposerPlusPanel = 'main' | 'skills' | 'mcp' | 'agents'

export interface ComposerPlusMenuProps {
  disabled?: boolean
  /** 触发统一附件选择器 */
  onAttachFiles: () => void
  agents?: Agent[]
  selectedAgent?: Agent | null
  agentsLoading?: boolean
  onAgentChange?: (agent: Agent | null) => void
  /** 跳转技能中心「我的技能」 */
  onManageSkills?: () => void
  /** 跳转技能中心「MCP」Tab */
  onManageMcp?: () => void
  /** 跳转 Agent 管理页 */
  onManageAgents?: () => void
  /** 打开 Wiki 资料库 */
  onOpenWiki?: () => void
}

/**
 * 从 MCP 工具名解析 server 名：`mcp__{server}__{tool}`
 */
function parseMcpServerName(toolName: string): string | null {
  const parts = toolName.split('__')
  return parts.length >= 3 && parts[0] === 'mcp' ? parts[1] : null
}

/**
 * Composer 左侧「+」菜单：附件 + 技能/MCP/Agent 快捷管理
 */
const ComposerPlusMenu: React.FC<ComposerPlusMenuProps> = ({
  disabled = false,
  onAttachFiles,
  agents = [],
  selectedAgent = null,
  agentsLoading = false,
  onAgentChange,
  onManageSkills,
  onManageMcp,
  onManageAgents,
  onOpenWiki,
}) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [panel, setPanel] = useState<ComposerPlusPanel>('main')
  const [query, setQuery] = useState('')
  const [togglingSkillId, setTogglingSkillId] = useState<string | null>(null)
  /** 本会话禁用的 MCP server（设置页开关是全局默认，这里是会话覆盖） */
  const [sessionDisabledMcp, setSessionDisabledMcp] = useState<readonly string[]>([])
  /** 本会话禁用的技能 id（技能中心的启用状态是全局默认） */
  const [sessionDisabledSkills, setSessionDisabledSkills] = useState<readonly string[]>([])
  const [togglingMcpServer, setTogglingMcpServer] = useState<string | null>(null)
  const sessionKey = useAgentRuntimeGlobalState((s) => s.currentSessionKey)

  // 打开菜单时拉一次会话禁用集：会话可能在别处被改过
  useEffect(() => {
    if (!open || !sessionKey) return
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return
    void (async () => {
      const [mcp, skills] = await Promise.all([
        api.sendCommand({ type: 'mcp:sessionDisabled', sessionKey }).catch(() => null),
        api.sendCommand({ type: 'skill:sessionDisabled', sessionKey }).catch(() => null),
      ])
      setSessionDisabledMcp((mcp as { disabledServers?: readonly string[] })?.disabledServers ?? [])
      setSessionDisabledSkills((skills as { disabledSkills?: readonly string[] })?.disabledSkills ?? [])
    })()
  }, [open, sessionKey])

  const { installedSkills, isLoading: skillsLoading } = useSkills()
  const {
    tools,
    mcpStatus,
    isLoading: toolsLoading,
    refresh: refreshTools,
  } = useToolSearch()

  /** 关闭菜单并复位到主面板 */
  const closeMenu = useCallback(() => {
    setOpen(false)
    setPanel('main')
    setQuery('')
  }, [])

  /** 打开/关闭主菜单 */
  const toggleOpen = useCallback(() => {
    if (disabled) return
    setOpen((prev) => {
      if (prev) {
        setPanel('main')
        setQuery('')
        return false
      }
      return true
    })
  }, [disabled])

  /** 进入子面板时清空搜索并聚焦 */
  const openPanel = useCallback((next: ComposerPlusPanel) => {
    setPanel(next)
    setQuery('')
    if (next === 'mcp') {
      void refreshTools()
    }
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [refreshTools])

  /** 点击外部关闭 */
  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        closeMenu()
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (panel !== 'main') {
          setPanel('main')
          setQuery('')
        } else {
          closeMenu()
        }
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open, panel, closeMenu])

  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return installedSkills
    return installedSkills.filter((s) => {
      const name = s.skill?.name ?? ''
      const desc = s.skill?.description ?? ''
      return name.toLowerCase().includes(q) || desc.toLowerCase().includes(q) || s.skillItemId.toLowerCase().includes(q)
    })
  }, [installedSkills, query])

  /** MCP：按 server 聚合工具，支持搜索 server / 工具名 */
  const mcpServers = useMemo(() => {
    const channelTools = tools.filter((t) => t.category === 'channel')
    const byServer = new Map<string, typeof channelTools>()
    for (const tool of channelTools) {
      const server = parseMcpServerName(tool.name)
      if (!server) continue
      const list = byServer.get(server) ?? []
      list.push(tool)
      byServer.set(server, list)
    }
    // 确保 mcpStatus 中的 server 也出现（即使暂无工具）
    for (const status of mcpStatus) {
      if (!byServer.has(status.name)) {
        byServer.set(status.name, [])
      }
    }
    const q = query.trim().toLowerCase()
    return Array.from(byServer.entries())
      .map(([name, serverTools]) => {
        const status = mcpStatus.find((s) => s.name === name)
        const disabledInSession = sessionDisabledMcp.includes(name)
        return {
          name,
          connected: status?.connected ?? false,
          serverEnabled: status?.enabled ?? true,
          lastError: status?.lastError,
          tools: serverTools,
          // 会话级开关：全局启用且本会话未禁用才算开
          enabled: isMcpEnabledForSession(name, sessionDisabledMcp),
          estimatedTokens: status?.estimatedTokens ?? 0,
          usageCount: serverTools.reduce((sum, t) => sum + (t.usageCount ?? 0), 0),
        }
      })
      .filter((row) => {
        if (!q) return true
        if (row.name.toLowerCase().includes(q)) return true
        return row.tools.some(
          (t) => t.name.toLowerCase().includes(q) || t.label.toLowerCase().includes(q),
        )
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [tools, mcpStatus, query, sessionDisabledMcp])

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return agents
    return agents.filter((a) => a.name.toLowerCase().includes(q))
  }, [agents, query])

  /**
   * 会话级启停技能。
   *
   * 只改本会话，不动技能中心的全局启用状态——同一批技能可在不同会话按需带。
   * 主进程会让该会话实例失效，下轮消息按新技能清单重建提示词。
   */
  const handleToggleSkill = useCallback(async (skillItemId: string, enabled: boolean) => {
    if (!sessionKey) return
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return
    setTogglingSkillId(skillItemId)
    try {
      const res = (await api.sendCommand({
        type: 'skill:setSessionEnabled',
        sessionKey,
        skillId: skillItemId,
        enabled,
      })) as { disabledSkills: readonly string[] }
      setSessionDisabledSkills(res.disabledSkills ?? [])
    } finally {
      setTogglingSkillId(null)
    }
  }, [sessionKey])

  /**
   * 会话级启停某个 MCP Server。
   *
   * 只改本会话，不动设置页的全局开关——同一批 MCP 在不同会话里按需带。
   * 主进程会让该会话实例失效，下轮消息按新工具列表重建。
   */
  const handleToggleMcpServer = useCallback(async (serverName: string, enabled: boolean) => {
    if (!sessionKey) return
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return
    setTogglingMcpServer(serverName)
    try {
      const res = (await api.sendCommand({
        type: 'mcp:setSessionEnabled',
        sessionKey,
        name: serverName,
        enabled,
      })) as { disabledServers: readonly string[] }
      setSessionDisabledMcp(res.disabledServers ?? [])
    } finally {
      setTogglingMcpServer(null)
    }
  }, [sessionKey])

  /** 选择 Agent 后关闭菜单 */
  const handleSelectAgent = useCallback((agent: Agent | null) => {
    onAgentChange?.(agent)
    closeMenu()
  }, [onAgentChange, closeMenu])

  const currentAgentLabel = selectedAgent?.name ?? '系统默认'

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={clsx(styles.plusBtn, open && styles.plusBtnActive)}
        onClick={toggleOpen}
        disabled={disabled}
        aria-label="添加附件、技能与 Agent"
        title={`添加附件 / 技能 / MCP / Agent（当前：${currentAgentLabel}）`}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          {panel === 'main' && (
            <>
              <button
                type="button"
                className={styles.menuItem}
                role="menuitem"
                onClick={() => {
                  onAttachFiles()
                  closeMenu()
                }}
              >
                <span className={styles.menuIcon} aria-hidden>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
                </span>
                <span className={styles.menuLabel}>添加文件或图片</span>
                <kbd className={styles.menuHint}>Ctrl+U</kbd>
              </button>

              <button type="button" className={styles.menuItem} role="menuitem" onClick={() => openPanel('skills')}>
                <span className={styles.menuIcon} aria-hidden>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
                </span>
                <span className={styles.menuLabel}>技能</span>
                <span className={styles.menuChevron} aria-hidden>›</span>
              </button>

              <button type="button" className={styles.menuItem} role="menuitem" onClick={() => openPanel('mcp')}>
                <span className={styles.menuIcon} aria-hidden>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
                </span>
                <span className={styles.menuLabel}>MCP 服务</span>
                <span className={styles.menuChevron} aria-hidden>›</span>
              </button>

              <button type="button" className={styles.menuItem} role="menuitem" onClick={() => openPanel('agents')}>
                <span className={styles.menuIcon} aria-hidden>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8c-2.5 0-4.5 2-4.5 4.5V18h9v-5.5C16.5 10 14.5 8 12 8z" /><path d="M9 18v2h6v-2" /><circle cx="12" cy="5" r="2" /></svg>
                </span>
                <span className={styles.menuLabel}>切换 Agent</span>
                <span className={styles.menuMeta}>{currentAgentLabel}</span>
                <span className={styles.menuChevron} aria-hidden>›</span>
              </button>

              {onOpenWiki && (
                <button
                  type="button"
                  className={styles.menuItem}
                  role="menuitem"
                  onClick={() => {
                    onOpenWiki()
                    closeMenu()
                  }}
                >
                  <span className={styles.menuIcon} aria-hidden>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>
                  </span>
                  <span className={styles.menuLabel}>打开资料库</span>
                </button>
              )}
            </>
          )}

          {panel === 'skills' && (
            <SubPanel
              title="技能"
              query={query}
              onQueryChange={setQuery}
              searchPlaceholder="搜索技能…"
              searchInputRef={searchInputRef}
              onBack={() => { setPanel('main'); setQuery('') }}
              manageLabel="管理技能"
              onManage={() => { onManageSkills?.(); closeMenu() }}
            >
              {skillsLoading ? (
                <div className={styles.empty}>加载中…</div>
              ) : filteredSkills.length === 0 ? (
                <div className={styles.empty}>{query ? '没有匹配的技能' : '暂无已安装技能'}</div>
              ) : (
                filteredSkills.map((skill) => {
                  const name = skill.skill?.name || skill.skillItemId
                  const busy = togglingSkillId === skill.skillItemId
                  return (
                    <div key={skill.id} className={styles.listRow}>
                      <div className={styles.listMain}>
                        <span className={styles.listName} title={skill.skill?.description}>{name}</span>
                        {!skill.isEnabled ? (
                          <span className={styles.listDesc}>已在技能中心全局停用</span>
                        ) : skill.skill?.description ? (
                          <span className={styles.listDesc}>{skill.skill.description}</span>
                        ) : null}
                      </div>
                      <Switch
                        size="sm"
                        checked={skill.isEnabled && !sessionDisabledSkills.includes(skill.skillItemId)}
                        disabled={busy || !skill.isEnabled}
                        onChange={(checked) => void handleToggleSkill(skill.skillItemId, checked)}
                      />
                    </div>
                  )
                })
              )}
            </SubPanel>
          )}

          {panel === 'mcp' && (
            <SubPanel
              title="MCP 服务"
              query={query}
              onQueryChange={setQuery}
              searchPlaceholder="搜索 MCP…"
              searchInputRef={searchInputRef}
              onBack={() => { setPanel('main'); setQuery('') }}
              manageLabel="管理 MCP"
              onManage={() => { onManageMcp?.(); closeMenu() }}
            >
              {toolsLoading && mcpServers.length === 0 ? (
                <div className={styles.empty}>加载中…</div>
              ) : mcpServers.length === 0 ? (
                <div className={styles.empty}>{query ? '没有匹配的 MCP' : '暂无 MCP 服务'}</div>
              ) : (
                mcpServers.map((server) => {
                  const busy = togglingMcpServer === server.name
                  const errorHint = server.serverEnabled && !server.connected ? server.lastError : undefined
                  return (
                    <div key={server.name} className={styles.listRow}>
                      <div className={styles.listMain}>
                        <span className={styles.listName}>
                          {server.name}
                          {errorHint ? (
                            <span className={styles.listNameError} title={errorHint}>
                              {' '}· {errorHint}
                            </span>
                          ) : null}
                        </span>
                        <span className={clsx(
                          styles.listDesc,
                          !server.serverEnabled ? undefined : !server.connected && styles.listDescError,
                        )}>
                          {!server.serverEnabled
                            ? '已在设置中全局停用'
                            : server.connected
                              ? `${server.tools.length} 个工具${server.estimatedTokens > 0 ? ` · 占用 ${formatTokenCount(server.estimatedTokens)}` : ''} · 调用 ${server.usageCount} 次`
                              : errorHint
                                ? '连接失败'
                                : '未连接'}
                        </span>
                      </div>
                      {server.tools.length > 0 || server.serverEnabled ? (
                        <Switch
                          size="sm"
                          checked={server.enabled}
                          disabled={busy || !server.serverEnabled || !sessionKey}
                          onChange={(checked) => void handleToggleMcpServer(server.name, checked)}
                        />
                      ) : (
                        <span className={styles.listStatus} title={errorHint}>
                          {!server.serverEnabled ? '已停用' : server.connected ? '无工具' : '连接失败'}
                        </span>
                      )}
                    </div>
                  )
                })
              )}
            </SubPanel>
          )}

          {panel === 'agents' && (
            <SubPanel
              title="切换 Agent"
              query={query}
              onQueryChange={setQuery}
              searchPlaceholder="搜索 Agent…"
              searchInputRef={searchInputRef}
              onBack={() => { setPanel('main'); setQuery('') }}
              manageLabel="管理 Agent"
              onManage={() => { onManageAgents?.(); closeMenu() }}
            >
              {agentsLoading ? (
                <div className={styles.empty}>加载中…</div>
              ) : (
                <>
                  {(!query.trim() || '系统默认'.includes(query.trim())) && (
                    <button
                      type="button"
                      className={clsx(styles.selectRow, !selectedAgent && styles.selectRowActive)}
                      onClick={() => handleSelectAgent(null)}
                    >
                      <span className={styles.listName}>系统默认</span>
                      {!selectedAgent && <span className={styles.checkMark} aria-hidden>✓</span>}
                    </button>
                  )}
                  {filteredAgents.length === 0 && query.trim() ? (
                    <div className={styles.empty}>没有匹配的 Agent</div>
                  ) : (
                    filteredAgents.map((agent) => (
                      <button
                        type="button"
                        key={agent.id}
                        className={clsx(
                          styles.selectRow,
                          selectedAgent?.id === agent.id && styles.selectRowActive,
                        )}
                        onClick={() => handleSelectAgent(agent)}
                      >
                        <span className={styles.listName}>{agent.name}</span>
                        {selectedAgent?.id === agent.id && (
                          <span className={styles.checkMark} aria-hidden>✓</span>
                        )}
                      </button>
                    ))
                  )}
                </>
              )}
            </SubPanel>
          )}
        </div>
      )}
    </div>
  )
}

interface SubPanelProps {
  title: string
  query: string
  onQueryChange: (q: string) => void
  searchPlaceholder: string
  searchInputRef: React.Ref<HTMLInputElement>
  onBack: () => void
  manageLabel: string
  onManage?: () => void
  children: React.ReactNode
}

/** 子面板：返回 + 搜索 + 列表 + 管理入口 */
function SubPanel({
  title,
  query,
  onQueryChange,
  searchPlaceholder,
  searchInputRef,
  onBack,
  manageLabel,
  onManage,
  children,
}: SubPanelProps) {
  return (
    <div className={styles.subPanel}>
      <div className={styles.subHeader}>
        <button type="button" className={styles.backBtn} onClick={onBack} aria-label="返回">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <input
          ref={searchInputRef}
          className={styles.searchInput}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
        />
        {onManage && (
          <button type="button" className={styles.manageLink} onClick={onManage} title={manageLabel}>
            管理
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        )}
      </div>
      <div className={styles.subTitle}>{title}</div>
      <div className={styles.listScroll}>{children}</div>
    </div>
  )
}

const ComposerPlusMenuMemo = React.memo(ComposerPlusMenu)
ComposerPlusMenuMemo.displayName = 'ComposerPlusMenu'

export default ComposerPlusMenuMemo
export { ComposerPlusMenuMemo as ComposerPlusMenu }
