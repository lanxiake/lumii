/**
 * WorkspaceArtifactsPanel — 工作台 rail：按任务分组的产物台账
 *
 * 首屏只放成品；中间产物（切片/归一化/帧）折叠成一行，点开才铺网格。
 * 数据来自当前会话每轮 assistant 消息的 fileChanges，历史与实时同一条路径。
 */

import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Search } from 'lucide-react'
import { stageOfTool, type ArtifactKind } from '../../../../../shared/artifact-rules'
import { actionsForCard, type ArtifactCardState } from '../../../../../shared/card-state'
import { ArtifactCard } from './ArtifactCard'
import { ArtifactFoldRow } from './ArtifactFoldRow'
import { applySelect, type ToggleMode } from './selection'
import { useOptionalToast } from '../../../../components/ui/Toast/useOptionalToast'
import { writeClipboardFiles } from '../../../../services/clipboard-service'
import {
  formatClock,
  type Artifact,
  type ArtifactGroup,
  type ArtifactLedger,
} from './ledger'
import styles from './WorkspaceArtifactsPanel.module.css'

type KindFilter = 'all' | 'image' | 'video' | 'doc' | 'code' | 'other'

/** 折叠网格一次最多铺这么多张，超出给「显示全部」 */
const FOLD_RENDER_CAP = 200

const FILTERS: readonly { key: KindFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'doc', label: '文档' },
  { key: 'code', label: '代码' },
  { key: 'other', label: '其它' },
]

const FILTER_KINDS: Record<Exclude<KindFilter, 'all'>, readonly ArtifactKind[]> = {
  image: ['image', 'image-set'],
  video: ['video'],
  doc: ['doc', 'slides', 'sheet'],
  code: ['code', 'site'],
  other: ['audio', 'archive', 'other'],
}

function matchesKind(kind: ArtifactKind, filter: KindFilter): boolean {
  return filter === 'all' || FILTER_KINDS[filter].includes(kind)
}

function countOfFilter(ledger: ArtifactLedger, filter: KindFilter): number {
  if (filter === 'all') return ledger.counts.deliverables + ledger.counts.intermediates
  let total = 0
  for (const kind of FILTER_KINDS[filter]) total += ledger.counts.byKind[kind] ?? 0
  return total
}

function matchesQuery(artifact: Artifact, needle: string): boolean {
  return !needle || artifact.path.toLowerCase().includes(needle)
}

