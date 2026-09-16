/**
 * AgentUsageView — 「按 Agent」看工具用量
 *
 * 回答的是「某个工具到底有没有人用」，这是逐 Agent 收敛工具面的唯一依据。
 * 全局累计计数答不了这个问题——维护的 wiki_read 用没用过，混在所有人的合计里看不出来。
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
  const [agents, setAgents] = useState<readonly AgentUsage[] | null>(null)
  const [selectedId, setSelectedId] = useState<string>('')
  const [loadFailed, setLoadFailed] = useState(false)

  const load = useCallback(async () => {
    setLoadFailed(false)
    try {
      const result = (await window.electronAPI.agentRuntime.sendCommand({
        type: 'tools:usage-by-agent',
      })) as AgentUsageList
      const list = result ?? []
      setAgents(list)
      setSelectedId((prev) => (prev && list.some((a) => a.id === prev) ? prev : (list[0]?.id ?? '')))
    } catch {
      setLoadFailed(true)
      setAgents([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const selected = useMemo(
    () => agents?.find((a) => a.id === selectedId) ?? null,
    [agents, selectedId],
  )

  if (agents === null) return <Loading text="加载用量中..." />
  if (loadFailed) return <Empty description="用量读取失败，稍后重试" />
  if (agents.length === 0) {
    return <Empty description="还没有任何工具调用记录——让任意 Agent 干点活再回来" />
  }

  return (
    <div className={styles.usageView}>
      <div className={styles.usageToolbar}>
        <Select
          className={styles.usageSelect}
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          options={agents.map((a) => ({
            value: a.id,
            label: `${a.name}（${a.totalCalls} 次）`,
          }))}
        />
        {selected && (
          <span className={styles.usageSummary}>
            {selected.tools.length} 个工具 · 共 {selected.totalCalls} 次调用
          </span>
        )}
      </div>

      {selected && selected.tools.length === 0 ? (
        <Empty description={`「${selected.name}」还没有调用过任何工具`} />
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
                <span className={styles.usageCount}>{tool.count} 次</span>
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

export default AgentUsageView
