/**
 * WorkspaceVersionPanel — 工作空间版本管理面板（文件对比视图）
 *
 * 参考代码编辑器：
 * - 左栏：未提交变更文件列表 + 版本历史列表（点击版本展开其变更文件）
 * - 右栏：点击某文件渲染该文件逐行 diff，并可对单个文件撤销
 * - 仍保留整版回滚（回滚到某历史版本）入口
 * 颜色使用 CSS 变量，自动跟随深色/浅色主题。
 */

import React, { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useWorkspaceVcs, type VcsDiffItem } from '../../../../hooks/business/useWorkspaceVcs'
import { ConfirmModal } from '../../../../components/ui/Modal/ConfirmModal'
import styles from './WorkspaceVersionPanel.module.css'

// ── SVG 图标 ──────────────────────────────────────────────────

const IconClose: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

const IconSave: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" />
  </svg>
)

const IconRollback: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
)

const IconChevron: React.FC<{ expanded: boolean; size?: number }> = ({ expanded, size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
    style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

const IconUndo: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7v6h6" />
    <path d="M3 13a9 9 0 1 0 3-7.7L3 8" />
  </svg>
)

// ── 格式化 ────────────────────────────────────────────────────

function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function shortOid(oid: string): string {
  return oid.slice(0, 8)
}

function statusGlyph(status: string): string {
  return status === 'added' ? '+' : status === 'deleted' ? '-' : '~'
}

// ── 差异行颜色 ────────────────────────────────────────────────

function hunkLineClass(line: string): string {
  if (line.startsWith('+')) return styles['diff-add']
  if (line.startsWith('-')) return styles['diff-del']
  return styles['diff-context']
}

// ── Props ─────────────────────────────────────────────────────

interface WorkspaceVersionPanelProps {
  open: boolean
  onClose: () => void
  /** 嵌入 WorkspaceWorkbench 时去掉全屏遮罩与自有 header */
  embedded?: boolean
}

/**
 * 选中文件的来源上下文：
 * - uncommitted：未提交变更，撤销即恢复到 HEAD
 * - commit：某历史版本的变更，撤销即把该文件恢复到该版本（fromOid）内容
 */
interface SelectedFile {
  filepath: string
  status: string
  /** 撤销时把文件恢复到的版本 oid；未提交变更用 'HEAD' */
  revertOid: string
  source: 'uncommitted' | 'commit'
  /** diff 的两端，用于右栏渲染 */
  diff: VcsDiffItem | null
}

// ── 组件 ─────────────────────────────────────────────────────

export const WorkspaceVersionPanel: React.FC<WorkspaceVersionPanelProps> = ({
  open,
  onClose,
  embedded = false,
}) => {
  const { history, uncommittedDiff, loading, commit, rollback, revertFile, diffWithHunks, refresh } = useWorkspaceVcs()
  const [saving, setSaving] = useState(false)
  const [rollbackTarget, setRollbackTarget] = useState<{ oid: string; label: string } | null>(null)
  const [rollbackConfirming, setRollbackConfirming] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  // 左栏：展开的历史版本 oid → 其文件 diff 列表
  const [expandedOid, setExpandedOid] = useState<string | null>(null)
  const [expandedDiff, setExpandedDiff] = useState<VcsDiffItem[]>([])
  const [diffLoading, setDiffLoading] = useState(false)

  // 右栏：当前选中的文件
  const [selected, setSelected] = useState<SelectedFile | null>(null)

  // 单文件撤销二次确认
  const [revertConfirming, setRevertConfirming] = useState(false)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const result = await commit()
      if (result) {
        showToast('版本已保存')
        await refresh()
        setSelected(null)
      } else {
        showToast('工作区无变更，跳过保存')
      }
    } catch (err) {
      showToast(`保存失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleRollbackClick = (oid: string, message: string) => {
    setRollbackTarget({ oid, label: message || shortOid(oid) })
    setRollbackConfirming(true)
  }

  const handleRollbackConfirm = async () => {
    if (!rollbackTarget) return
    setRollbackConfirming(false)
    try {
      const result = await rollback(rollbackTarget.oid)
      showToast(`已回滚至 ${shortOid(result.restoredOid)}（当前状态已自动备份）`)
      setRollbackTarget(null)
      setSelected(null)
      await refresh()
    } catch (err) {
      showToast(`回滚失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 展开/折叠历史版本：加载该版本相对父版本的文件 diff */
  const handleToggleExpand = async (index: number) => {
    const entry = history[index]
    if (!entry) return
    if (expandedOid === entry.oid) {
      setExpandedOid(null)
      setExpandedDiff([])
      return
    }
    setExpandedOid(entry.oid)
    setDiffLoading(true)
    try {
      const parentIndex = index + 1
      const parentOid = parentIndex < history.length ? history[parentIndex].oid : null
      // 首个提交无父版本：与自身 diff（展示为全新增）
      const diff = await diffWithHunks(parentOid ?? entry.oid, entry.oid)
      setExpandedDiff(diff)
    } catch {
      setExpandedDiff([])
    } finally {
      setDiffLoading(false)
    }
  }

  /** 选中未提交变更中的文件 → 右栏渲染 diff（含 hunks） */
  const handleSelectUncommitted = useCallback(async (item: VcsDiffItem) => {
    setSelected({
      filepath: item.filepath,
      status: item.status,
      revertOid: 'HEAD',
      source: 'uncommitted',
      diff: item.hunks ? item : null,
    })
    if (!item.hunks) {
      // statusDiff 不带 hunks，需补取逐行 diff（HEAD vs 工作区）。
      // diffWithHunks 比对两个 commit，工作区未提交内容无 oid，
      // 这里退化为提示用户先在版本历史查看；仍展示文件级状态。
      setSelectedHunksLoading(false)
    }
  }, [])

  /** 选中历史版本中的文件 → 右栏渲染该文件 diff */
  const handleSelectCommitFile = useCallback((item: VcsDiffItem, parentOid: string) => {
    setSelected({
      filepath: item.filepath,
      status: item.status,
      revertOid: parentOid,
      source: 'commit',
      diff: item,
    })
    setSelectedHunksLoading(false)
  }, [])

  const handleRevertConfirm = async () => {
    if (!selected) return
    setRevertConfirming(false)
    try {
      await revertFile(selected.revertOid, selected.filepath)
      showToast(`已撤销 ${selected.filepath}`)
      setSelected(null)
      await refresh()
    } catch (err) {
      showToast(`撤销失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!open) return null

  const renderDiffHunks = (diff: VcsDiffItem | null) => {
    if (!diff) {
      return <p className={styles['vcs-empty']}>该文件为未提交变更，逐行差异请在保存版本后查看；可直接撤销恢复到上一版本。</p>
    }
    if (!diff.hunks || diff.hunks.length === 0) {
      return <p className={styles['vcs-empty']}>无逐行差异（可能为二进制文件或仅元数据变更）</p>
    }
    return (
      <div className={styles['vcs-diff-hunks']}>
        {diff.hunks.map((h, hi) => (
          <div key={hi} className={styles['vcs-diff-hunk']}>
            <div className={styles['vcs-diff-hunk-header']}>
              @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
            </div>
            {h.lines.map((line, li) => (
              <pre key={li} className={hunkLineClass(line)}>{line}</pre>
            ))}
          </div>
        ))}
      </div>
    )
  }

  const panel = (
      <div
        className={clsx(styles['vcs-panel'], embedded && styles['vcs-panel--embedded'])}
        onClick={embedded ? undefined : (e) => e.stopPropagation()}
      >
        {/* Header：嵌入时由 Workbench 提供 tabs */}
        {!embedded && (
          <div className={styles['vcs-header']}>
            <h3 className={styles['vcs-title']}>工作空间版本</h3>
            <button className={styles['vcs-close']} onClick={onClose}><IconClose /></button>
          </div>
        )}

        {/* 两栏主体 */}
        <div className={styles['vcs-body']}>
          {/* 左栏：文件 / 版本列表 */}
          <div className={styles['vcs-left']}>
            {/* 未提交变更 */}
            <div className={styles['vcs-section']}>
              <div className={styles['vcs-section-header']}>
                <span className={styles['vcs-section-title']}>
                  未提交变更
                  {uncommittedDiff.length > 0 && (
                    <span className={styles['vcs-badge']}>{uncommittedDiff.length}</span>
                  )}
                </span>
                <button
                  className={styles['vcs-btn-save']}
                  onClick={handleSave}
                  disabled={saving}
                >
                  <IconSave size={13} />
                  {saving ? '保存中...' : '保存版本'}
                </button>
              </div>
              {uncommittedDiff.length > 0 ? (
                <ul className={styles['vcs-file-list']}>
                  {uncommittedDiff.map((f) => (
                    <li
                      key={f.filepath}
                      className={clsx(
                        styles['vcs-file-item'],
                        styles['vcs-file-item--clickable'],
                        selected?.source === 'uncommitted' && selected.filepath === f.filepath && styles['vcs-file-item--active'],
                      )}
                      onClick={() => handleSelectUncommitted(f)}
                      title={`点击查看 ${f.filepath}`}
                    >
                      <span className={clsx(styles['vcs-file-status'], styles[`status-${f.status}`])}>
                        {statusGlyph(f.status)}
                      </span>
                      <span className={styles['vcs-file-path']}>{f.filepath}</span>
                      <span className={styles['vcs-file-stats']}>+{f.insertions} -{f.deletions}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles['vcs-empty']}>工作区无变更</p>
              )}
            </div>

            {/* 版本历史 */}
            <div className={styles['vcs-section']}>
              <span className={styles['vcs-section-title']}>版本历史</span>
              {loading ? (
                <p className={styles['vcs-empty']}>加载中...</p>
              ) : history.length === 0 ? (
                <p className={styles['vcs-empty']}>暂无版本记录</p>
              ) : (
                <ul className={styles['vcs-history-list']}>
                  {history.map((entry, idx) => {
                    const parentOid = idx + 1 < history.length ? history[idx + 1].oid : entry.oid
                    return (
                      <li key={entry.oid}>
                        <div className={styles['vcs-history-item']}>
                          <button
                            className={styles['vcs-history-expand']}
                            onClick={() => handleToggleExpand(idx)}
                            title="展开查看变更文件"
                          >
                            <IconChevron expanded={expandedOid === entry.oid} />
                          </button>
                          <div className={styles['vcs-history-meta']}>
                            <span className={styles['vcs-history-author']}>
                              {entry.author === 'agent' ? '' : '👤'}
                            </span>
                            <span className={styles['vcs-history-msg']}>{entry.message || shortOid(entry.oid)}</span>
                            <span className={styles['vcs-history-time']}>{formatTime(entry.timestamp)}</span>
                            <span className={styles['vcs-history-oid']}>{shortOid(entry.oid)}</span>
                          </div>
                          <button
                            className={styles['vcs-btn-rollback']}
                            onClick={() => handleRollbackClick(entry.oid, entry.message)}
                            title="回滚整个工作区到此版本"
                          >
                            <IconRollback size={13} />
                            回滚
                          </button>
                        </div>
                        {/* 该版本的变更文件列表（点击在右栏看 diff） */}
                        {expandedOid === entry.oid && (
                          <div className={styles['vcs-commit-files']}>
                            {diffLoading ? (
                              <p className={styles['vcs-empty']}>加载差异中...</p>
                            ) : expandedDiff.length === 0 ? (
                              <p className={styles['vcs-empty']}>无文件变更</p>
                            ) : (
                              <ul className={styles['vcs-file-list']}>
                                {expandedDiff.map((f) => (
                                  <li
                                    key={f.filepath}
                                    className={clsx(
                                      styles['vcs-file-item'],
                                      styles['vcs-file-item--clickable'],
                                      selected?.source === 'commit' && selected.filepath === f.filepath && selected.revertOid === parentOid && styles['vcs-file-item--active'],
                                    )}
                                    onClick={() => handleSelectCommitFile(f, parentOid)}
                                    title={`点击查看 ${f.filepath}`}
                                  >
                                    <span className={clsx(styles['vcs-file-status'], styles[`status-${f.status}`])}>
                                      {statusGlyph(f.status)}
                                    </span>
                                    <span className={styles['vcs-file-path']}>{f.filepath}</span>
                                    <span className={styles['vcs-file-stats']}>+{f.insertions} -{f.deletions}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* 右栏：选中文件的 diff */}
          <div className={styles['vcs-right']}>
            {!selected ? (
              <div className={styles['vcs-right-empty']}>
                <p>从左侧点击一个文件查看差异</p>
                <p className={styles['vcs-right-empty-sub']}>可对单个文件单独撤销，无需回滚整个工作区</p>
              </div>
            ) : (
              <>
                <div className={styles['vcs-right-header']}>
                  <span className={clsx(styles['vcs-file-status'], styles[`status-${selected.status}`])}>
                    {statusGlyph(selected.status)}
                  </span>
                  <span className={styles['vcs-right-filepath']} title={selected.filepath}>{selected.filepath}</span>
                  <button
                    className={styles['vcs-btn-revert']}
                    onClick={() => setRevertConfirming(true)}
                    title={selected.source === 'uncommitted' ? '丢弃该文件的未提交改动，恢复到上一版本' : '把该文件恢复到此版本之前的内容'}
                  >
                    <IconUndo size={13} />
                    撤销此文件
                  </button>
                </div>
                <div className={styles['vcs-right-diff']}>
                  {selectedHunksLoading ? (
                    <p className={styles['vcs-empty']}>加载差异中...</p>
                  ) : (
                    renderDiffHunks(selected.diff)
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Toast */}
        {toast && <div className={styles['vcs-toast']}>{toast}</div>}
      </div>

      {/* 整版回滚确认 */}
      <ConfirmModal
        open={rollbackConfirming}
        title="确认回滚"
        content={
          rollbackTarget
            ? `回滚整个工作区到「${rollbackTarget.label}」？\n\n当前工作区会自动备份，回滚后可恢复。`
            : ''
        }
        confirmText="确认回滚"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={handleRollbackConfirm}
        onCancel={() => setRollbackConfirming(false)}
      />

      {/* 单文件撤销确认 */}
      <ConfirmModal
        open={revertConfirming}
        title="撤销此文件"
        content={
          selected
            ? selected.source === 'uncommitted'
              ? `丢弃「${selected.filepath}」的未提交改动，恢复到最近一次保存的版本？此操作不可撤销。`
              : `把「${selected.filepath}」恢复到该版本之前的内容？仅影响此文件，不影响其他文件。`
            : ''
        }
        confirmText="确认撤销"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={handleRevertConfirm}
        onCancel={() => setRevertConfirming(false)}
      />
    </div>
  )

  if (embedded) return panel

  return createPortal(
    <div className={styles['vcs-overlay']} onClick={onClose}>
      {panel}
    </div>,
    document.body,
  )
}

export default WorkspaceVersionPanel
