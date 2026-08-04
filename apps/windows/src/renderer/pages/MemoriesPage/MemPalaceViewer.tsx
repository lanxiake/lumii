import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '../../components/ui/Button/Button'
import { Loading } from '../../components/ui/Loading/Loading'
import { ErrorBanner } from '../../components/ui/ErrorBanner/ErrorBanner'
import { Modal } from '../../components/ui/Modal/Modal'
import { useMemPalace } from '../../hooks/business/useMemPalace/useMemPalace'
import './MemPalaceViewer.css'

export const MemPalaceViewer: React.FC = () => {
  const {
    drawers, totalDrawers, listLoading, listError, currentPage, pageSize, listDrawers,
    searchResults, searchLoading, searchQuery, isSearchMode, searchDrawers, setSearchQuery, exitSearch,
    deleteLoading, deleteDrawer,
    clearLoading, clearProgress, clearAllDrawers,
  } = useMemPalace()

  const [localQuery, setLocalQuery] = useState('')
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [clearConfirmStep, setClearConfirmStep] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // 组件挂载时加载第一页
  useEffect(() => {
    listDrawers(0)
  }, [listDrawers])

  const handleSearch = useCallback(() => {
    if (!localQuery.trim()) return
    searchDrawers(localQuery.trim())
  }, [localQuery, searchDrawers])

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch()
    if (e.key === 'Escape') {
      setLocalQuery('')
      exitSearch()
    }
  }, [handleSearch, exitSearch])

  const handleClearSearch = useCallback(() => {
    setLocalQuery('')
    setSearchQuery('')
    exitSearch()
  }, [exitSearch, setSearchQuery])

  const handleClearConfirm = useCallback(async () => {
    const ok = await clearAllDrawers()
    if (ok) {
      setShowClearConfirm(false)
      setClearConfirmStep(0)
    }
  }, [clearAllDrawers])

  const handleClearCancel = useCallback(() => {
    if (clearLoading) return
    setShowClearConfirm(false)
    setClearConfirmStep(0)
  }, [clearLoading])

  const totalPages = Math.ceil(totalDrawers / pageSize)

  const renderSimilarityBadge = (similarity: number) => {
    const pct = Math.round(similarity * 100)
    const cls = similarity >= 0.8 ? 'mpv-badge--high' : similarity >= 0.5 ? 'mpv-badge--mid' : 'mpv-badge--low'
    return <span className={`mpv-badge ${cls}`}>{pct}%</span>
  }

  const renderFiledAt = (filedAt?: string) => {
    if (!filedAt || filedAt === 'unknown') return null
    try {
      const d = new Date(filedAt)
      if (isNaN(d.getTime())) return null
      const now = new Date()
      const isToday = d.toDateString() === now.toDateString()
      const isThisYear = d.getFullYear() === now.getFullYear()
      const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      const date = isThisYear
        ? `${d.getMonth() + 1}/${d.getDate()}`
        : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
      const label = isToday ? `今天 ${time}` : `${date} ${time}`
      return <span className="mpv-filed-at">{label}</span>
    } catch {
      return null
    }
  }

  const renderWingRoom = (wing: string, room: string) => (
    <span className="mpv-tags">
      {wing && <span className="mpv-tag mpv-tag--wing">{wing}</span>}
      {room && <span className="mpv-tag mpv-tag--room">{room}</span>}
    </span>
  )

  return (
    <div className="mpv-root">
      {/* 工具栏 */}
      <div className="mpv-toolbar">
        <div className="mpv-search-wrap">
          <input
            ref={inputRef}
            className="mpv-search-input"
            placeholder="语义搜索记忆..."
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          {localQuery ? (
            <button className="mpv-search-clear" onClick={handleClearSearch} title="清除搜索">×</button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={handleSearch} disabled={!localQuery.trim() || searchLoading}>
            搜索
          </Button>
        </div>
        <div className="mpv-toolbar-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => listDrawers(currentPage)}
            disabled={listLoading}
            title="刷新"
          >
            ↻
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setShowClearConfirm(true); setClearConfirmStep(0) }}
            disabled={totalDrawers === 0 || clearLoading}
            style={{ color: 'var(--color-error)' }}
          >
            清空全部
          </Button>
        </div>
      </div>

      {/* 统计栏 */}
      <div className="mpv-stats">
        {isSearchMode ? (
          <span>
            搜索 "<strong>{searchQuery}</strong>" 找到 {searchResults.length} 条
            <button className="mpv-exit-search" onClick={handleClearSearch}>退出搜索</button>
          </span>
        ) : (
          <span>共 <strong>{totalDrawers}</strong> 条记忆</span>
        )}
      </div>

      {/* 内容区 */}
      <div className="mpv-content">
        {(listLoading || searchLoading) && (
          <div className="mpv-loading">
            <Loading text={listLoading ? '加载记忆中...' : '搜索中...'} />
          </div>
        )}

        {listError && !listLoading && (
          <ErrorBanner message={listError} onRetry={() => listDrawers(currentPage)} />
        )}

        {!listLoading && !searchLoading && !listError && (
          <>
            {isSearchMode ? (
              searchResults.length === 0 ? (
                <div className="mpv-empty">未找到相关记忆</div>
              ) : (
                <div className="mpv-cards">
                  {searchResults.map((item) => (
                    <div key={item.drawer_id} className="mpv-card">
                      <div className="mpv-card-header">
                        {renderSimilarityBadge(item.similarity)}
                        {renderWingRoom(item.wing, item.room)}
                        {renderFiledAt(item.created_at)}
                      </div>
                      <p className="mpv-card-text">{item.text}</p>
                      <div className="mpv-card-footer">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteDrawer(item.drawer_id)}
                          disabled={deleteLoading === item.drawer_id}
                          style={{ color: 'var(--color-error)' }}
                        >
                          {deleteLoading === item.drawer_id ? '删除中...' : '删除'}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : (
              drawers.length === 0 ? (
                <div className="mpv-empty">暂无记忆，开始对话后 AI 会自动记录</div>
              ) : (
                <div className="mpv-cards">
                  {drawers.map((drawer) => (
                    <div key={drawer.drawer_id} className="mpv-card">
                      <div className="mpv-card-header">
                        {renderWingRoom(drawer.wing, drawer.room)}
                        {renderFiledAt(drawer.filed_at)}
                      </div>
                      <p className="mpv-card-text">{drawer.content_preview}</p>
                      <div className="mpv-card-footer">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteDrawer(drawer.drawer_id)}
                          disabled={deleteLoading === drawer.drawer_id}
                          style={{ color: 'var(--color-error)' }}
                        >
                          {deleteLoading === drawer.drawer_id ? '删除中...' : '删除'}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
          </>
        )}
      </div>

      {/* 分页器（仅列表模式） */}
      {!isSearchMode && totalPages > 1 && (
        <div className="mpv-pagination">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => listDrawers(currentPage - 1)}
            disabled={currentPage === 0 || listLoading}
          >
            上一页
          </Button>
          <span className="mpv-page-info">第 {currentPage + 1} / {totalPages} 页</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => listDrawers(currentPage + 1)}
            disabled={currentPage >= totalPages - 1 || listLoading}
          >
            下一页
          </Button>
        </div>
      )}

      {/* 清空确认 Modal */}
      <Modal
        open={showClearConfirm}
        title="清空全部记忆"
        onClose={handleClearCancel}
        footer={
          <div className="mpv-modal-footer">
            <Button variant="secondary" onClick={handleClearCancel} disabled={clearLoading}>
              取消
            </Button>
            {clearConfirmStep === 0 ? (
              <Button variant="primary" onClick={() => setClearConfirmStep(1)} style={{ background: 'var(--color-error)', borderColor: 'var(--color-error)' }}>
                我确认要清空
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={handleClearConfirm}
                disabled={clearLoading}
                style={{ background: 'var(--color-error)', borderColor: 'var(--color-error)' }}
              >
                {clearLoading ? `删除中... (${clearProgress} 条)` : '确认清空'}
              </Button>
            )}
          </div>
        }
      >
        <div className="mpv-modal-body">
          {clearConfirmStep === 0 ? (
            <p>确定要清空全部 <strong>{totalDrawers}</strong> 条记忆？此操作不可撤销。</p>
          ) : (
            <p>再次确认：将永久删除所有 <strong>{totalDrawers}</strong> 条记忆，无法恢复。</p>
          )}
        </div>
      </Modal>
    </div>
  )
}

export default MemPalaceViewer
