/**
 * PageSidebar — 页面视图第三栏：反链列表 + 修订历史（diff/回滚）
 *
 * 设计：docs/plans/记忆重构/2026-08-26-wiki-p1-implementation.md Task 8 §10.1
 * diff 在前端算（agent-runtime/browser 导出的纯函数 diffLines），IPC 只提供
 * wiki:page:revisions 取回各版本正文，避免为纯计算多一次往返。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { diffLines } from '@mtbot/agent-runtime/browser'
import { Button } from '../../../components/ui/Button/Button'
import { ConfirmModal } from '../../../components/ui/Modal'
import type { WikiBacklinkItem, WikiRevisionItem } from '../../../hooks/business/useWikiPage'

interface PageSidebarProps {
  readonly pageId: string
  readonly currentContentMd: string
  readonly listBacklinks: (pageId: string) => Promise<readonly WikiBacklinkItem[]>
  readonly listRevisions: (pageId: string) => Promise<readonly WikiRevisionItem[]>
  readonly rollbackPage: (pageId: string, targetVersion: number) => Promise<unknown>
  readonly onOpenPage: (pageId: string) => void
  readonly onRolledBack: () => void
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export const PageSidebar: React.FC<PageSidebarProps> = ({
  pageId,
  currentContentMd,
  listBacklinks,
  listRevisions,
  rollbackPage,
  onOpenPage,
  onRolledBack,
}) => {
  const [backlinks, setBacklinks] = useState<readonly WikiBacklinkItem[]>([])
  const [revisions, setRevisions] = useState<readonly WikiRevisionItem[]>([])
  const [diffTarget, setDiffTarget] = useState<WikiRevisionItem | null>(null)
  const [rollbackTarget, setRollbackTarget] = useState<WikiRevisionItem | null>(null)
  const [isExpanded, setIsExpanded] = useState(false)

  useEffect(() => {
    void listBacklinks(pageId).then(setBacklinks)
    void listRevisions(pageId).then(setRevisions)
    setDiffTarget(null)
    setRollbackTarget(null)
    setIsExpanded(false)
  }, [pageId, listBacklinks, listRevisions])

  const diffOutput = useMemo(() => {
    if (!diffTarget) return null
    return diffLines(diffTarget.contentMd, currentContentMd)
  }, [diffTarget, currentContentMd])

  /**
   * 确认回滚后清理比较状态并通知详情页刷新。
   */
  const handleConfirmRollback = async () => {
    if (!rollbackTarget) return
    await rollbackPage(pageId, rollbackTarget.version)
    setRollbackTarget(null)
    setDiffTarget(null)
    onRolledBack()
  }

  return (
    <div className="wiki-page-sidebar">
      <button
        type="button"
        className="wiki-page-sidebar-summary"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded((expanded) => !expanded)}
      >
        <span>反链 · {backlinks.length}</span>
        <span>{isExpanded ? '收起' : '展开'}</span>
      </button>

      {isExpanded && (
        <div className="wiki-page-sidebar-content">
          <div className="wiki-sidebar-section">
            <h4>反链（{backlinks.length}）</h4>
            {backlinks.length === 0 ? (
              <p className="wiki-empty-hint">暂无页面链接到此页</p>
            ) : (
              backlinks.map((backlink) => (
                <button
                  key={backlink.linkId}
                  type="button"
                  className="wiki-backlink-item"
                  onClick={() => onOpenPage(backlink.sourcePageId)}
                >
                  <span className="wiki-backlink-title">{backlink.sourceTitle}</span>
                  <span className="wiki-backlink-path">{backlink.sourcePath}</span>
                </button>
              ))
            )}
          </div>

          <div className="wiki-sidebar-section">
            <h4>修订历史（{revisions.length}）</h4>
            {revisions.map((revision) => (
              <div key={revision.id} className="wiki-revision-item">
                <button
                  type="button"
                  className="wiki-revision-item-main"
                  onClick={() => setDiffTarget(diffTarget?.id === revision.id ? null : revision)}
                >
                  <span className="wiki-revision-version">v{revision.version}</span>
                  <span className="wiki-revision-editor">
                    {revision.editor === 'ai' ? 'AI' : '用户'}
                  </span>
                  <span className="wiki-revision-time">{formatTime(revision.createdAt)}</span>
                </button>
                {revisions[0]?.id !== revision.id && (
                  <Button variant="ghost" size="sm" onClick={() => setRollbackTarget(revision)}>
                    回滚到此版本
                  </Button>
                )}
              </div>
            ))}
          </div>

          {diffTarget && diffOutput && (
            <div className="wiki-sidebar-section wiki-diff-view">
              <h4>v{diffTarget.version} → 当前</h4>
              <pre className="wiki-diff-lines">
                {diffOutput.map((line, index) => (
                  <div key={index} className={`wiki-diff-line wiki-diff-line--${line.type}`}>
                    {line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  '}
                    {line.text}
                  </div>
                ))}
              </pre>
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        open={rollbackTarget !== null}
        title="回滚到此版本"
        content={`将把页面内容回滚为 v${rollbackTarget?.version} 的内容。这会新增一个版本，原有修订历史不会被覆盖。`}
        confirmText="回滚"
        confirmVariant="danger"
        onConfirm={() => void handleConfirmRollback()}
        onCancel={() => setRollbackTarget(null)}
      />
    </div>
  )
}

export default PageSidebar
