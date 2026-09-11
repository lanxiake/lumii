/**
 * EvolvedToolsSection — 工具进化管理（设置页）
 *
 * 展示 bash 命令工具进化管道的产物：
 * - 统计概览：追踪命令数、调用次数、高频命令、分析时间等
 * - 待审批候选：确认（注册生效）/ 拒绝（丢弃）
 * - 已批准工具：启用/禁用开关、查看模板、删除（不可恢复）
 */

import React, { useCallback, useEffect, useState } from 'react'
import { FlaskConical, Trash2, Check, X, Inbox, Hammer, TrendingUp, Clock, Activity } from 'lucide-react'
import { Card } from '../../../../components/ui/Card/Card'
import { Button } from '../../../../components/ui/Button/Button'
import { useToast } from '../../../../components/ui/Toast/useToast'
import settingsStyles from '../../SettingsPage.module.css'
import styles from './EvolvedToolsSection.module.css'

interface EvolvedToolInfo {
  name: string
  description: string
  commandTemplate: string
  isReadOnly: boolean
  enabled: boolean
  sampleCount: number
  approvedAt: string
}

interface PendingToolInfo {
  name: string
  description: string
  pattern: string
  commandTemplate: string
  createdAt: string
  whenToUse?: string
  whenNotToUse?: string
  samples?: string[]
  similarApproved?: string[]
  lowValueReason?: string | null
}

interface ListResult {
  ok: boolean
  tools: EvolvedToolInfo[]
  pending: PendingToolInfo[]
  error?: string
}

interface StatsResult {
  ok: boolean
  stats?: {
    trackedPatterns: number
    recentCalls: number
    highFrequencyCommands: Array<{ command: string; count: number }>
    lastAnalysisTime: string | null
    nextScheduledTime: string | null
    totalGenerated: number
    approved: number
    rejected: number
    pending: number
  }
  error?: string
}

async function sendCommand<T>(command: unknown): Promise<T> {
  return window.electronAPI.agentRuntime.sendCommand(command) as Promise<T>
}

