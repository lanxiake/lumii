/**
 * WorkspaceChangesPanel — 会话级变更台账（工作台「变更」Tab）
 *
 * 数据来自当前会话每轮 assistant 消息的 fileChanges（历史与实时同一条路径）。
 * 两种视图：
 * - 列表：按轮分组，适合逐轮追溯；
 * - 产物：媒体文件按目录分批的网格，适合批量生成的短剧素材。
 */

import React, { useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  LayoutGrid,
  List as ListIcon,
  Search,
} from 'lucide-react'
import type { FileChangeEntry } from '@mtbot/agent-runtime/browser'
import { FilePreviewModal } from '../../../../components/FilePreviewModal'
import {
  extOf,
  filterArtifacts,
  filterTurns,
  formatClock,
  isImagePath,
  mediaUrl,
  type ArtifactBatch,
  type ArtifactItem,
  type ChangeFilter,
  type ChangeLedger,
  type LedgerTurn,
} from './ledger'
import styles from './WorkspaceChangesPanel.module.css'

const STATUS_LABEL: Record<FileChangeEntry['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
}

const STATUS_SHORT: Record<FileChangeEntry['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
}

const FILTERS: readonly { key: ChangeFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'added', label: '新增' },
  { key: 'modified', label: '修改' },
  { key: 'deleted', label: '删除' },
]

type ViewMode = 'list' | 'artifacts'

function extLabel(filePath: string): string {
  const ext = extOf(filePath)
  if (!ext) return '·'
  return (ext.length > 4 ? ext.slice(0, 4) : ext).toUpperCase()
}

function fileNameOf(filePath: string): string {
  return filePath.split('/').pop() ?? filePath
}

export interface WorkspaceChangesPanelProps {
  ledger: ChangeLedger
  toAbsolutePath: (relativePath: string) => string
  /** 行尾「在文件中定位」：交给工作台切到文件 Tab */
  onRevealInFiles?: (relativePath: string, status: FileChangeEntry['status']) => void
}

