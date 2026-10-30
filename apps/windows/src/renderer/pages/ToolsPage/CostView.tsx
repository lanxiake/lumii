/**
 * CostView — 「常驻成本」tab：把「每次请求都要付的 token」和「到底用没用」摆在一起。
 *
 * 为什么要这张表：常驻成本是每个回合都付的钱，而 150 个工具里有 9–20K token 是这个成本。
 * 光看用量排序会漏掉「很贵但从不使用」的那批——那才是裁剪的头号候选。
 *
 * 口径与 `contextUsage` 同源（主进程用 `estimateToolTokens` 算，同一个标定比），
 * 所以合计能跟日志里的 `tools + mcp` 对账——**但有已知偏差**：本页按全局
 * `provider.json` 的模型标定比折算，日志按会话模型，实测差 12.6%（见
 * `capability-inventory.ts` 文件头的三级口径表）。看趋势，别拿它当精确值。
 * 技能侧只有累计计数、没有日维度，页面上如实区分（不拿工具口径去补）。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import clsx from 'clsx'
import { Loading } from '../../components/ui/Loading/Loading'
import { Empty } from '../../components/ui/Empty/Empty'
import { Select } from '../../components/ui/Select/Select'
import { formatLastUsed } from './AgentUsageView'
import styles from './ToolsPage.module.css'

interface CapabilityRow {
  kind: 'tool' | 'skill'
  id: string
  whenToUse: string
  residentTokens: number
  usage30d: number
  lastUsed: number | null
}

type SortKey = 'residentTokens' | 'usage30d' | 'lastUsed'

const COLUMNS: readonly { key: SortKey; label: string }[] = [
  { key: 'residentTokens', label: '常驻成本' },
  { key: 'usage30d', label: '近 30 天用量' },
  { key: 'lastUsed', label: '最后使用' },
]

/** 两套用量口径不同源（见 capability-inventory.ts 文件头），所以必须能分开看 */
const KIND_OPTIONS = [
  { value: 'all', label: '全部（工具 + 技能）' },
  { value: 'tool', label: '仅工具' },
  { value: 'skill', label: '仅技能' },
]

function sortValue(row: CapabilityRow, key: SortKey): number {
  // 从未使用的排在最前（成本视角下最该被裁）；技能没有时间维度，按 0 处理
  return key === 'lastUsed' ? (row.lastUsed ?? 0) : row[key]
}

export const CostView: React.FC = () => {
  const [rows, setRows] = useState<CapabilityRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('residentTokens')
  const [desc, setDesc] = useState(true)
  const [kind, setKind] = useState<'all' | 'tool' | 'skill'>('all')

  const load = useCallback(async () => {
    setFailed(false)
    setRows(null)
    try {
      const result = (await window.electronAPI.agentRuntime.sendCommand({
        type: 'capability:inventory',
        days: 30,
      })) as CapabilityRow[]
      setRows(result ?? [])
    } catch {
      setFailed(true)
      setRows([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const visible = useMemo(
    () => (kind === 'all' ? (rows ?? []) : (rows ?? []).filter((r) => r.kind === kind)),
    [rows, kind],
  )

  const sorted = useMemo(() => {
    const list = [...visible].sort((a, b) => sortValue(a, sortKey) - sortValue(b, sortKey))
    return desc ? list.reverse() : list
  }, [visible, sortKey, desc])

  const totalTokens = useMemo(() => visible.reduce((s, r) => s + r.residentTokens, 0), [visible])
  const neverUsed = useMemo(
    () => visible.filter((r) => r.usage30d === 0 && r.kind === 'tool').length,
    [visible],
  )

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setDesc((d) => !d)
    else {
      setSortKey(key)
      setDesc(true)
    }
  }

  if (rows === null) return <Loading text="计算常驻成本中..." />
  if (failed) return <Empty description="成本数据读取失败，稍后重试" />
  if (rows.length === 0) return <Empty description="没有可统计的能力" />

  return (
    <div className={styles.usageView}>
      <div className={styles.usageToolbar}>
        <Select
          className={styles.usageSelect}
          value={kind}
          onChange={(e) => setKind(e.target.value as 'all' | 'tool' | 'skill')}
          options={KIND_OPTIONS}
        />
        <span className={styles.usageSummary}>
          {visible.length} 项 · 常驻合计约 {totalTokens.toLocaleString()} tokens · 其中{' '}
          {neverUsed} 个工具近 30 天从未使用
        </span>
      </div>

      <div className={styles.costHead}>
        <span className={styles.costName}>名称 / 用途</span>
        {COLUMNS.map((col) => (
          <button
            key={col.key}
            className={clsx(styles.costCol, sortKey === col.key && styles.costColActive)}
            onClick={() => toggleSort(col.key)}
          >
            {col.label}
            {sortKey === col.key &&
              (desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
          </button>
        ))}
      </div>

      <div className={styles.usageList}>
        {sorted.map((row) => (
          <div key={`${row.kind}:${row.id}`} className={clsx(styles.usageRow, styles.costRow)}>
            <div className={styles.costName}>
              <span className={styles.usageToolName}>{row.id}</span>
              <span className={styles.usageToolLabel}>
                {row.kind === 'skill' ? '技能' : '工具'}
                {row.whenToUse ? ` · ${row.whenToUse}` : ''}
              </span>
            </div>
            <span className={styles.costNum}>{row.residentTokens.toLocaleString()}</span>
            <span className={styles.costNum}>
              {row.kind === 'tool' && row.usage30d === 0 ? (
                <span className={styles.costNeverUsed}>从未使用</span>
              ) : (
                <>
                  {row.usage30d}
                  {row.kind === 'skill' && (
                    <span className={styles.usageToolLabel}>（累计）</span>
                  )}
                </>
              )}
            </span>
            <span className={styles.usageLast}>
              {row.lastUsed == null ? '—' : formatLastUsed(row.lastUsed)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