/** 1s 走一次的已用时；卸载清定时器 */
function useElapsed(startedAt: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || !startedAt) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, startedAt])
  if (!startedAt) return 0
  return Math.max(0, Math.floor((now - startedAt) / 1000))
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m${String(rest).padStart(2, '0')}s`
}

export interface ArtifactProgress {
  /** 当前阶段（用户语言）；未知为 undefined → 「执行中」 */
  toolName?: string
  done: number
  total: number
  startedAt: number
}

export interface WorkspaceArtifactsPanelProps {
  ledger: ArtifactLedger
  toAbsolutePath: (relativePath: string) => string
  selectedPath?: string
  onSelect: (relativePath: string) => void
  /** 双击开独立预览窗 */
  onOpenWindow?: (absolutePath: string, fileName: string) => void
  /** 多选对比（2–4 项）：由工作台把 main 切到对比视图 */
  onCompare?: (relativePaths: readonly string[]) => void
  /** 已在本次会话里被删掉的路径：历史 fileChanges 仍会派生卡片，这里统一隐藏 */
  trashedPaths?: ReadonlySet<string>
  /** 删除成功后上抛，父层负责隐藏卡片并提供刷新入口 */
  onTrashed?: (relativePaths: readonly string[]) => void
  /** 当前回合有工具在跑时的进度（阶段 + 已完成/总数 + 起始时间） */
  progress?: ArtifactProgress | null
  /** 中断当前回合（复用 ChatInput 的同一条中止通道） */
  onAbort?: () => void
  /** 打开清理对话框 */
  onCleanup?: () => void
  /** 当前回合的工具卡状态（running / failed / cancelled 占位） */
  cards?: readonly ArtifactCardState[]
  /** 等审批（interrupt）：卡片式动作，复用现有权限通道 */
  interrupt?: {
    title: string
    detail?: string
    onAllowOnce?: () => void
    onAllowAlways?: () => void
    onDeny?: () => void
  }
  /** 失败卡「重试」：只把原 prompt 放回输入框，不自动发送 */
  onRetryPrompt?: (prompt: string) => void
  /**
   * 工作区中间产物总体积（主进程 scan 懒加载）。
   * 只在「本屏只有一组过程文件」时挂到该行——scan 是全局数，多组重复显示会错。
   */
  intermediateBytes?: number
}

export const WorkspaceArtifactsPanel: React.FC<WorkspaceArtifactsPanelProps> = ({
  ledger,
  toAbsolutePath,
  selectedPath,
  onSelect,
  onOpenWindow,
  onCompare,
  trashedPaths,
  onTrashed,
  progress,
  onAbort,
  onCleanup,
  cards = [],
  interrupt,
  onRetryPrompt,
  intermediateBytes,
}) => {
  const [filter, setFilter] = useState<KindFilter>('all')
  const [query, setQuery] = useState('')
  /** 多选：Ctrl/Cmd 加选、Shift 区间（区间只在可见顺序里算） */
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * 默认只展开最新一组（「本次任务」），更早的折叠——
   * 一个会话可能有几十组、三百多张卡，全展开既费 DOM 也不是用户当下要看的。
   * 用户点过之后以 overrides 为准。
   */
  const [groupOverrides, setGroupOverrides] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [expandedFolds, setExpandedFolds] = useState<ReadonlySet<string>>(new Set())
  /** 一次最多铺 200 张过程卡；再多先给按钮（1114 张全铺 ≈ 6800 节点） */
  const [showAllFolds, setShowAllFolds] = useState<ReadonlySet<string>>(new Set())
  // 默认只展开最新一组；但筛选/搜索时把所有命中组展开，否则用户看不到结果
  const filterActive = filter !== 'all' || query.trim().length > 0
  const defaultOpen = (key: string, _timestamp: number): boolean =>
    filterActive || key === ledger.groups[0]?.key
  const isGroupOpen = (key: string, timestamp: number): boolean =>
    groupOverrides.has(key) ? groupOverrides.get(key)! : defaultOpen(key, timestamp)
  const toggleGroup = (key: string, timestamp: number): void => {
    setGroupOverrides((previous) => {
      const next = new Map(previous)
      next.set(key, !(previous.has(key) ? previous.get(key) : defaultOpen(key, timestamp)))
      return next
    })
  }

  const elapsed = useElapsed(progress?.startedAt, Boolean(progress))
  const stage = progress?.toolName ? stageOfTool(progress.toolName) : undefined

  const needle = query.trim().toLowerCase()
  const filteredGroups = useMemo(() => {
    const pass = (item: Artifact): boolean =>
      matchesKind(item.kind, filter) &&
      matchesQuery(item, needle) &&
      !trashedPaths?.has(item.path)
    const out: Array<{
      group: ArtifactGroup
      deliverables: Artifact[]
      intermediates: Artifact[]
    }> = []
    for (const group of ledger.groups) {
      const deliverables = group.deliverables.filter(pass)
      const intermediates = group.intermediates.filter(pass)
      if (deliverables.length + intermediates.length === 0) continue
      out.push({ group, deliverables, intermediates })
    }
    return out
  }, [ledger.groups, filter, needle, trashedPaths])

  /**
   * 可见条目顺序（Shift 区间用）：按渲染顺序把「展开组的成品 + 展开折叠行的过程文件」
   * 拼起来。收起的内容不参与——用户看不见的东西不该被一键圈走。
   * 过程文件最多铺 FOLD_RENDER_CAP 张，顺序也照实际渲染的来。
   */
  const visibleOrder = useMemo(() => {
    const out: string[] = []
    for (const { group, deliverables, intermediates } of filteredGroups) {
      if (!isGroupOpen(group.key, group.timestamp)) continue
      for (const item of deliverables) out.push(item.path)
      if (!expandedFolds.has(group.key)) continue
      const shown = showAllFolds.has(group.key)
        ? intermediates
        : intermediates.slice(0, FOLD_RENDER_CAP)
      for (const item of shown) out.push(item.path)
    }
    return out
    // isGroupOpen 读 groupOverrides / filterActive，两者都在依赖里
  }, [filteredGroups, groupOverrides, expandedFolds, showAllFolds, filterActive]) // eslint-disable-line react-hooks/exhaustive-deps

  // 选择集随可见性收敛：切筛选/收组后，已经看不到的项别继续挂着（底部条会显示它）
  useEffect(() => {
    setSelection((previous) => {
      if (previous.size === 0) return previous
      const visible = new Set(visibleOrder)
      let changed = false
      const next = new Set<string>()
      for (const path of previous) {
        if (visible.has(path)) next.add(path)
        else changed = true
      }
      return changed ? next : previous
    })
  }, [visibleOrder])

  const toast = useOptionalToast()

  const handleCardSelect = (artifact: Artifact, mode?: 'add' | 'range'): void => {
    const result = applySelect({
      selected: selection,
      order: visibleOrder,
      path: artifact.path,
      mode: (mode ?? 'toggle') as ToggleMode,
      anchor,
    })
    setSelection(result.selected)
    setAnchor(result.anchor)
    // 普通点击就是「看这个」；多选时只改选中集，不打断当前预览
    if (!mode) onSelect(artifact.path)
  }

  const selectedArtifacts = useMemo(() => {
    if (selection.size === 0) return []
    const byPath = new Map<string, Artifact>()
    for (const group of ledger.groups) {
      for (const item of group.deliverables) byPath.set(item.path, item)
      for (const item of group.intermediates) byPath.set(item.path, item)
    }
    const out: Artifact[] = []
    for (const path of selection) {
      const hit = byPath.get(path)
      if (hit) out.push(hit)
    }
    return out
  }, [ledger.groups, selection])

  const clearSelection = (): void => {
    setSelection(new Set())
    setAnchor(null)
  }

  const handleExport = async (mode: 'zip' | 'copy'): Promise<void> => {
    const api = window.electronAPI?.artifact
    const paths = selectedArtifacts.map((item) => item.path)
    if (!api?.exportFiles || paths.length === 0) return
    setBusy(true)
    try {
      const result = await api.exportFiles(paths, mode)
      if (result.ok) {
        toast.success(
          `已${mode === 'zip' ? '打包' : '复制'} ${result.exported} 个文件到 ${result.destPath ?? '目标位置'}`,
        )
      } else if (result.error !== '已取消') {
        toast.error(result.error ?? '导出失败')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导出失败')
    } finally {
      setBusy(false)
    }
  }

  const handleTrash = async (): Promise<void> => {
    const api = window.electronAPI?.artifact
    const paths = selectedArtifacts.map((item) => item.path)
    if (!api?.trash || paths.length === 0) return
    setBusy(true)
    try {
      const result = await api.trash(paths)
      if (!result.ok) {
        toast.error(result.error ?? '删除失败')
        return
      }
      const removed = new Set(paths)
      onTrashed?.([...removed])
      toast.success(
        result.skipped > 0
          ? `已移入回收站 ${result.removed} 个（${result.skipped} 个被引用/不可删，已保留）`
          : `已移入回收站 ${result.removed} 个（可在「清理…」里恢复）`,
      )
      clearSelection()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const handleCopyPaths = (): void => {
    const absolute = selectedArtifacts.map((item) => toAbsolutePath(item.path))
    void writeClipboardFiles(absolute)
      .then(() => toast.success(`已复制 ${absolute.length} 个文件到剪贴板`))
      .catch(() => toast.error('复制失败'))
  }

  const handleCompare = (): void => {
    if (!onCompare || selectedArtifacts.length < 2) return
    onCompare(selectedArtifacts.map((item) => item.path))
  }

  const toggle = (
    setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
    key: string,
  ): void => {
    setter((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const renderCard = (artifact: Artifact): React.ReactNode => (
    <ArtifactCard
      key={artifact.path}
      artifact={artifact}
      absolutePath={toAbsolutePath(artifact.path)}
      selected={selectedPath === artifact.path || selection.has(artifact.path)}
      onSelect={(path, mode) => handleCardSelect(artifact, mode)}
      {...(onOpenWindow ? { onOpenWindow } : {})}
    />
  )

  const runningCards = cards.filter((card) => card.lifecycle === 'running')
  /** 有 running 卡时，卡片本身就是进度视图，不再叠一条进度条（避免同一件事出现两次） */
  const showProgressBar = Boolean(progress) && runningCards.length === 0
  const nothingAtAll = ledger.groups.length === 0 && cards.length === 0
  /** scan 字节是工作区全局值；仅当过滤后只有一组含过程文件时才展示，避免多行重复同一体积 */
  const foldBytesGroupKey =
    intermediateBytes &&
    filteredGroups.filter((entry) => entry.intermediates.length > 0).length === 1
      ? filteredGroups.find((entry) => entry.intermediates.length > 0)?.group.key
      : undefined

  return (
    <div className={styles.panel} data-testid="workspace-artifacts-panel">
      {showProgressBar && progress && (
        <div className={styles.progress} role="status" aria-live="polite">
          <span className={styles.progressStage}>{stage ?? '执行中'}</span>
          <span className={styles.progressMeta}>
            {progress.total > 0 ? `${progress.done}/${progress.total} · ` : ''}
            {formatElapsed(elapsed)}
          </span>
          {onAbort && (
            <button
              type="button"
              className={styles.progressAbort}
              onClick={onAbort}
              title="中断本次运行（与输入框停止按钮相同）"
            >
              中断
            </button>
          )}
        </div>
      )}

      {interrupt && (
        <div className={styles.interrupt} role="status">
          <span className={styles.interruptLabel}>等你拍板</span>
          <span className={styles.interruptTitle} title={interrupt.detail ?? interrupt.title}>
            {interrupt.title}
          </span>
          <div className={styles.interruptActions}>
            {interrupt.onAllowOnce && (
              <button type="button" onClick={interrupt.onAllowOnce}>
                允许一次
              </button>
            )}
            {interrupt.onAllowAlways && (
              <button type="button" onClick={interrupt.onAllowAlways}>
                总是允许
              </button>
            )}
            {interrupt.onDeny && (
              <button type="button" className={styles.interruptDeny} onClick={interrupt.onDeny}>
                拒绝
              </button>
            )}
          </div>
        </div>
      )}

      {cards.length > 0 && (
        <div className={styles.pendingList}>
          {cards.map((card) => {
            const actions = actionsForCard(card)
            return (
              <div
                key={card.id}
                className={clsx(styles.pendingCard, styles[`pending--${card.lifecycle}`])}
                data-card-lifecycle={card.lifecycle}
              >
                <span className={styles.pendingBadge}>
                  {card.lifecycle === 'running'
                    ? '进行中'
                    : card.lifecycle === 'failed'
                      ? '失败'
                      : '已中断'}
                </span>
                <span className={styles.pendingTitle} title={card.title}>
                  {card.title ?? card.kind}
                </span>
                {card.placeholder?.prompt && (
                  <span className={styles.pendingPrompt}>{card.placeholder.prompt}</span>
                )}
                {card.error && <span className={styles.pendingError}>{card.error}</span>}
                {card.lifecycle === 'running' && progress && (
                  <span className={styles.pendingMeta}>
                    {progress.total > 0 ? `${progress.done}/${progress.total} · ` : ''}
                    {formatElapsed(elapsed)}
                  </span>
                )}
                <div className={styles.pendingActions}>
                  {actions.includes('abort') && onAbort && (
                    <button type="button" onClick={onAbort}>
                      中断
                    </button>
                  )}
                  {actions.includes('retry') && card.retry?.prompt && onRetryPrompt && (
                    <button type="button" onClick={() => onRetryPrompt(card.retry!.prompt!)}>
                      重试
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className={styles.summary}>
        <span className={styles.summaryText}>
          {ledger.counts.deliverables === 0 && runningCards.length > 0 ? (
            <span className={styles.summaryMuted}>正在生成…</span>
          ) : (
            <>
              <strong>{ledger.counts.deliverables}</strong> 个产出
              {ledger.counts.intermediates > 0 && (
                <span className={styles.summaryMuted}>
                  · 中间 {ledger.counts.intermediates}
                </span>
              )}
            </>
          )}
        </span>
        {onCleanup && (
          <button
            type="button"
            className={styles.summaryCleanup}
            onClick={onCleanup}
            title="清理过程文件（先进回收站）"
          >
            清理…
          </button>
        )}
      </div>

      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Search size={13} strokeWidth={1.8} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索产物路径…"
            aria-label="搜索产物路径"
          />
        </label>
        <div className={styles.filters} role="group" aria-label="产物筛选">
          {FILTERS.map((item) => {
            const count = countOfFilter(ledger, item.key)
            return (
              <button
                key={item.key}
                type="button"
                className={clsx(styles.filter, filter === item.key && styles.filterActive)}
                onClick={() => setFilter(item.key)}
                aria-pressed={filter === item.key}
              >
                {item.label}
                {count > 0 && <span className={styles.filterCount}>{count}</span>}
              </button>
            )
          })}
        </div>
      </div>

      <div className={styles.scroll}>
        {nothingAtAll ? (
          <div className={styles.empty}>
            这个会话还没有产出。
            <br />
            试着让我写一份文档、做一组图，或整理一下当前工作区。
          </div>
        ) : filteredGroups.length === 0 ? (
          cards.length > 0 ? null : <div className={styles.empty}>没有匹配的产物。</div>
        ) : (
          filteredGroups.map(({ group, deliverables, intermediates }) => {
            const expanded = isGroupOpen(group.key, group.timestamp)
            const foldOpen = expandedFolds.has(group.key)
            return (
              <section className={styles.group} key={group.key || '(root)'}>
                <button
                  type="button"
                  className={styles.groupHeader}
                  onClick={() => toggleGroup(group.key, group.timestamp)}
                  aria-expanded={expanded}
                >
                  <span className={styles.groupTime}>{formatClock(group.timestamp)}</span>
                  <span className={styles.groupLabel} title={group.label}>
                    {group.label}
                  </span>
                  {group.sourceLabel && (
                    <span className={styles.groupAgent}>{group.sourceLabel}</span>
                  )}
                  <span className={styles.groupCount}>
                    {deliverables.length > 0 ? `${deliverables.length} 个成品` : '仅过程文件'}
                  </span>
                </button>

                {expanded && (
                  <div className={styles.groupBody}>
                    {deliverables.length > 0 && (
                      <div className={styles.grid}>{deliverables.map(renderCard)}</div>
                    )}
                    {intermediates.length > 0 && (
                      <>
                        <ArtifactFoldRow
                          count={intermediates.length}
                          {...(foldBytesGroupKey === group.key && intermediateBytes
                            ? { bytes: intermediateBytes }
                            : {})}
                          expanded={foldOpen}
                          onToggle={() => toggle(setExpandedFolds, group.key)}
                          {...(onCleanup ? { onCleanup } : {})}
                        />
                        {foldOpen && (
                          <>
                            <p className={styles.foldNote}>这些是过程文件，通常用于重跑。</p>
                            <div className={styles.grid}>
                              {(showAllFolds.has(group.key)
                                ? intermediates
                                : intermediates.slice(0, FOLD_RENDER_CAP)
                              ).map(renderCard)}
                            </div>
                            {!showAllFolds.has(group.key) &&
                              intermediates.length > FOLD_RENDER_CAP && (
                                <button
                                  type="button"
                                  className={styles.foldMore}
                                  onClick={() => toggle(setShowAllFolds, group.key)}
                                >
                                  显示全部 {intermediates.length} 个
                                </button>
                              )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </section>
            )
          })
        )}
      </div>

      {/* 多选条：固定在 rail 底部（不随列表滚走），未选中时不占位 */}
      {selection.size > 0 && (
        <div className={styles.selectionBar} role="toolbar" aria-label="已选产物操作">
          <span className={styles.selectionCount}>已选 {selection.size} 项</span>
          <button
            type="button"
            className={styles.selectionAction}
            disabled={busy}
            onClick={() => void handleExport('zip')}
            title="打包成一个 zip（保留目录结构）"
          >
            导出 zip
          </button>
          <button
            type="button"
            className={styles.selectionAction}
            disabled={busy}
            onClick={() => void handleExport('copy')}
            title="复制到指定文件夹（重名自动改名）"
          >
            复制到…
          </button>
          <button
            type="button"
            className={styles.selectionAction}
            onClick={handleCopyPaths}
            title="把文件复制到剪贴板，可直接粘贴"
          >
            复制路径
          </button>
          {onCompare && (
            <button
              type="button"
              className={styles.selectionAction}
              disabled={selection.size < 2}
              onClick={handleCompare}
              title={selection.size < 2 ? '至少选 2 项才能对比' : '在右侧并排对比'}
            >
              对比
            </button>
          )}
          <button
            type="button"
            className={clsx(styles.selectionAction, styles.selectionDanger)}
            disabled={busy}
            onClick={() => void handleTrash()}
            title="移入回收站（可在「清理…」里恢复）"
          >
            移入回收站
          </button>
          <button
            type="button"
            className={styles.selectionClose}
            onClick={clearSelection}
            title="取消选择（Esc）"
            aria-label="取消选择"
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
