import React, { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Button } from '../../../../components/ui/Button/Button'
import { Card } from '../../../../components/ui/Card/Card'
import { Loading } from '../../../../components/ui/Loading/Loading'
import { useToast } from '../../../../components/ui/Toast/useToast'
import {
  useMemoryUsage,
  type MemoryListItem,
  type MemoryProvenanceResult,
} from '../../../../hooks/business/useMemoryUsage'
import styles from './MemoryViewer.module.css'

const CATEGORY_LABEL: Record<string, string> = {
  user: '用户画像',
  feedback: '交互偏好',
  project: '进行中的事',
  reference: '外部资源',
  general: '其他',
}

/** 每类记忆的简短用途说明 */
const CATEGORY_DESC: Record<string, string> = {
  user: '身份信息（通常保存在个人记忆中）',
  feedback: '交互偏好（通常保存在个人记忆中）',
  project: '计划、日程、项目进展、截止日期等动态事项',
  reference: '常用工具、网址、联系人等外部资源',
  general: '对话中有跨会话价值的知识和信息',
}

const PREVIEW_PER_CATEGORY = 3

function formatMemoryTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const isThisYear = d.getFullYear() === now.getFullYear()
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (isToday) return `今天 ${time}`
  const date = isThisYear
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
  return `${date} ${time}`
}

/**
 * 设置页 — AI 本地记忆列表：按类展示、删除、导出与清空
 */
