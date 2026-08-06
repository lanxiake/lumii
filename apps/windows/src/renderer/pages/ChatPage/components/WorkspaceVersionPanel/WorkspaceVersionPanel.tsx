/**
 * WorkspaceVersionPanel — 工作空间版本（更改 / 历史）
 *
 * 对齐 Cursor Changes：堆叠多文件 Diff + 右栏文件导航；列表秒开，hunks 按文件懒加载。
 * 嵌入 WorkspaceWorkbench 时无全屏遮罩。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Save, RotateCcw, X, Maximize2, Minimize2, Expand } from 'lucide-react'
import {
  useWorkspaceVcs,
  type VcsDiffItem,
  type VcsLogEntry,
} from '../../../../hooks/business/useWorkspaceVcs'
import { ConfirmModal } from '../../../../components/ui/Modal/ConfirmModal'
import { DiffFileCard } from './DiffFileCard'
import { ChangedFilesRail } from './ChangedFilesRail'
import type { WorkbenchLayoutMode } from '../WorkspaceWorkbench'
import styles from './WorkspaceVersionPanel.module.css'

type Subnav = 'changes' | 'history'

interface WorkspaceVersionPanelProps {
  open: boolean
  onClose: () => void
  embedded?: boolean
  /** 版本卡片「在文件中显示」→ 切到 files tab 并定位 */
  onRevealInFiles?: (filepath: string) => void
  /** 向共享工作台同步未提交文件数量 */
  onUncommittedCountChange?: (count: number) => void
  /** 向共享工作台注册当前 VCS 实例的刷新函数 */
  refreshRef?: React.MutableRefObject<(() => Promise<void>) | null>
  /** 工作台宽度布局（默认 / 加宽 / 全屏盖满对话区） */
  layoutMode?: WorkbenchLayoutMode
  onLayoutModeChange?: (mode: WorkbenchLayoutMode) => void
}

interface HunkCacheEntry {
  item: VcsDiffItem
  loading: boolean
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 列表用相对时间，降低技术感 */
function formatRelativeTime(ms: number): string {
  const now = Date.now()
  const diff = Math.max(0, now - ms)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day === 1) return '昨天'
  if (day < 7) return `${day} 天前`
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 作者面向用户文案 */
function authorLabel(author: VcsLogEntry['author']): string {
  return author === 'agent' ? '灵栖' : '你'
}

/** 历史条目标题：空 message 时给可读兜底；隐藏「auto: 对话 xxx」中的 ID */
function historyTitle(
  message: string,
  oid: string,
  conversationTitle?: string,
): string {
  const t = message.trim()
  if (/^auto:\s*对话\s+/i.test(t) && conversationTitle) {
    return `对话快照 · ${conversationTitle}`
  }
  if (t) return t
  if (conversationTitle) return `对话快照 · ${conversationTitle}`
  return `版本 ${oid.slice(0, 7)}`
}

function shortOid(oid: string): string {
  return oid.slice(0, 8)
}

/** 解析会话标题映射（sessionKey / conversationId → title） */
async function loadConversationTitleMap(): Promise<Record<string, string>> {
  const api = window.electronAPI?.agentRuntime
  if (!api?.sendCommand) return {}
  try {
    const result = await api.sendCommand({ type: 'conversation:list' })
    if (!Array.isArray(result)) return {}
    const map: Record<string, string> = {}
    for (const row of result as Array<{ id?: string; sessionKey?: string; title?: string }>) {
      const title = (row.title ?? '').trim()
      if (!title) continue
      if (row.sessionKey) map[row.sessionKey] = title
      if (row.id) map[row.id] = title
    }
    return map
  } catch {
    return {}
  }
}

function cardId(filepath: string): string {
  return `vcs-card-${encodeURIComponent(filepath)}`
}

/**
 * 有限并发执行异步任务
 */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i])
    }
  })
  await Promise.all(runners)
  return results
}

