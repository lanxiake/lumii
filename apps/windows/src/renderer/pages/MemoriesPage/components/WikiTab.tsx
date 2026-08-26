/**
 * WikiTab — Wiki 知识库界面（P0 两栏 + P1 第三栏/清理视图/编辑器增强）
 *
 * 左栏：搜索 + 固定分类树（sources/media/inbox）+ 待整理入口 + 清理入口；
 * 右栏三视图：页面（渲染/编辑，附第三栏反链+修订历史）、待整理、运行日志、清理。
 * P0 不做真实文件树懒加载——固定顶层分类，直接按分类过滤页面列表即可。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import MDEditor from '@uiw/react-md-editor'
import { Search, Inbox, FileText, Image as ImageIcon, RefreshCw, Trash2, History, Sparkles, Network, BookOpen } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import { Loading } from '../../../components/ui/Loading/Loading'
import { ConfirmModal } from '../../../components/ui/Modal'
import {
  useWikiPage,
  type WikiInboxItem,
  type WikiPageListItem,
  type WikiPageDetail,
  type WikiSearchHit,
  type WikiRunItem,
} from '../../../hooks/business/useWikiPage'
import { PageSidebar } from './PageSidebar'
import { CleanupView } from './CleanupView'
import { SynthesisView } from './SynthesisView'
import { WikiGraphView } from './WikiGraphView'
import { LinkAutocomplete, detectWikilinkTrigger } from './LinkAutocomplete'
import { uploadFilesForWikiAttachment } from './wikiAttachmentUpload'
import './WikiTab.css'

type WikiCategory = 'sources' | 'media' | 'inbox'
type RightView = 'page' | 'inbox' | 'runs' | 'cleanup' | 'synthesis' | 'graph'

const CATEGORY_LABEL: Record<WikiCategory, string> = {
  sources: '资料',
  media: '多媒体',
  inbox: '待整理',
}

const CATEGORY_ICON: Record<WikiCategory, React.FC<{ size?: number | string }>> = {
  sources: FileText,
  media: ImageIcon,
  inbox: Inbox,
}

function formatTime(ts: number | null): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

const OUTCOME_LABEL: Record<string, string> = {
  archived: '已归档',
  corrected: '已纠正',
  degraded: '已降级',
  failed: '失败',
}

const EXTRACT_LABEL: Record<string, string> = {
  preview: '已有预览',
  extracted: '本次提取',
  none: '无正文',
}

/** 可展开的归档运行日志条目 */
const RunLogItem: React.FC<{ run: WikiRunItem }> = ({ run }) => {
  const [expanded, setExpanded] = useState(false)
  const hasDetail = (run.resultDetail?.items.length ?? 0) > 0

  return (
    <div className="wiki-run-item">
      <button
        type="button"
        className={`wiki-run-item-header${hasDetail ? ' wiki-run-item-header--expandable' : ''}`}
        onClick={() => hasDetail && setExpanded((v) => !v)}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        <span className={`wiki-run-status wiki-run-status--${run.status}`}>{run.status}</span>
        <span>{formatTime(run.createdAt)}</span>
        {hasDetail && <span className="wiki-run-expand-hint">{expanded ? '收起' : '展开明细'}</span>}
      </button>
      {run.resultSummary && <p>{run.resultSummary}</p>}
      {run.error && <p className="wiki-inbox-item-error">{run.error}</p>}
      {expanded && run.resultDetail?.items.map((item) => (
        <div key={item.inboxId} className="wiki-run-detail-item">
          <div className="wiki-run-detail-item-header">
            <span className={`wiki-run-outcome wiki-run-outcome--${item.outcome}`}>
              {OUTCOME_LABEL[item.outcome] ?? item.outcome}
            </span>
            <span className="wiki-run-detail-title">{item.title}</span>
            <span className="wiki-run-detail-extract">{EXTRACT_LABEL[item.extract] ?? item.extract}</span>
          </div>
          <p className="wiki-run-detail-path">{item.title} → {item.path || '（未落库）'}</p>
          {item.reason && <p className="wiki-run-detail-reason">{item.reason}</p>}
        </div>
      ))}
    </div>
  )
}

