import React, { useMemo } from 'react'
import { Button } from '../../../components/ui/Button/Button'
import type {
  WikiMigrateMappingItem,
  WikiMigrateMappingPatch,
  WikiMigrateRunItem,
  WikiTopicTree,
} from '../../../hooks/business/useWikiPage'
import { formatTopicDisplay } from './wikiTopicDisplay'

interface WikiMigrateReviewViewProps {
  readonly run: WikiMigrateRunItem | null
  readonly topicTree: WikiTopicTree | null
  readonly applying: boolean
  readonly onUpdateMapping: (folderRel: string, patch: WikiMigrateMappingPatch) => void
  readonly onApply: () => void
  readonly onDiscard: () => void
  readonly onReplan: () => void
}

/**
 * 映射状态中文标签。
 */
function mappingStatusLabel(status: WikiMigrateMappingItem['status']): string {
  if (status === 'ok') return '就绪'
  if (status === 'conflict') return '冲突'
  return '需内容'
}

/**
 * 判断是否存在未忽略且未解决的 conflict 映射。
 */
function hasUnresolvedConflicts(mappings: readonly WikiMigrateMappingItem[]): boolean {
  return mappings.some((m) => !m.ignored && m.status === 'conflict')
}

/**
 * 格式化置信度为百分比展示。
 */
