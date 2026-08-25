/**
 * WikiTab — Wiki 知识库 P0 界面
 *
 * 两栏布局：左栏搜索 + 固定分类树（sources/media/inbox）+ 待整理入口；
 * 右栏三视图：页面（渲染/编辑）、待整理（收件箱列表）、运行日志。
 * P0 不做真实文件树懒加载——固定 3 个顶层分类，直接按分类过滤页面列表即可。
 */

import React, { useCallback, useEffect, useState } from 'react'
import MDEditor from '@uiw/react-md-editor'
import { Search, Inbox, FileText, Image as ImageIcon, RefreshCw, Trash2, History } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import { Loading } from '../../../components/ui/Loading/Loading'
import {
  useWikiPage,
  type WikiInboxItem,
  type WikiPageListItem,
  type WikiPageDetail,
  type WikiSearchHit,
  type WikiRunItem,
} from '../../../hooks/business/useWikiPage'
import './WikiTab.css'

type WikiCategory = 'sources' | 'media' | 'inbox'
type RightView = 'page' | 'inbox' | 'runs'

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

export const WikiTab: React.FC = () => {
  const {
    listInbox,
    retryInbox,
    discardInbox,
    listPages,
    getPage,
    updatePage,
    deletePage,
    search,
    listRuns,
    rebuildIndex,
    loading,
  } = useWikiPage()

  const [category, setCategory] = useState<WikiCategory | null>(null)
  const [rightView, setRightView] = useState<RightView>('inbox')
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

  const refreshPages = useCallback(async () => {
    const all = await listPages()
    setPages(all)
    const counts: Record<string, number> = {}
    for (const p of all) counts[p.category] = (counts[p.category] ?? 0) + 1
    setPageCounts(counts)
  }, [listPages])

  const refreshInbox = useCallback(async () => {
    const all = await listInbox()
    setInboxItems(all)
    setPendingCount(all.filter((i) => i.status === 'pending').length)
  }, [listInbox])

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
    setRightView(cat === 'inbox' ? 'inbox' : 'page')
    setSelectedPage(null)
  }, [])

  const handleOpenPage = useCallback(
    async (pageId: string) => {
      const page = await getPage(pageId)
      setSelectedPage(page)
      setIsEditing(false)
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

  const handleDeletePage = useCallback(async () => {
    if (!selectedPage) return
    const ok = await deletePage(selectedPage.id)
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
      return
    }
    setSearchResults(await search(query))
  }, [query, search])

  const handleRebuildIndex = useCallback(async () => {
    await rebuildIndex()
    void refreshPages()
  }, [rebuildIndex, refreshPages])

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
                className={`wiki-category-item ${category === cat ? 'wiki-category-item--active' : ''}`}
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
            <h3>搜索结果（{searchResults.length}）</h3>
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
            <h3>待整理（{inboxItems.length}）</h3>
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
                <div key={run.id} className="wiki-run-item">
                  <div className="wiki-run-item-header">
                    <span className={`wiki-run-status wiki-run-status--${run.status}`}>{run.status}</span>
                    <span>{formatTime(run.createdAt)}</span>
                  </div>
                  {run.resultSummary && <p>{run.resultSummary}</p>}
                  {run.error && <p className="wiki-inbox-item-error">{run.error}</p>}
                </div>
              ))
            )}
          </div>
        ) : selectedPage ? (
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
                    <Button variant="ghost" size="sm" onClick={() => void handleDeletePage()}>
                      <Trash2 size={12} />
                    </Button>
                  </>
                )}
              </div>
            </div>
            <p className="wiki-page-view-meta">{selectedPage.path} · v{selectedPage.version} · {formatTime(selectedPage.updatedAt)}</p>
            <div className="wiki-page-view-editor">
              <MDEditor
                value={isEditing ? editDraft : selectedPage.contentMd}
                onChange={(val) => { if (isEditing) setEditDraft(val ?? '') }}
                preview={isEditing ? 'live' : 'preview'}
                height="100%"
                visibleDragbar={false}
                hideToolbar={!isEditing}
              />
            </div>
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
    </div>
  )
}

export default WikiTab
