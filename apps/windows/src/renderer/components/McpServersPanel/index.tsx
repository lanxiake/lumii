/**
 * MCP 服务设置面板
 *
 * 一行一个 Server：状态点 + 名称 + 命令摘要 + 工具数 + 启用开关 + 更多操作。
 * 配置改动即时生效（主进程会断开重连），不需要重启客户端。
 */

import React, { useMemo, useState } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, Ellipsis, Plus, RefreshCw } from 'lucide-react'
import { Button, Empty, Input, Loading, Switch } from '../ui'
import { useToolSearch } from '../../hooks/business/useToolSearch'
import { ConfirmModal } from '../ui/Modal/ConfirmModal'
import type { McpServerConfigInput } from '@shared/agent-runtime-commands'
import { McpServerEditModal } from './McpServerEditModal'
import { type McpServer, useMcpServers } from './useMcpServers'
import styles from './McpServersPanel.module.css'

/** 命令 + 参数拼成一行摘要 */
function commandSummary(server: McpServer): string {
  return [server.command, ...(server.args ?? [])].join(' ')
}

function statusText(server: McpServer): string {
  if (server.enabled === false) return '已停用'
  if (server.connecting) return '连接中'
  if (server.connected) return '已连接'
  return server.lastError ? '连接失败' : '未连接'
}

/** 状态点的 class：停用灰、失败红、已连接绿、其余黄 */
function statusClass(server: McpServer): string {
  if (server.enabled === false) return styles['dot-off']
  if (server.connected) return styles['dot-on']
  if (server.lastError) return styles['dot-error']
  return styles['dot-pending']
}