const MemoryViewer: React.FC = () => {
  const toast = useToast()
  // 不传 sessionKey/agentId → IPC 侧走全量查询，展示该用户所有 Agent 的工作记忆
  const { listMemories, deleteMemory, updateMemory, clearAll, exportJson, getProvenance, loading } = useMemoryUsage()

  const [items, setItems] = useState<readonly MemoryListItem[]>([])
  const [expanded, setExpanded] = useState(false)
  const [clearOnce, setClearOnce] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  // 来源下转：当前展开的记忆 ID + 已加载的来源
  const [provId, setProvId] = useState<string | null>(null)
  const [provData, setProvData] = useState<MemoryProvenanceResult | null>(null)
  const [provLoading, setProvLoading] = useState(false)

  const load = useCallback(async () => {
    const rows = await listMemories()
    setItems(rows)
  }, [listMemories])

  useEffect(() => {
    void load()
  }, [load])

  const byCategory = useMemo(() => {
    const map = new Map<string, MemoryListItem[]>()
    for (const row of items) {
      const k = row.category || 'general'
      const list = map.get(k) ?? []
      list.push(row)
      map.set(k, list)
    }
    // UI 层去重：相同 content 保留最新一条（兜底现有数据库重复记录）
    const deduped = new Map<string, MemoryListItem[]>()
    for (const [cat, rows] of map) {
      const seen = new Map<string, MemoryListItem>()
      for (const row of rows) {
        const key = row.content.trim()
        const existing = seen.get(key)
        if (!existing || row.createdAt > existing.createdAt) {
          seen.set(key, row)
        }
      }
      deduped.set(cat, [...seen.values()].sort((a, b) => b.createdAt - a.createdAt))
    }
    return deduped
  }, [items])

  const handleDelete = async (id: string) => {
    if (!window.confirm('确定删除这条记忆？删除后 AI 将不再使用。')) return
    const ok = await deleteMemory(id)
    if (ok) {
      toast.success('已删除')
      await load()
    } else {
      toast.error('删除失败')
    }
  }

  const startEdit = (m: MemoryListItem) => {
    setEditingId(m.id)
    setEditDraft(m.content)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditDraft('')
  }

  const toggleProvenance = async (memoryId: string) => {
    if (provId === memoryId) {
      setProvId(null)
      setProvData(null)
      return
    }
    setProvId(memoryId)
    setProvData(null)
    setProvLoading(true)
    try {
      const r = await getProvenance(memoryId)
      setProvData(r)
    } finally {
      setProvLoading(false)
    }
  }

  const handleSaveEdit = async (id: string) => {
    const content = editDraft.trim()
    if (!content) {
      toast.error('内容不能为空')
      return
    }
    const ok = await updateMemory(id, content)
    if (ok) {
      toast.success('已保存')
      setEditingId(null)
      setEditDraft('')
      await load()
    } else {
      toast.error('保存失败')
    }
  }

  const handleExport = async () => {
    try {
      const json = await exportJson()
      await window.electronAPI.clipboard.writeText(json)
      toast.success('记忆 JSON 已复制到剪贴板')
    } catch {
      toast.error('导出失败')
    }
  }

  const handleClear = async () => {
    if (!clearOnce) {
      setClearOnce(true)
      return
    }
    setClearOnce(false)
    const n = await clearAll()
    toast.success(`已清空 ${n} 条记忆`)
    await load()
  }

  if (loading && items.length === 0) {
    return (
      <div className={styles.wrap}>
        <Loading text="加载记忆..." />
      </div>
    )
  }

  return (
    <div className={styles.wrap}>
      <p className={styles.lead}>
        AI 会自动从对话中提取有价值的动态信息（计划、日程、资源等），用于跨会话提供连续支持。
        身份和偏好等静态信息保存在「个人记忆」中。
        <strong className={styles.privacy}>
          所有记忆仅存储在本地设备，不会上传到云端。
        </strong>
      </p>

      <div className={styles.toolbar}>
        <Button variant="secondary" onClick={() => void load()} disabled={loading}>
          刷新
        </Button>
        <Button variant="secondary" onClick={() => void handleExport()}>
          导出记忆（JSON）
        </Button>
        <Button
          variant={clearOnce ? 'danger' : 'secondary'}
          onClick={() => void handleClear()}
        >
          {clearOnce ? '确认清空全部记忆' : '清空全部记忆'}
        </Button>
        {clearOnce ? (
          <Button variant="secondary" onClick={() => setClearOnce(false)}>
            取消
          </Button>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className={styles.empty}>暂无记忆。试试告诉 AI 你正在进行的计划、常用的工具、或说「请记住：...」来手动添加。</p>
      ) : (
        <div className={styles.groups}>
          {[...byCategory.entries()].map(([cat, rows]) => {
            const label = CATEGORY_LABEL[cat] ?? cat
            const show = expanded ? rows : rows.slice(0, PREVIEW_PER_CATEGORY)
            const hidden = !expanded && rows.length > PREVIEW_PER_CATEGORY
            return (
              <section key={cat} className={styles.group}>
                <h4 className={styles.groupTitle}>
                  {label}（{rows.length} 条）
                </h4>
                {CATEGORY_DESC[cat] && (
                  <p className={styles.groupDesc}>{CATEGORY_DESC[cat]}</p>
                )}
                {show.map((m) => (
                  <Card key={m.id} className={styles.card}>
                    {editingId === m.id ? (
                      <>
                        <textarea
                          className={styles.cardEditor}
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          rows={4}
                          autoFocus
                        />
                        <div className={styles.cardMeta}>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => void handleSaveEdit(m.id)}
                          >
                            保存
                          </Button>
                          <Button variant="secondary" size="sm" onClick={cancelEdit}>
                            取消
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className={styles.cardText}>{m.content}</p>
                        <div className={styles.cardMeta}>
                          <span className={styles.cardTime}>{formatMemoryTime(m.createdAt)}</span>
                          <span>重要度 {Math.round(m.importance * 100)}%</span>
                          {m.sourceSegmentId ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => void toggleProvenance(m.id)}
                            >
                              {provId === m.id ? '收起来源' : '查看来源'}
                            </Button>
                          ) : null}
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => startEdit(m)}
                          >
                            编辑
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => void handleDelete(m.id)}
                          >
                            删除
                          </Button>
                        </div>
                        {provId === m.id ? (
                          <div className={styles.provenance}>
                            {provLoading ? (
                              <p className={styles.provenanceEmpty}>加载来源原文…</p>
                            ) : provData?.originalText ? (
                              <>
                                <div className={styles.provenanceMeta}>
                                  {provData.segment ? (
                                    <>
                                      <span>来源段 {provData.segment.turnCount} 轮 · {provData.segment.charCount} 字</span>
                                      <span>{new Date(provData.segment.createdAt).toLocaleString('zh-CN')}</span>
                                    </>
                                  ) : null}
                                  {provData.palaceDrawerId ? (
                                    <span>宫殿片段 {provData.palaceDrawerId.slice(0, 8)}</span>
                                  ) : null}
                                </div>
                                <pre className={styles.provenanceText}>{provData.originalText}</pre>
                              </>
                            ) : (
                              <p className={styles.provenanceEmpty}>
                                来源段原文已不可回溯（对话可能已删除）。
                              </p>
                            )}
                          </div>
                        ) : null}
                      </>
                    )}
                  </Card>
                ))}
                {hidden ? (
                  <button
                    type="button"
                    className={styles.expandLink}
                    onClick={() => setExpanded(true)}
                  >
                    查看全部记忆（本类还有 {rows.length - PREVIEW_PER_CATEGORY} 条）
                  </button>
                ) : null}
              </section>
            )
          })}
        </div>
      )}

      {expanded && items.length > PREVIEW_PER_CATEGORY ? (
        <button
          type="button"
          className={clsx(styles.expandLink, styles.expandLinkBottom)}
          onClick={() => setExpanded(false)}
        >
          收起列表
        </button>
      ) : null}
    </div>
  )
}

export { MemoryViewer }
