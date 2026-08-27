/**
 * WikiTab — Wiki 知识库工作区
 *
 * 左栏只承载浏览分区、知识图谱与更多入口；顶栏统一承载搜索、
 * 当前分区上下文和任务进度，主内容区继续复用现有业务视图。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Loading } from '../../../components/ui/Loading/Loading'
import { ConfirmModal } from '../../../components/ui/Modal'
import {
  useWikiPage,
  type WikiInboxItem,
  type WikiPageListItem,
  type WikiPageDetail,
  type WikiSearchHit,
} from '../../../hooks/business/useWikiPage'
import { CleanupView } from './CleanupView'
import { SynthesisView } from './SynthesisView'
import { WikiGraphView } from './WikiGraphView'
import { WikiDetailDrawer } from './WikiDetailDrawer'
import { WikiLeftNav, type WikiPrimaryNav } from './WikiLeftNav'
import { WikiTopBar } from './WikiTopBar'
import { WikiPageList } from './WikiPageList'
import { WikiInboxPanel } from './WikiInboxPanel'
import { WikiTaskCenter } from './WikiTaskCenter'
import { useWikiTaskCenter, type WikiLocalTask } from './useWikiTaskCenter'
import './WikiTab.css'

type WikiToolView = 'cleanup' | 'synthesis' | null

const NAV_CONTEXT: Record<WikiPrimaryNav, { title: string; subtitle: string }> = {
  sources: { title: '资料', subtitle: '自动归档的资料与任务产物' },
  media: { title: '多媒体', subtitle: '图片、音频与其他媒体内容' },
  inbox: { title: '待整理', subtitle: '等待归档处理的内容' },
  graph: { title: '知识图谱', subtitle: '浏览页面与实体之间的关系' },
}

/**
 * 渲染 Wiki 工作区并协调列表、工具视图与详情抽屉。
 */
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
  const taskCenter = useWikiTaskCenter()

  const [primaryNav, setPrimaryNav] = useState<WikiPrimaryNav>('sources')
  const [toolView, setToolView] = useState<WikiToolView>(null)
  const [pages, setPages] = useState<readonly WikiPageListItem[]>([])
  const [pageCounts, setPageCounts] = useState<Record<string, number>>({})
  const [inboxItems, setInboxItems] = useState<readonly WikiInboxItem[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [selectedPage, setSelectedPage] = useState<WikiPageDetail | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<readonly WikiSearchHit[] | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ backlinks: number } | null>(null)
  const [searchDegradeReason, setSearchDegradeReason] = useState<string | null>(null)
  const [searchMode, setSearchMode] = useState<string | null>(null)
  const [isTaskCenterOpen, setIsTaskCenterOpen] = useState(false)

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

  useEffect(() => {
    /** 将已有归档运行合并进任务中心历史。 */
    const loadRunHistory = async (): Promise<void> => {
      taskCenter.mergeRuns(await listRuns())
    }

    void loadRunHistory()
  }, [listRuns, taskCenter.mergeRuns])

  /**
   * 打开任务中心并清除失败任务的未读提示。
   */
  const handleOpenTaskCenter = useCallback(() => {
    taskCenter.markFailuresSeen()
    setIsTaskCenterOpen(true)
  }, [taskCenter.markFailuresSeen])

  /**
   * 重试任务记录中保留的原操作或归档 inbox 项。
   */
  const handleRetryTask = useCallback(
    async (task: WikiLocalTask): Promise<void> => {
      try {
        if (task.retry) {
          await task.retry()
          taskCenter.dismissTask(task.id)
          return
        }
        if (task.kind !== 'archive' || !task.inboxIds?.length) return
        await taskCenter.wrapAsync('archive', task.title, async () => {
          const results = await Promise.all(task.inboxIds?.map(retryInbox) ?? [])
          if (results.some((result) => !result)) throw new Error('部分归档任务重试失败')
          await refreshInbox()
        })
        taskCenter.dismissTask(task.id)
      } catch {
        // wrapAsync 已将失败原因写入新的任务记录，避免事件处理产生未捕获拒绝。
      }
    },
    [refreshInbox, retryInbox, taskCenter.dismissTask, taskCenter.wrapAsync],
  )

  /**
   * 用任务中心追踪清理扫描及其完成状态。
   */
  const trackedCleanupScan = useCallback(
    (staleDays?: number) => taskCenter.wrapAsync(
      'cleanup',
      '扫描清理项',
      () => cleanupScan(staleDays),
    ),
    [cleanupScan, taskCenter.wrapAsync],
  )

  /**
   * 用任务中心追踪批量归档操作。
   */
  const trackedArchiveSources = useCallback(
    (sourceIds: readonly string[]) => taskCenter.wrapAsync(
      'cleanup',
      '归档资料',
      () => archiveSources(sourceIds),
    ),
    [archiveSources, taskCenter.wrapAsync],
  )

  /**
   * 用任务中心追踪批量恢复操作。
   */
  const trackedRestoreSources = useCallback(
    (sourceIds: readonly string[]) => taskCenter.wrapAsync(
      'cleanup',
      '恢复资料',
      () => restoreSources(sourceIds),
    ),
    [restoreSources, taskCenter.wrapAsync],
  )

  /**
   * 用任务中心追踪批量删除操作。
   */
  const trackedDeleteSources = useCallback(
    (sourceIds: readonly string[]) => taskCenter.wrapAsync(
      'cleanup',
      '删除资料',
      () => deleteSources(sourceIds),
    ),
    [deleteSources, taskCenter.wrapAsync],
  )

  /**
   * 用任务中心追踪自动综述合成。
   */
  const trackedAutoRunSynthesis = useCallback(
    () => taskCenter.wrapAsync('synthesis', '自动综述合成', autoRunSynthesis),
    [autoRunSynthesis, taskCenter.wrapAsync],
  )

  /**
   * 用任务中心追踪图谱初始化。
   */
  const trackedBootstrapEro = useCallback(
    () => taskCenter.wrapAsync('graph', '初始化知识图谱', bootstrapEro),
    [bootstrapEro, taskCenter.wrapAsync],
  )

  /**
   * 用任务中心追踪图谱实体抽取。
   */
  const trackedExtractEro = useCallback(
    () => taskCenter.wrapAsync('graph', '抽取图谱实体', extractEro),
    [extractEro, taskCenter.wrapAsync],
  )

  const handleSelectPrimaryNav = useCallback((nav: WikiPrimaryNav) => {
    setPrimaryNav(nav)
    setToolView(null)
    setSearchResults(null)
    setSearchDegradeReason(null)
    setSearchMode(null)
    setSelectedPage(null)
    setIsDetailOpen(false)
  }, [])

  const handleOpenPage = useCallback(
    async (pageId: string) => {
      const page = await getPage(pageId)
      setSelectedPage(page)
      setIsDetailOpen(page !== null)
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
      setIsDetailOpen(false)
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
          pillText={taskCenter.pillText}
          pillTone={taskCenter.pillTone}
          onOpenTasks={handleOpenTaskCenter}
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
              <WikiPageList
                searchHits={searchResults}
                selectedPageId={selectedPage?.id ?? null}
                onOpen={(pageId) => void handleOpenPage(pageId)}
              />
            )}
          </div>
        ) : primaryNav === 'inbox' ? (
          <div className="wiki-inbox-view">
            <h3>待整理（{pendingCount}）</h3>
            {inboxItems.length < pendingCount && (
              <p className="wiki-empty-hint">仅显示最近 {inboxItems.length} 条</p>
            )}
            <WikiInboxPanel
              items={inboxItems}
              onRetry={(inboxId) => void handleRetry(inboxId)}
              onDiscard={(inboxId) => void handleDiscard(inboxId)}
            />
          </div>
        ) : toolView === 'cleanup' ? (
          <CleanupView
            cleanupScan={trackedCleanupScan}
            archiveSources={trackedArchiveSources}
            restoreSources={trackedRestoreSources}
            deleteSources={trackedDeleteSources}
            statusScan={statusScan}
            confirmStatus={confirmStatus}
          />
        ) : toolView === 'synthesis' ? (
          <SynthesisView
            pages={pages}
            autoRunSynthesis={trackedAutoRunSynthesis}
            onOpenPage={(pageId) => void handleOpenPage(pageId)}
            onRefreshPages={refreshPages}
          />
        ) : primaryNav === 'graph' ? (
          <WikiGraphView
            pages={pages}
            getGraphData={getGraphData}
            onOpenPage={(pageId) => void handleOpenPage(pageId)}
            bootstrapEro={trackedBootstrapEro}
            extractEro={trackedExtractEro}
            listEntityObservations={listEntityObservations}
          />
        ) : (
          <div className="wiki-page-list-view">
            <h3>{NAV_CONTEXT[primaryNav].title}（{visiblePages.length}）</h3>
            {visiblePages.length === 0 ? (
              <p className="wiki-empty-hint">
                暂无页面。Wiki 会自动收集上传文件、任务产物与网页搜索结果并归档整理。
              </p>
            ) : (
              <WikiPageList
                pages={visiblePages}
                selectedPageId={selectedPage?.id ?? null}
                onOpen={(pageId) => void handleOpenPage(pageId)}
              />
            )}
          </div>
        )}
          <WikiDetailDrawer
            open={isDetailOpen}
            page={selectedPage}
            pages={pages}
            isEditing={isEditing}
            editTitle={editTitle}
            editDraft={editDraft}
            onEditTitleChange={setEditTitle}
            onEditDraftChange={setEditDraft}
            onStartEdit={handleStartEdit}
            onCancelEdit={() => setIsEditing(false)}
            onSaveEdit={() => void handleSaveEdit()}
            onRequestDelete={() => void requestDeletePage()}
            onClose={() => {
              setIsDetailOpen(false)
              setIsEditing(false)
            }}
            listBacklinks={listBacklinks}
            listRevisions={listRevisions}
            rollbackPage={rollbackPage}
            onOpenPage={(pageId) => void handleOpenPage(pageId)}
            onRolledBack={handleRolledBack}
          />
          <WikiTaskCenter
            open={isTaskCenterOpen}
            tasks={taskCenter.tasks}
            onClose={() => setIsTaskCenterOpen(false)}
            onRetry={(task) => void handleRetryTask(task)}
            onDismiss={taskCenter.dismissTask}
          />
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