/** 在光标处插入文本，替换 [[ 起始位置到当前光标的内容（用于自动补全选择后落子） */
function insertWikilinkAtCursor(textarea: HTMLTextAreaElement, currentValue: string, title: string): string {
  const cursor = textarea.selectionStart
  const before = currentValue.slice(0, cursor)
  const after = currentValue.slice(cursor)
  const lastOpen = before.lastIndexOf('[[')
  if (lastOpen === -1) return currentValue
  return `${before.slice(0, lastOpen)}[[${title}]]${after}`
}

export const WikiTab: React.FC = () => {
  const {
    listInbox,
    countInbox,
    retryInbox,
    discardInbox,
    listPages,
    getPage,
    updatePage,
    deletePage,
    search,
    listRuns,
    rebuildIndex,
    listBacklinks,
    listRevisions,
    rollbackPage,
    cleanupScan,
    archiveSources,
    restoreSources,
    deleteSources,
    createSynthesis,
    listSyntheses,
    getSynthesis,
    acceptSynthesis,
    rejectSynthesis,
    getGraphData,
    statusScan,
    confirmStatus,
    searchHybrid,
    bootstrapEro,
    loading,
  } = useWikiPage()

  const [category, setCategory] = useState<WikiCategory | null>('sources')
  const [rightView, setRightView] = useState<RightView>('page')
  const [pages, setPages] = useState<readonly WikiPageListItem[]>([])
  const [pageCounts, setPageCounts] = useState<Record<string, number>>({})
  const [inboxItems, setInboxItems] = useState<readonly WikiInboxItem[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [runs, setRuns] = useState<readonly WikiRunItem[]>([])
  const [selectedPage, setSelectedPage] = useState<WikiPageDetail | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<readonly WikiSearchHit[] | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ backlinks: number } | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [linkQuery, setLinkQuery] = useState<string | null>(null)
  const [searchDegradeReason, setSearchDegradeReason] = useState<string | null>(null)
  const [searchMode, setSearchMode] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const refreshPages = useCallback(async () => {
    const all = await listPages()
    setPages(all)
    const counts: Record<string, number> = {}
    for (const p of all) counts[p.category] = (counts[p.category] ?? 0) + 1
    setPageCounts(counts)
  }, [listPages])

  const refreshInbox = useCallback(async () => {
    const [all, total] = await Promise.all([listInbox('pending'), countInbox('pending')])
    setInboxItems(all)
    setPendingCount(total)
  }, [listInbox, countInbox])

  const refreshRuns = useCallback(async () => {
    setRuns(await listRuns())
  }, [listRuns])

  useEffect(() => {
    void refreshPages()
    void refreshInbox()
  }, [refreshPages, refreshInbox])

  useEffect(() => {
    if (rightView === 'runs') void refreshRuns()
  }, [rightView, refreshRuns])

  const handleSelectCategory = useCallback((cat: WikiCategory) => {
    setCategory(cat)
    setSearchResults(null)
    setSearchDegradeReason(null)
    setSearchMode(null)
    setRightView(cat === 'inbox' ? 'inbox' : 'page')
    setSelectedPage(null)
  }, [])

  const handleOpenPage = useCallback(
    async (pageId: string) => {
      const page = await getPage(pageId)
      setSelectedPage(page)
      setIsEditing(false)
      setSearchResults(null)
      setRightView('page')
    },
    [getPage],
  )

  const handleStartEdit = useCallback(() => {
    if (!selectedPage) return
    setEditTitle(selectedPage.title)
    setEditDraft(selectedPage.contentMd)
    setIsEditing(true)
  }, [selectedPage])

  const handleSaveEdit = useCallback(async () => {
    if (!selectedPage) return
    const updated = await updatePage(selectedPage.path, editTitle, editDraft)
    if (updated) {
      setSelectedPage(updated)
      setIsEditing(false)
      void refreshPages()
    }
  }, [selectedPage, editTitle, editDraft, updatePage, refreshPages])

  const requestDeletePage = useCallback(async () => {
    if (!selectedPage) return
    const backlinks = await listBacklinks(selectedPage.id)
    setDeleteConfirm({ backlinks: backlinks.length })
  }, [selectedPage, listBacklinks])

  const handleConfirmDeletePage = useCallback(async () => {
    if (!selectedPage) return
    const ok = await deletePage(selectedPage.id)
    setDeleteConfirm(null)
    if (ok) {
      setSelectedPage(null)
      void refreshPages()
    }
  }, [selectedPage, deletePage, refreshPages])

  const handleRetry = useCallback(
    async (inboxId: string) => {
      await retryInbox(inboxId)
      void refreshInbox()
    },
    [retryInbox, refreshInbox],
  )

  const handleDiscard = useCallback(
    async (inboxId: string) => {
      await discardInbox(inboxId)
      void refreshInbox()
    },
    [discardInbox, refreshInbox],
  )

  const handleSearch = useCallback(async () => {
    if (!query.trim()) {
      setSearchResults(null)
      setSearchDegradeReason(null)
      setSearchMode(null)
      return
    }
    const hybrid = await searchHybrid(query)
    if (hybrid) {
      setSearchResults(hybrid.hits)
      setSearchDegradeReason(hybrid.degradeReason)
      setSearchMode(hybrid.mode)
      return
    }
    setSearchResults(await search(query))
    setSearchDegradeReason('混合检索不可用，已回退全文检索')
    setSearchMode('fts')
  }, [query, search, searchHybrid])

  const handleRebuildIndex = useCallback(async () => {
    await rebuildIndex()
    void refreshPages()
  }, [rebuildIndex, refreshPages])

  const handleRolledBack = useCallback(() => {
    if (!selectedPage) return
    void handleOpenPage(selectedPage.id)
  }, [selectedPage, handleOpenPage])

  /** 编辑草稿变化时检测 [[ 触发自动补全，并同步文本框光标位置供插入定位 */
  const handleEditChange = useCallback(
    (val: string | undefined, event?: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = val ?? ''
      setEditDraft(next)
      if (event?.target) textareaRef.current = event.target
      const cursor = event?.target?.selectionStart ?? next.length
      setLinkQuery(detectWikilinkTrigger(next.slice(0, cursor)))
    },
    [],
  )

  const handleSelectWikilink = useCallback((page: WikiPageListItem) => {
    const textarea = textareaRef.current
    if (!textarea) return
    setEditDraft((prev) => insertWikilinkAtCursor(textarea, prev, page.title))
    setLinkQuery(null)
  }, [])

  const handleAttachmentDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      if (!isEditing || e.dataTransfer.files.length === 0) return
      const uploaded = await uploadFilesForWikiAttachment(e.dataTransfer.files)
      if (uploaded.length === 0) return
      setEditDraft((prev) => {
        const lines = uploaded.map((u) => u.referenceLine).join('\n')
        return prev ? `${prev}\n${lines}` : lines
      })
    },
    [isEditing],
  )

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isEditing) return
      e.preventDefault()
      setIsDragOver(true)
    },
    [isEditing],
  )

  const visiblePages = category ? pages.filter((p) => p.category === category) : pages

  return (
    <div className="wiki-tab">
      <div className="wiki-tab-left">
        <div className="wiki-search">
          <Search size={14} className="wiki-search-icon" />
          <input
            type="text"
            placeholder="搜索 Wiki（支持中文）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch() }}
          />
        </div>

        <div className="wiki-category-list">
          {(['sources', 'media', 'inbox'] as const).map((cat) => {
            const Icon = CATEGORY_ICON[cat]
            const count = cat === 'inbox' ? pendingCount : (pageCounts[cat] ?? 0)
            return (
              <button
                key={cat}
                type="button"
                className={`wiki-category-item ${category === cat && rightView !== 'cleanup' ? 'wiki-category-item--active' : ''}`}
                onClick={() => handleSelectCategory(cat)}
              >
                <Icon size={14} />
                <span>{CATEGORY_LABEL[cat]}</span>
                <span className="wiki-category-count">{count}</span>
              </button>
            )
          })}
        </div>

        <button
          type="button"
          className={`wiki-runs-entry ${rightView === 'runs' ? 'wiki-category-item--active' : ''}`}
          onClick={() => setRightView('runs')}
        >
          <History size={14} />
          <span>运行日志</span>
        </button>

        <button
          type="button"
          className={`wiki-runs-entry ${rightView === 'cleanup' ? 'wiki-category-item--active' : ''}`}
          onClick={() => setRightView('cleanup')}
        >
          <Sparkles size={14} />
          <span>清理</span>
        </button>

        <button
          type="button"
          className={`wiki-runs-entry ${rightView === 'synthesis' ? 'wiki-category-item--active' : ''}`}
          onClick={() => setRightView('synthesis')}
        >
          <BookOpen size={14} />
          <span>综述合成</span>
        </button>

        <button
          type="button"
          className={`wiki-runs-entry ${rightView === 'graph' ? 'wiki-category-item--active' : ''}`}
          onClick={() => setRightView('graph')}
        >
          <Network size={14} />
          <span>图谱</span>
        </button>

        <div className="wiki-left-footer">
          <Button variant="ghost" size="sm" onClick={() => void handleRebuildIndex()}>
            <RefreshCw size={12} style={{ marginRight: 4 }} />
            重建索引
          </Button>
        </div>
      </div>

      <div className="wiki-tab-right">
        {loading && !selectedPage && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
            <Loading text="加载中..." />
          </div>
        )}

        {searchResults !== null ? (
          <div className="wiki-search-results">
            <h3>
              搜索结果（{searchResults.length}）
              {searchMode ? <span className="wiki-search-mode"> · {searchMode}</span> : null}
            </h3>
            {searchDegradeReason && (
              <p className="wiki-search-degrade" role="status">
                {searchDegradeReason}
              </p>
            )}
            {searchResults.length === 0 ? (
              <p className="wiki-empty-hint">未找到相关页面</p>
            ) : (
              searchResults.map((hit) => (
                <div key={hit.pageId} className="wiki-page-list-item" onClick={() => void handleOpenPage(hit.pageId)}>
                  <div className="wiki-page-list-title">{hit.title}</div>
                  <div className="wiki-page-list-path">{hit.path}</div>
                  <div className="wiki-page-list-snippet">{hit.snippet}</div>
                </div>
              ))
            )}
          </div>
        ) : rightView === 'inbox' ? (
          <div className="wiki-inbox-view">
            <h3>待整理（{pendingCount}）</h3>
            {inboxItems.length < pendingCount && (
              <p className="wiki-empty-hint">仅显示最近 {inboxItems.length} 条</p>
            )}
            {inboxItems.length === 0 ? (
              <p className="wiki-empty-hint">暂无待整理条目。上传文件、任务产物或网页搜索结果会自动出现在这里。</p>
            ) : (
              inboxItems.map((item) => (
                <div key={item.id} className="wiki-inbox-item">
                  <div className="wiki-inbox-item-header">
                    <span className="wiki-inbox-item-type">{item.itemType}</span>
                    <span className="wiki-inbox-item-title">{item.title}</span>
                    <span className={`wiki-inbox-item-status wiki-inbox-item-status--${item.status}`}>
                      {item.status}
                    </span>
                  </div>
                  {item.contentPreview && <p className="wiki-inbox-item-preview">{item.contentPreview}</p>}
                  {item.lastError && (
                    <p className="wiki-inbox-item-error">失败原因: {item.lastError}（已重试 {item.attemptCount} 次）</p>
                  )}
                  {item.status === 'pending' && (
                    <div className="wiki-inbox-item-actions">
                      <Button variant="ghost" size="sm" onClick={() => void handleRetry(item.id)}>重试</Button>
                      <Button variant="ghost" size="sm" onClick={() => void handleDiscard(item.id)}>丢弃</Button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        ) : rightView === 'runs' ? (
          <div className="wiki-runs-view">
            <h3>归档运行日志</h3>
            {runs.length === 0 ? (
              <p className="wiki-empty-hint">暂无归档记录</p>
            ) : (
              runs.map((run) => (
                <RunLogItem key={run.id} run={run} />
              ))
            )}
          </div>
        ) : rightView === 'cleanup' ? (
          <CleanupView
            cleanupScan={cleanupScan}
            archiveSources={archiveSources}
            restoreSources={restoreSources}
            deleteSources={deleteSources}
            statusScan={statusScan}
            confirmStatus={confirmStatus}
          />
        ) : rightView === 'synthesis' ? (
          <SynthesisView
            pages={pages}
            createSynthesis={createSynthesis}
            listSyntheses={listSyntheses}
            getSynthesis={getSynthesis}
            acceptSynthesis={acceptSynthesis}
            rejectSynthesis={rejectSynthesis}
            onOpenPage={(pageId) => void handleOpenPage(pageId)}
          />
        ) : rightView === 'graph' ? (
          <WikiGraphView
            pages={pages}
            getGraphData={getGraphData}
            onOpenPage={(pageId) => void handleOpenPage(pageId)}
            bootstrapEro={bootstrapEro}
          />
        ) : selectedPage ? (
          <div className="wiki-page-view-layout">
          <div className="wiki-page-view">
            <div className="wiki-page-view-header">
              {isEditing ? (
                <input
                  className="wiki-page-title-input"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
              ) : (
                <h2>{selectedPage.title}</h2>
              )}
              <div className="wiki-page-view-actions">
                {isEditing ? (
                  <>
                    <Button variant="primary" size="sm" onClick={() => void handleSaveEdit()}>保存</Button>
                    <Button variant="secondary" size="sm" onClick={() => setIsEditing(false)}>取消</Button>
                  </>
                ) : (
                  <>
                    <Button variant="secondary" size="sm" onClick={handleStartEdit}>编辑</Button>
                    <Button variant="ghost" size="sm" onClick={() => void requestDeletePage()}>
                      <Trash2 size={12} />
                    </Button>
                  </>
                )}
              </div>
            </div>
            <p className="wiki-page-view-meta">{selectedPage.path} · v{selectedPage.version} · {formatTime(selectedPage.updatedAt)}</p>
            <div
              className={`wiki-page-view-editor ${isDragOver ? 'wiki-page-view-editor--dragover' : ''}`}
              onDrop={(e) => void handleAttachmentDrop(e)}
              onDragOver={handleDragOver}
              onDragLeave={() => setIsDragOver(false)}
            >
              <MDEditor
                value={isEditing ? editDraft : selectedPage.contentMd}
                onChange={handleEditChange}
                preview={isEditing ? 'live' : 'preview'}
                height="100%"
                visibleDragbar={false}
                hideToolbar={!isEditing}
              />
              {linkQuery !== null && (
                <LinkAutocomplete
                  query={linkQuery}
                  pages={pages}
                  onSelect={handleSelectWikilink}
                  onDismiss={() => setLinkQuery(null)}
                />
              )}
            </div>
          </div>
          <PageSidebar
            pageId={selectedPage.id}
            currentContentMd={isEditing ? editDraft : selectedPage.contentMd}
            listBacklinks={listBacklinks}
            listRevisions={listRevisions}
            rollbackPage={rollbackPage}
            onOpenPage={(id) => void handleOpenPage(id)}
            onRolledBack={handleRolledBack}
          />
          </div>
        ) : (
          <div className="wiki-page-list-view">
            <h3>{category ? CATEGORY_LABEL[category] : '全部页面'}（{visiblePages.length}）</h3>
            {visiblePages.length === 0 ? (
              <p className="wiki-empty-hint">
                暂无页面。Wiki 会自动收集上传文件、任务产物与网页搜索结果并归档整理。
              </p>
            ) : (
              visiblePages.map((page) => (
                <div key={page.id} className="wiki-page-list-item" onClick={() => void handleOpenPage(page.id)}>
                  <div className="wiki-page-list-title">{page.title}</div>
                  <div className="wiki-page-list-path">{page.path}</div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <ConfirmModal
        open={deleteConfirm !== null}
        title="删除页面"
        content={
          deleteConfirm && deleteConfirm.backlinks > 0
            ? `删除后，${deleteConfirm.backlinks} 处指向此页的链接将变为未解析。修订历史仍会保留在数据库中。`
            : '删除后修订历史仍会保留在数据库中，但页面不再可见。'
        }
        confirmText="删除"
        confirmVariant="danger"
        onConfirm={() => void handleConfirmDeletePage()}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  )
}

export default WikiTab