export const McpServersPanel: React.FC = () => {
  const { servers, isLoading, error, busyName, refresh, upsert, importServers, remove, setEnabled, reconnect } =
    useMcpServers()
  // 工具的单个开关沿用现成的 tools:toggle，不另造一套
  const { tools, togglingTool, toggleTool, refresh: refreshTools } = useToolSearch()
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<McpServerConfigInput | undefined>(undefined)
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null)
  const [removingName, setRemovingName] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')

  const connectedCount = servers.filter((s) => s.connected).length
  const toolCount = servers.reduce((sum, s) => sum + s.tools.length, 0)

  /** 工具名 → 工具详情，用于展开区渲染 label/description/开关 */
  const toolByName = useMemo(() => new Map(tools.map((t) => [t.name, t])), [tools])

  /** 该 Server 有多少工具处于启用态（工具列表还没加载时按全部可用算） */
  const enabledCount = (server: McpServer) =>
    server.tools.filter((name) => toolByName.get(name)?.enabled !== false).length

  /**
   * 搜索同时命中 Server 与工具：
   * 命中 Server 名/命令则整条保留；只命中工具则该条只留匹配的工具并自动展开。
   */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return servers.map((server) => ({ server, tools: server.tools, matchedByTool: false }))

    const result: Array<{ server: McpServer; tools: readonly string[]; matchedByTool: boolean }> = []
    for (const server of servers) {
      const serverHit = server.name.toLowerCase().includes(q) || commandSummary(server).toLowerCase().includes(q)
      const hitTools = server.tools.filter((name) => {
        const tool = toolByName.get(name)
        return (
          name.toLowerCase().includes(q) ||
          tool?.label.toLowerCase().includes(q) ||
          tool?.description.toLowerCase().includes(q)
        )
      })
      if (serverHit) result.push({ server, tools: server.tools, matchedByTool: false })
      else if (hitTools.length) result.push({ server, tools: hitTools, matchedByTool: true })
    }
    return result
  }, [servers, query, toolByName])

  const toggleExpand = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  /** 配置变更后工具列表也会变，两边一起刷 */
  const refreshAll = () => {
    void refresh()
    void refreshTools()
  }

  const openAdd = () => { setEditing(undefined); setEditOpen(true) }
  const openEdit = (server: McpServer) => {
    setMenuOpenFor(null)
    // 只带上配置字段，运行时状态不进表单
    setEditing({
      name: server.name,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      enabled: server.enabled,
    })
    setEditOpen(true)
  }

  /** 单条走 upsert（支持改名），粘贴多条走 import */
  const handleSubmit = async (entries: readonly McpServerConfigInput[], originalName?: string) => {
    const result = entries.length === 1 ? await upsert(entries[0]!, originalName) : await importServers(entries)
    if (result.success) void refreshTools()
    return result
  }

  /** 包一层：写操作成功后同步刷新工具列表 */
  const withToolRefresh = async (run: Promise<{ success: boolean }>) => {
    const result = await run
    if (result.success) void refreshTools()
  }

  return (
    <div className={styles['panel']}>
      <div className={styles['panel-head']}>
        <div>
          <h3 className={styles['panel-title']}>MCP 服务</h3>
          <p className={styles['panel-sub']}>
            {servers.length === 0
              ? '通过 Model Context Protocol 接入外部工具'
              : `已连接 ${connectedCount}/${servers.length} 个 Server，提供 ${toolCount} 个工具`}
          </p>
        </div>
        <div className={styles['panel-actions']}>
          <Button variant="ghost" size="sm" onClick={refreshAll} title="刷新状态">
            <RefreshCw size={14} />
          </Button>
          <Button size="sm" onClick={openAdd}>
            <Plus size={14} /> 添加
          </Button>
        </div>
      </div>

      {servers.length > 0 && (
        <Input
          className={styles['panel-search']}
          placeholder="搜索 Server 或工具..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {error && (
        <div className={styles['panel-error']}>
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {isLoading ? (
        <Loading text="读取 MCP 配置中..." />
      ) : servers.length === 0 ? (
        <Empty description="还没有配置 MCP Server，点「添加」粘贴官方配置即可" />
      ) : visible.length === 0 ? (
        <Empty description="没有匹配的 Server 或工具" />
      ) : (
        <ul className={styles['server-list']}>
          {visible.map(({ server, tools: shownTools, matchedByTool }) => {
          // 搜索命中工具时自动展开，让用户直接看到结果
          const isOpen = expanded.has(server.name) || matchedByTool
          return (
            <li key={server.name} className={styles['server-item']}>
            <div className={styles['server-row']}>
              <button
                type="button"
                className={styles['expand-btn']}
                aria-expanded={isOpen}
                aria-label={`${isOpen ? '收起' : '展开'} ${server.name} 的工具`}
                disabled={server.tools.length === 0}
                onClick={() => toggleExpand(server.name)}
              >
                {server.tools.length === 0
                  ? <span className={styles['expand-placeholder']} />
                  : isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>

              <span className={`${styles['dot']} ${statusClass(server)}`} aria-hidden />

              <div className={styles['server-main']}>
                <div className={styles['server-title-row']}>
                  <span className={styles['server-name']}>{server.name}</span>
                  <span className={styles['server-status']}>{statusText(server)}</span>
                  {server.tools.length > 0 && (
                    <button
                      type="button"
                      className={styles['tool-count']}
                      onClick={() => toggleExpand(server.name)}
                    >
                      {enabledCount(server)}/{server.tools.length} 个工具可用
                    </button>
                  )}
                </div>
                <code className={styles['server-command']}>{commandSummary(server)}</code>
                {server.lastError && server.enabled !== false && (
                  <span className={styles['server-error']}>{server.lastError}</span>
                )}
              </div>

              <Switch
                checked={server.enabled !== false}
                disabled={busyName === server.name}
                onChange={(checked) => void withToolRefresh(setEnabled(server.name, checked))}
              />

              <div className={menuOpenFor === server.name ? styles['menu-wrap-open'] : styles['menu-wrap']}>
                <button
                  type="button"
                  className={styles['menu-trigger']}
                  aria-label={`${server.name} 更多操作`}
                  onClick={() => setMenuOpenFor(menuOpenFor === server.name ? null : server.name)}
                >
                  <Ellipsis size={16} />
                </button>
                {menuOpenFor === server.name && (
                  <>
                    <div className={styles['menu-mask']} onClick={() => setMenuOpenFor(null)} />
                    <div className={styles['menu']} role="menu">
                      <button type="button" role="menuitem" onClick={() => openEdit(server)}>编辑</button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => { setMenuOpenFor(null); void withToolRefresh(reconnect(server.name)) }}
                      >
                        重新连接
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles['menu-danger']}
                        onClick={() => { setMenuOpenFor(null); setRemovingName(server.name) }}
                      >
                        删除
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {isOpen && (
              <ul className={styles['tool-list']}>
                {shownTools.length === 0 ? (
                  <li className={styles['tool-empty']}>该 Server 未提供工具</li>
                ) : (
                  shownTools.map((toolName) => {
                    const tool = toolByName.get(toolName)
                    // 去掉 mcp__<server>__ 前缀，只显示工具本名
                    const shortName = toolName.replace(`mcp__${server.name}__`, '')
                    const on = tool?.enabled !== false
                    const locked = !tool || togglingTool === toolName || server.enabled === false
                    return (
                      <li key={toolName}>
                        <button
                          type="button"
                          className={on ? styles['tool-chip'] : styles['tool-chip-off']}
                          // 悬浮看说明；没有说明就退回工具全名
                          title={tool?.description || toolName}
                          aria-pressed={on}
                          disabled={locked}
                          onClick={() => void toggleTool(toolName, !on)}
                        >
                          <span className={styles['tool-chip-mark']} aria-hidden>{on ? '✓' : '✕'}</span>
                          <span className={styles['tool-chip-name']}>{shortName}</span>
                        </button>
                      </li>
                    )
                  })
                )}
              </ul>
            )}
            </li>
          )})}
        </ul>
      )}

      <p className={styles['panel-foot']}>
        配置存于 <code>~/.lumii/config/mcp-servers.json</code>，格式与其他 MCP 客户端一致。
      </p>

      <McpServerEditModal
        open={editOpen}
        editing={editing}
        onClose={() => setEditOpen(false)}
        onSubmit={handleSubmit}
      />

      <ConfirmModal
        open={removingName !== null}
        title="删除 MCP Server"
        content={`确定删除「${removingName}」？它提供的工具会立即从工具列表移除。`}
        confirmText="删除"
        confirmVariant="danger"
        layer="elevated"
        onCancel={() => setRemovingName(null)}
        onConfirm={() => {
          const name = removingName
          setRemovingName(null)
          if (name) void withToolRefresh(remove(name))
        }}
      />
    </div>
  )
}
