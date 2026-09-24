/**
 * AgentUsageView — 「按 Agent」看工具用量
 *
 * 回答的是「某个工具到底有没有人用」，这是逐 Agent 收敛工具面的唯一依据。
 * 全局累计计数答不了这个问题——维护的 wiki_read 用没用过，混在所有人的合计里看不出来。
 *
 * **两种口径来自两张表，刻意不互相兜底**：
 * - 累计 → `tool_usage_stats`
 * - 最近 N 天 → `tool_usage_daily`（V46 起才有）
 * 拿累计数当「最近在用」用，就是 B1 那个坑（把历史存量当成当前状态）的复发。
 *
 * 数据在主进程就算好、排好序了（含 Agent 显示名），这里只管画。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Loading } from '../../components/ui/Loading/Loading'
import { Empty } from '../../components/ui/Empty/Empty'
import { Select } from '../../components/ui/Select/Select'
import { builtinToolLabel } from '../../hooks/business/useToolSearch'
import styles from './ToolsPage.module.css'

interface AgentToolUsageRow {
  name: string
  count: number
  errorCount: number
  lastUsedAt: number
}

interface AgentUsage {
  id: string
  name: string
  totalCalls: number
  tools: AgentToolUsageRow[]
}

type AgentUsageList = readonly AgentUsage[]

/** 0 = 累计。按日统计有保留期，这里不提供超过保留期的窗口 */
const WINDOW_OPTIONS = [
  { value: '0', label: '累计' },
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
] as const

/** 紧凑时间：同年只显示月-日 时:分，免得一列全是重复的年份 */
function formatLastUsed(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return sameYear ? `${mm}-${dd} ${hh}:${mi}` : `${d.getFullYear()}-${mm}-${dd}`
}

export const AgentUsageView: React.FC = () => {
  const [agents, setAgents] = useState<AgentUsageList | null>(null)
  const [selectedId, setSelectedId] = useState<string>('')
  const [days, setDays] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)

  const load = useCallback(async (windowDays: number) => {
    setLoadFailed(false)
    setAgents(null)
    try {
      const command =
        windowDays > 0
          ? ({ type: 'tools:usage-by-agent', days: windowDays } as const)
          : ({ type: 'tools:usage-by-agent' } as const)
      const result = (await window.electronAPI.agentRuntime.sendCommand(command)) as AgentUsageList
      const list = result ?? []
      setAgents(list)
      setSelectedId((prev) => (prev && list.some((a) => a.id === prev) ? prev : (list[0]?.id ?? '')))
    } catch {
      setLoadFailed(true)
      setAgents([])
    }
  }, [])

  useEffect(() => {
    void load(days)
  }, [load, days])

  const selected = useMemo(
    () => agents?.find((a) => a.id === selectedId) ?? null,
    [agents, selectedId],
  )

  const windowLabel = WINDOW_OPTIONS.find((o) => Number(o.value) === days)?.label ?? '累计'

  return (
    <div className={styles.usageView}>
      <div className={styles.usageToolbar}>
        <Select
          className={styles.usageSelect}
          value={String(days)}
          onChange={(e) => setDays(Number(e.target.value))}
          options={WINDOW_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
        {agents !== null && agents.length > 0 && (
          <Select
            className={styles.usageSelect}
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            options={agents.map((a) => ({
              value: a.id,
              label: `${a.name}（${a.totalCalls} 次）`,
            }))}
          />
        )}
        {selected && (
          <span className={styles.usageSummary}>
            {selected.tools.length} 个工具 · {windowLabel}共 {selected.totalCalls} 次
          </span>
        )}
      </div>

      {agents === null ? (
        <Loading text="加载用量中..." />
      ) : loadFailed ? (
        <Empty description="用量读取失败，稍后重试" />
      ) : agents.length === 0 ? (
        <Empty description={emptyDescription(days)} />
      ) : selected && selected.tools.length === 0 ? (
        <Empty description={`「${selected.name}」${windowLabel}没有调用过工具`} />
      ) : (
        <div className={styles.usageList}>
          {selected?.tools.map((tool) => (
            <div key={tool.name} className={styles.usageRow}>
              <div className={styles.usageTool}>
                <span className={styles.usageToolName}>{tool.name}</span>
                {builtinToolLabel(tool.name) && (
                  <span className={styles.usageToolLabel}>{builtinToolLabel(tool.name)}</span>
                )}
              </div>
              <div className={styles.usageStats}>
                <span className={styles.usageCount}>
                  {windowLabel === '累计' ? `${tool.count} 次` : `${windowLabel} ${tool.count} 次`}
                </span>
                {tool.errorCount > 0 && (
                  <span className={styles.usageErrors}>失败 {tool.errorCount}</span>
                )}
                <span className={styles.usageLast}>{formatLastUsed(tool.lastUsedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 窗口口径下「空」有两种原因，别让用户分不清是没数据还是没干活：
 * 按日统计是 V46 才建的表，升级前的历史只在「累计」里。
 */
function emptyDescription(days: number): string {
  if (days === 0) return '还没有任何工具调用记录——让任意 Agent 干点活再回来'
  return `最近 ${days} 天没有工具调用记录。按日统计是本次升级后才开始累积的，更早的历史只在「累计」里看得到。`
}
