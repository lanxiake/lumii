/**
 * WorkspaceVersionPanel — 工作空间版本（更改 / 历史）
 *
 * 对齐 Cursor Changes：堆叠多文件 Diff + 右栏文件导航；列表秒开，hunks 按文件懒加载。
 * 嵌入 WorkspaceWorkbench 时无全屏遮罩。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Save, RotateCcw, X } from 'lucide-react'
import {
  useWorkspaceVcs,
  type VcsDiffItem,
  type VcsLogEntry,
} from '../../../../hooks/business/useWorkspaceVcs'
import { ConfirmModal } from '../../../../components/ui/Modal/ConfirmModal'
import { DiffFileCard } from './DiffFileCard'
import { ChangedFilesRail } from './ChangedFilesRail'
import styles from './WorkspaceVersionPanel.module.css'

type Subnav = 'changes' | 'history'

interface WorkspaceVersionPanelProps {
  open: boolean
  onClose: () => void
  embedded?: boolean
  /** 版本卡片「在文件中显示」→ 切到 files tab 并定位 */
  onRevealInFiles?: (filepath: string) => void
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

function shortOid(oid: string): string {
  return oid.slice(0, 8)
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

  const [subnav, setSubnav] = useState<Subnav>('changes')
  const [saving, setSaving] = useState(false)
  const [saveOk, setSaveOk] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [activePath, setActivePath] = useState<string | undefined>()
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
    <div className={clsx(styles['vcs-panel'], embedded && styles['vcs-panel--embedded'])}>
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
              <span className={styles.metaLabel}>{shortOid(selectedHistory.entry.oid)}</span>
              <span className={styles.ins}>+{totalIns}</span>
              <span className={styles.del}>−{totalDel}</span>
            </>
          ) : (
            <span className={styles.metaLabel}>选择一个版本查看变更</span>
          )}
        </div>
      </div>

      <div className={styles.main}>
        {subnav === 'history' && (
          <div className={styles.timeline}>
            {loading ? (
              <p className={styles.empty}>加载中…</p>
            ) : history.length === 0 ? (
              <p className={styles.empty}>暂无版本记录</p>
            ) : (
              <ul className={styles.timelineList}>
                {history.map((entry, idx) => (
                  <li key={entry.oid} className={styles.timelineItem}>
                    <button
                      type="button"
                      className={clsx(
                        styles.timelineBtn,
                        selectedHistory?.entry.oid === entry.oid && styles.timelineBtnActive,
                      )}
                      onClick={() => void selectHistory(entry, idx)}
                    >
                      <span className={styles.timelineDot} />
                      <span className={styles.timelineMsg}>
                        {entry.message || shortOid(entry.oid)}
                      </span>
                      <span className={styles.timelineMeta}>
                        {entry.author === 'agent' ? 'agent' : 'user'} · {formatTime(entry.timestamp)} ·{' '}
                        {shortOid(entry.oid)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={styles.rollbackBtn}
                      title="回滚整个工作区到此版本"
                      onClick={() => {
                        setRollbackTarget({ oid: entry.oid, label: entry.message || shortOid(entry.oid) })
                        setRollbackConfirming(true)
                      }}
                    >
                      <RotateCcw size={12} />
                      回滚
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className={styles.diffArea}>
          {(subnav === 'changes' || selectedHistory) && (
            <>
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
              <ChangedFilesRail
                files={listFiles}
                activePath={activePath}
                onSelect={handleSelectFile}
              />
            </>
          )}
          {subnav === 'history' && !selectedHistory && !historyLoading && (
            <p className={styles.emptyHint}>从左侧时间线选择一个版本</p>
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
