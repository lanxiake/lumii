/**
 * EvolvedToolsSection — 工具进化管理（设置页）
 *
 * 展示 bash 命令工具进化管道的产物：
 * - 待审批候选：确认（注册生效）/ 拒绝（丢弃）
 * - 已批准工具：启用/禁用开关、查看模板、删除（不可恢复）
 */

import React, { useCallback, useEffect, useState } from 'react'
import { FlaskConical, Trash2, Check, X, Inbox, Hammer } from 'lucide-react'
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
}

interface ListResult {
  ok: boolean
  tools: EvolvedToolInfo[]
  pending: PendingToolInfo[]
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
  /** 正在操作的名称集合（防重复点击） */
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await sendCommand<ListResult>({ type: 'tool-evolution:list' })
      if (!res.ok) throw new Error(res.error || '加载失败')
      setTools(res.tools)
      setPending(res.pending)
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
            每日凌晨自动产出候选（最多 2 个），在此审批；已批准工具可随时禁用或删除。
          </p>

          {loading && <p className={styles.status}>加载中…</p>}
          {error && <p className={styles.error}>{error}</p>}

          {!loading && !error && (
            <>
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
                    <p className={styles.desc}>{p.description}</p>
                    <code className={styles.template}>{p.commandTemplate}</code>
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
