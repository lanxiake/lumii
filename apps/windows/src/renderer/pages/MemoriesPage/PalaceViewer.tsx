import React, { useState, useCallback } from 'react'
import { Button } from '../../components/ui/Button/Button'
import { Loading } from '../../components/ui/Loading/Loading'
import { ErrorBanner } from '../../components/ui/ErrorBanner/ErrorBanner'
import { Modal } from '../../components/ui/Modal/Modal'
import { WIKI_MODAL_LAYER } from './components/wikiModalLayer'
import { usePalace } from '../../hooks/business/usePalace/usePalace'
import './PalaceViewer.css'

/**
 * 记忆宫殿（自研 SQLite）数据面板。
 *
 * 与旧的 MemPalaceViewer 的三处语义变化（见 `palace-ipc.ts` 的说明）：
 * 1. **没有安装态**：后端就是应用自己的库，"装插件"这一步不存在。不可用时只提示不可用。
 * 2. **列表项没有正文**：`PalaceRepo.listDrawers` 只返回元数据（一屏 20 条 × 每条上千字符
 *    会让渲染卡住）。点「查看全文」按需 `read`。
 * 3. **相关性显示 `score` 不是百分比**：后端给的是 `-bm25`，无上界、不可跨查询比较。
 *    这里只做**相对**高低的视觉区分（最高/中等/较低），不编造"87% 相似"这种数字。
 */
