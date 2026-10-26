/**
 * WorkspaceCleanupDialog — 手动清理过程文件
 *
 * 先看清单（四类占用 + 最大候选 + 回收站），勾选后执行。
 * 删除 = 移入 `<ws>/.lumii/trash/<id>/`，可在本对话框恢复；
 * 成品（deliverable）永远不在候选里。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import { Modal } from '../../../../components/ui/Modal'
import type {
  CleanupRunResult,
  CleanupScan,
  CleanupTrashEntry,
} from '../../../../../shared/workspace-cleanup-types'
import { formatBytes } from '../WorkspaceArtifactsPanel/ArtifactFoldRow'
import styles from './WorkspaceCleanupDialog.module.css'

const CLASS_LABEL = {
  deliverable: '成品',
  intermediate: '中间产物',
  ephemeral: '临时文件',
  internal: '记账/缓存',
} as const

export interface WorkspaceCleanupDialogProps {
  open: boolean
  onClose: () => void
  /** 清理完成后通知外部刷新 rail 体积 */
  onCleaned?: () => void
  /** 当前会话声明为成品的路径（清理时永不删） */
  protectedPaths?: readonly string[]
}

export const WorkspaceCleanupDialog: React.FC<WorkspaceCleanupDialogProps> = ({
  open,
  onClose,
  onCleaned,
  protectedPaths,
}) => {
  const [scan, setScan] = useState<CleanupScan | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [includeIntermediate, setIncludeIntermediate] = useState(true)
  const [includeEphemeral, setIncludeEphemeral] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<CleanupRunResult | null>(null)
  const [trash, setTrash] = useState<CleanupTrashEntry[]>([])
  /** 干跑结果：真实会删多少（含 too-recent/被引用跳过），不再拿分类总数充数 */
  const [preview, setPreview] = useState<CleanupRunResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const protectedSignature = (protectedPaths ?? []).join('\n')

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.workspace
    if (!api?.cleanupScan) {
      setError('清理接口不可用')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [scanResponse, trashEntries] = await Promise.all([
        api.cleanupScan({ budgetMs: 3000 }),
        api.cleanupListTrash?.() ?? Promise.resolve([]),
      ])
      if (!scanResponse.ok) {
        setError(scanResponse.error)
        setScan(null)
      } else {
        setScan(scanResponse.scan)
      }
      setTrash(trashEntries)
    } catch (err) {
      setError(err instanceof Error ? err.message : '扫描失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setResult(null)
    setPreview(null)
    void refresh()
  }, [open, refresh])

  const targetOf = (): 'intermediate' | 'ephemeral' | 'both' | null =>
    includeIntermediate && includeEphemeral
      ? 'both'
      : includeIntermediate
        ? 'intermediate'
        : includeEphemeral
          ? 'ephemeral'
          : null

  // 勾选变化 → 干跑，得到「实际会删多少」；防抖避免连点触发多次全量扫描
  useEffect(() => {
    if (!open) return
    const target = targetOf()
    if (!target) {
      setPreview(null)
      return
    }
    const api = window.electronAPI?.workspace
    if (!api?.cleanupRun) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      setPreviewLoading(true)
      void api
        .cleanupRun({
          target,
          dryRun: true,
          ...(protectedPaths && protectedPaths.length > 0
            ? { protectedPaths }
            : {}),
        })
        .then((response) => {
          if (cancelled) return
          setPreview(response)
          if (!response.ok && response.error) setError(response.error)
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : '预检失败')
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // protectedSignature 覆盖同一批路径；数组本身每次渲染都可能换引用
  }, [open, includeIntermediate, includeEphemeral, protectedSignature]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async () => {
    const api = window.electronAPI?.workspace
    if (!api?.cleanupRun) return
    const target = targetOf()
    if (!target) return
    setRunning(true)
    setError(null)
    try {
      const response = await api.cleanupRun({
        target,
        dryRun: false,
        ...(protectedPaths && protectedPaths.length > 0 ? { protectedPaths } : {}),
      })
      setResult(response)
      if (!response.ok && response.error) setError(response.error)
      setPreview(null)
      await refresh()
      onCleaned?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : '清理失败')
    } finally {
      setRunning(false)
    }
  }, [includeIntermediate, includeEphemeral, refresh, onCleaned, protectedPaths])

  const restore = useCallback(
    async (id: string) => {
      const api = window.electronAPI?.workspace
      if (!api?.cleanupRestore) return
      const response = await api.cleanupRestore(id)
      if (!response.ok && response.error) setError(response.error)
      await refresh()
      onCleaned?.()
    },
    [refresh, onCleaned],
  )

  const selectedCount = preview?.ok ? preview.removed : 0
  const selectedBytes = preview?.ok ? preview.bytes : 0
  const selectedSkipped = preview?.ok ? preview.skipped : 0
  const canRun = Boolean(preview?.ok && preview.removed > 0) && !running && !previewLoading

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="清理过程文件"
      width={560}
      footer={
        <div className={styles.footer}>
          <span className={styles.selection}>
            {previewLoading
              ? '正在核对可清理范围…'
              : preview?.ok
                ? `实际将清理 ${selectedCount} 个 · 释放约 ${formatBytes(selectedBytes) ?? '0 B'}${
                    selectedSkipped > 0 ? `（跳过 ${selectedSkipped} 个）` : ''
                  }`
                : '暂无可清理项'}
          </span>
          <button type="button" className={styles.cancel} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={styles.confirm}
            onClick={() => void run()}
            disabled={!canRun}
          >
            <Trash2 size={13} strokeWidth={1.8} />
            {running ? '清理中…' : '移入回收站'}
          </button>
        </div>
      }
    >
      <div className={styles.body}>
        <p className={styles.note}>
          只清理过程文件；成品不会被删除。文件先移入回收站，可随时恢复。
        </p>

        {loading && <p className={styles.muted}>正在扫描工作区…</p>}
        {error && <p className={styles.error}>{error}</p>}

        {scan && (
          <>
            <div className={styles.classes}>
              {(Object.keys(CLASS_LABEL) as Array<keyof typeof CLASS_LABEL>).map((role) => (
                <div
                  key={role}
                  className={
                    role === 'deliverable' ? styles.classSafe : styles.classItem
                  }
                >
                  <span className={styles.className}>{CLASS_LABEL[role]}</span>
                  <span className={styles.classValue}>
                    {scan.classes[role].count} 个 ·{' '}
                    {formatBytes(scan.classes[role].bytes) ?? '0 B'}
                  </span>
                </div>
              ))}
            </div>

            <div className={styles.options}>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={includeIntermediate}
                  onChange={(event) => setIncludeIntermediate(event.target.checked)}
                />
                中间产物（切片 / 归一化 / 帧）
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={includeEphemeral}
                  onChange={(event) => setIncludeEphemeral(event.target.checked)}
                />
                临时文件（temp/）
              </label>
            </div>

            {scan.candidates.length > 0 && (
              <div className={styles.candidates}>
                <div className={styles.sectionTitle}>体积最大的文件</div>
                {scan.candidates.slice(0, 20).map((candidate) => (
                  <div className={styles.candidate} key={candidate.path}>
                    <span className={styles.candidatePath} title={candidate.path}>
                      {candidate.path}
                    </span>
                    <span className={styles.candidateSize}>
                      {formatBytes(candidate.bytes) ?? ''}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {scan.truncated && (
              <p className={styles.muted}>
                扫描达到时间预算，统计不完整；已列出的候选仍然有效。
              </p>
            )}
          </>
        )}

        {result?.ok && (
          <p className={styles.success}>
            已移入回收站 {result.removed} 个 ·{' '}
            {formatBytes(result.bytes) ?? '0 B'}
            {result.skipped > 0 ? `（跳过 ${result.skipped} 个最近写入或被引用的文件）` : ''}
          </p>
        )}

        <div className={styles.trash}>
          <div className={styles.sectionTitle}>回收站（{trash.length}）</div>
          {trash.length === 0 ? (
            <p className={styles.muted}>暂无记录。</p>
          ) : (
            trash.map((entry) => (
              <div className={styles.trashRow} key={entry.id}>
                <span className={styles.trashMeta}>
                  {entry.createdAt ? new Date(entry.createdAt).toLocaleString('zh-CN') : entry.id}
                  {' · '}
                  {entry.files} 个 · {formatBytes(entry.bytes) ?? '0 B'}
                </span>
                <button
                  type="button"
                  className={styles.restore}
                  onClick={() => void restore(entry.id)}
                >
                  <RotateCcw size={12} strokeWidth={1.8} />
                  恢复
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  )
}
