/**
 * WikiTab — Wiki 知识库工作区
 *
 * 左栏只承载浏览分区、知识图谱与更多入口；顶栏统一承载搜索、
 * 当前分区上下文和任务进度，主内容区继续复用现有业务视图。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import MDEditor from '@uiw/react-md-editor'
import { Trash2 } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import { Loading } from '../../../components/ui/Loading/Loading'
import { ConfirmModal } from '../../../components/ui/Modal'
import {
  useWikiPage,
  type WikiInboxItem,
  type WikiPageListItem,
  type WikiPageDetail,
  type WikiSearchHit,
} from '../../../hooks/business/useWikiPage'
import { PageSidebar } from './PageSidebar'
import { CleanupView } from './CleanupView'
import { SynthesisView } from './SynthesisView'
import { WikiGraphView } from './WikiGraphView'
import { LinkAutocomplete, detectWikilinkTrigger } from './LinkAutocomplete'
import { uploadFilesForWikiAttachment } from './wikiAttachmentUpload'
import { WikiLeftNav, type WikiPrimaryNav } from './WikiLeftNav'
import { WikiTopBar } from './WikiTopBar'
import { useWikiTaskCenter } from './useWikiTaskCenter'
import './WikiTab.css'

type WikiToolView = 'cleanup' | 'synthesis' | null

const NAV_CONTEXT: Record<WikiPrimaryNav, { title: string; subtitle: string }> = {
  sources: { title: '资料', subtitle: '自动归档的资料与任务产物' },
  media: { title: '多媒体', subtitle: '图片、音频与其他媒体内容' },
  inbox: { title: '待整理', subtitle: '等待归档处理的内容' },
  graph: { title: '知识图谱', subtitle: '浏览页面与实体之间的关系' },
}

function formatTime(ts: number | null): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
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
    listBacklinks,
    listRevisions,
    rollbackPage,
    cleanupScan,
    archiveSources,
    restoreSources,
    deleteSources,
    autoRunSynthesis,
    getGraphData,
    statusScan,
    confirmStatus,
    searchHybrid,
    bootstrapEro,
    extractEro,
    listEntityObservations,
    loading,
  } = useWikiPage()
  const { pillText, pillTone } = useWikiTaskCenter()

  const [primaryNav, setPrimaryNav] = useState<WikiPrimaryNav>('sources')
  const [toolView, setToolView] = useState<WikiToolView>(null)
  const [pages, setPages] = useState<readonly WikiPageListItem[]>([])
  const [pageCounts, setPageCounts] = useState<Record<string, number>>({})
  const [inboxItems, setInboxItems] = useState<readonly WikiInboxItem[]>([])
  const [pendingCount, setPendingCount] = useState(0)
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

  useEffect(() => {
    void refreshPages()
    void refreshInbox()
  }, [refreshPages, refreshInbox])

  const handleSelectPrimaryNav = useCallback((nav: WikiPrimaryNav) => {
    setPrimaryNav(nav)
    setToolView(null)
    setSearchResults(null)
    setSearchDegradeReason(null)
    setSearchMode(null)
    setSelectedPage(null)
  }, [])

  const handleOpenPage = useCallback(
    async (pageId: string) => {
      const page = await getPage(pageId)
      setSelectedPage(page)
      setIsEditing(false)
      setSearchResults(null)
      setToolView(null)
      if (page?.category === 'sources' || page?.category === 'media') {
        setPrimaryNav(page.category)
      }
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

  /**
   * 清空当前检索词与结果，恢复当前一级分区内容。
   */
  const handleClearSearch = useCallback(() => {
    setQuery('')
    setSearchResults(null)
    setSearchDegradeReason(null)
    setSearchMode(null)
  }, [])

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

  const visiblePages = pages.filter((page) => page.category === primaryNav)
  const currentContext = searchResults !== null
    ? { title: '搜索结果', subtitle: `共找到 ${searchResults.length} 项内容` }
    : toolView === 'cleanup'
      ? { title: '清理', subtitle: '扫描并处理需要维护的资料' }
      : toolView === 'synthesis'
        ? { title: '综述合成', subtitle: '从已有页面生成主题综述' }
        : NAV_CONTEXT[primaryNav]

  return (
    <div className="wiki-tab">
      <WikiLeftNav
        active={toolView ? 'more' : primaryNav}
        pendingCount={pendingCount}
        pageCounts={pageCounts}
        onSelect={handleSelectPrimaryNav}
        onOpenMore={() => undefined}
      />

      <div className="wiki-tab-right">
        <WikiTopBar
          title={currentContext.title}
          subtitle={currentContext.subtitle}
          query={query}
          onQueryChange={setQuery}
          onSearch={() => void handleSearch()}
          onClearSearch={handleClearSearch}
          pillText={pillText}
          pillTone={pillTone}
          onOpenTasks={() => undefined}
        />

        <main className="wiki-tab-content">
          {loading && !selectedPage && (
            <div className="wiki-loading">
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
        ) : primaryNav === 'inbox' ? (
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
        ) : toolView === 'cleanup' ? (
          <CleanupView
            cleanupScan={cleanupScan}
            archiveSources={archiveSources}
            restoreSources={restoreSources}
            deleteSources={deleteSources}
            statusScan={statusScan}
            confirmStatus={confirmStatus}
          />
        ) : toolView === 'synthesis' ? (
          <SynthesisView
            pages={pages}
            autoRunSynthesis={autoRunSynthesis}
            onOpenPage={(pageId) => void handleOpenPage(pageId)}
            onRefreshPages={refreshPages}
          />
        ) : primaryNav === 'graph' ? (
          <WikiGraphView
            pages={pages}
            getGraphData={getGraphData}
            onOpenPage={(pageId) => void handleOpenPage(pageId)}
            bootstrapEro={bootstrapEro}
            extractEro={extractEro}
            listEntityObservations={listEntityObservations}
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
            <h3>{NAV_CONTEXT[primaryNav].title}（{visiblePages.length}）</h3>
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
        </main>
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