export const WorkspaceChangesPanel: React.FC<WorkspaceChangesPanelProps> = ({
  ledger,
  toAbsolutePath,
  onRevealInFiles,
}) => {
  const [mode, setMode] = useState<ViewMode>('list')
  const [filter, setFilter] = useState<ChangeFilter>('all')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [preview, setPreview] = useState<{ absPath: string; name: string } | null>(null)

  const turns = useMemo(
    () => filterTurns(ledger.turns, filter, query),
    [ledger.turns, filter, query],
  )
  const batches = useMemo(
    () => filterArtifacts(ledger.artifacts, filter, query),
    [ledger.artifacts, filter, query],
  )

  const toggleTurn = (messageId: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }

  const openPreview = (filePath: string): void => {
    setPreview({ absPath: toAbsolutePath(filePath), name: fileNameOf(filePath) })
  }

  const renderFileRow = (entry: FileChangeEntry): React.ReactNode => (
    <div className={styles.rowWrap} key={`${entry.status}:${entry.path}`}>
      <button
        type="button"
        className={styles.row}
        onClick={() => openPreview(entry.path)}
        disabled={entry.status === 'deleted'}
        title={entry.status === 'deleted' ? `${entry.path}（已删除）` : entry.path}
      >
        <span className={clsx(styles.status, styles[`status--${entry.status}`])}>
          {STATUS_SHORT[entry.status]}
        </span>
        <span className={styles.ext}>{extLabel(entry.path)}</span>
        <span className={styles.name}>{entry.path}</span>
        {entry.sourceTool && <span className={styles.tool}>{entry.sourceTool}</span>}
        <span className={clsx(styles.statusText, styles[`statusText--${entry.status}`])}>
          {STATUS_LABEL[entry.status]}
        </span>
      </button>
      {entry.status !== 'deleted' && onRevealInFiles && (
        <button
          type="button"
          className={styles.reveal}
          onClick={() => onRevealInFiles(entry.path, entry.status)}
          title="在文件中定位"
          aria-label={`在文件中定位 ${entry.path}`}
        >
          <FolderOpen size={13} strokeWidth={1.8} />
        </button>
      )}
    </div>
  )

  const renderTurn = (turn: LedgerTurn): React.ReactNode => {
    const isCollapsed = collapsed.has(turn.messageId)
    return (
      <section className={styles.turn} key={turn.messageId}>
        <button
          type="button"
          className={styles.turnHeader}
          onClick={() => toggleTurn(turn.messageId)}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? (
            <ChevronRight size={13} strokeWidth={2} />
          ) : (
            <ChevronDown size={13} strokeWidth={2} />
          )}
          <span className={styles.turnTime}>{formatClock(turn.timestamp)}</span>
          {turn.sourceLabel && <span className={styles.turnAgent}>{turn.sourceLabel}</span>}
          <span className={styles.turnCount}>{turn.changes.length} 个文件</span>
        </button>
        {!isCollapsed && <div className={styles.turnBody}>{turn.changes.map(renderFileRow)}</div>}
      </section>
    )
  }

  const renderArtifact = (item: ArtifactItem): React.ReactNode => {
    const absolute = toAbsolutePath(item.path)
    const image = isImagePath(item.path)
    return (
      <button
        type="button"
        key={item.path}
        className={styles.artifact}
        onClick={() => openPreview(item.path)}
        title={item.path}
      >
        <span className={styles.thumb}>
          {image ? (
            <img src={mediaUrl(absolute)} alt="" loading="lazy" decoding="async" />
          ) : (
            <span className={styles.thumbExt}>{extLabel(item.path)}</span>
          )}
          <span className={clsx(styles.statusDot, styles[`status--${item.status}`])}>
            {STATUS_SHORT[item.status]}
          </span>
        </span>
        <span className={styles.artifactName}>{fileNameOf(item.path)}</span>
      </button>
    )
  }

  const renderBatch = (batch: ArtifactBatch): React.ReactNode => (
    <section className={styles.batch} key={batch.dir || '/'}>
      <div className={styles.batchHeader}>
        <span className={styles.batchDir} title={batch.dir}>
          {batch.dir || '（根目录）'}
        </span>
        <span className={styles.batchCount}>{batch.items.length} 个</span>
      </div>
      <div className={styles.grid}>{batch.items.map(renderArtifact)}</div>
    </section>
  )

  const { counts } = ledger
  const nothingAtAll = ledger.turns.length === 0

  return (
    <div className={styles.panel} data-testid="workspace-changes-panel">
      <div className={styles.summary}>
        <div className={styles.summaryText}>
          <strong>{counts.files}</strong> 个文件
          <span className={styles.dot}>·</span>
          <span className={styles.countAdded}>新增 {counts.added}</span>
          <span className={styles.countModified}>修改 {counts.modified}</span>
          <span className={styles.countDeleted}>删除 {counts.deleted}</span>
        </div>
        <div className={styles.modes} role="group" aria-label="变更视图">
          <button
            type="button"
            className={clsx(styles.modeBtn, mode === 'list' && styles.modeActive)}
            onClick={() => setMode('list')}
            aria-pressed={mode === 'list'}
            title="按轮查看"
          >
            <ListIcon size={13} strokeWidth={1.8} />
            列表
          </button>
          <button
            type="button"
            className={clsx(styles.modeBtn, mode === 'artifacts' && styles.modeActive)}
            onClick={() => setMode('artifacts')}
            aria-pressed={mode === 'artifacts'}
            title="按目录查看产物"
          >
            <LayoutGrid size={13} strokeWidth={1.8} />
            产物
            {ledger.artifactCount > 0 && (
              <span className={styles.modeBadge}>{ledger.artifactCount}</span>
            )}
          </button>
        </div>
      </div>

      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Search size={13} strokeWidth={1.8} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文件路径…"
            aria-label="搜索文件路径"
          />
        </label>
        <div className={styles.filters} role="group" aria-label="变更筛选">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={clsx(styles.filter, filter === item.key && styles.filterActive)}
              onClick={() => setFilter(item.key)}
              aria-pressed={filter === item.key}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.scroll}>
        {nothingAtAll ? (
          <div className={styles.empty}>
            本会话还没有文件变更。
            <br />
            执行会写文件的回合后，这里会汇总每一轮的净变更。
          </div>
        ) : mode === 'list' ? (
          turns.length > 0 ? (
            turns.map(renderTurn)
          ) : (
            <div className={styles.empty}>没有匹配的文件。</div>
          )
        ) : batches.length > 0 ? (
          batches.map(renderBatch)
        ) : (
          <div className={styles.empty}>
            {ledger.artifactCount === 0 ? '本会话还没有生成图片/视频/音频产物。' : '没有匹配的产物。'}
          </div>
        )}
      </div>

      {preview && (
        <FilePreviewModal
          filePath={preview.absPath}
          fileName={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}