export function EvolvedToolsSection() {
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tools, setTools] = useState<EvolvedToolInfo[]>([])
  const [pending, setPending] = useState<PendingToolInfo[]>([])
  const [stats, setStats] = useState<StatsResult['stats'] | null>(null)
  /** 正在操作的名称集合（防重复点击） */
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // 并行加载列表和统计数据
      const [listRes, statsRes] = await Promise.all([
        sendCommand<ListResult>({ type: 'tool-evolution:list' }),
        sendCommand<StatsResult>({ type: 'tool-evolution:stats' }),
      ])
      
      if (!listRes.ok) throw new Error(listRes.error || '加载失败')
      setTools(listRes.tools)
      setPending(listRes.pending)
      
      if (statsRes.ok && statsRes.stats) {
        setStats(statsRes.stats)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载工具列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = useCallback(
    async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, successMsg: string) => {
      setBusy((prev) => new Set(prev).add(key))
      try {
        const res = await fn()
        if (!res.ok) throw new Error(res.error || '操作失败')
        toast.success(successMsg)
        await load()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '操作失败')
      } finally {
        setBusy((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    [load, toast],
  )

  const handleConfirm = (name: string) =>
    void run(`confirm-${name}`, () => sendCommand({ type: 'tool-evolution:confirm', toolName: name }), `已启用工具「${name}」`)
  const handleReject = (name: string) =>
    void run(`reject-${name}`, () => sendCommand({ type: 'tool-evolution:reject', toolName: name }), `已丢弃候选「${name}」`)
  const handleToggle = (tool: EvolvedToolInfo) =>
    void run(
      `toggle-${tool.name}`,
      () => sendCommand({ type: 'tool-evolution:set-enabled', toolName: tool.name, enabled: !tool.enabled }),
      tool.enabled ? `已禁用「${tool.name}」` : `已启用「${tool.name}」`,
    )
  const handleRemove = (tool: EvolvedToolInfo) => {
    if (!window.confirm(`删除工具「${tool.name}」？此操作不可恢复。`)) return
    void run(`remove-${tool.name}`, () => sendCommand({ type: 'tool-evolution:remove', toolName: tool.name }), `已删除「${tool.name}」`)
  }

  const isBusy = (key: string) => busy.has(key)

  return (
    <div className={styles.wrap}>
      <Card className={settingsStyles.settingCard}>
        <div className={settingsStyles.settingCardHeader}>
          <FlaskConical size={20} />
          <h3>工具进化（实验）</h3>
        </div>
        <div className={settingsStyles.settingCardContent}>
          <p className={styles.intro}>
            自动挖掘高频 bash 命令，草拟参数化工具供 Agent 直接调用，降低命令编写出错率。
            在此审批候选；已批准工具可随时禁用或删除。
          </p>

          {loading && <p className={styles.status}>加载中…</p>}
          {error && <p className={styles.error}>{error}</p>}

          {!loading && !error && (
            <>
              {/* 统计概览 */}
              {stats && (
                <div className={styles.statsOverview}>
                  <h4 className={styles.statsTitle}>
                    <Activity size={16} /> 统计概览
                  </h4>
                  <div className={styles.statsGrid}>
                    <div className={styles.statCard}>
                      <div className={styles.statIcon}>
                        <TrendingUp size={20} />
                      </div>
                      <div className={styles.statContent}>
                        <div className={styles.statValue}>{stats.trackedPatterns}</div>
                        <div className={styles.statLabel}>已追踪命令模式</div>
                      </div>
                    </div>
                    <div className={styles.statCard}>
                      <div className={styles.statIcon}>
                        <Activity size={20} />
                      </div>
                      <div className={styles.statContent}>
                        <div className={styles.statValue}>{stats.recentCalls}</div>
                        <div className={styles.statLabel}>近一周调用总数</div>
                      </div>
                    </div>
                    <div className={styles.statCard}>
                      <div className={styles.statIcon}>
                        <FlaskConical size={20} />
                      </div>
                      <div className={styles.statContent}>
                        <div className={styles.statValue}>{stats.totalGenerated}</div>
                        <div className={styles.statLabel}>总生成候选数</div>
                      </div>
                    </div>
                    <div className={styles.statCard}>
                      <div className={styles.statIcon}>
                        <Check size={20} />
                      </div>
                      <div className={styles.statContent}>
                        <div className={styles.statValue}>{stats.approved}</div>
                        <div className={styles.statLabel}>已批准工具数</div>
                      </div>
                    </div>
                  </div>

                  {/* 高频命令 Top 5 */}
                  {stats.highFrequencyCommands.length > 0 && (
                    <div className={styles.topCommands}>
                      <h5 className={styles.topCommandsTitle}>
                        🔥 高频命令 Top {stats.highFrequencyCommands.length}（近一周）
                      </h5>
                      <div className={styles.commandList}>
                        {stats.highFrequencyCommands.map((cmd, idx) => (
                          <div key={idx} className={styles.commandItem}>
                            <span className={styles.commandRank}>#{idx + 1}</span>
                            <code className={styles.commandText}>{cmd.command}</code>
                            <span className={styles.commandCount}>{cmd.count} 次</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 分析时间信息 */}
                  <div className={styles.analysisInfo}>
                    <Clock size={14} />
                    <span>
                      {stats.lastAnalysisTime
                        ? `上次分析：${new Date(stats.lastAnalysisTime).toLocaleString('zh-CN')}`
                        : '尚未运行过分析'}
                    </span>
                    {stats.nextScheduledTime && (
                      <>
                        <span className={styles.separator}>·</span>
                        <span>下次自动分析：{new Date(stats.nextScheduledTime).toLocaleString('zh-CN')}</span>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* 待审批候选 */}
              <h4 className={styles.groupTitle}>
                <Inbox size={14} /> 待审批候选（{pending.length}）
              </h4>
              {pending.length === 0 && (
                <p className={styles.status}>暂无候选。工具进化引擎会在检测到高频命令后自动草拟。</p>
              )}
              {pending.map((p) => (
                <div key={p.name} className={styles.item}>
                  <div className={styles.itemMain}>
                    <div className={styles.itemHead}>
                      <span className={styles.toolName}>{p.name}</span>
                      <span className={styles.meta}>候选 · {new Date(p.createdAt).toLocaleDateString()}</span>
                    </div>
                    <p className={styles.desc}>
                      <span className={styles.fieldLabel}>用途</span>
                      {p.description}
                    </p>
                    {(p.whenToUse || p.whenNotToUse) && (
                      <div className={styles.advice}>
                        {p.whenToUse && (
                          <p className={styles.adviceLine}>
                            <span className={styles.fieldLabel}>建议使用</span>
                            {p.whenToUse}
                          </p>
                        )}
                        {p.whenNotToUse && (
                          <p className={styles.adviceLine}>
                            <span className={styles.fieldLabel}>不建议</span>
                            {p.whenNotToUse}
                          </p>
                        )}
                      </div>
                    )}
                    {p.similarApproved && p.similarApproved.length > 0 && (
                      <p className={styles.dupWarn}>
                        疑似与已批准工具重复：{p.similarApproved.join('、')}。建议点「不用」。
                      </p>
                    )}
                    {p.lowValueReason && (
                      <p className={styles.dupWarn}>
                        低价值候选：{p.lowValueReason}。建议点「不用」。
                      </p>
                    )}
                    <code className={styles.template}>{p.commandTemplate}</code>
                    {p.samples && p.samples.length > 0 && (
                      <ul className={styles.sampleList}>
                        {p.samples.slice(0, 3).map((s) => (
                          <li key={s}>
                            <code className={styles.sampleCmd}>{s}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className={styles.itemActions}>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={isBusy(`confirm-${p.name}`)}
                      onClick={() => handleConfirm(p.name)}
                      title="注册为系统工具，Agent 可直接调用"
                    >
                      <Check size={14} /> 启用
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isBusy(`reject-${p.name}`)}
                      onClick={() => handleReject(p.name)}
                      title="丢弃该候选"
                    >
                      <X size={14} /> 不用
                    </Button>
                  </div>
                </div>
              ))}

              {/* 已批准工具 */}
              <h4 className={styles.groupTitle}>
                <Hammer size={14} /> 已批准工具（{tools.length}）
              </h4>
              {tools.length === 0 && (
                <p className={styles.status}>还没有已批准的工具。审批一个候选后，它会出现在这里。</p>
              )}
              {tools.map((t) => (
                <div key={t.name} className={styles.item}>
                  <div className={styles.itemMain}>
                    <div className={styles.itemHead}>
                      <span className={styles.toolName}>{t.name}</span>
                      <span className={styles.meta}>
                        {t.enabled ? '已启用' : '已禁用'}
                        {t.isReadOnly && ' · 只读'}
                        {t.sampleCount > 0 && ` · ${t.sampleCount} 样本`}
                      </span>
                    </div>
                    <p className={styles.desc}>{t.description}</p>
                    <code className={styles.template}>{t.commandTemplate}</code>
                  </div>
                  <div className={styles.itemActions}>
                    <Button
                      size="sm"
                      variant={t.enabled ? 'ghost' : 'primary'}
                      disabled={isBusy(`toggle-${t.name}`)}
                      onClick={() => handleToggle(t)}
                    >
                      {t.enabled ? '禁用' : '启用'}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={isBusy(`remove-${t.name}`)}
                      onClick={() => handleRemove(t)}
                      title="删除工具（不可恢复）"
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </Card>
    </div>
  )
}