function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`
}

/**
 * 库级迁移映射预览审阅主区。
 *
 * 映射是「建议」不是「已改」：只有点确认整理才写主题两列。
 * 冲突未处理完时禁用确认；用户可改落点、批准小类或忽略文件夹。
 */
export const WikiMigrateReviewView: React.FC<WikiMigrateReviewViewProps> = ({
  run,
  topicTree,
  applying,
  onUpdateMapping,
  onApply,
  onDiscard,
  onReplan,
}) => {
  const mappings = run?.mappings ?? []
  const unresolvedConflicts = useMemo(() => hasUnresolvedConflicts(mappings), [mappings])

  if (!run) {
    return <p className="wiki-migrate-review-empty">还没有整理入库方案。从收件箱导入文件夹并开启 AI 自动分类后开始。</p>
  }

  if (run.phase === 'inventorying' || run.phase === 'planning') {
    return (
      <div className="wiki-migrate-review">
        <p className="wiki-migrate-review-progress">
          {run.progress.phaseLabel || '正在规划目录映射'}
          {run.progress.total > 0 && ` · ${run.progress.done}/${run.progress.total}`}
        </p>
        {run.progress.currentItem && (
          <p className="wiki-migrate-review-hint">当前：{run.progress.currentItem}</p>
        )}
      </div>
    )
  }

  if (run.phase === 'applying') {
    return (
      <div className="wiki-migrate-review">
        <p className="wiki-migrate-review-progress">
          正在整理入库 {run.progress.done}/{run.progress.total}
        </p>
        {run.progress.currentItem && (
          <p className="wiki-migrate-review-hint">当前：{run.progress.currentItem}</p>
        )}
      </div>
    )
  }

  if (run.phase === 'failed') {
    return (
      <div className="wiki-migrate-review">
        <p className="wiki-migrate-review-error" role="alert">
          整理入库失败：{run.error ?? '未知原因'}
        </p>
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          清除本次方案
        </Button>
      </div>
    )
  }

  if (mappings.length === 0) {
    return (
      <div className="wiki-migrate-review">
        <p className="wiki-migrate-review-empty">没有可执行的文件夹映射。</p>
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          知道了
        </Button>
      </div>
    )
  }

  const categories = topicTree?.categories ?? []

  /**
   * 行内修改大类/小类落点。
   */
  const handleCategoryChange = (mapping: WikiMigrateMappingItem, category: string): void => {
    onUpdateMapping(mapping.folderRel, { category, subtopic: null })
  }

  /**
   * 行内修改小类落点。
   */
  const handleSubtopicChange = (mapping: WikiMigrateMappingItem, subtopic: string): void => {
    onUpdateMapping(mapping.folderRel, { subtopic: subtopic || null })
  }

  return (
    <div className="wiki-migrate-review">
      <header className="wiki-migrate-review-header">
        <span className="wiki-migrate-review-count">
          {mappings.length} 条文件夹映射（请确认后点「确认整理」才会归档）
        </span>
        <div className="wiki-migrate-review-actions">
          <Button
            variant="primary"
            size="sm"
            disabled={applying || unresolvedConflicts}
            onClick={onApply}
          >
            {applying ? '整理中…' : '确认整理'}
          </Button>
          <Button variant="ghost" size="sm" disabled={applying} onClick={onReplan}>
            重新规划
          </Button>
          <Button variant="ghost" size="sm" disabled={applying} onClick={onDiscard}>
            丢弃方案
          </Button>
        </div>
      </header>

      {unresolvedConflicts && (
        <p className="wiki-migrate-review-hint" role="status">
          仍有冲突未处理：请改落点、批准新建小类或忽略对应文件夹后再确认。
        </p>
      )}

      <table className="wiki-migrate-review-table">
        <thead>
          <tr>
            <th scope="col">源文件夹</th>
            <th scope="col">文件数</th>
            <th scope="col">目标大类/小类</th>
            <th scope="col">置信</th>
            <th scope="col">理由</th>
            <th scope="col">状态</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {mappings.map((m) => {
            const subtopics = categories.find((c) => c.name === m.category)?.subtopics ?? []
            const rowClass = m.ignored
              ? 'wiki-migrate-review-row--ignored'
              : m.status === 'conflict'
                ? 'wiki-migrate-review-row--conflict'
                : undefined

            return (
              <tr key={m.folderRel} className={rowClass}>
                <td className="wiki-migrate-review-folder">{m.folderRel}</td>
                <td>{m.inboxIds.length}</td>
                <td>
                  {m.ignored ? (
                    <span className="wiki-migrate-review-ignored-label">已忽略</span>
                  ) : (
                    <div className="wiki-migrate-review-target">
                      <select
                        aria-label={`${m.folderRel} 目标大类`}
                        value={m.category ?? ''}
                        onChange={(e) => handleCategoryChange(m, e.target.value)}
                      >
                        <option value="">— 选择大类 —</option>
                        {categories.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`${m.folderRel} 目标小类`}
                        value={m.subtopic ?? ''}
                        disabled={!m.category}
                        onChange={(e) => handleSubtopicChange(m, e.target.value)}
                      >
                        <option value="">暂不细分</option>
                        {subtopics.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                        {m.proposedSubtopic && !subtopics.includes(m.proposedSubtopic) && (
                          <option value={m.proposedSubtopic}>
                            {m.proposedSubtopic}（新建）
                          </option>
                        )}
                      </select>
                      {m.proposedSubtopic && (
                        <label className="wiki-migrate-review-approve">
                          <input
                            type="checkbox"
                            aria-label={`批准新建小类「${m.proposedSubtopic}」`}
                            checked={m.approvedProposedSubtopic === true}
                            onChange={(e) =>
                              onUpdateMapping(m.folderRel, { approvedProposedSubtopic: e.target.checked })
                            }
                          />
                          批准新建小类「{m.proposedSubtopic}」
                        </label>
                      )}
                      <span className="wiki-migrate-review-target-preview">
                        {formatTopicDisplay(m.category, m.subtopic)}
                      </span>
                    </div>
                  )}
                </td>
                <td>{formatConfidence(m.confidence)}</td>
                <td className="wiki-migrate-review-reason">{m.reason}</td>
                <td>
                  <span
                    className={`wiki-migrate-review-status wiki-migrate-review-status--${m.status}`}
                  >
                    {mappingStatusLabel(m.status)}
                  </span>
                </td>
                <td>
                  {!m.ignored && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onUpdateMapping(m.folderRel, { ignored: true })}
                    >
                      忽略此夹
                    </Button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default WikiMigrateReviewView