export const PalaceViewer: React.FC = () => {
  const {
    available,
    counts,
    wings,
    wingFilter,
    selectWing,
    items,
    total,
    listLoading,
    listError,
    currentPage,
    pageSize,
    loadPage,
    searchResults,
    searchLoading,
    searchQuery,
    isSearchMode,
    search,
    exitSearch,
    readDrawer,
    deleteLoading,
    deleteDrawer,
    clearLoading,
    clearAllDrawers,
  } = usePalace()

  const [localQuery, setLocalQuery] = useState('')
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [clearConfirmStep, setClearConfirmStep] = useState(0)
  const [detail, setDetail] = useState<{ id: string; content: string } | null>(null)

  const handleSearch = useCallback(() => {
    if (!localQuery.trim()) return
    void search(localQuery.trim())
  }, [localQuery, search])

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleSearch()
      if (e.key === 'Escape') {
        setLocalQuery('')
        exitSearch()
      }
    },
    [handleSearch, exitSearch],
  )

  const handleExitSearch = useCallback(() => {
    setLocalQuery('')
    exitSearch()
  }, [exitSearch])

  const handleShowDetail = useCallback(
    async (drawerId: string) => {
      const d = await readDrawer(drawerId)
      if (d) setDetail({ id: drawerId, content: d.content })
    },
    [readDrawer],
  )

  const handleClearConfirm = useCallback(async () => {
    const ok = await clearAllDrawers()
    if (ok) {
      setShowClearConfirm(false)
      setClearConfirmStep(0)
    }
  }, [clearAllDrawers])

  const totalPages = Math.ceil(total / pageSize)

  /**
   * 相关性分档。只用品**相对**高低——`-bm25` 无上界也不可跨查询比较，
   * 换算成百分比是数据层说谎（与后端 `score` 不叫 `similarity` 同一条纪律）。
   */
  const renderScoreBadge = (score: number, best: number) => {
    const ratio = best > 0 ? score / best : 0
    const cls = ratio >= 0.8 ? 'pv-badge--high' : ratio >= 0.4 ? 'pv-badge--mid' : 'pv-badge--low'
    const label = ratio >= 0.8 ? '最相关' : ratio >= 0.4 ? '相关' : '较弱'
    return <span className={`pv-badge ${cls}`}>{label}</span>
  }

  const renderFiledAt = (filedAt?: string) => {
    if (!filedAt) return null
    const d = new Date(filedAt)
    if (isNaN(d.getTime())) return null
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    const isThisYear = d.getFullYear() === now.getFullYear()
    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    const date = isThisYear
      ? `${d.getMonth() + 1}/${d.getDate()}`
      : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
    return <span className="pv-filed-at">{isToday ? `今天 ${time}` : `${date} ${time}`}</span>
  }

  const renderWingRoom = (wing: string, room: string) => (
    <span className="pv-tags">
      {wing && <span className="pv-tag pv-tag--wing">{wing}</span>}
      {room && <span className="pv-tag pv-tag--room">{room}</span>}
    </span>
  )

  const bestScore = searchResults.length > 0 ? Math.max(...searchResults.map((r) => r.score)) : 1

  if (!available) {
    return (
      <div className="pv-root">
        <div className="pv-empty">
          记忆宫殿暂不可用（数据库未就绪）。重启应用后重试。
        </div>
      </div>
    )
  }

  return (
    <div className="pv-root">
      {/* 工具栏 */}
      <div className="pv-toolbar">
        <div className="pv-search-wrap">
          <input
            className="pv-search-input"
            placeholder="搜索历史对话..."
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          {localQuery ? (
            <button className="pv-search-clear" onClick={handleExitSearch} title="清除搜索">
              ×
            </button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSearch}
            disabled={!localQuery.trim() || searchLoading}
          >
            搜索
          </Button>
        </div>
        <div className="pv-toolbar-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadPage(currentPage)}
            disabled={listLoading}
            title="刷新"
          >
            ↻
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowClearConfirm(true)
              setClearConfirmStep(0)
            }}
            disabled={total === 0 || clearLoading}
            style={{ color: 'var(--color-error)' }}
          >
            清空全部
          </Button>
        </div>
      </div>

      {/* wing 过滤（点选标签切换） */}
      {!isSearchMode && wings.length > 1 && (
        <div className="pv-wings">
          <button
            className={`pv-wing-chip ${wingFilter === null ? 'pv-wing-chip--active' : ''}`}
            onClick={() => selectWing(null)}
          >
            全部 <span className="pv-wing-count">{counts?.active ?? total}</span>
          </button>
          {wings.map((w) => (
            <button
              key={w.wing}
              className={`pv-wing-chip ${wingFilter === w.wing ? 'pv-wing-chip--active' : ''}`}
              onClick={() => selectWing(w.wing)}
            >
              {w.wing} <span className="pv-wing-count">{w.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* 统计栏 */}
      <div className="pv-stats">
        {isSearchMode ? (
          <span>
            搜索 "<strong>{searchQuery}</strong>" 找到 {searchResults.length} 条
            <button className="pv-exit-search" onClick={handleExitSearch}>
              退出搜索
            </button>
          </span>
        ) : (
          <span>
            共 <strong>{total}</strong> 条归档
            {counts && counts.tombstoned > 0 ? (
              <span className="pv-stats-muted">（另有 {counts.tombstoned} 条已删除）</span>
            ) : null}
          </span>
        )}
      </div>

      {/* 内容区 */}
      <div className="pv-content">
        {(listLoading || searchLoading) && (
          <div className="pv-loading">
            <Loading text={listLoading ? '加载中...' : '搜索中...'} />
          </div>
        )}

        {listError && !listLoading && (
          <ErrorBanner message={listError} onRetry={() => void loadPage(currentPage)} />
        )}

        {!listLoading && !searchLoading && !listError && (
          <>
            {isSearchMode ? (
              searchResults.length === 0 ? (
                <div className="pv-empty">未找到相关记录</div>
              ) : (
                <div className="pv-cards">
                  {searchResults.map((item) => (
                    <div key={item.drawer_id} className="pv-card">
                      <div className="pv-card-header">
                        {renderScoreBadge(item.score, bestScore)}
                        {renderWingRoom(item.wing, item.room)}
                        {renderFiledAt(item.created_at)}
                      </div>
                      <p className="pv-card-text">{item.text}</p>
                      <div className="pv-card-footer">
                        {item.truncated && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleShowDetail(item.drawer_id)}
                          >
                            查看全文（{item.char_count} 字）
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void deleteDrawer(item.drawer_id)}
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
            ) : items.length === 0 ? (
              <div className="pv-empty">暂无归档，开始对话后会自动记录</div>
            ) : (
              <div className="pv-cards">
                {items.map((item) => (
                  <div key={item.drawer_id} className="pv-card">
                    <div className="pv-card-header">
                      {renderWingRoom(item.wing, item.room)}
                      {renderFiledAt(item.created_at)}
                    </div>
                    <p className="pv-card-text pv-card-text--meta">
                      {item.char_count} 字符 · {item.agent_id}
                      {item.conversation_id ? ` · ${item.conversation_id}` : ''}
                    </p>
                    <div className="pv-card-footer">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleShowDetail(item.drawer_id)}
                      >
                        查看全文
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void deleteDrawer(item.drawer_id)}
                        disabled={deleteLoading === item.drawer_id}
                        style={{ color: 'var(--color-error)' }}
                      >
                        {deleteLoading === item.drawer_id ? '删除中...' : '删除'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* 分页器（仅列表模式） */}
      {!isSearchMode && totalPages > 1 && (
        <div className="pv-pagination">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadPage(currentPage - 1)}
            disabled={currentPage === 0 || listLoading}
          >
            上一页
          </Button>
          <span className="pv-page-info">
            第 {currentPage + 1} / {totalPages} 页
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadPage(currentPage + 1)}
            disabled={currentPage >= totalPages - 1 || listLoading}
          >
            下一页
          </Button>
        </div>
      )}

      {/* 全文 Modal */}
      <Modal
        open={detail !== null}
        title="归档原文"
        layer={WIKI_MODAL_LAYER}
        onClose={() => setDetail(null)}
        footer={
          <div className="pv-modal-footer">
            <Button variant="secondary" onClick={() => setDetail(null)}>
              关闭
            </Button>
          </div>
        }
      >
        <div className="pv-modal-body pv-detail-body">
          <pre className="pv-detail-text">{detail?.content}</pre>
        </div>
      </Modal>

      {/* 清空确认 Modal */}
      <Modal
        open={showClearConfirm}
        title="清空全部归档"
        layer={WIKI_MODAL_LAYER}
        onClose={() => {
          if (!clearLoading) {
            setShowClearConfirm(false)
            setClearConfirmStep(0)
          }
        }}
        footer={
          <div className="pv-modal-footer">
            <Button
              variant="secondary"
              onClick={() => {
                setShowClearConfirm(false)
                setClearConfirmStep(0)
              }}
              disabled={clearLoading}
            >
              取消
            </Button>
            {clearConfirmStep === 0 ? (
              <Button
                variant="primary"
                onClick={() => setClearConfirmStep(1)}
                style={{ background: 'var(--color-error)', borderColor: 'var(--color-error)' }}
              >
                我确认要清空
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void handleClearConfirm()}
                disabled={clearLoading}
                style={{ background: 'var(--color-error)', borderColor: 'var(--color-error)' }}
              >
                {clearLoading ? '清空中...' : '确认清空'}
              </Button>
            )}
          </div>
        }
      >
        <div className="pv-modal-body">
          {clearConfirmStep === 0 ? (
            <p>
              确定要清空全部 <strong>{total}</strong> 条归档？
            </p>
          ) : (
            <>
              <p>
                再次确认：将清空所有 <strong>{total}</strong> 条归档，之后搜索与列表都不再显示它们。
              </p>
              {/*
                文案如实说"非破坏"：实现写的是 deleted_at 墓碑，原文仍在库里。
                旧文案写"永久删除、无法恢复"——对着墓碑实现说这话是骗用户，
                而且会让人以为没必要留痕。
              */}
              <p className="pv-modal-note">
                归档原文不会被销毁，只是不再出现在搜索与列表里（可在后续版本中恢复）。
              </p>
            </>
          )}
        </div>
      </Modal>
    </div>
  )
}

export default PalaceViewer