export const WorkspaceVersionPanel: React.FC<WorkspaceVersionPanelProps> = ({
  open,
  onClose,
  embedded = false,
  onRevealInFiles,
  onUncommittedCountChange,
  refreshRef,
  layoutMode = 'default',
  onLayoutModeChange,
}) => {
  const {
    history,
    uncommittedDiff,
    loading,
    commit,
    rollback,
    revertFile,
    diffList,
    diffFile,
    refresh,
  } = useWorkspaceVcs()

  /** 将版本面板持有的未提交数量同步给工作台徽标 */
  useEffect(() => {
    onUncommittedCountChange?.(uncommittedDiff.length)
  }, [onUncommittedCountChange, uncommittedDiff.length])

  /** 将同一 VCS hook 实例的刷新函数提供给工作台标题栏 */
  useEffect(() => {
    if (!refreshRef) return
    refreshRef.current = refresh
    return () => {
      if (refreshRef.current === refresh) refreshRef.current = null
    }
  }, [refresh, refreshRef])

  const [subnav, setSubnav] = useState<Subnav>('changes')
  const [saving, setSaving] = useState(false)
  const [saveOk, setSaveOk] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [activePath, setActivePath] = useState<string | undefined>()
  const [railVisible, setRailVisible] = useState(true)
  /** conversationId → 会话标题，供历史列表展示 */
  const [conversationTitles, setConversationTitles] = useState<Record<string, string>>({})
  const [historyFiles, setHistoryFiles] = useState<VcsDiffItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [selectedHistory, setSelectedHistory] = useState<{
    entry: VcsLogEntry
    parentOid: string
  } | null>(null)

  const [hunkCache, setHunkCache] = useState<Record<string, HunkCacheEntry>>({})
  const cacheKeyRef = useRef('')

  const [rollbackTarget, setRollbackTarget] = useState<{ oid: string; label: string } | null>(null)
  const [rollbackConfirming, setRollbackConfirming] = useState(false)
  const [revertTarget, setRevertTarget] = useState<{
    filepath: string
    revertOid: string
    source: 'uncommitted' | 'commit'
  } | null>(null)
  const [revertConfirming, setRevertConfirming] = useState(false)

  /** 打开历史子页时拉取会话标题，把 ID 换成可读名称 */
  useEffect(() => {
    if (!open || subnav !== 'history') return
    let cancelled = false
    void loadConversationTitleMap().then((map) => {
      if (!cancelled) setConversationTitles(map)
    })
    return () => {
      cancelled = true
    }
  }, [open, subnav])

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const listFiles: VcsDiffItem[] =
    subnav === 'changes' ? uncommittedDiff : historyFiles

  const totalIns = useMemo(
    () => listFiles.reduce((s, f) => s + f.insertions, 0),
    [listFiles],
  )
  const totalDel = useMemo(
    () => listFiles.reduce((s, f) => s + f.deletions, 0),
    [listFiles],
  )

  /** 当前列表对应的 diff 端点 */
  const endpoints = useMemo(() => {
    if (subnav === 'changes') return { from: 'HEAD', to: 'WORKTREE' as const }
    if (selectedHistory) return { from: selectedHistory.parentOid, to: selectedHistory.entry.oid }
    return null
  }, [subnav, selectedHistory])

  const cachePrefix = endpoints ? `${endpoints.from}:${endpoints.to}` : ''

  // 列表切换时清空 hunk 缓存前缀
  useEffect(() => {
    if (cacheKeyRef.current !== cachePrefix) {
      cacheKeyRef.current = cachePrefix
      setHunkCache({})
    }
  }, [cachePrefix])

  /** 懒加载单个文件 hunks */
  const ensureHunks = useCallback(
    async (filepath: string) => {
      if (!endpoints) return
      const key = `${cachePrefix}:${filepath}`
      setHunkCache((prev) => {
        if (prev[key]?.item.hunks || prev[key]?.loading) return prev
        return { ...prev, [key]: { item: { filepath, status: 'modified', insertions: 0, deletions: 0 }, loading: true } }
      })
      const detailed = await diffFile(endpoints.from, endpoints.to, filepath)
      setHunkCache((prev) => ({
        ...prev,
        [key]: {
          loading: false,
          item: detailed ?? {
            filepath,
            status: 'modified',
            insertions: 0,
            deletions: 0,
            skipReason: '无法加载差异',
            truncated: true,
          },
        },
      }))
    },
    [cachePrefix, diffFile, endpoints],
  )

  // 列表出现后优先加载前 5 个文件 hunks
  useEffect(() => {
    if (!open || !endpoints || listFiles.length === 0) return
    const first = listFiles.slice(0, 5).map((f) => f.filepath)
    void mapPool(first, 4, async (fp) => {
      await ensureHunks(fp)
    })
  }, [open, endpoints, listFiles, ensureHunks])

  /** 选中历史版本 → 仅拉文件列表（无 hunks） */
  const selectHistory = useCallback(
    async (entry: VcsLogEntry, index: number) => {
      const parentOid = index + 1 < history.length ? history[index + 1].oid : entry.oid
      setSelectedHistory({ entry, parentOid })
      setHistoryLoading(true)
      setActivePath(undefined)
      try {
        const list = await diffList(parentOid, entry.oid)
        setHistoryFiles(list)
      } catch {
        setHistoryFiles([])
        showToast('加载版本文件列表失败')
      } finally {
        setHistoryLoading(false)
      }
    },
    [diffList, history],
  )

  const handleSave = async () => {
    setSaving(true)
    try {
      const result = await commit()
      if (result) {
        setSaveOk(true)
        setTimeout(() => setSaveOk(false), 1200)
        showToast('版本已保存')
        await refresh()
      } else {
        showToast('工作区无变更，跳过保存')
      }
    } catch (err) {
      showToast(`保存失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  // Ctrl+S 保存（仅更改子页）
  useEffect(() => {
    if (!open || subnav !== 'changes') return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void handleSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const handleSelectFile = (filepath: string) => {
    setActivePath(filepath)
    void ensureHunks(filepath)
    requestAnimationFrame(() => {
      document.getElementById(cardId(filepath))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const handleRollbackConfirm = async () => {
    if (!rollbackTarget) return
    setRollbackConfirming(false)
    try {
      const result = await rollback(rollbackTarget.oid)
      showToast(`已回滚至 ${shortOid(result.restoredOid)}（当前状态已自动备份）`)
      setRollbackTarget(null)
      setSelectedHistory(null)
      setHistoryFiles([])
      await refresh()
    } catch (err) {
      showToast(`回滚失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleRevertConfirm = async () => {
    if (!revertTarget) return
    setRevertConfirming(false)
    try {
      await revertFile(revertTarget.revertOid, revertTarget.filepath)
      showToast(`已撤销 ${revertTarget.filepath}`)
      setRevertTarget(null)
      await refresh()
      if (subnav === 'history' && selectedHistory) {
        const list = await diffList(selectedHistory.parentOid, selectedHistory.entry.oid)
        setHistoryFiles(list)
      }
    } catch (err) {
      showToast(`撤销失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!open) return null

  const panel = (
    <div
      className={clsx(
        styles['vcs-panel'],
        embedded && styles['vcs-panel--embedded'],
        layoutMode === 'fullscreen' && styles['vcs-panel--fullscreen'],
        layoutMode === 'wide' && styles['vcs-panel--wide'],
      )}
    >
      {!embedded && (
        <div className={styles['vcs-header']}>
          <h3 className={styles['vcs-title']}>工作空间版本</h3>
          <button type="button" className={styles['vcs-close']} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className={styles.subnav}>
        <div className={styles.subnavTabs}>
          <button
            type="button"
            className={clsx(styles.subTab, subnav === 'changes' && styles.subTabActive)}
            onClick={() => {
              setSubnav('changes')
              setActivePath(undefined)
            }}
          >
            更改
          </button>
          <button
            type="button"
            className={clsx(styles.subTab, subnav === 'history' && styles.subTabActive)}
            onClick={() => setSubnav('history')}
          >
            历史
          </button>
        </div>
        <div className={styles.subnavMeta}>
          {subnav === 'changes' ? (
            <>
              <span className={styles.metaLabel}>未提交</span>
              <span className={styles.ins}>+{totalIns}</span>
              <span className={styles.del}>−{totalDel}</span>
              <button
                type="button"
                className={clsx(styles.saveBtn, 'mt-press')}
                onClick={() => void handleSave()}
                disabled={saving}
              >
                <Save size={13} strokeWidth={2} />
                {saving ? '保存中…' : saveOk ? '已保存 ✓' : '保存版本'}
              </button>
            </>
          ) : selectedHistory ? (
            <>
              <span className={styles.metaLabel}>
                {listFiles.length} 个文件
              </span>
              <span className={styles.ins}>+{totalIns}</span>
              <span className={styles.del}>−{totalDel}</span>
            </>
          ) : (
            <span className={styles.metaLabel}>选择一个版本查看变更</span>
          )}
          <div className={styles.layoutBtns}>
            <button
              type="button"
              className={clsx(styles.layoutBtn, layoutMode === 'default' && styles.layoutBtnActive)}
              title="默认比例"
              onClick={() => onLayoutModeChange?.('default')}
            >
              <Minimize2 size={13} />
            </button>
            <button
              type="button"
              className={clsx(styles.layoutBtn, layoutMode === 'wide' && styles.layoutBtnActive)}
              title="加宽预览"
              onClick={() => onLayoutModeChange?.('wide')}
            >
              <Expand size={13} />
            </button>
            <button
              type="button"
              className={clsx(styles.layoutBtn, layoutMode === 'fullscreen' && styles.layoutBtnActive)}
              title="全屏（铺满对话区，可再拖拽调整）"
              onClick={() =>
                onLayoutModeChange?.(layoutMode === 'fullscreen' ? 'default' : 'fullscreen')
              }
            >
              <Maximize2 size={13} />
            </button>
          </div>
        </div>
      </div>

      <div className={styles.main}>
        {subnav === 'history' && (
          <aside className={styles.historyRail} aria-label="版本历史">
            {loading ? (
              <p className={styles.empty}>加载中…</p>
            ) : history.length === 0 ? (
              <p className={styles.empty}>暂无版本记录</p>
            ) : (
              <ul className={styles.historyList}>
                {history.map((entry, idx) => {
                  const active = selectedHistory?.entry.oid === entry.oid
                  const convTitle = entry.conversationId
                    ? conversationTitles[entry.conversationId]
                    : undefined
                  const title = historyTitle(entry.message, entry.oid, convTitle)
                  return (
                    <li key={entry.oid}>
                      <button
                        type="button"
                        className={clsx(styles.historyItem, active && styles.historyItemActive)}
                        onClick={() => void selectHistory(entry, idx)}
                        title={title}
                      >
                        <span className={styles.historyTitle}>{title}</span>
                        <span className={styles.historyMeta}>
                          {formatRelativeTime(entry.timestamp)} · {authorLabel(entry.author)}
                          {convTitle && !title.includes(convTitle)
                            ? ` · ${convTitle}`
                            : ''}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </aside>
        )}

        <div className={clsx(styles.diffArea, !railVisible && styles.diffAreaSolo)}>
          {subnav === 'history' && selectedHistory && (
            <div className={styles.historyDetail}>
              <div className={styles.historyDetailText}>
                <div className={styles.historyDetailTitle}>
                  {historyTitle(
                    selectedHistory.entry.message,
                    selectedHistory.entry.oid,
                    selectedHistory.entry.conversationId
                      ? conversationTitles[selectedHistory.entry.conversationId]
                      : undefined,
                  )}
                </div>
                <div className={styles.historyDetailMeta}>
                  <span>{authorLabel(selectedHistory.entry.author)}</span>
                  <span aria-hidden>·</span>
                  <span title={formatTime(selectedHistory.entry.timestamp)}>
                    {formatTime(selectedHistory.entry.timestamp)}
                  </span>
                  {selectedHistory.entry.conversationId &&
                    conversationTitles[selectedHistory.entry.conversationId] && (
                      <>
                        <span aria-hidden>·</span>
                        <span
                          className={styles.historyConv}
                          title={conversationTitles[selectedHistory.entry.conversationId]}
                        >
                          对话：{conversationTitles[selectedHistory.entry.conversationId]}
                        </span>
                      </>
                    )}
                  {!historyLoading && (
                    <>
                      <span aria-hidden>·</span>
                      <span>{listFiles.length} 个文件</span>
                      <span className={styles.ins}>+{totalIns}</span>
                      <span className={styles.del}>−{totalDel}</span>
                    </>
                  )}
                </div>
              </div>
              <button
                type="button"
                className={styles.historyRollback}
                title="将整个工作区回滚到此版本"
                onClick={() => {
                  setRollbackTarget({
                    oid: selectedHistory.entry.oid,
                    label: historyTitle(
                      selectedHistory.entry.message,
                      selectedHistory.entry.oid,
                      selectedHistory.entry.conversationId
                        ? conversationTitles[selectedHistory.entry.conversationId]
                        : undefined,
                    ),
                  })
                  setRollbackConfirming(true)
                }}
              >
                <RotateCcw size={13} strokeWidth={2} />
                回滚到此版本
              </button>
            </div>
          )}

          {(subnav === 'changes' || selectedHistory) && (
            <div className={styles.diffBody}>
              <div className={styles.stack}>
                {historyLoading && <p className={styles.empty}>加载文件列表…</p>}
                {!historyLoading && listFiles.length === 0 && (
                  <p className={styles.empty}>
                    {subnav === 'changes'
                      ? '工作区无变更 — 可切换到「历史」查看过往版本'
                      : '该版本无文件变更'}
                  </p>
                )}
                {!historyLoading &&
                  listFiles.map((f, i) => {
                    const key = `${cachePrefix}:${f.filepath}`
                    const cached = hunkCache[key]
                    return (
                      <div
                        key={f.filepath}
                        className={styles.stackItem}
                        style={i < 4 ? { animationDelay: `${i * 40}ms` } : undefined}
                        onMouseEnter={() => {
                          if (!hunkCache[key]) void ensureHunks(f.filepath)
                        }}
                      >
                        <DiffFileCard
                          id={cardId(f.filepath)}
                          entry={cached?.item.hunks ? cached.item : f}
                          hunks={cached?.item.hunks}
                          loading={!cached || cached.loading}
                          truncated={cached?.item.truncated}
                          skipReason={cached?.item.skipReason}
                          onRevert={() => {
                            setRevertTarget({
                              filepath: f.filepath,
                              revertOid: subnav === 'changes' ? 'HEAD' : (selectedHistory?.parentOid ?? 'HEAD'),
                              source: subnav === 'changes' ? 'uncommitted' : 'commit',
                            })
                            setRevertConfirming(true)
                          }}
                          onRevealInFiles={
                            onRevealInFiles
                              ? () => onRevealInFiles(f.filepath)
                              : undefined
                          }
                        />
                      </div>
                    )
                  })}
              </div>
              {layoutMode !== 'fullscreen' && (
                <ChangedFilesRail
                  files={listFiles}
                  activePath={activePath}
                  onSelect={handleSelectFile}
                  visible={railVisible}
                  onVisibleChange={setRailVisible}
                />
              )}
            </div>
          )}
          {subnav === 'history' && !selectedHistory && !historyLoading && (
            <p className={styles.emptyHint}>从左侧选择一个版本查看变更</p>
          )}
        </div>
      </div>

      {toast && <div className={styles['vcs-toast']}>{toast}</div>}

      <ConfirmModal
        open={rollbackConfirming}
        title="确认回滚"
        content={
          rollbackTarget
            ? `回滚整个工作区到「${rollbackTarget.label}」（${shortOid(rollbackTarget.oid)}）？\n\n当前工作区会自动备份，回滚后可恢复。`
            : ''
        }
        confirmText="确认回滚"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={() => void handleRollbackConfirm()}
        onCancel={() => setRollbackConfirming(false)}
      />

      <ConfirmModal
        open={revertConfirming}
        title="撤销此文件"
        content={
          revertTarget
            ? revertTarget.source === 'uncommitted'
              ? `丢弃「${revertTarget.filepath}」的未提交改动，恢复到最近一次保存的版本？此操作不可撤销。`
              : `把「${revertTarget.filepath}」恢复到该版本之前的内容？仅影响此文件。`
            : ''
        }
        confirmText="确认撤销"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={() => void handleRevertConfirm()}
        onCancel={() => setRevertConfirming(false)}
      />
    </div>
  )

  if (embedded) return panel

  return createPortal(
    <div className={styles['vcs-overlay']} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>{panel}</div>
    </div>,
    document.body,
  )
}

export default WorkspaceVersionPanel
